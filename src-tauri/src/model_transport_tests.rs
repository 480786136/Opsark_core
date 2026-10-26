//! All requests use local TCP fixtures and synthetic captured authorization.
use super::*;
use std::io::{Read, Write};

enum Reply {
    Json(u16, Value),
    Lost,
    ShortBody,
    AcceptedAdapter,
    Adapter(&'static str, Option<Value>, bool),
    RejectedAdapter(u16, &'static str, bool),
    DelayedLost(u64),
    ObservedDelayedJson(u64, Value, std::sync::mpsc::Sender<()>),
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
                Reply::AcceptedAdapter => {
                    let initial = &requests[0];
                    let id = initial
                        .lines()
                        .find_map(|line| line.strip_prefix("x-opsark-client-request-id: "))
                        .unwrap();
                    let digest = initial
                        .lines()
                        .find_map(|line| line.strip_prefix("x-opsark-request-digest: "))
                        .unwrap();
                    let body=json!({"protocol":"opsark-local-v1","requestId":id,"requestDigest":digest,"state":"queued"}).to_string();
                    write!(socket,"HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
                }
                Reply::ShortBody => {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 99999\r\nConnection: close\r\n\r\n{\"choices\":[").unwrap();
                }
                Reply::DelayedLost(milliseconds) => {
                    std::thread::sleep(Duration::from_millis(milliseconds));
                }
                Reply::ObservedDelayedJson(milliseconds, payload, observed) => {
                    observed.send(()).unwrap();
                    std::thread::sleep(Duration::from_millis(milliseconds));
                    let body = payload.to_string();
                    write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
                }
                Reply::RejectedAdapter(status, reason, wrong_digest) => {
                    let initial = &requests[0];
                    let id = initial
                        .lines()
                        .find_map(|line| line.strip_prefix("x-opsark-client-request-id: "))
                        .unwrap();
                    let digest = initial
                        .lines()
                        .find_map(|line| line.strip_prefix("x-opsark-request-digest: "))
                        .unwrap();
                    let body = json!({"protocol":"opsark-local-v1","requestId":id,
                        "requestDigest":if wrong_digest {"unbound"} else {digest},
                        "state":"not_accepted","httpStatus":status,"reason":reason})
                    .to_string();
                    write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
                }
                Reply::Adapter(state, result, wrong_digest) => {
                    let initial = &requests[0];
                    let request_id = initial
                        .lines()
                        .find_map(|line| line.strip_prefix("x-opsark-client-request-id: "))
                        .unwrap();
                    let expected = initial
                        .lines()
                        .find_map(|line| line.strip_prefix("x-opsark-request-digest: "))
                        .unwrap();
                    let original_body = initial.split_once("\r\n\r\n").unwrap().1;
                    assert_eq!(
                        crate::model_request_lifecycle::digest(original_body.as_bytes()),
                        expected
                    );
                    let body = json!({"protocol":"opsark-local-v1","requestId":request_id,
                        "requestDigest":if wrong_digest { "bad-digest" } else { expected },"state":state,
                        "httpStatus":200,"response":result,"usage":result.as_ref().and_then(|value|value.get("usage")),"timing":{"acceptedAtMs":1,"completedAtMs":2}}).to_string();
                    write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
                }
            }
        }
        requests
    });
    (url, handle)
}

fn local_adapter_call(
    url: &str,
    timeout: u64,
) -> (
    Result<(Value, u16, Value), String>,
    Value,
    crate::model_request_lifecycle::RequestRecord,
) {
    let base = url.strip_suffix("/v1/chat/completions").unwrap();
    let body = json!({"model":"synthetic","max_tokens":128,"messages":[{"role":"user","content":"test"}],
        "_opsarkContext":json!({"_modelRequestLifecycle":{"adapter":{"protocol":"opsark-local-v1","baseUrl":base}}}).to_string()});
    let budget =
        crate::model_budget::OperationBudget::for_request(url, "synthetic", &body, timeout)
            .unwrap();
    let dir = std::env::temp_dir()
        .join("opsark-model-transport-unit")
        .join(crate::task_logs::call_id());
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("model-calls.jsonl");
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(send_model_request_authorized(
            url,
            "synthetic",
            "captured-synthetic-access",
            false,
            &body,
            "模型总结",
            timeout,
            Some(&log),
            &budget,
        ));
    let snapshot = budget.snapshot();
    let id = crate::model_request_lifecycle::digest(
        json!([snapshot["modelOperationId"], 1])
            .to_string()
            .as_bytes(),
    );
    let store = crate::model_request_lifecycle::Store::open(
        &dir.join("model-requests.sqlite3"),
        "test-inspection-boot",
    )
    .unwrap();
    (result, snapshot, store.get(&id).unwrap())
}

