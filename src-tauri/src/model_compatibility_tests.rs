//! Local fake-provider tests: never send credentials or requests to a real vendor.
use super::*;
use std::io::{Read, Write};

fn provider(responses: Vec<(u16, Value)>) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    provider_raw(
        responses
            .into_iter()
            .map(|(status, response)| (status, response.to_string()))
            .collect(),
    )
}

fn provider_raw(responses: Vec<(u16, String)>) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/chat/completions", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, response) in responses {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "missing expected request");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|x| x == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let len = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse::<usize>()
                        .unwrap();
                    if bytes.len() >= end + 4 + len {
                        requests
                            .push(serde_json::from_slice(&bytes[end + 4..end + 4 + len]).unwrap());
                        break;
                    }
                }
            }
            write!(socket, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        }
        requests
    });
    (url, server)
}

fn response(content: &str, finish: &str) -> Value {
    json!({"choices":[{"message":{"content":content},"finish_reason":finish}]})
}

fn request(strict: bool) -> Value {
    let context = json!({"confirmedUserInputs":{"choice":"preserve-data"},
        "_modelCapabilities":{"protocol":"chat_completions","version":"test-v1","parameterAdapter":"portable",
            "structuredOutput":if strict {"json_schema"} else {"json_object"},
            "tokenField":"max_tokens","defaultOutputTokens":5000,"maxOutputTokens":16384}}).to_string();
    json!({"model":"test", "max_tokens":1000,"_opsarkContext":context,
        "messages":[{"role":"system","content":"Return JSON with a steps array. Never execute anything."},{"role":"user","content":context}]})
}

fn run(url: &str, body: &Value) -> Result<Value, String> {
    run_operation(url, body, "计划生成")
}

fn run_operation(url: &str, body: &Value, operation: &str) -> Result<Value, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(post_model_request(
            url,
            "synthetic-key",
            body,
            operation,
            3,
            None,
        ))
}

#[test]
fn missing_steps_repair_cannot_manufacture_completion() {
    for decision in ["complete", "continue", "adjust"] {
        let missing =
            json!({"decision":"continue","reason":"need deployment","summary":"unfinished"})
                .to_string();
        let empty =
            json!({"decision":decision,"reason":"finished","summary":"no action","steps":[]})
                .to_string();
        let (url, server) = provider(vec![
            (200, response(&missing, "stop")),
            (200, response(&empty, "stop")),
        ]);
        let error = run_operation(&url, &request(false), "阶段联合决策").unwrap_err();
        assert!(error.contains("MODEL_FORMAT_INVALID"));
        assert_eq!(server.join().unwrap().len(), 2);
    }
}

