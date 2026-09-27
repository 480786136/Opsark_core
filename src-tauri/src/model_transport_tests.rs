//! All requests use local TCP fixtures and synthetic captured authorization.
use super::*;
use std::io::{Read, Write};

enum Reply {
    Json(u16, Value),
    Lost,
    ShortBody,
}

fn server(replies: Vec<Reply>) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let handle = std::thread::spawn(move || {
        let mut requests = vec![];
        for reply in replies {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "expected request did not arrive");
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = vec![];
            loop {
                let mut buffer = [0u8; 4096];
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .map(|value| value.trim().parse::<usize>().unwrap())
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            requests.push(String::from_utf8(bytes).unwrap());
            match reply {
                Reply::Json(status, payload) => {
                    let body = payload.to_string();
                    write!(socket,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nX-Opsark-Provider-Http-Status: 201\r\nX-Opsark-Call-Id: header-call-original\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
                }
                Reply::Lost => {}
                Reply::ShortBody => {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 99999\r\nConnection: close\r\n\r\n{\"choices\":[").unwrap();
                }
            }
        }
        requests
    });
    (url, handle)
}

fn call(url: &str, official: bool) -> (Value, Value) {
    call_with_key(url, official, "synthetic")
}

fn call_with_key(url: &str, official: bool, key: &str) -> (Value, Value) {
    let body =
        json!({"model":"synthetic","max_tokens":128,"messages":[{"role":"user","content":"test"}]});
    let budget = crate::model_budget::OperationBudget::for_request(url, key, &body, 3).unwrap();
    let error = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(send_model_request_authorized(
            url,
            key,
            "captured-synthetic-access",
            official,
            &body,
            "模型总结",
            3,
            None,
            &budget,
        ))
        .unwrap_err();
    let decoded: Value = serde_json::from_str(
        error
            .strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX)
            .expect(&error),
    )
    .unwrap();
    (decoded, budget.snapshot())
}

fn accepted() -> Reply {
    Reply::Json(
        409,
        json!({"error":{"code":"REQUEST_ALREADY_ACCEPTED","details":{
    "origin":"gateway","stage":"request_deduplication","dispatchCertainty":"may_have_dispatched","callId":"call-original","gatewayHttpStatus":409}}}),
    )
}
fn completed() -> Reply {
    Reply::Json(
        200,
        json!({"status":"succeeded","call_id":"call-original","actual":27,"credit_state":"settled",
    "dispatchCertainty":"response_received","gatewayHttpStatus":201,"providerHttpStatus":201,"responseAvailable":false}),
    )
}

#[test]
fn accepted_request_queries_same_origin_identity_and_frozen_authorization_without_regeneration() {
    let (url, handle) = server(vec![accepted(), completed()]);
    let (error, budget) = call(&url, true);
    assert_eq!(budget["knownUsageTokens"], 27);
    assert_eq!(budget["unknownUsageAttempts"], 0);
    assert_eq!(error["modelError"]["code"], "MODEL_RESULT_UNAVAILABLE");
    assert_eq!(error["modelError"]["httpStatus"], 409);
    assert_eq!(error["modelError"]["gatewayHttpStatus"], 409);
    assert_eq!(error["modelError"]["providerHttpStatus"], 201);
    assert_eq!(error["modelError"]["statusQueryHttpStatus"], 200);
    assert_eq!(error["modelError"]["actual"], 27);
    let requests = handle.join().unwrap();
    assert_eq!(requests.len(), 2);
    let key = requests[0]
        .lines()
        .find_map(|line| line.strip_prefix("idempotency-key: "))
        .unwrap();
    assert!(requests[0].starts_with("POST /v1/chat/completions "));
    assert!(requests[1].starts_with(&format!("GET /api/core/v1/model-requests/{key} ")));
    for request in requests {
        assert!(request.contains("authorization: Bearer captured-synthetic-access"));
    }
}

#[test]
fn lost_and_partial_official_responses_only_query_original_generation() {
    for reply in [Reply::Lost, Reply::ShortBody] {
        let (url, handle) = server(vec![reply, completed()]);
        let (error, _) = call(&url, true);
        assert_eq!(error["modelError"]["code"], "MODEL_RESULT_UNAVAILABLE");
        let requests = handle.join().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.starts_with("POST "))
                .count(),
            1
        );
        assert_eq!(requests.len(), 2);
    }
}

#[test]
fn unavailable_status_and_foreign_identity_never_prove_non_dispatch() {
    for reply in [
        Reply::Json(401, json!({})),
        Reply::Json(404, json!({})),
        Reply::Json(
            200,
            json!({"status":"succeeded","requestKey":"another-request"}),
        ),
    ] {
        let (url, handle) = server(vec![accepted(), reply]);
        let (error, _) = call(&url, true);
        assert_eq!(error["modelError"]["code"], "MODEL_DISPATCH_UNKNOWN");
        assert_eq!(
            error["modelError"]["dispatchCertainty"],
            "may_have_dispatched"
        );
        assert_eq!(handle.join().unwrap().len(), 2);
    }
}