#[test]
fn lifecycle_adapter_recovers_original_result_after_http_deadline_without_second_post() {
    let result = json!({"choices":[{"message":{"content":"original-result"}}],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}});
    // Short controlled deadline exercises the same reqwest timeout path as 90s;
    // the bridge's separate 95s case owns validation of the real wall-clock value.
    let (url, server) = server(vec![
        Reply::DelayedLost(1100),
        Reply::Adapter("completed", Some(result.clone()), false),
    ]);
    let (response, budget, record) = local_adapter_call(&url, 1);
    assert_eq!(response.unwrap().0, result);
    assert_eq!(budget["knownUsageTokens"], 19);
    assert_eq!(record.state, RequestState::Completed);
    assert_eq!(record.response, Some(result));
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests.iter().filter(|r| r.starts_with("POST ")).count(),
        1
    );
    assert!(requests[1].starts_with("GET /opsark/requests/"));
    assert!(requests
        .iter()
        .all(|r| r.contains("authorization: Bearer captured-synthetic-access")));
}

#[test]
fn lifecycle_adapter_rejects_other_body_digest_and_preserves_unknown() {
    let (url, server) = server(vec![
        Reply::Lost,
        Reply::Adapter("completed", Some(json!({"choices":[]})), true),
    ]);
    let (result, budget, record) = local_adapter_call(&url, 3);
    assert!(result.unwrap_err().contains("MODEL_DISPATCH_UNKNOWN"));
    assert_eq!(record.state, RequestState::Unknown);
    assert_eq!(budget["unknownUsageAttempts"], 1);
    assert!(record.response.is_none());
    assert_eq!(server.join().unwrap().len(), 2);
}

#[test]
fn lifecycle_adapter_accepted_ack_is_not_delivered_as_assistant_completion() {
    let expected = json!({"choices":[{"message":{"content":"original-result"}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}});
    let (url, server) = server(vec![
        Reply::AcceptedAdapter,
        Reply::Adapter("completed", Some(expected.clone()), false),
    ]);
    let (result, budget, record) = local_adapter_call(&url, 3);
    assert_eq!(result.unwrap().0, expected);
    assert_eq!(budget["knownUsageTokens"], 5);
    assert!(record
        .events
        .iter()
        .any(|e| e["phase"] == "adapter_post_ack" && e["state"] == "accepted"));
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].starts_with("GET /opsark/requests/"));
}

#[test]
fn lifecycle_adapter_explicit_not_accepted_releases_only_original_reservation() {
    let (url, server) = server(vec![
        Reply::Json(429, json!({"error":{"code":"ADAPTER_BUSY"}})),
        Reply::Adapter("not_accepted", None, false),
    ]);
    let (result, budget, record) = local_adapter_call(&url, 3);
    assert!(result.unwrap_err().contains("MODEL_ADAPTER_BUSY"));
    assert_eq!(record.state, RequestState::NotDispatched);
    assert_eq!(budget["knownUsageTokens"], 0);
    assert_eq!(budget["unknownUsageAttempts"], 0);
    assert_eq!(server.join().unwrap().len(), 2);
}

#[test]
fn lifecycle_adapter_bound_not_accepted_classifies_busy_and_retains_original_status() {
    for (post_status, ledger_status, reason, expected_code) in [
        (None, 429, "QUEUE_FULL", "MODEL_ADAPTER_BUSY"),
        (
            Some(503),
            400,
            "UNSUPPORTED_REQUEST",
            "MODEL_REQUEST_NOT_ACCEPTED",
        ),
        (Some(503), 503, "QUEUE_FULL", "MODEL_ADAPTER_BUSY"),
        (
            Some(409),
            409,
            "CANCELLED_BEFORE_DISPATCH",
            "MODEL_REQUEST_NOT_ACCEPTED",
        ),
    ] {
        let first_reply = post_status
            .map(|status| Reply::Json(status, json!({"error":{"code":"ADAPTER_ERROR"}})))
            .unwrap_or(Reply::Lost);
        let (url, server) = server(vec![
            first_reply,
            Reply::RejectedAdapter(ledger_status, reason, false),
        ]);
        let (result, budget, record) = local_adapter_call(&url, 3);
        let raw_error = result.unwrap_err();
        let error: Value = serde_json::from_str(
            raw_error
                .strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX)
                .unwrap(),
        )
        .unwrap();
        let error = &error["modelError"];
        assert_eq!(error["code"], expected_code);
        assert_eq!(error["stage"], "request_recovery");
        assert_eq!(error["origin"], "core");
        assert_eq!(error["dispatchCertainty"], "not_dispatched");
        assert_eq!(error["requestKey"], record.request_id);
        assert_eq!(error["httpStatus"], post_status.unwrap_or(ledger_status));
        assert_eq!(error["adapterHttpStatus"], ledger_status);
        assert_eq!(error["adapterReason"], reason);
        assert_eq!(error["providerCode"], reason);
        assert_eq!(error["retryable"], false);
        assert_eq!(record.state, RequestState::NotDispatched);
        assert_eq!(budget["knownUsageTokens"], 0);
        assert_eq!(budget["unknownUsageAttempts"], 0);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.starts_with("POST "))
                .count(),
            1
        );
        assert!(requests[1].starts_with("GET /opsark/requests/"));
    }
}

