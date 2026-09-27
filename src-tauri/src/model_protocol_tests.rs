//! Offline protocol regression tests; the only HTTP destination is loopback.
use super::*;
use std::io::{Read, Write};

fn capabilities(protocol: &str) -> Value {
    json!({"version":"model-capabilities@2","revision":"test-v2","supportedProtocols":[protocol],"preferredProtocol":protocol,
        "outputModes":{"json_object":"supported","json_schema":"supported"},"parameterAdapter":"openai",
        "tokenField":if protocol=="responses" {"max_output_tokens"} else {"max_completion_tokens"},"defaultOutputTokens":5000,"maxOutputTokens":16000,
        "budgetSemantics":"total_output","strictFlag":"required","store":"supported",
        "parameterRules":{"reasoningEfforts":["none","low","medium","high","xhigh"],"thinkingEnabled":false,"frequencyPenalty":false,"temperature":"supported","topP":"supported","presencePenalty":"unsupported"},
        "evidence":{"source":"user_declared"}})
}
fn request(protocol: &str, policy: &str) -> Value {
    let context=json!({"evidence":"real business evidence","_modelIntegration":{"apiProtocol":protocol,"outputPolicy":policy,"capabilitiesV2":capabilities(protocol)},"_requestParameters":{"outputBudget":1000}}).to_string();
    json!({"model":"offline-model","messages":[{"role":"system","content":"Return JSON, never execute any command."},{"role":"user","content":format!("服务器上下文：\n{context}")}],"max_tokens":5000,"_opsarkContext":context})
}
fn with_context(mut body: Value, update: impl FnOnce(&mut Value)) -> Value {
    let mut context: Value =
        serde_json::from_str(body["_opsarkContext"].as_str().unwrap()).unwrap();
    let old = context.to_string();
    update(&mut context);
    let new = context.to_string();
    for message in body["messages"].as_array_mut().unwrap() {
        if let Some(text) = message["content"].as_str() {
            message["content"] = json!(text.replace(&old, &new));
        }
    }
    body["_opsarkContext"] = json!(new);
    body
}
fn completed(text: &str) -> Value {
    json!({"id":"resp_offline","status":"completed","output":[{"type":"reasoning","summary":[]},{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":text}]}],
        "usage":{"input_tokens":20,"output_tokens":30,"total_tokens":50,"input_tokens_details":{"cached_tokens":5},"output_tokens_details":{"reasoning_tokens":10}}})
}
fn server(responses: Vec<(u16, Value)>) -> (String, std::thread::JoinHandle<Vec<(String, Value)>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, response) in responses {
            let deadline = Instant::now() + Duration::from_secs(4);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "expected model request");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
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
                if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_string();
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        requests.push((
                            header,
                            serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap(),
                        ));
                        break;
                    }
                }
            }
            let response = response.to_string();
            write!(socket,"HTTP/1.1 {status} Offline\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).unwrap();
        }
        requests
    });
    (endpoint, server)
}
fn run(endpoint: &str, body: &Value) -> Result<Value, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(post_model_request(
            &format!("{endpoint}/chat/completions"),
            "offline-key",
            body,
            "模型结构测试",
            5,
            None,
        ))
}
fn error_code(error: &str) -> String {
    serde_json::from_str::<Value>(
        error
            .strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX)
            .expect(error),
    )
    .unwrap()["modelError"]["code"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn protocol_preview_is_exact_wire_and_strips_private_metadata() {
    for protocol in ["chat_completions", "responses"] {
        let body = request(protocol, "require_schema");
        let response = if protocol == "responses" {
            completed("{\"ok\":true}")
        } else {
            json!({"choices":[{"message":{"content":"{\"ok\":true}"},"finish_reason":"stop"}]})
        };
        let (endpoint, provider) = server(vec![(200, response)]);
        let preview = preview_model_request(&endpoint, &body, "模型结构测试", false).unwrap();
        let payload = run(&endpoint, &body).unwrap();
        assert_eq!(
            message_content(&payload, "missing").unwrap(),
            "{\"ok\":true}"
        );
        let requests = provider.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(preview["request"], requests[0].1);
        assert!(requests[0].0.starts_with(&format!(
            "POST /v1/{} HTTP/1.1",
            if protocol == "responses" {
                "responses"
            } else {
                "chat/completions"
            }
        )));
        let wire = &requests[0].1;
        let serialized = wire.to_string();
        assert!(!serialized.contains("_modelIntegration"));
        assert!(!serialized.contains("_opsark"));
        assert!(!serialized.contains("_requestParameters"));
        assert!(serialized.contains("real business evidence"));
        assert_eq!(wire["stream"], false);
        assert_eq!(wire["store"], false);
        if protocol == "responses" {
            assert!(wire.get("messages").is_none());
            assert!(wire.get("response_format").is_none());
            assert_eq!(wire["max_output_tokens"], 64);
            assert_eq!(wire["text"]["format"]["type"], "json_schema");
            assert_eq!(wire["text"]["format"]["strict"], true);
        } else {
            assert!(wire.get("input").is_none());
            assert_eq!(wire["max_completion_tokens"], 64);
            assert_eq!(wire["response_format"]["type"], "json_schema");
        }
    }
}
#[test]
fn endpoint_preserves_custom_roots_and_recognizes_full_paths() {
    for original in [
        "https://example.test/custom/v2",
        "https://example.test/custom/v2/responses",
        "https://example.test/custom/v2/chat/completions",
        "https://example.test/custom/v2/responses/chat/completions",
    ] {
        assert_eq!(
            crate::model_protocol::endpoint(original, "responses").unwrap(),
            "https://example.test/custom/v2/responses"
        );
    }
    for original in [
        "https://secret@example.test/v1",
        "https://example.test/v1?key=secret",
        "https://example.test/v1#secret",
        "file:///tmp/api",
    ] {
        assert!(crate::model_protocol::endpoint(original, "responses").is_err());
    }
}
#[test]
fn explicit_policy_unknown_capabilities_and_parameters_fail_before_network() {
    let cases = vec![
        with_context(request("responses", "require_schema"), |c| {
            c["_modelIntegration"]["capabilitiesV2"]["outputModes"]["json_schema"] =
                json!("unknown")
        }),
        with_context(request("responses", "auto"), |c| {
            c["_modelIntegration"]["capabilitiesV2"]["outputModes"] =
                json!({"json_object":"unknown","json_schema":"unknown"});
        }),
        with_context(request("responses", "auto"), |c| {
            c["_modelIntegration"]["capabilitiesV2"]["supportedProtocols"] =
                json!(["chat_completions"])
        }),
        with_context(request("responses", "auto"), |c| {
            c["_requestParameters"] = json!({"max_tokens":20})
        }),
        with_context(request("responses", "auto"), |c| {
            c["_requestParameters"] = json!({"outputBudget":20,"max_output_tokens":20})
        }),
        with_context(request("responses", "auto"), |c| {
            c["_requestParameters"] = json!({"reasoning_effort":"invented"})
        }),
        with_context(request("responses", "auto"), |c| {
            c["_requestParameters"] = json!({"presence_penalty":0.5})
        }),
    ];
    for body in cases {
        let error = preview_model_request("https://example.test/v1", &body, "模型结构测试", false)
            .unwrap_err();
        assert!(
            matches!(
                error_code(&error).as_str(),
                "MODEL_CAPABILITY_UNKNOWN"
                    | "MODEL_CAPABILITY_INVALID"
                    | "MODEL_PARAMETER_UNSUPPORTED"
            ),
            "{error}"
        );
    }
}
#[test]
fn response_reasoning_budget_and_optional_flags_follow_capabilities() {
    let body = with_context(request("responses", "json_only"), |c| {
        c["_requestParameters"] =
            json!({"outputBudget":1200,"reasoning_effort":"xhigh","temperature":0.4});
        c["_modelIntegration"]["capabilitiesV2"]["store"] = json!("unknown");
    });
    let preview =
        preview_model_request("https://example.test/v1", &body, "计划生成", false).unwrap();
    let wire = &preview["request"];
    assert_eq!(wire["max_output_tokens"], 1200);
    assert_eq!(wire["reasoning"]["effort"], "xhigh");
    assert_eq!(wire["temperature"], 0.4);
    assert_eq!(wire["text"]["format"]["type"], "json_object");
    assert!(wire.get("store").is_none());
    assert!(wire.get("reasoning_effort").is_none());
    let body = with_context(request("responses", "require_schema"), |c| {
        c["_modelIntegration"]["capabilitiesV2"]["strictFlag"] = json!("unsupported")
    });
    let preview =
        preview_model_request("https://example.test/v1", &body, "模型结构测试", false).unwrap();
    assert!(preview["request"]["text"]["format"].get("strict").is_none());
}
#[test]
fn response_noncompletion_is_not_format_repair() {
    let cases = vec![
        (json!({"status":"queued"}), "MODEL_OUTPUT_PENDING"),
        (json!({"status":"in_progress"}), "MODEL_OUTPUT_PENDING"),
        (
            json!({"status":"failed","error":{"code":"server_error"}}),
            "MODEL_PROVIDER_FAILED",
        ),
        (json!({"status":"cancelled"}), "MODEL_OUTPUT_CANCELLED"),
        (
            json!({"status":"incomplete","incomplete_details":{"reason":"content_filter"}}),
            "MODEL_CONTENT_FILTERED",
        ),
        (
            json!({"status":"incomplete","incomplete_details":{"reason":"new_reason"}}),
            "MODEL_OUTPUT_INCOMPLETE",
        ),
        (
            json!({"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"no"}]}]}),
            "MODEL_OUTPUT_REFUSED",
        ),
        (
            json!({"status":"completed","output":[{"type":"function_call","call_id":"x","name":"dangerous","arguments":"{}"}]}),
            "MODEL_TOOL_CALL_UNEXPECTED",
        ),
        (
            json!({"status":"completed","output":[{"type":"unknown_item"}]}),
            "MODEL_OUTPUT_ITEM_UNSUPPORTED",
        ),
        (
            json!({"status":"completed","output":[]}),
            "MODEL_RESPONSE_INVALID",
        ),
    ];
    for (payload, code) in cases {
        let (endpoint, provider) = server(vec![(200, payload)]);
        let error = run(&endpoint, &request("responses", "json_only")).unwrap_err();
        assert_eq!(error_code(&error), code, "{error}");
        assert_eq!(provider.join().unwrap().len(), 1);
    }
}
#[test]
fn response_single_document_parts_are_combined_but_messages_are_not() {
    let mut payload = completed("unused");
    payload["output"][1]["content"] =
        json!([{"type":"output_text","text":"{\"ok\":"},{"type":"output_text","text":"true}"}]);
    crate::model_protocol::normalize_response(&mut payload, "responses").unwrap();
    assert_eq!(
        message_content(&payload, "missing").unwrap(),
        "{\"ok\":true}"
    );
    let mut payload = completed("{}");
    let second = payload["output"][1].clone();
    payload["output"].as_array_mut().unwrap().push(second);
    assert_eq!(
        crate::model_protocol::normalize_response(&mut payload, "responses")
            .unwrap_err()
            .code,
        "MODEL_RESPONSE_INVALID"
    );
}
#[test]
fn response_truncation_and_invalid_json_have_one_bounded_regeneration() {
    for first in [
        json!({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}),
        completed("not JSON"),
    ] {
        let (endpoint, provider) = server(vec![(200, first), (200, completed("{\"ok\":true}"))]);
        run(&endpoint, &request("responses", "json_only")).unwrap();
        let requests = provider.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].1["max_output_tokens"],
            requests[1].1["max_output_tokens"]
        );
        assert!(
            requests[1].1["input"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap()
                .contains("恢复类型")
        );
    }
}
#[test]
fn require_schema_never_silently_downgrades_on_provider_rejection() {
    let (endpoint, provider) = server(vec![(
        400,
        json!({"error":{"message":"response_format json_schema is not supported","code":"unsupported_response_format"}}),
    )]);
    assert!(run(&endpoint, &request("responses", "require_schema")).is_err());
    let requests = provider.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].1["text"]["format"]["type"], "json_schema");
}
#[test]
fn shared_raw_protocol_fixtures_agree_with_core_boundary() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../contracts/model-api/protocol-cases.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let mut payload = case["payload"].clone();
        let result = crate::model_protocol::normalize_response(
            &mut payload,
            case["apiProtocol"].as_str().unwrap(),
        )
        .and_then(|_| response_outcome(&payload));
        match case["expectedCode"].as_str() {
            Some("MODEL_OUTPUT_TRUNCATED") => assert_eq!(result.unwrap(), true, "{}", case["id"]),
            Some(code) => assert_eq!(result.unwrap_err().code, code, "{}", case["id"]),
            None => {
                assert_eq!(result.unwrap(), false, "{}", case["id"]);
                assert_eq!(
                    message_content(&payload, "missing").unwrap(),
                    case["expectedText"].as_str().unwrap(),
                    "{}",
                    case["id"]
                );
            }
        }
    }
}
#[test]
fn auto_downgrade_requires_json_capability_and_keeps_protocol() {
    let error = json!({"error":{"message":"json_schema response format is not supported","code":"unsupported_response_format"}});
    let (endpoint, provider) = server(vec![
        (400, error.clone()),
        (200, completed("{\"ok\":true}")),
    ]);
    run(&endpoint, &request("responses", "auto")).unwrap();
    let requests = provider.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].1["text"]["format"]["type"], "json_schema");
    assert_eq!(requests[1].1["text"]["format"]["type"], "json_object");
    let body = with_context(request("responses", "auto"), |c| {
        c["_modelIntegration"]["capabilitiesV2"]["outputModes"]["json_object"] = json!("unknown")
    });
    let (endpoint, provider) = server(vec![(400, error)]);
    assert!(run(&endpoint, &body).is_err());
    assert_eq!(provider.join().unwrap().len(), 1);
}
#[test]
fn native_tool_schema_support_does_not_enable_output_schema() {
    let body = with_context(request("responses", "require_schema"), |c| {
        c["_modelIntegration"]["capabilitiesV2"]["outputModes"]["json_schema"] = json!("unknown");
        c["_modelIntegration"]["capabilitiesV2"]["nativeTools"] =
            json!({"supported":true,"strictFlag":"required"});
    });
    assert_eq!(
        error_code(
            &preview_model_request("https://example.test/v1", &body, "计划生成", false)
                .unwrap_err()
        ),
        "MODEL_CAPABILITY_UNKNOWN"
    );
}
#[test]
fn capability_projection_discards_unrecognized_gateway_metadata() {
    let mut caps = capabilities("responses");
    caps["apiKey"] = json!("private-secret");
    caps["parameterRules"]["password"] = json!("private-secret");
    caps["evidence"]["rawBody"] = json!("private-secret");
    let public = crate::model_protocol::public_capabilities(&caps).unwrap();
    assert!(!public.to_string().contains("private-secret"));
    assert_eq!(public["preferredProtocol"], "responses");
    caps["version"] = json!("future-version");
    assert!(crate::model_protocol::public_capabilities(&caps).is_none());
}