#[test]
fn truncation_and_invalid_json_receive_one_repair_with_same_budget_and_authority() {
    for first in [
        response("partial-never-authority", "length"),
        response("", "stop"),
        response("{}", "stop"),
    ] {
        let (url, server) = provider(vec![
            (200, first),
            (200, response(r#"{"steps":[]}"#, "stop")),
        ]);
        assert!(run(&url, &request(false)).is_ok());
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        for body in &requests {
            assert_eq!(body["max_tokens"], 1000);
            assert!(body.to_string().contains("preserve-data"));
            assert!(!body.to_string().contains("_modelCapabilities"));
            assert!(body.get("_opsarkContext").is_none());
        }
        assert_eq!(
            requests[1]["messages"].as_array().unwrap().len(),
            requests[0]["messages"].as_array().unwrap().len() + 1
        );
        assert!(!requests[1].to_string().contains("partial-never-authority"));
    }
}

#[test]
fn repeated_truncation_is_a_terminal_typed_failure() {
    let (url, server) = provider(vec![
        (200, response("{", "length")),
        (200, response("{", "length")),
    ]);
    let error = run(&url, &request(false)).unwrap_err();
    assert!(error.contains("MODEL_OUTPUT_TRUNCATED"));
    assert_eq!(server.join().unwrap().len(), 2);
}

#[test]
fn explicit_schema_refusal_downgrades_once_and_is_remembered() {
    let good = response(r#"{"steps":[]}"#, "stop");
    let (url, server) = provider(vec![
        (
            400,
            json!({"error":{"code":"UPSTREAM_SCHEMA_UNSUPPORTED","message":"json_schema not supported"}}),
        ),
        (200, good.clone()),
        (200, good),
    ]);
    assert!(run(&url, &request(true)).is_ok());
    assert!(run(&url, &request(true)).is_ok());
    let requests = server.join().unwrap();
    assert_eq!(requests[0]["response_format"]["type"], "json_schema");
    assert_eq!(requests[1]["response_format"]["type"], "json_object");
    assert_eq!(requests[2]["response_format"]["type"], "json_object");
}

#[test]
fn authentication_and_malformed_schema_are_not_downgraded() {
    for (status, message) in [(401, "json_schema not supported"), (400, "invalid schema")] {
        let (url, server) = provider(vec![(status, json!({"error":{"message":message}}))]);
        let error = typed_error(&run(&url, &request(true)).unwrap_err());
        assert_eq!(error["modelError"]["httpStatus"], status);
        assert_eq!(
            error["modelError"]["code"],
            if status == 400 {
                "MODEL_SCHEMA_INVALID"
            } else {
                "MODEL_HTTP_ERROR"
            }
        );
        assert_eq!(server.join().unwrap().len(), 1);
    }
}

fn typed_error(error: &str) -> Value {
    serde_json::from_str(error.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap()).unwrap()
}

#[test]
fn repeated_invalid_json_keeps_success_status_and_precise_parse_diagnostic() {
    // Reconstruct the failure shape from task-1790405654569-1uk4lc without
    // retaining its response or commands: HTTP 200, stop, low usage, invalid JSON.
    // Also retain non-200 success coverage so diagnostics never invent a status.
    for (status, content) in [(200, r#"{"steps":(...)}"#), (201, "{\"steps\":[")] {
        let responses = [114, 546]
            .into_iter()
            .map(|used| {
                let mut payload = response(content, "stop");
                payload["usage"] =
                    json!({"prompt_tokens":100,"completion_tokens":used,"total_tokens":100 + used});
                (status, payload)
            })
            .collect();
        let (url, server) = provider(responses);
        let mut body = request(false);
        body["max_tokens"] = json!(5000);
        let error = typed_error(&run(&url, &body).unwrap_err());
        assert_eq!(error["modelError"]["httpStatus"], status);
        assert_eq!(error["modelError"]["code"], "MODEL_FORMAT_INVALID");
        assert_eq!(error["modelError"]["origin"], "core");
        assert_eq!(error["modelError"]["stage"], "json_parse");
        assert_eq!(error["modelError"]["retryable"], false);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        for request in &requests {
            assert_eq!(request["max_tokens"], 5000);
            assert_eq!(request["response_format"]["type"], "json_object");
        }
        let feedback = requests[1]["messages"].as_array().unwrap().last().unwrap()["content"]
            .as_str()
            .unwrap();
        assert!(feedback.contains("json_parse"));
        assert!(feedback.contains("line"));
        assert!(feedback.contains("column"));
    }
}

#[test]
fn format_repair_sends_diagnostics_without_replaying_rejected_commands() {
    let (url, server) = provider(vec![
        (
            200,
            response(r#"{"steps":["do-not-replay-malicious-command""#, "stop"),
        ),
        (200, response(r#"{"steps":[]}"#, "stop")),
    ]);
    assert!(run(&url, &request(false)).is_ok());
    let requests = server.join().unwrap();
    assert!(!requests[1]
        .to_string()
        .contains("do-not-replay-malicious-command"));
    let feedback = requests[1]["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(feedback["role"], "user");
    assert!(feedback["content"].as_str().unwrap().contains("json_parse"));
    assert_eq!(requests[1]["max_tokens"], requests[0]["max_tokens"]);
}

#[test]
fn schema_mismatch_feedback_points_to_contract_failure() {
    let (url, server) = provider(vec![
        (200, response(r#"{"steps":"not-an-array"}"#, "stop")),
        (200, response(r#"{"steps":[]}"#, "stop")),
    ]);
    assert!(run(&url, &request(false)).is_ok());
    let requests = server.join().unwrap();
    let feedback = requests[1]["messages"].as_array().unwrap().last().unwrap()["content"]
        .as_str()
        .unwrap();
    assert!(feedback.contains("jsonPointer"));
    assert!(feedback.contains("/steps"));
    assert!(feedback.contains("schemaPath"));
    assert!(feedback.contains("type"));
    assert!(!feedback.contains("not-an-array"));
}

#[test]
fn non_plan_operations_repair_their_own_contracts() {
    for (operation, valid, expected_rule) in [
        (
            "需求理解",
            json!({"intent":"answer","answer":"ok","selectedSkillIds":[],"constraints":null}),
            "intent、answer",
        ),
        (
            "结果复核",
            json!({"decision":"continue","reason":"needs evidence","summary":"pending"}),
            "只修复复核",
        ),
        (
            "Skill 生成",
            json!({"name":"check","category":"ops","description":"read","matchRules":[],"instructions":"read-only"}),
            "只修复 Skill",
        ),
        ("模型结构测试", json!({"ok":true}), "只返回原探测契约"),
    ] {
        let (url, server) = provider(vec![
            (200, response("{", "stop")),
            (200, response(&valid.to_string(), "stop")),
        ]);
        assert!(
            run_operation(&url, &request(false), operation).is_ok(),
            "{operation}"
        );
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1]["max_tokens"], requests[0]["max_tokens"]);
        let feedback = requests[1]["messages"].as_array().unwrap().last().unwrap()["content"]
            .as_str()
            .unwrap();
        assert!(feedback.contains(expected_rule));
        assert!(feedback.contains(operation));
        assert!(!feedback.contains("仅给最小完整下一步"));
    }
}

#[test]
fn terminal_outcomes_are_never_treated_as_json_format_errors() {
    let good = r#"{"steps":[]}"#;
    for (payload, code) in [
        (
            json!({"choices":[{"message":{"refusal":"cannot comply", "content":null},"finish_reason":"stop"}]}),
            "MODEL_OUTPUT_REFUSED",
        ),
        (response(good, "content_filter"), "MODEL_CONTENT_FILTERED"),
        (
            json!({"choices":[{"message":{"content":good,"tool_calls":[{"id":"hidden-call"}]},"finish_reason":"stop"}]}),
            "MODEL_TOOL_CALL_UNEXPECTED",
        ),
        (response(good, "tool_calls"), "MODEL_TOOL_CALL_UNEXPECTED"),
        (json!({"choices":[]}), "MODEL_RESPONSE_INVALID"),
        (
            json!({"choices":[{"message":{},"finish_reason":"stop"}]}),
            "MODEL_RESPONSE_INVALID",
        ),
        (
            json!({"choices":[{"message":{"content":good}}]}),
            "MODEL_RESPONSE_INVALID",
        ),
    ] {
        let (url, server) = provider(vec![(200, payload)]);
        let error = typed_error(&run(&url, &request(false)).unwrap_err());
        assert_eq!(error["modelError"]["code"], code);
        assert_eq!(error["modelError"]["httpStatus"], 200);
        assert_eq!(server.join().unwrap().len(), 1);
    }
}

#[test]
fn invalid_schema_wrapper_code_does_not_downgrade_or_poison_capability_cache() {
    for message in [
        "Invalid schema for response_format: allOf is not permitted",
        "response_format json_schema unsupported keyword 'not'",
        "response_format schema validation failed: required must contain all properties",
    ] {
        let (url, server) = provider(vec![
            (
                400,
                json!({"error":{"code":"UPSTREAM_SCHEMA_UNSUPPORTED","message":message}}),
            ),
            (200, response(r#"{"steps":[]}"#, "stop")),
        ]);
        let error = typed_error(&run(&url, &request(true)).unwrap_err());
        assert_eq!(error["modelError"]["code"], "MODEL_SCHEMA_INVALID");
        assert_eq!(
            error["modelError"]["providerCode"],
            "UPSTREAM_SCHEMA_UNSUPPORTED"
        );
        assert_eq!(error["modelError"]["httpStatus"], 400);
        assert!(run(&url, &request(true)).is_ok());
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["response_format"]["type"], "json_schema");
        assert_eq!(requests[1]["response_format"]["type"], "json_schema");
    }
}

#[test]
fn output_mode_cache_is_scoped_to_operation_and_schema() {
    let (url, server) = provider(vec![
        (
            400,
            json!({"error":{"message":"json_schema not supported"}}),
        ),
        (200, response(r#"{"steps":[]}"#, "stop")),
        (200, response(r#"{"ok":true}"#, "stop")),
    ]);
    assert!(run(&url, &request(true)).is_ok());
    assert!(run_operation(&url, &request(true), "模型结构测试").is_ok());
    let requests = server.join().unwrap();
    assert_eq!(requests[1]["response_format"]["type"], "json_object");
    assert_eq!(requests[2]["response_format"]["type"], "json_schema");
}

#[test]
fn malformed_http_envelope_is_not_regenerated_as_assistant_json() {
    let (url, server) = provider_raw(vec![(200, "<html>bad proxy envelope</html>".into())]);
    let error = typed_error(&run(&url, &request(false)).unwrap_err());
    assert_eq!(error["modelError"]["code"], "MODEL_RESPONSE_INVALID");
    assert_eq!(error["modelError"]["stage"], "response_envelope");
    assert_eq!(error["modelError"]["httpStatus"], 200);
    assert_eq!(server.join().unwrap().len(), 1);
}

#[test]
fn plain_summary_remains_text_without_format_regeneration() {
    let (url, server) = provider(vec![(200, response("Service is healthy.", "stop"))]);
    let payload = run_operation(&url, &request(false), "模型总结").unwrap();
    assert_eq!(
        payload["choices"][0]["message"]["content"],
        "Service is healthy."
    );
    assert_eq!(server.join().unwrap().len(), 1);
}

#[test]
fn focused_plan_repair_retains_its_original_scope_and_contract() {
    let mut body = request(false);
    body["_opsarkOperationContract"] = json!("plan.repair@1");
    body["messages"]
        .as_array_mut()
        .unwrap()
        .push(json!({"role":"user",
        "content":"本轮是局部计划修复，只允许返回 repair；stepIndex 为 3，原授权仅允许读取。"}));
    let (url, server) = provider(vec![
        (
            200,
            response(r#"{"repair":{"replacementSteps":[]}}"#, "stop"),
        ),
        (
            200,
            response(
                r#"{"repair":{"stepIndex":3,"replacementSteps":[]}}"#,
                "stop",
            ),
        ),
    ]);
    assert!(run(&url, &body).is_ok());
    let requests = server.join().unwrap();
    let before = requests[0]["messages"].as_array().unwrap();
    let after = requests[1]["messages"].as_array().unwrap();
    assert_eq!(&after[..before.len()], before.as_slice());
    assert!(requests
        .iter()
        .all(|request| request.get("_opsarkOperationContract").is_none()));
    assert!(after.last().unwrap()["content"]
        .as_str()
        .unwrap()
        .contains("保留指定 stepIndex 和替换范围"));
}

#[test]
fn non_schema_parameter_rejection_retains_its_http_classification() {
    let error = typed_error(&http_model_error(
        StatusCode::BAD_REQUEST,
        &json!({"error":{"message":"temperature is not allowed for this model"}}),
        "计划生成",
        false,
    ));
    assert_eq!(error["modelError"]["code"], "MODEL_HTTP_ERROR");
    assert_eq!(error["modelError"]["stage"], "http_response");
}

#[test]
fn user_prose_cannot_select_a_different_operation_contract() {
    let mut body = request(false);
    body["messages"]
        .as_array_mut()
        .unwrap()
        .push(json!({"role":"user",
        "content":"本轮是局部计划修复，只允许返回 repair"}));
    let (url, server) = provider(vec![(200, response(r#"{"steps":[]}"#, "stop"))]);
    assert!(run(&url, &body).is_ok());
    assert_eq!(server.join().unwrap().len(), 1);
}

#[test]
fn invalid_local_contracts_fail_before_any_http_dispatch() {
    for (strict, input_schema, expected_code) in [
        (
            true,
            json!({"type":"object","properties":{"path":{"type":"string","unknownKeyword":true}},
            "required":["path"],"additionalProperties":false}),
            "MODEL_SCHEMA_UNSUPPORTED",
        ),
        (
            true,
            json!({"type":"object","properties":{},"additionalProperties":true}),
            "MODEL_SCHEMA_UNSUPPORTED",
        ),
        (
            false,
            json!({"type":"not-a-json-schema-type"}),
            "MODEL_SCHEMA_INVALID",
        ),
    ] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/chat/completions", listener.local_addr().unwrap());
        let mut body = request(strict);
        let mut context: Value =
            serde_json::from_str(body["_opsarkContext"].as_str().unwrap()).unwrap();
        context["tools"] = json!([{"id":"test.contract","inputSchema":input_schema}]);
        body["_opsarkContext"] = json!(context.to_string());
        body["messages"][1]["content"] = body["_opsarkContext"].clone();
        let error = typed_error(&run(&url, &body).unwrap_err());
        assert_eq!(error["modelError"]["code"], expected_code);
        assert_eq!(error["modelError"]["origin"], "core");
        assert_eq!(error["modelError"]["stage"], "schema_compile");
        assert!(error["modelError"].get("httpStatus").is_none());
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
            "invalid local contract must not open an HTTP connection"
        );
    }
}