#[test]
fn lifecycle_adapter_unbound_busy_is_unknown_and_reason_is_not_arbitrary_text() {
    let (url, handle) = server(vec![
        Reply::Json(429, json!({"error":{"code":"QUEUE_FULL"}})),
        Reply::RejectedAdapter(429, "QUEUE_FULL", true),
    ]);
    let (result, budget, record) = local_adapter_call(&url, 3);
    assert!(result.unwrap_err().contains("MODEL_DISPATCH_UNKNOWN"));
    assert_eq!(record.state, RequestState::Unknown);
    assert_eq!(budget["unknownUsageAttempts"], 1);
    assert_eq!(handle.join().unwrap().len(), 2);

    let (url, handle) = server(vec![
        Reply::Lost,
        Reply::RejectedAdapter(400, "QUEUE_FULL secret /token", false),
    ]);
    let (result, _, record) = local_adapter_call(&url, 3);
    let error = result.unwrap_err();
    assert!(error.contains("MODEL_REQUEST_NOT_ACCEPTED"));
    assert!(!error.contains("secret"));
    assert_eq!(record.state, RequestState::NotDispatched);
    assert!(!serde_json::to_string(&record.events)
        .unwrap()
        .contains("secret"));
    assert_eq!(handle.join().unwrap().len(), 2);
}