#[test]
fn probes_share_one_builder_and_business_probe_is_bounded_and_read_only() {
    for protocol in ["chat_completions", "responses"] {
        for mode in ["parameters", "structured", "business"] {
            let integration = json!({"apiProtocol":protocol,"outputPolicy":"auto","capabilitiesV2":capabilities(protocol)});
            let (body, operation) = probe_body(
                "offline-model",
                mode,
                Some(json!({"outputBudget":9000})),
                None,
                Some(integration),
            )
            .unwrap();
            let preview =
                preview_model_request("https://example.test/v1", &body, operation, false).unwrap();
            let wire = &preview["request"];
            assert_eq!(
                wire[if protocol == "responses" {
                    "max_output_tokens"
                } else {
                    "max_completion_tokens"
                }],
                if mode == "business" { 1200 } else { 64 }
            );
            if mode == "business" {
                assert!(wire.to_string().contains("pwd"));
                assert_eq!(
                    preview["schemaCompilation"]["contractVersion"],
                    "model.business-probe@1"
                );
            }
            if mode == "parameters" {
                assert_eq!(preview["effectiveOutputMode"], "text");
            }
        }
    }
}

#[test]
fn automatic_compilation_fallback_requires_known_local_schema_and_explicit_v2_json_support() {
    let local_schema = json!({"type":"object","properties":{"choice":{"anyOf":[
        {"type":"object","properties":{"value":{"type":"string"}},"required":[],"additionalProperties":false},
        {"type":"object","properties":{"value":{"type":"null"}},"required":["value"],"additionalProperties":false}
    ]}},"required":["choice"],"additionalProperties":false});
    assert!(crate::model_schema::compile(&local_schema).is_err());
    let body = with_context(request("responses", "auto"), |c| {
        c["tools"] = json!([{"id":"local.test","inputSchema":local_schema}])
    });
    let preview =
        preview_model_request("https://example.test/v1", &body, "计划生成", false).unwrap();
    assert_eq!(preview["effectiveOutputMode"], "json_object");
    assert_eq!(
        preview["schemaCompilation"]["fallback"]["reason"],
        "operation_schema_compile"
    );
    let strict = with_context(body.clone(), |c| {
        c["_modelIntegration"]["outputPolicy"] = json!("require_schema")
    });
    assert_eq!(
        error_code(
            &preview_model_request("https://example.test/v1", &strict, "计划生成", false)
                .unwrap_err()
        ),
        "MODEL_SCHEMA_UNSUPPORTED"
    );
    let typo = with_context(body, |c| {
        c["tools"][0]["inputSchema"]["unknownKeyword"] = json!(true)
    });
    assert_eq!(
        error_code(
            &preview_model_request("https://example.test/v1", &typo, "计划生成", false)
                .unwrap_err()
        ),
        "MODEL_SCHEMA_UNSUPPORTED"
    );
}

