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

#[test]
fn format_repair_and_next_invoke_share_budget_and_distinct_generation_ids() {
    let (endpoint, server) = provider(vec![(200, response("{")), (200, response("{"))]);
    let body = json!({"_opsarkContext":context(2,false),"model":"test","max_tokens":5000,
        "messages":[{"role":"system","content":"Return JSON"}]});
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let url = format!("{endpoint}/chat/completions");
    let first = runtime
        .block_on(post_model_request(
            &url,
            "fake-key",
            &body,
            "计划生成",
            5,
            None,
        ))
        .unwrap_err();
    assert_eq!(error(first)["code"], "MODEL_FORMAT_INVALID");
    let next = error(
        runtime
            .block_on(post_model_request(
                &url,
                "fake-key",
                &body,
                "计划生成",
                5,
                None,
            ))
            .unwrap_err(),
    );
    assert_eq!(next["code"], "MODEL_RECOVERY_BUDGET_EXHAUSTED");
    assert_eq!(next["recoveryBudget"]["generations"], 2);
    assert_eq!(next["recoveryBudget"]["knownUsageTokens"], 200);
    let (requests, listener) = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert_ne!(requests[0]["key"], requests[1]["key"]);
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn schema_downgrade_cannot_reset_budget_before_format_regeneration() {
    let (endpoint, server) = provider(vec![
        (
            400,
            json!({"error":{"message":"response_format json_schema is unavailable now"}}),
        ),
        (200, response("{")),
    ]);
    let body = json!({"_opsarkContext":context(2,true),"model":"test","max_tokens":5000,
        "messages":[{"role":"system","content":"Return JSON"}]});
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let failure = error(
        runtime
            .block_on(post_model_request(
                &format!("{endpoint}/chat/completions"),
                "fake-key",
                &body,
                "计划生成",
                5,
                None,
            ))
            .unwrap_err(),
    );
    assert_eq!(failure["code"], "MODEL_RECOVERY_BUDGET_EXHAUSTED");
    assert_eq!(failure["recoveryBudget"]["transportAttempts"], 2);
    let (requests, listener) = server.join().unwrap();
    assert_eq!(
        requests[0]["body"]["response_format"]["type"],
        "json_schema"
    );
    assert_eq!(
        requests[1]["body"]["response_format"]["type"],
        "json_object"
    );
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn semantic_plan_repair_uses_the_original_operation_budget() {
    let plan = json!({"steps":[{"kind":"change","title":"Build","description":"Build app",
        "action":{"type":"shell","command":"npm run build | tail -20"},"expected":"Build output",
        "validation":"test -f dist/index.html","risk":"medium"}]})
    .to_string();
    let (endpoint, server) = provider(vec![(200, response(&plan))]);
    let mut trace = ModelDeveloperTrace::default();
    let failure = error(
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(generate_ai_plan_with_trace(
                "fake-key".into(),
                endpoint,
                "test".into(),
                "Build app".into(),
                context(1, false),
                None,
                5,
                &mut trace,
                None,
            ))
            .unwrap_err(),
    );
    assert_eq!(failure["code"], "MODEL_RECOVERY_BUDGET_EXHAUSTED");
    assert_eq!(failure["recoveryBudget"]["generations"], 1);
    let (requests, listener) = server.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}