#[test]
fn lifecycle_adapter_queue_running_and_completion_keep_one_original_request() {
    let result =
        json!({"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}});
    let (url, server) = server(vec![
        Reply::Lost,
        Reply::Adapter("queued", None, false),
        Reply::Adapter(
            "running",
            Some(json!({"usage":{"prompt_tokens":3,"completion_tokens":0,"total_tokens":3}})),
            false,
        ),
        Reply::Adapter("completed", Some(result.clone()), false),
    ]);
    let (response, budget, record) = local_adapter_call(&url, 3);
    assert_eq!(response.unwrap().0, result);
    assert_eq!(budget["knownUsageTokens"], 5);
    assert!(record.events.iter().any(|event| event["phase"] == "queued"));
    assert!(record
        .events
        .iter()
        .any(|event| event["phase"] == "running"));
    assert!(record.events.iter().any(|event| event["phase"] == "running"
        && event["detail"]["reportedUsage"]["total_tokens"] == 3
        && event["detail"]["usage"].is_null()));
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 4);
    assert_eq!(
        requests.iter().filter(|r| r.starts_with("POST ")).count(),
        1
    );
}

#[test]
fn lifecycle_adapter_confirmed_cancellation_without_usage_does_not_invent_zero_cost() {
    let (url, server) = server(vec![Reply::Lost, Reply::Adapter("cancelled", None, false)]);
    let (result, budget, record) = local_adapter_call(&url, 3);
    assert!(result.unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
    assert_eq!(record.state, RequestState::Cancelled);
    assert_eq!(budget["unknownUsageAttempts"], 1);
    assert!(budget["accountedTokens"].as_u64().unwrap() > 0);
    assert!(record.usage.is_none());
    assert_eq!(server.join().unwrap().len(), 2);
}

#[test]
fn lifecycle_adapter_restart_unknown_never_reissues_generation() {
    let (url, server) = server(vec![Reply::Lost, Reply::Adapter("unknown", None, false)]);
    let (result, budget, record) = local_adapter_call(&url, 3);
    assert!(result.unwrap_err().contains("MODEL_DISPATCH_UNKNOWN"));
    assert_eq!(record.state, RequestState::Unknown);
    assert_eq!(budget["unknownUsageAttempts"], 1);
    assert_eq!(server.join().unwrap().len(), 2);
}

#[test]
fn lifecycle_adapter_plain_503_uses_bound_ledger_for_unknown_cancelled_and_not_accepted() {
    for (state, expected, error_code, unknown_cost) in [
        (
            "unknown",
            RequestState::Unknown,
            "MODEL_DISPATCH_UNKNOWN",
            1,
        ),
        (
            "cancelled",
            RequestState::Cancelled,
            "MODEL_REQUEST_CANCELLED",
            1,
        ),
        (
            "not_accepted",
            RequestState::NotDispatched,
            "MODEL_REQUEST_NOT_ACCEPTED",
            0,
        ),
    ] {
        let (url, server) = server(vec![
            Reply::Json(
                503,
                json!({"error":{"type":"local_adapter_error","message":"INFERENCE_FAILED"}}),
            ),
            Reply::Adapter(state, None, false),
        ]);
        let (result, budget, record) = local_adapter_call(&url, 3);
        assert!(result.unwrap_err().contains(error_code));
        assert_eq!(record.state, expected);
        assert_eq!(budget["unknownUsageAttempts"], unknown_cost);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests.iter().filter(|r| r.starts_with("POST ")).count(),
            1
        );
    }
}

#[test]
fn lifecycle_adapter_nonretryable_http_or_200_error_cannot_masquerade_as_completion() {
    for status in [200, 400, 401, 409] {
        let (url, server) = server(vec![
            Reply::Json(
                status,
                json!({"error":{"message":"ADAPTER_STATE_NOT_A_MODEL_RESULT"}}),
            ),
            Reply::Adapter("unknown", None, false),
        ]);
        let (result, _, record) = local_adapter_call(&url, 3);
        assert!(result.unwrap_err().contains("MODEL_DISPATCH_UNKNOWN"));
        assert_eq!(record.state, RequestState::Unknown);
        assert!(record.response.is_none());
        assert_eq!(server.join().unwrap().len(), 2);
    }
}

#[test]
fn lifecycle_active_adapter_cancel_uses_original_identity_and_does_not_claim_confirmation() {
    use crate::model_request_lifecycle::{RequestHandle, RequestRecord, Store};
    let (url, server) = server(vec![Reply::Json(202, json!({"cancelRequested":true}))]);
    let base = url.strip_suffix("/v1/chat/completions").unwrap();
    let path = std::env::temp_dir()
        .join("opsark-cancel-watch-tests")
        .join(format!("{}.sqlite3", crate::task_logs::call_id()));
    // Construct the durable admission independently of the model budget so this
    // transport test does not mutate global application registration state.
    let record:RequestRecord=serde_json::from_value(json!({"version":1,"requestId":"request-original","operationId":"operation-original",
        "operationStartedAtMs":1,"taskId":"task-a","roundId":"round-a","endpoint":url,"credentialDigest":"synthetic-hash",
        "requestDigest":"a".repeat(64),"adapter":{"protocol":"opsark-local-v1","baseUrl":base},"state":"not_dispatched","phase":"prepared",
        "cancelRequested":false,"late":false,"attemptIds":[],"createdAtMs":1,"updatedAtMs":1,"httpStatus":null,"response":null,"usage":null,"events":[]})).unwrap();
    let mut store = Store::open(&path, "setup").unwrap();
    store.prepare(record).unwrap();
    drop(store);
    let handle = RequestHandle::from_test_path(path.clone(), "request-original".into());
    handle.dispatch("attempt-original").unwrap();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let _watch = watch_adapter_cancellation(&handle, "original-captured-token").unwrap();
            Store::open(&path, "external-cancel-test")
                .unwrap()
                .cancel("task-a", Some("request-original"))
                .unwrap();
            for _ in 0..30 {
                if handle
                    .read()
                    .unwrap()
                    .events
                    .iter()
                    .any(|event| event["detail"]["source"] == "cancel_transport")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("POST /opsark/requests/request-original/cancel "));
    assert!(requests[0].contains("authorization: Bearer original-captured-token"));
    let body: Value = serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["requestDigest"], "a".repeat(64));
    assert_eq!(body["requestId"], "request-original");
    let current = handle.read().unwrap();
    assert!(current.cancel_requested);
    assert_ne!(current.state, RequestState::Cancelled);
    assert!(current.usage.is_none());
}