#[test]
fn gateway_preflight_codes_and_provider_status_details_survive_without_new_attempts() {
    for code in [
        "CAPABILITY_REVISION_MISMATCH",
        "API_PROTOCOL_MISMATCH",
        "INVALID_API_PROTOCOL",
        "PROTOCOL_PARAMETER_UNSUPPORTED",
        "PARAMETER_SEMANTICS_CONFLICT",
        "PRESET_PROTOCOL_UNSUPPORTED",
    ] {
        let error = http_model_error(
            StatusCode::BAD_REQUEST,
            &json!({"error":{"code":code,"message":"configuration mismatch"}}),
            "模型结构测试",
            true,
        );
        assert_eq!(error_code(&error), code);
    }
    let (endpoint, provider) = server(vec![(
        200,
        json!({"status":"failed","error":{"code":"server_error","message":"private rejected body"}}),
    )]);
    let error = run(&endpoint, &request("responses", "json_only")).unwrap_err();
    let error: Value =
        serde_json::from_str(error.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap()).unwrap();
    assert_eq!(error["modelError"]["rawStatus"], "failed");
    assert_eq!(error["modelError"]["providerCode"], "server_error");
    assert!(!error.to_string().contains("private rejected body"));
    assert_eq!(provider.join().unwrap().len(), 1);
}

