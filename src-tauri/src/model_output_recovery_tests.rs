//! Exercise the real Core request and business-repair chain against local HTTP only.
use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

fn provider(
    responses: Vec<(u16, Value)>,
) -> (String, std::thread::JoinHandle<(Vec<Value>, TcpListener)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
        let mut requests = vec![];
        for (status, response) in responses {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "expected model request missing");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = vec![];
            loop {
                let mut chunk = [0; 4096];
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        let body: Value =
                            serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
                        assert!(!body.to_string().contains("_modelRecovery"));
                        assert!(!body.to_string().contains("_modelOutputRecovery"));
                        let key = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("idempotency-key:"))
                            .unwrap()
                            .trim()
                            .to_owned();
                        requests.push(json!({"key":key,"body":body}));
                        break;
                    }
                }
            }
            let response = response.to_string();
            write!(socket,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).unwrap();
        }
        (requests, listener)
    });
    (endpoint, thread)
}

fn context(generations: u64, strict: bool) -> String {
    let mut context: Value =
        serde_json::from_str(&model_budget::ensure_context("{}").unwrap()).unwrap();
    context["_modelRecovery"]["maxGenerations"] = json!(generations);
    context["_modelCapabilities"] = json!({"protocol":"chat_completions","version":"budget-tests",
        "structuredOutput":if strict {"json_schema"} else {"json_object"},"parameterAdapter":"portable",
        "tokenField":"max_tokens","defaultOutputTokens":5000,"maxOutputTokens":10000});
    context.to_string()
}

fn response(content: &str) -> Value {
    json!({"choices":[{"finish_reason":"stop","message":{"content":content}}],
        "usage":{"prompt_tokens":40,"completion_tokens":60,"total_tokens":100}})
}

fn error(value: String) -> Value {
    serde_json::from_str::<Value>(value.strip_prefix(MODEL_TRACE_ERROR_PREFIX).unwrap()).unwrap()
        ["modelError"]
        .clone()
}

fn request(generations: u64, strict: bool) -> Value {
    let mut context: Value = serde_json::from_str(&context(generations, strict)).unwrap();
    context["_modelOutputRecovery"] = json!({"strategy":"initial"});
    json!({"_opsarkContext":context.to_string(),"model":"test","max_tokens":5000,
        "messages":[{"role":"system","content":"Return JSON with steps"},
            {"role":"user","content":context.to_string()}]})
}

fn strategy(body: &Value, strategy: &str) -> Value {
    let mut body = body.clone();
    let mut context: Value =
        serde_json::from_str(body["_opsarkContext"].as_str().unwrap()).unwrap();
    context["_modelOutputRecovery"] = json!({"strategy":strategy});
    body["_opsarkContext"] = json!(context.to_string());
    body["messages"][1]["content"] = json!(context.to_string());
    body
}

fn run(endpoint: &str, body: &Value) -> Result<Value, String> {
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(post_model_request(
            &format!("{endpoint}/chat/completions"),
            "fake-key",
            body,
            "计划生成",
            5,
            None,
        ))
}

fn plan() -> Value {
    json!({"steps":[{"kind":"change","title":"Build","description":"Build app",
        "action":{"type":"shell","command":"npm run build"},"expected":"Build output",
        "validation":"test -f dist/index.html","risk":"medium"}]})
}

#[test]
fn malformed_or_truncated_initial_is_returned_before_normal_candidate_regeneration() {
    for truncated in [false, true] {
        let mut first = response("{");
        if truncated {
            first["choices"][0]["finish_reason"] = json!("length");
        }
        let (endpoint, server) = provider(vec![(200, first), (200, response(&plan().to_string()))]);
        let body = request(3, false);
        let failure = error(run(&endpoint, &body).unwrap_err());
        assert_eq!(
            failure["code"],
            if truncated {
                "MODEL_OUTPUT_TRUNCATED"
            } else {
                "MODEL_FORMAT_INVALID"
            }
        );
        assert_eq!(failure["recoveryBudget"]["generations"], 1);
        assert_eq!(failure["recoveryBudget"]["fieldRepairs"], 0);
        let payload = run(&endpoint, &strategy(&body, "regenerate")).unwrap();
        let generated: Value = serde_json::from_str(
            payload["choices"][0]["message"]["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(generated, plan()); // Change candidates remain subject to normal business/approval checks.
        let (requests, _) = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0]["body"]["messages"],
            requests[1]["body"]["messages"]
        );
        assert_ne!(requests[0]["key"], requests[1]["key"]);
    }
}