#[test]
fn lifecycle_terminal_receipts_with_historical_cancellation_send_no_cancel_or_lookup() {
    use crate::model_request_lifecycle::{RequestHandle, RequestRecord, Store};
    for state in [RequestState::Completed, RequestState::Cancelled] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let path = std::env::temp_dir().join("opsark-terminal-cancel-tests")
            .join(format!("{}.sqlite3", crate::task_logs::call_id()));
        let payload = json!({"choices":[{"message":{"content":"original result"}}],"usage":{"total_tokens":19}});
        // Reproduce a persisted historical flag independently of the corrected
        // cancellation writer. Taskless here: task usage settlement is tested by
        // lifecycle_cancelled_direct_call_retains_late_result_and_settles_original_task_budget.
        let record: RequestRecord = serde_json::from_value(json!({"version":1,"requestId":"terminal-original",
            "operationId":"original-operation","operationStartedAtMs":1,"endpoint":format!("{base}/v1/chat/completions"),
            "credentialDigest":"synthetic-hash","requestDigest":"a".repeat(64),
            "adapter":{"protocol":"opsark-local-v1","baseUrl":base},"state":state,"phase":"completed",
            "cancelRequested":true,"late":false,"attemptIds":[],"createdAtMs":1,"updatedAtMs":2,
            "httpStatus":200,"response":payload,"usage":{"total_tokens":19},"events":[]})).unwrap();
        let mut store = Store::open(&path,"terminal-test").unwrap();
        store.prepare(record).unwrap(); drop(store);
        let handle = RequestHandle::from_test_path(path,"terminal-original".into());
        let before = serde_json::to_value(handle.read().unwrap()).unwrap();
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let _watch = watch_adapter_cancellation(&handle,"synthetic-token").unwrap();
            let result = recover_local_adapter(&handle,"synthetic-token",1).await.unwrap();
            assert_eq!(result, if state == RequestState::Completed {Some((payload.clone(),200))} else {None});
            tokio::time::sleep(Duration::from_millis(150)).await;
        });
        assert_eq!(listener.accept().unwrap_err().kind(),std::io::ErrorKind::WouldBlock);
        assert_eq!(serde_json::to_value(handle.read().unwrap()).unwrap(),before);
    }
}

#[test]
fn lifecycle_cancelled_direct_call_retains_late_result_and_settles_original_task_budget() {
    crate::task_model_budget::initialize_test_runtime().unwrap();
    let task = crate::task_logs::call_id();
    let round = "round-original";
    crate::task_model_budget::register(crate::task_model_budget::TaskBudgetRegistration {
        task_id: task.clone(),
        round_id: round.into(),
        max_task_tokens: 100_000,
        max_round_tokens: 50_000,
        safety_reserve_tokens: 0,
    })
    .unwrap();
    let context = json!({"_log":{"taskId":task,"roundId":round},"_taskModelBudget":{"version":1,"taskId":task,"roundId":round}});
    let body = json!({"model":"synthetic","max_tokens":128,"messages":[{"role":"user","content":"test"}],"_opsarkContext":context.to_string()});
    let payload = json!({"choices":[{"message":{"content":"late-original-answer"}}],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}});
    let (sent, received) = std::sync::mpsc::channel();
    let (url, server) = server(vec![Reply::ObservedDelayedJson(250, payload.clone(), sent)]);
    let budget =
        crate::model_budget::OperationBudget::for_request(&url, "synthetic", &body, 3).unwrap();
    let dir = std::env::temp_dir()
        .join("opsark-late-response-tests")
        .join(crate::task_logs::call_id());
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("model-calls.jsonl");
    let id = crate::model_request_lifecycle::digest(
        json!([budget.snapshot()["modelOperationId"], 1])
            .to_string()
            .as_bytes(),
    );
    let handle = crate::model_request_lifecycle::RequestHandle::from_test_path(
        dir.join("model-requests.sqlite3"),
        id,
    );
    let cancelling = handle.clone();
    let cancelling_task = task.clone();
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let cancellation = tokio::spawn(async move {
                for _ in 0..100 {
                    if received.try_recv().is_ok() {
                        cancelling.cancel_for_test(&cancelling_task).unwrap();
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                panic!("original request did not dispatch");
            });
            let result = send_model_request_authorized(
                &url,
                "synthetic",
                "captured-synthetic-access",
                false,
                &body,
                "模型总结",
                3,
                Some(&log),
                &budget,
            )
            .await;
            cancellation.await.unwrap();
            result
        });
    assert!(result.unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
    let record = handle.read().unwrap();
    assert!(record.late && record.cancel_requested);
    assert_eq!(record.state, RequestState::Completed);
    assert_eq!(record.response, Some(payload));
    let cost = crate::task_model_budget::query(&task, round).unwrap();
    assert_eq!(cost["task"]["knownUsageTokens"], 19);
    assert_eq!(cost["round"]["knownUsageTokens"], 19);
    assert_eq!(server.join().unwrap().len(), 1);
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