#[test]
fn running_status_polling_is_bounded_and_failed_dispatch_keeps_settlement() {
    let (url, handle) = server(vec![
        accepted(),
        Reply::Json(200, json!({"status":"running"})),
        Reply::Json(200, json!({"status":"running"})),
        Reply::Json(200, json!({"status":"running"})),
    ]);
    assert_eq!(
        call(&url, true).0["modelError"]["code"],
        "MODEL_DISPATCH_UNKNOWN"
    );
    assert_eq!(handle.join().unwrap().len(), 4);
    let (url, handle) = server(vec![
        accepted(),
        Reply::Json(
            200,
            json!({"status":"failed","dispatchCertainty":"not_dispatched",
        "credit_state":"released","actual":0,"callId":"call-original"}),
        ),
    ]);
    let (error, _) = call(&url, true);
    assert_eq!(error["modelError"]["code"], "MODEL_REQUEST_FAILED");
    assert_eq!(error["modelError"]["dispatchCertainty"], "not_dispatched");
    assert_eq!(error["modelError"]["creditState"], "released");
    assert_eq!(handle.join().unwrap().len(), 2);
}

#[test]
fn direct_and_omk_unknown_dispatch_never_retry_or_query_status() {
    for reply in [
        Reply::Lost,
        Reply::ShortBody,
        Reply::Json(503, json!({"error":{"message":"busy"}})),
    ] {
        let (url, handle) = server(vec![reply]);
        let (error, _) = call(&url, false);
        assert_eq!(error["modelError"]["code"], "MODEL_DISPATCH_UNKNOWN");
        assert_eq!(error["modelError"]["retryable"], false);
        assert_eq!(handle.join().unwrap().len(), 1);
    }
}

#[test]
fn two_hop_statuses_and_schema_invalid_are_not_lost_or_downgraded() {
    let (url, handle) = server(vec![Reply::Json(
        400,
        json!({"error":{"code":"UPSTREAM_SCHEMA_INVALID",
        "message":"Invalid schema: unsupported schema definition","origin":"upstream","stage":"request_schema",
        "dispatchCertainty":"response_received","gatewayHttpStatus":400,"providerHttpStatus":422,
        "providerCode":"invalid_json_schema","callId":"call-original"}}),
    )]);
    let (error, _) = call(&url, true);
    assert_eq!(error["modelError"]["code"], "MODEL_SCHEMA_INVALID");
    assert_eq!(error["modelError"]["httpStatus"], 400);
    assert_eq!(error["modelError"]["gatewayHttpStatus"], 400);
    assert_eq!(error["modelError"]["providerHttpStatus"], 422);
    assert_eq!(error["modelError"]["providerCode"], "invalid_json_schema");
    assert_eq!(handle.join().unwrap().len(), 1);
    let (url, handle) = server(vec![Reply::Json(
        409,
        json!({"error":{"code":"IDEMPOTENCY_KEY_CONFLICT",
        "details":{"origin":"gateway","stage":"request_deduplication","dispatchCertainty":"may_have_dispatched"}}}),
    )]);
    assert_eq!(
        call(&url, true).0["modelError"]["code"],
        "IDEMPOTENCY_KEY_CONFLICT"
    );
    assert_eq!(handle.join().unwrap().len(), 1);
}