fn business_context(protocol: &str, generations: u64) -> String {
    let body = request(protocol, "require_schema");
    let mut context: Value = serde_json::from_str(
        &crate::model_budget::ensure_context(body["_opsarkContext"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    context["_modelRecovery"]["maxGenerations"] = json!(generations);
    context.to_string()
}
fn read_step() -> Value {
    json!({"kind":"observe","title":"Read directory","description":"Read current directory","action":{"type":"shell","command":"pwd"},"expected":"A directory path","validation":"","risk":"low"})
}
fn wire_step(mut step: Value) -> Value {
    for field in [
        "executionScope",
        "validationScope",
        "runtimeClass",
        "sessionContextChange",
        "recovery",
        "retryBasis",
    ] {
        step[field] = Value::Null;
    }
    step
}
fn protocol_response(protocol: &str, content: Value) -> Value {
    if protocol == "responses" {
        completed(&content.to_string())
    } else {
        json!({"choices":[{"finish_reason":"stop","message":{"content":content.to_string()}}],"usage":{"prompt_tokens":20,"completion_tokens":30,"total_tokens":50}})
    }
}
fn strip_step_ids(mut value: Value) -> Value {
    if let Some(array) = value.as_array_mut() {
        for step in array {
            step.as_object_mut().unwrap().remove("id");
        }
    }
    value
}
fn response_body_failure(error: String) -> Value {
    serde_json::from_str::<Value>(
        error
            .strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX)
            .expect(&error),
    )
    .unwrap()["modelError"]
        .clone()
}
#[test]
fn both_protocols_reach_the_actual_plan_consumer_with_equivalent_business_steps() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let mut plans = Vec::new();
    for protocol in ["chat_completions", "responses"] {
        let (endpoint, provider) = server(vec![(
            200,
            protocol_response(protocol, json!({"steps":[wire_step(read_step())]})),
        )]);
        let mut trace = crate::ModelDeveloperTrace::default();
        let plan = runtime
            .block_on(crate::generate_ai_plan_with_trace(
                "offline-key".into(),
                endpoint,
                "offline-model".into(),
                "Read current directory".into(),
                business_context(protocol, 2),
                None,
                5,
                &mut trace,
                None,
            ))
            .unwrap();
        plans.push(strip_step_ids(serde_json::to_value(plan).unwrap()));
        assert_eq!(provider.join().unwrap().len(), 1);
    }
    assert_eq!(plans[0], plans[1]);
    assert_eq!(plans[0][0]["command"], "pwd");
    assert_eq!(plans[0][0]["validation"], "");
}
#[test]
fn focused_semantic_plan_repair_keeps_responses_schema_and_original_budget() {
    let invalid = json!({"kind":"change","title":"Build","description":"Build app","action":{"type":"shell","command":"npm run build | tail -20"},"expected":"Build output","validation":"test -f dist/index.html","risk":"medium"});
    let mut repaired = invalid.clone();
    repaired["action"]["command"] = json!("npm run build");
    let (endpoint, provider) = server(vec![
        (
            200,
            completed(&json!({"steps":[wire_step(invalid)]}).to_string()),
        ),
        (
            200,
            completed(
                &json!({"repair":{"stepIndex":1,"replacementSteps":[wire_step(repaired)]}})
                    .to_string(),
            ),
        ),
    ]);
    let context = business_context("responses", 2);
    let mut trace = crate::ModelDeveloperTrace::default();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let plan = runtime
        .block_on(crate::generate_ai_plan_with_trace(
            "offline-key".into(),
            endpoint.clone(),
            "offline-model".into(),
            "Build app".into(),
            context.clone(),
            None,
            5,
            &mut trace,
            None,
        ))
        .unwrap();
    assert_eq!(plan[0].command, "npm run build");
    let failure = response_body_failure(
        runtime
            .block_on(crate::generate_ai_plan_with_trace(
                "offline-key".into(),
                endpoint,
                "offline-model".into(),
                "Build app".into(),
                context,
                None,
                5,
                &mut trace,
                None,
            ))
            .unwrap_err(),
    );
    assert_eq!(failure["code"], "MODEL_RECOVERY_BUDGET_EXHAUSTED");
    assert_eq!(failure["recoveryBudget"]["generations"], 2);
    assert_eq!(failure["recoveryBudget"]["knownUsageTokens"], 100);
    let requests = provider.join().unwrap();
    assert_eq!(requests.len(), 2);
    for (header, body) in &requests {
        assert!(header.starts_with("POST /v1/responses "));
        assert_eq!(body["text"]["format"]["type"], "json_schema");
        assert!(body.get("messages").is_none());
        assert!(!body.to_string().contains("_modelIntegration"));
    }
    assert!(requests[1].1["text"]["format"]["schema"]["properties"]
        .get("repair")
        .is_some());
    assert_eq!(
        requests[0].1["max_output_tokens"],
        requests[1].1["max_output_tokens"]
    );
}
#[test]
fn compact_stage_repair_keeps_responses_and_uses_the_same_stage_consumer_and_budget() {
    let stage = json!({"decision":"continue","reason":"Need current directory","summary":"Read current directory","steps":[wire_step(read_step())],"planUpdate":null,"reconciliation":null});
    let (endpoint, provider) = server(vec![
        (200, completed(&stage.to_string())),
        (200, completed(&stage.to_string())),
    ]);
    let original = business_context("responses", 2);
    let mut context: Value = serde_json::from_str(&original).unwrap();
    context["protocolReplan"] = json!({"errorCode":"next_stage_response_invalid","rejectedResponse":{"content":"{\"decision\":\"continue\",\"reason\":\"missing steps\",\"summary\":\"needs repair\"}"}});
    let compact_context = context.to_string();
    let settings = crate::AiGenerationSettings::default();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let mut values = Vec::new();
    for context in [&original, &compact_context] {
        let body = crate::build_next_stage_request_body(
            "offline-model",
            "Read current directory",
            context,
            &settings,
        );
        let payload = runtime
            .block_on(post_model_request(
                &format!("{endpoint}/chat/completions"),
                "offline-key",
                &body,
                "阶段联合决策",
                5,
                None,
            ))
            .unwrap();
        let parsed = crate::parse_next_stage_with_format_guard(&payload, context).unwrap();
        let converted =
            crate::validate_next_stage_preserving_recovery(parsed, &settings, None).unwrap();
        let mut value = serde_json::to_value(converted).unwrap();
        value["steps"] = strip_step_ids(value["steps"].clone());
        values.push(value);
    }
    assert_eq!(values[0], values[1]);
    let body = crate::build_next_stage_request_body(
        "offline-model",
        "Read current directory",
        &compact_context,
        &settings,
    );
    let failure = response_body_failure(
        runtime
            .block_on(post_model_request(
                &format!("{endpoint}/chat/completions"),
                "offline-key",
                &body,
                "阶段联合决策",
                5,
                None,
            ))
            .unwrap_err(),
    );
    assert_eq!(failure["code"], "MODEL_RECOVERY_BUDGET_EXHAUSTED");
    assert_eq!(failure["recoveryBudget"]["generations"], 2);
    assert_eq!(failure["recoveryBudget"]["knownUsageTokens"], 100);
    let requests = provider.join().unwrap();
    assert_eq!(requests.len(), 2);
    for (header, body) in requests {
        assert!(header.starts_with("POST /v1/responses "));
        assert_eq!(body["text"]["format"]["type"], "json_schema");
        assert!(!body.to_string().contains("_modelIntegration"));
    }
}
#[test]
fn explicit_business_probe_validates_the_real_plan_consumer_without_execution() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let integration = json!({"apiProtocol":"responses","outputPolicy":"json_only","capabilitiesV2":capabilities("responses")});
    let (endpoint, provider) = server(vec![(
        200,
        completed(&json!({"steps":[read_step()]}).to_string()),
    )]);
    let result = runtime
        .block_on(crate::check_ai_model(
            "offline-key".into(),
            endpoint,
            "offline-model".into(),
            None,
            None,
            Some(integration.clone()),
            Some("business".into()),
            Some(5),
        ))
        .unwrap();
    assert_eq!(result.validation["businessContract"], "passed");
    assert_eq!(provider.join().unwrap().len(), 1);
    let mut duplicate_validation = read_step();
    duplicate_validation["validation"] = json!("pwd");
    let (endpoint, provider) = server(vec![(
        200,
        completed(&json!({"steps":[duplicate_validation]}).to_string()),
    )]);
    let error = runtime
        .block_on(crate::check_ai_model(
            "offline-key".into(),
            endpoint,
            "offline-model".into(),
            None,
            None,
            Some(integration),
            Some("business".into()),
            Some(5),
        ))
        .unwrap_err();
    assert_eq!(error_code(&error), "MODEL_PROBE_CONTRACT_INVALID");
    assert_eq!(provider.join().unwrap().len(), 1);
}