#[test]
fn failed_field_repair_escalates_once_and_the_shared_slot_cannot_be_reused() {
    let mut invalid = plan();
    invalid["steps"][0]["risk"] = json!("invalid-risk");
    let (endpoint, server) = provider(vec![
        (200, response(&invalid.to_string())),
        (200, response(r#"{"value":"still-invalid"}"#)),
        (200, response(&plan().to_string())),
    ]);
    let body = request(6, false);
    let failure = error(run(&endpoint, &body).unwrap_err());
    assert_eq!(failure["recoveryBudget"]["generations"], 2);
    assert_eq!(failure["recoveryBudget"]["fieldRepairs"], 1);
    let exhausted = error(run(&endpoint, &strategy(&body, "field_repair")).unwrap_err());
    assert_eq!(exhausted["code"], "MODEL_OUTPUT_REPAIR_EXHAUSTED");
    assert_eq!(exhausted["stage"], "output_recovery");
    assert_eq!(exhausted["modelOperationId"], failure["modelOperationId"]);
    run(&endpoint, &strategy(&body, "regenerate")).unwrap();
    let exhausted = error(run(&endpoint, &strategy(&body, "regenerate")).unwrap_err());
    assert_eq!(exhausted["code"], "MODEL_RECOVERY_BUDGET_EXHAUSTED");
    assert_eq!(exhausted["recoveryBudget"]["generations"], 3);
    assert_eq!(exhausted["recoveryBudget"]["candidateRegenerations"], 1);
    assert_eq!(server.join().unwrap().0.len(), 3);
}

#[test]
fn frontend_field_strategy_never_falls_back_to_a_hidden_syntax_retry() {
    let (endpoint, server) = provider(vec![
        (200, response("{")),
        (200, response(&plan().to_string())),
    ]);
    let body = request(6, false);
    let rejected = error(run(&endpoint, &strategy(&body, "field_repair")).unwrap_err());
    assert_eq!(rejected["code"], "MODEL_FORMAT_INVALID");
    assert_eq!(rejected["recoveryBudget"]["generations"], 1);
    assert_eq!(rejected["recoveryBudget"]["fieldRepairs"], 1);
    run(&endpoint, &strategy(&body, "regenerate")).unwrap();
    assert_eq!(server.join().unwrap().0.len(), 2);
}

#[test]
fn fenced_candidate_keeps_a_trustworthy_field_boundary_for_one_correction() {
    let mut invalid = plan();
    invalid["steps"][0]["risk"] = json!("invalid-risk");
    let fenced = format!("```json\n{invalid}\n```");
    let (endpoint, server) = provider(vec![
        (200, response(&fenced)),
        (200, response(r#"{"value":"medium"}"#)),
    ]);
    let body = request(3, false);
    let result = run(&endpoint, &body).unwrap();
    let actual: Value = serde_json::from_str(result["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
    assert_eq!(actual, plan());
    let (requests, _) = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    let feedback = requests[1]["body"]["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap();
    assert!(feedback.contains("/steps/0/risk"));
    assert!(!feedback.contains("json_parse"));
}

#[test]
fn last_generation_is_reserved_for_candidate_and_regeneration_has_no_nested_repair() {
    let mut invalid = plan();
    invalid["steps"][0]["risk"] = json!("invalid-risk");
    let (endpoint, server) = provider(vec![
        (200, response(&invalid.to_string())),
        (200, response(&invalid.to_string())),
    ]);
    let body = request(2, false);
    let initial = error(run(&endpoint, &body).unwrap_err());
    assert_eq!(initial["recoveryBudget"]["generations"], 1);
    assert_eq!(initial["recoveryBudget"]["fieldRepairs"], 0);
    let final_error = error(run(&endpoint, &strategy(&body, "regenerate")).unwrap_err());
    assert_eq!(final_error["code"], "MODEL_FORMAT_INVALID");
    assert_eq!(final_error["recoveryBudget"]["generations"], 2);
    assert_eq!(final_error["recoveryBudget"]["fieldRepairs"], 0);
    assert_eq!(server.join().unwrap().0.len(), 2);
}

#[test]
fn schema_downgrade_uses_total_budget_and_cannot_replenish_candidate_budget() {
    let (endpoint, server) = provider(vec![
        (
            400,
            json!({"error":{"message":"response_format json_schema is unavailable now"}}),
        ),
        (200, response("{")),
    ]);
    let body = request(2, true);
    let initial = error(run(&endpoint, &body).unwrap_err());
    assert_eq!(initial["code"], "MODEL_FORMAT_INVALID");
    assert_eq!(initial["recoveryBudget"]["generations"], 2);
    let exhausted = error(run(&endpoint, &strategy(&body, "regenerate")).unwrap_err());
    assert_eq!(exhausted["code"], "MODEL_RECOVERY_BUDGET_EXHAUSTED");
    assert_eq!(exhausted["recoveryBudget"]["candidateRegenerations"], 0);
    let (requests, _) = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0]["body"]["response_format"]["type"],
        "json_schema"
    );
    assert_eq!(
        requests[1]["body"]["response_format"]["type"],
        "json_object"
    );
}

#[test]
fn candidate_schema_downgrade_claims_the_strategy_slot_only_once() {
    let (endpoint, server) = provider(vec![
        (200, response("{")),
        (400, json!({"error":{"message":"response_format json_schema is unavailable now"}})),
        (200, response(&plan().to_string())),
    ]);
    let body = request(3, true);
    assert_eq!(error(run(&endpoint, &body).unwrap_err())["code"], "MODEL_FORMAT_INVALID");
    run(&endpoint, &strategy(&body, "regenerate")).unwrap();
    let exhausted = error(run(&endpoint, &strategy(&body, "regenerate")).unwrap_err());
    assert_eq!(exhausted["recoveryBudget"]["candidateRegenerations"], 1);
    assert_eq!(exhausted["recoveryBudget"]["generations"], 3);
    assert_eq!(server.join().unwrap().0.len(), 3);
}

#[test]
fn local_repair_context_cannot_authorize_a_full_candidate() {
    let mut body = strategy(&request(6, false), "regenerate");
    let mut context: Value =
        serde_json::from_str(body["_opsarkContext"].as_str().unwrap()).unwrap();
    context["workflowPhase"] = json!("protocol_repair");
    body["_opsarkContext"] = json!(context.to_string());
    let failure = error(run("http://127.0.0.1:1", &body).unwrap_err());
    assert_eq!(failure["code"], "MODEL_RECOVERY_SCOPE_REJECTED");
}

#[test]
fn uncertain_dispatch_blocks_candidate_strategy_without_another_request() {
    let (endpoint, server) = provider(vec![(503, json!({"error":{"message":"busy"}}))]);
    let body = request(6, false);
    let original = error(run(&endpoint, &body).unwrap_err());
    assert_eq!(original["code"], "MODEL_DISPATCH_UNKNOWN");
    let rejected = error(run(&endpoint, &strategy(&body, "regenerate")).unwrap_err());
    assert_eq!(rejected["code"], "MODEL_RECOVERY_BUDGET_EXHAUSTED");
    assert_eq!(rejected["recoveryBudget"]["recoveryBlocked"], true);
    assert_eq!(rejected["recoveryBudget"]["candidateRegenerations"], 0);
    assert_eq!(rejected["recoveryBudget"]["generations"], 1);
    assert_eq!(server.join().unwrap().0.len(), 1);
}

#[test]
fn coordinated_business_validation_does_not_start_the_legacy_plan_repair_loop() {
    let mut invalid = plan();
    invalid["steps"][0]["action"]["command"] = json!("npm run build | tail -20");
    let (endpoint, server) = provider(vec![(200, response(&invalid.to_string()))]);
    let body = request(6, false);
    let failure = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(generate_ai_plan_with_trace(
            "fake-key".into(),
            endpoint,
            "test".into(),
            "Build app".into(),
            body["_opsarkContext"].as_str().unwrap().into(),
            None,
            5,
            &mut ModelDeveloperTrace::default(),
            None,
        ))
        .unwrap_err();
    let failure: Value = serde_json::from_str(&failure).unwrap();
    assert!(failure.get("issue").is_some() || failure["kind"] == "plan_protocol_failure");
    assert!(failure.get("steps").is_some());
    assert!(failure.get("repairStopCode").is_none());
    assert_eq!(server.join().unwrap().0.len(), 1);
}