#[test]
fn successful_model_key_envelope_retains_both_hops_and_usage_even_if_business_json_is_invalid() {
    let (url, handle) = server(vec![Reply::Json(
        200,
        json!({
        "choices":[{"message":{"content":"invalid JSON"},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":11,"completion_tokens":6,"total_tokens":17}}),
    )]);
    let body =
        json!({"model":"synthetic","max_tokens":128,"messages":[{"role":"user","content":"test"}]});
    let budget =
        crate::model_budget::OperationBudget::for_request(&url, "omk_synthetic-key", &body, 3)
            .unwrap();
    let (mut payload, status, transport) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(send_model_request_authorized(
            &url,
            "omk_synthetic-key",
            "captured-synthetic-access",
            false,
            &body,
            "模型总结",
            3,
            None,
            &budget,
        ))
        .unwrap();
    assert_eq!(status, 200);
    assert_eq!(transport["gatewayHttpStatus"], 200);
    assert_eq!(transport["providerHttpStatus"], 201);
    assert_eq!(transport["callId"], "header-call-original");
    assert_eq!(budget.snapshot()["knownUsageTokens"], 17);
    let diagnostic = crate::model_compatibility::normalize_response_with_wire(
        &mut payload,
        &json!({"type":"object","additionalProperties":false,"properties":{},"required":[]}),
        None,
    )
    .unwrap_err();
    let encoded = model_error_with_context(
        crate::model_compatibility::output_error(&diagnostic, Some(status)),
        &budget,
        Some(&transport),
    );
    let error: Value = serde_json::from_str(
        encoded
            .strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(error["modelError"]["providerHttpStatus"], 201);
    assert_eq!(
        error["modelError"]["recoveryBudget"]["knownUsageTokens"],
        17
    );
    assert_eq!(error["modelError"]["code"], "MODEL_FORMAT_INVALID");
    assert_eq!(handle.join().unwrap().len(), 1);
}

#[test]
fn model_keys_keep_gateway_topology_without_enabling_account_recovery() {
    let (url, handle) = server(vec![Reply::Json(
        502,
        json!({"error":{
        "code":"UPSTREAM_HTTP_ERROR","message":"authentication rejected","origin":"upstream","stage":"upstream_http",
        "gatewayHttpStatus":502,"providerHttpStatus":401,"providerCode":"invalid_api_key","dispatchCertainty":"response_received"}}),
    )]);
    let (error, _) = call_with_key(&url, false, "omk_synthetic-key");
    assert_eq!(error["modelError"]["code"], "UPSTREAM_HTTP_ERROR");
    assert_eq!(error["modelError"]["gatewayHttpStatus"], 502);
    assert_eq!(error["modelError"]["providerHttpStatus"], 401);
    assert_eq!(error["modelError"]["providerCode"], "invalid_api_key");
    assert_eq!(handle.join().unwrap().len(), 1);
    let (url, handle) = server(vec![Reply::Json(
        502,
        json!({"error":{
        "code":"UPSTREAM_READ_FAILED","message":"read failed","origin":"gateway","stage":"response_read",
        "gatewayHttpStatus":502,"dispatchCertainty":"may_have_dispatched"}}),
    )]);
    let (error, _) = call_with_key(&url, false, "omk_synthetic-key");
    assert_eq!(error["modelError"]["code"], "MODEL_DISPATCH_UNKNOWN");
    assert_eq!(error["modelError"]["gatewayHttpStatus"], 502);
    assert!(error["modelError"].get("providerCode").is_none());
    assert_eq!(handle.join().unwrap().len(), 1);
}

#[test]
fn direct_http_rejections_are_typed_without_invented_provider_codes_or_gateway_trust() {
    for payload in [
        json!({"error":{"code":"invalid_api_key","message":"invalid key","gatewayHttpStatus":502,"origin":"gateway"}}),
        json!({"error":{"message":"invalid key"}}),
    ] {
        let (url, handle) = server(vec![Reply::Json(401, payload.clone())]);
        let (error, _) = call(&url, false);
        assert_eq!(error["modelError"]["code"], "MODEL_HTTP_ERROR");
        assert_eq!(error["modelError"]["httpStatus"], 401);
        assert_eq!(error["modelError"]["providerHttpStatus"], 401);
        assert_eq!(error["modelError"]["origin"], "upstream");
        assert!(error["modelError"].get("gatewayHttpStatus").is_none());
        if payload["error"].get("code").is_some() {
            assert_eq!(error["modelError"]["providerCode"], "invalid_api_key");
        } else {
            assert!(error["modelError"].get("providerCode").is_none());
        }
        assert_eq!(handle.join().unwrap().len(), 1);
    }
}

#[test]
fn official_authorization_rejection_is_typed_and_never_dispatches_or_reads_credentials() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    // This path can never equal account::origin()/v1/chat/completions, so the
    // real authorization function rejects it before touching session/keyring.
    let url = format!(
        "http://{}/invalid-official-endpoint",
        listener.local_addr().unwrap()
    );
    let error = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(post_model_request(
            &url,
            "opsark-account:synthetic-private-account",
            &json!({"model":"test","messages":[{"role":"user","content":"test"}]}),
            "结果复核",
            3,
            None,
        ))
        .unwrap_err();
    let payload: Value =
        serde_json::from_str(error.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap()).unwrap();
    assert_eq!(payload["modelError"]["code"], "MODEL_AUTH_UNAVAILABLE");
    assert_eq!(payload["modelError"]["origin"], "core");
    assert_eq!(payload["modelError"]["stage"], "request_auth");
    assert_eq!(payload["modelError"]["dispatchCertainty"], "not_dispatched");
    assert_eq!(payload["modelError"]["retryable"], false);
    assert!(payload["modelError"].get("httpStatus").is_none());
    assert_eq!(
        payload["modelError"]["recoveryBudget"]["transportAttempts"],
        0
    );
    assert_eq!(payload["modelError"]["recoveryBudget"]["generations"], 0);
    assert!(!error.contains("synthetic-private-account"));
    assert!(!error.contains(&url));
    assert!(
        matches!(listener.accept(),Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
    );
}