#[test]
fn official_configuration_conflicts_are_not_reclassified_as_uncertain_dispatch() {
    for code in ["CAPABILITY_REVISION_MISMATCH", "API_PROTOCOL_MISMATCH"] {
        let (endpoint, provider) = server(vec![(
            409,
            json!({"error":{"code":code,"message":"refresh the capability catalogue","details":{"origin":"gateway","stage":"request_capability","dispatchCertainty":"not_dispatched"}}}),
        )]);
        let url = format!("{endpoint}/responses");
        let body = request("responses", "require_schema");
        let budget = crate::model_budget::OperationBudget::for_request(
            &url,
            "opsark-account:fixture",
            &body,
            5,
        )
        .unwrap();
        let (prepared, _) =
            crate::model_compatibility::prepare(&body, "模型结构测试", true).unwrap();
        let error = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(send_model_request_authorized(
                &url,
                "opsark-account:fixture",
                "offline-access-token",
                true,
                &prepared,
                "模型结构测试",
                5,
                None,
                &budget,
            ))
            .unwrap_err();
        let failure = response_body_failure(error);
        assert_eq!(failure["code"], code);
        assert_eq!(failure["dispatchCertainty"], "not_dispatched");
        assert_eq!(failure["origin"], "gateway");
        assert_eq!(budget.snapshot()["transportAttempts"], 1);
        assert_eq!(budget.snapshot()["accountedTokens"], 0);
        assert_eq!(budget.snapshot()["recoveryBlocked"], false);
        let requests = provider.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].0.starts_with("POST /v1/responses "));
    }
}

#[test]
fn direct_deepseek_validates_sampling_against_the_effective_thinking_mode() {
    for legacy in [false, true] {
        let configured = |parameters: Value| {
            with_context(request("chat_completions", "auto"), |context| {
                context["_requestParameters"] = parameters;
                if legacy {
                    context.as_object_mut().unwrap().remove("_modelIntegration");
                    context["_modelCapabilities"] = json!({"protocol":"chat_completions","version":"legacy-deepseek","structuredOutput":"json_object","parameterAdapter":"deepseek","tokenField":"max_tokens","defaultOutputTokens":5000,"maxOutputTokens":16000});
                } else {
                    let caps = &mut context["_modelIntegration"]["capabilitiesV2"];
                    caps["parameterAdapter"] = json!("deepseek");
                    caps["tokenField"] = json!("max_tokens");
                    caps["outputModes"]["json_schema"] = json!("unsupported");
                    caps["parameterRules"]["thinkingEnabled"] = json!(true);
                }
            })
        };
        for parameters in [
            json!({"thinking":"enabled","temperature":0.5}),
            json!({"reasoning_effort":"high","temperature":0.5}),
            json!({"reasoning_effort":"high","top_p":0.8}),
        ] {
            let error = preview_model_request(
                "https://example.test/v1",
                &configured(parameters),
                "计划生成",
                false,
            )
            .unwrap_err();
            assert_eq!(error_code(&error), "MODEL_PARAMETER_UNSUPPORTED");
            assert!(error.contains("思考模式"));
        }
        let enabled = preview_model_request(
            "https://example.test/v1",
            &configured(json!({"reasoning_effort":"high"})),
            "计划生成",
            false,
        )
        .unwrap();
        assert_eq!(enabled["request"]["thinking"]["type"], "enabled");
        let disabled = preview_model_request(
            "https://example.test/v1",
            &configured(json!({"thinking":"disabled","temperature":0.5})),
            "计划生成",
            false,
        )
        .unwrap();
        assert_eq!(disabled["request"]["temperature"], 0.5);
        assert!(disabled["request"].get("top_p").is_none());
        let enabled_top_p = preview_model_request(
            "https://example.test/v1",
            &configured(json!({"thinking":"enabled","top_p":0.95})),
            "计划生成",
            false,
        )
        .unwrap();
        assert_eq!(enabled_top_p["request"]["top_p"], 0.95);
        let disabled_top_p = preview_model_request(
            "https://example.test/v1",
            &configured(json!({"thinking":"disabled","top_p":1.0})),
            "计划生成",
            false,
        )
        .unwrap_err();
        assert_eq!(error_code(&disabled_top_p), "MODEL_PARAMETER_UNSUPPORTED");
        let ignored_penalty = preview_model_request(
            "https://example.test/v1",
            &configured(json!({"thinking":"enabled","frequency_penalty":0.5})),
            "计划生成",
            false,
        )
        .unwrap_err();
        assert_eq!(error_code(&ignored_penalty), "MODEL_PARAMETER_UNSUPPORTED");
    }
}

#[test]
fn omitted_api_protocol_uses_the_v2_preference_without_changing_legacy_default() {
    let body = with_context(request("responses", "json_only"), |context| {
        context["_modelIntegration"]
            .as_object_mut()
            .unwrap()
            .remove("apiProtocol");
    });
    let preview =
        preview_model_request("https://example.test/v1", &body, "计划生成", false).unwrap();
    assert_eq!(preview["apiProtocol"], "responses");
    assert!(preview["request"].get("input").is_some());
    assert_eq!(
        crate::model_protocol::integration(&json!({})).unwrap()["apiProtocol"],
        "chat_completions"
    );
}

#[test]
fn deepseek_responses_maps_only_documented_efforts_and_preserves_non_thinking_defaults() {
    let configured = |protocol: &str, parameters: Value| {
        with_context(request(protocol, "json_only"), |context| {
            context["_requestParameters"] = parameters;
            let caps = &mut context["_modelIntegration"]["capabilitiesV2"];
            caps["parameterAdapter"] = json!("deepseek");
            caps["tokenField"] = json!(if protocol == "responses" {
                "max_output_tokens"
            } else {
                "max_tokens"
            });
            caps["parameterRules"]["reasoningEfforts"] =
                json!(["none", "low", "high", "max", "xhigh"]);
            caps["parameterRules"]["thinkingEnabled"] = json!(true);
        })
    };
    let no_explicit = configured("responses", json!({}));
    let mut actual_business = no_explicit.clone();
    actual_business["thinking"] = json!({"type":"disabled"});
    for body in [no_explicit.clone(), actual_business] {
        let preview =
            preview_model_request("https://example.test/v1", &body, "计划生成", false).unwrap();
        assert_eq!(preview["request"]["reasoning"]["effort"], "none");
        assert!(preview["request"].get("thinking").is_none());
    }
    for effort in ["none", "low", "high", "max"] {
        let preview = preview_model_request(
            "https://example.test/v1",
            &configured("responses", json!({"reasoning_effort":effort})),
            "计划生成",
            false,
        )
        .unwrap();
        assert_eq!(preview["request"]["reasoning"]["effort"], effort);
    }
    for (protocol, effort) in [("chat_completions", "none"), ("responses", "xhigh")] {
        let error = preview_model_request(
            "https://example.test/v1",
            &configured(protocol, json!({"reasoning_effort":effort})),
            "计划生成",
            false,
        )
        .unwrap_err();
        assert_eq!(error_code(&error), "MODEL_PARAMETER_UNSUPPORTED");
    }
    let context: Value =
        serde_json::from_str(no_explicit["_opsarkContext"].as_str().unwrap()).unwrap();
    let (probe, operation) = probe_body(
        "offline-model",
        "structured",
        None,
        None,
        Some(context["_modelIntegration"].clone()),
    )
    .unwrap();
    let preview =
        preview_model_request("https://example.test/v1", &probe, operation, false).unwrap();
    assert_eq!(preview["request"]["reasoning"]["effort"], "none");
    assert_eq!(preview["request"]["max_output_tokens"], 64);
    let explicit_provider_default = preview_model_request(
        "https://example.test/v1",
        &configured("responses", json!({"thinking":"default","temperature":0.5})),
        "计划生成",
        false,
    )
    .unwrap_err();
    assert_eq!(
        error_code(&explicit_provider_default),
        "MODEL_PARAMETER_UNSUPPORTED"
    );
}
