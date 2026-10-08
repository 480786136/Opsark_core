//! Local fake-provider tests: never send credentials or requests to a real vendor.
use super::*;
use std::io::{Read, Write};

#[test]
fn syntax_then_field_repair_normalizes_scope_without_regenerating_the_plan() {
    let value = json!({"decision":"continue","reason":"inspection unsupported","summary":"read disk with shell",
        "requirementReview":{"baseRevision":1,"roundId":"round","focusOutcome":"unmet","overallOutcome":"pending",
            "items":[{"requirementId":"disk","outcome":"unmet","evidenceIds":["unsupported-proof"],"reason":"no data"}]},
        "steps":[{"kind":"observe","title":"capacity","description":"read capacity",
            "action":{"type":"shell","command":"df -hT","executionScope":"isolated_exec"},
            "expected":"capacity","validation":"","risk":"low"}]});
    let (url, server) = provider(vec![
        (200, response("{invalid-json-private-command", "stop")),
        (200, response(&value.to_string(), "stop")),
        (200, response(r#"{"value":"pending"}"#, "stop")),
    ]);
    let result = run_operation(&url, &request(false), "阶段联合决策").unwrap();
    let result: Value = serde_json::from_str(result["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
    let mut expected = value;
    expected["requirementReview"]["focusOutcome"] = json!("pending");
    expected["steps"][0]["action"].as_object_mut().unwrap().remove("executionScope");
    expected["steps"][0]["executionScope"] = json!("isolated_exec");
    assert_eq!(result, expected);
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 3);
    let original_messages = requests[0]["messages"].as_array().unwrap();
    for (index, request) in requests.iter().enumerate() {
        assert_eq!(request["max_tokens"], requests[0]["max_tokens"]);
        assert!(!request.to_string().contains("invalid-json-private-command"));
        let messages = request["messages"].as_array().unwrap();
        assert_eq!(messages.len(), original_messages.len() + usize::from(index > 0));
        assert_eq!(&messages[..original_messages.len()], original_messages.as_slice());
    }
    let feedback = requests[2]["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap();
    assert!(feedback.contains("/requirementReview/focusOutcome"));
    assert!(!feedback.contains("json_parse"));
    assert!(feedback.contains("repairSchema"));
}

#[test]
fn task_zeujmj_shell_placement_and_null_tool_fields_need_no_model_repair() {
    for strict in [false, true] {
        let mut step = json!({"kind":"change","title":"start preview","description":"start service",
            "action":{"type":"shell","command":"npx vite preview --host 0.0.0.0 --port 8082",
                "executionScope":"agent_session","validationScope":"isolated_exec","runtimeClass":"persistent_service",
                "arguments":null,"toolId":null},"expected":"HTTP accessible","validation":"curl -f http://127.0.0.1:8082","risk":"medium"});
        if strict {
            for field in ["sessionContextChange", "recovery", "retryBasis"] { step[field] = Value::Null; }
        }
        let (url, server) = provider(vec![(200, response(&json!({"steps":[step]}).to_string(), "stop"))]);
        let payload = run(&url, &request(strict)).unwrap();
        let value: Value = serde_json::from_str(payload["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
        assert_eq!(value["steps"][0]["runtimeClass"], "persistent_service");
        assert_eq!(value["steps"][0]["executionScope"], "agent_session");
        assert_eq!(value["steps"][0]["validationScope"], "isolated_exec");
        assert_eq!(value["steps"][0]["action"], json!({"type":"shell","command":"npx vite preview --host 0.0.0.0 --port 8082"}));
        assert_eq!(server.join().unwrap().len(), 1);
    }
}

#[test]
fn shell_runtime_placement_never_discards_conflicts_or_non_null_tool_arguments() {
    let schema = crate::model_compatibility::contract("计划生成", &request(false)).unwrap();
    let base = json!({"steps":[{"kind":"observe","title":"version","description":"version",
        "action":{"type":"shell","command":"node -v"},"expected":"version","validation":"","risk":"low"}]});
    for (field, invalid) in [("runtimeClass", json!("invented")), ("arguments", json!({})),
        ("arguments", json!({"command":"kill 1"})), ("toolId", json!("files.write"))] {
        let mut value = base.clone();
        value["steps"][0]["action"][field] = invalid;
        let mut payload = response(&value.to_string(), "stop");
        let original = payload.clone();
        assert!(crate::model_compatibility::normalize_response_with_wire(&mut payload, &schema, None).is_err());
        assert_eq!(payload, original);
    }
    for field in ["runtimeClass", "validationScope"] {
        let mut value = base.clone();
        value["steps"][0]["action"][field] = json!(if field == "runtimeClass" { "persistent_service" } else { "isolated_exec" });
        value["steps"][0][field] = json!(if field == "runtimeClass" { "bounded" } else { "agent_session" });
        let mut payload = response(&value.to_string(), "stop");
        assert!(crate::model_compatibility::normalize_response_with_wire(&mut payload, &schema, None).is_err());
    }
}

fn field_repair_request(strict: bool) -> Value {
    with_request_context(request(strict), |context| {
        context["_log"] = json!({"taskId":"task-field-repair","roundId":"round"});
        context["workflowPhase"] = json!("protocol_repair");
        context["protocolRepairBudget"] = json!({"remainingModelCalls":1});
        context["planGenerationRepair"] = json!({"responseMode":"rejected_fields","originalPlanMergedLocally":true,
            "originalStepIndices":[7],"diagnostic":{"allowedRepairPaths":["steps[7].action.command"]},
            "previousModelOutput":[{"id":"frozen-id","kind":"observe","title":"runtime","description":"do not rewrite this",
                "action":{"type":"shell","command":"node -v; python3 -c 'import http.server'"},
                "command":"node -v; python3 -c 'import http.server'","expected":"runtime version","validation":"","risk":"low"}]});
    })
}

#[test]
fn task_zeujmj_command_repair_returns_only_command_and_merges_frozen_prose_locally() {
    for strict in [false, true] {
        let (url, server) = provider(vec![(200, response(r#"{"steps[7].action.command":"node -v; python3 -V"}"#, "stop"))]);
        let payload = run(&url, &field_repair_request(strict)).unwrap();
        let value: Value = serde_json::from_str(payload["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
        let step = &value["steps"][0];
        assert_eq!(step["action"]["command"], "node -v; python3 -V");
        assert_eq!(step["description"], "do not rewrite this");
        assert_eq!(step["expected"], "runtime version");
        assert_eq!(step["kind"], "observe");
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(!requests[0].to_string().contains("完整的被拒步骤"));
        let context: Value = serde_json::from_str(field_repair_request(strict)["_opsarkContext"].as_str().unwrap()).unwrap();
        let original = field_repair_request(strict);
        let full = crate::model_compatibility::full_contract("计划生成", &original).unwrap();
        let repair = crate::scoped_model_repair::ScopedRepair::new("计划生成", &original, &full).unwrap();
        let (_, log) = crate::prompt_layers::prepare_request(&repair.request(&original));
        assert_eq!(log["taskId"], context["_log"]["taskId"]);
    }
}

#[test]
fn field_repair_rejects_extra_execution_fields_without_requesting_another_generation() {
    for content in [r#"{"steps[7].action.command":"node -v","description":"rewritten"}"#,
        r#"{"steps":[{"action":{"type":"shell","command":"kill 1"}}]}"#] {
        let (url, server) = provider(vec![(200, response(content, "stop"))]);
        let error = run(&url, &field_repair_request(false)).unwrap_err();
        assert!(error.contains("MODEL_FORMAT_INVALID"));
        assert_eq!(server.join().unwrap().len(), 1);
    }
}

#[test]
fn task_zeujmj_acceptance_repair_keeps_expected_and_skips_tool_and_skill_catalogs() {
    for strict in [false, true] {
        let review = json!({"baseRevision":11,"roundId":"round","focusOutcome":"pending","overallOutcome":"pending",
            "items":[{"requirementId":"deploy","outcome":"unknown","reason":"awaiting HTTP proof","evidenceIds":[]}]});
        let body = with_request_context(request(strict), |context| {
            context["taskGoal"] = json!({"rootGoal":"deploy","lifecycle":{"revision":11}});
            context["tools"] = json!([{"id":"unused","inputSchema":{"type":"object"},"instructions":"UNNEEDED_TOOL_CATALOG"}]);
            context["activeSkills"] = json!([{"instructions":"UNNEEDED_SKILL_CATALOG"}]);
            context["baseSnapshot"] = json!({"requirementEvidence":{"availableIds":["fresh-proof"]}});
            context["operationalRepair"] = json!({"reason":"evidence reference is inadmissible",
                "rejectedProposal":{"responseMode":"metadata_fields","decision":"continue",
                    "steps":[{"kind":"observe","title":"ports","description":"check ports","action":{"type":"shell","command":"ss -lntp"},
                        "expected":"original acceptance stays byte-for-byte","validation":"","risk":"low"}]}});
        });
        let mut fields = json!({"decision":"continue","reason":"need proof","summary":"awaiting acceptance","requirementReview":review});
        if strict { fields["blocking"] = Value::Null; fields["issueResolutions"] = Value::Null; }
        let (url, server) = provider(vec![(200, response(&fields.to_string(), "stop"))]);
        let payload = run_operation(&url, &body, "阶段联合决策").unwrap();
        let value: Value = serde_json::from_str(payload["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
        assert_eq!(value["steps"][0]["expected"], "original acceptance stays byte-for-byte");
        assert_eq!(value["requirementReview"], review);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 1);
        let request = requests[0].to_string();
        assert!(request.contains("fresh-proof"));
        assert!(!request.contains("UNNEEDED_TOOL_CATALOG"));
        assert!(!request.contains("UNNEEDED_SKILL_CATALOG"));
    }
}

#[test]
fn focus_completion_metadata_repair_can_change_complete_to_adjust_without_actions() {
    for strict in [false, true] {
        let review = json!({"baseRevision":13,"roundId":"round","focusOutcome":"completed","overallOutcome":"pending",
            "items":[{"requirementId":"stop","outcome":"satisfied","reason":"independent final check","evidenceIds":["fresh-proof"]},
                {"requirementId":"deploy","outcome":"unmet","reason":"deployment pending","evidenceIds":[]}]});
        let body = with_request_context(request(strict), |context| {
            context["operationalRepair"] = json!({"reason":"整体目标仍未完成，不能使用 complete",
                "rejectedProposal":{"responseMode":"metadata_fields","decision":"complete","steps":[],"requirementReview":review}});
        });
        let mut fields = json!({"decision":"adjust","reason":"deliver this request only","summary":"deployment remains pending","requirementReview":review});
        if strict { fields["blocking"] = Value::Null; fields["issueResolutions"] = Value::Null; }
        let full = crate::model_compatibility::full_contract("阶段联合决策", &body).unwrap();
        let repair = crate::scoped_model_repair::ScopedRepair::new("阶段联合决策", &body, &full).unwrap();
        assert_eq!(repair.schema["properties"]["decision"], full["properties"]["decision"]);
        let mut injection = fields.clone();
        injection["steps"] = json!([{"action":{"type":"shell","command":"kill 370737"}}]);
        assert!(repair.merge(&injection).is_err());
        let (url, server) = provider(vec![(200, response(&fields.to_string(), "stop"))]);
        let payload = run_operation(&url, &body, "阶段联合决策").unwrap();
        let value: Value = serde_json::from_str(payload["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
        assert_eq!(value["decision"], "adjust");
        assert_eq!(value["steps"], json!([]));
        assert_eq!(value["requirementReview"], review);
        assert_eq!(server.join().unwrap().len(), 1);
    }
}

#[test]
fn format_repair_stops_after_three_distinct_corrections() {
    let invalid = json!({"steps":[{"kind":"bad","title":123,"description":"read",
        "action":{"type":"shell","command":"pwd"},"expected":"directory","validation":"",
        "risk":"bad","runtimeClass":"bad"}]});
    let (url, server) = provider(vec![
        (200, response(&invalid.to_string(), "stop")),
        (200, response(r#"{"value":"observe"}"#, "stop")),
        (200, response(r#"{"value":"low"}"#, "stop")),
        (200, response(r#"{"value":"bounded"}"#, "stop")),
    ]);
    let error = run(&url, &request(false)).unwrap_err();
    assert!(error.contains("MODEL_FORMAT_INVALID"));
    assert!(error.contains("/steps/0/title"));
    assert_eq!(server.join().unwrap().len(), 4);
}

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
        let correction = if first["choices"][0]["message"]["content"] == "{}" {
            r#"{"value":[]}"#
        } else { r#"{"steps":[]}"# };
        let (url, server) = provider(vec![(200, first), (200, response(correction, "stop"))]);
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
        (200, response(r#"{"value":[]}"#, "stop")),
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
    assert!(feedback.contains("repairSchema"));
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
                r#"{"value":3}"#,
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
        .contains("/repair/stepIndex"));
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

#[test]
fn extra_timeout_repair_removes_only_the_unsupported_field_preserving_action() {
    let invalid = json!({"steps":[{"kind":"observe","title":"read","description":"read",
        "action":{"type":"shell","command":"do-not-replay-audit-only","timeoutSeconds":600},
        "expected":"read","validation":"","risk":"low"}]});
    let (url, server) = provider(vec![
        (200, response(&invalid.to_string(), "stop")),
        (200, response(r#"{"remove":true}"#, "stop")),
    ]);
    let result = run(&url, &request(false)).unwrap();
    let result: Value = serde_json::from_str(result["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
    assert_eq!(result["steps"].as_array().unwrap().len(), 1);
    assert_eq!(result["steps"][0]["action"]["command"], invalid["steps"][0]["action"]["command"]);
    let requests = server.join().unwrap();
    let feedback = requests[1]["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap();
    assert!(feedback.contains("repairSchema"));
    assert!(feedback.contains("additionalProperties"));
    assert!(feedback.contains("timeoutSeconds"));
    assert!(feedback.contains("remove"));
    assert!(!feedback.contains("do-not-replay-audit-only"));
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1]["max_tokens"], requests[0]["max_tokens"]);
}

#[test]
fn timeout_then_invalid_scope_receives_targeted_correction_for_the_new_error() {
    let invalid = json!({"decision":"continue","reason":"not deployed","summary":"clone",
        "steps":[{"kind":"change","title":"clone","description":"clone",
        "action":{"type":"shell","command":"do-not-execute-clone","timeoutSeconds":600},
        "expected":"worktree exists","validation":"git -C /opt/repo rev-parse HEAD","risk":"low",
        "validationScope":"invalid-scope"}]});
    let (url, server) = provider(vec![
        (200, response(&invalid.to_string(), "stop")), (200, response(r#"{"remove":true}"#, "stop")),
        (200, response(r#"{"value":"isolated_exec"}"#, "stop")),
    ]);
    let result = run_operation(&url, &request(false), "阶段联合决策").unwrap();
    let result: Value = serde_json::from_str(result["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
    assert_eq!(result["steps"].as_array().unwrap().len(), 1);
    assert_eq!(result["steps"][0]["action"]["command"], invalid["steps"][0]["action"]["command"]);
    assert_eq!(result["steps"][0]["validationScope"], "isolated_exec");
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[2]["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().contains("/steps/0/validationScope"));
}

fn recorded_format_fixture(name: &str) -> Value {
    let fixtures: Value = serde_json::from_str(include_str!("fixtures/model-format-recovery.json")).unwrap();
    fixtures.as_array().unwrap().iter().find(|fixture| fixture["name"] == name).unwrap()["response"].clone()
}

fn with_request_context(mut body: Value, update: impl FnOnce(&mut Value)) -> Value {
    let mut context: Value = serde_json::from_str(body["_opsarkContext"].as_str().unwrap()).unwrap();
    update(&mut context);
    body["_opsarkContext"] = json!(context.to_string());
    body["messages"][1]["content"] = json!(context.to_string());
    body
}

#[test]
fn lifecycle_review_is_required_nonnull_in_initial_and_repair_contracts() {
    for strict in [false, true] {
        for lifecycle_path in ["taskGoal", "baseSnapshot", "task"] {
            let body = with_request_context(request(strict), |context| {
                let lifecycle = json!({"version":1,"revision":8});
                match lifecycle_path {
                    "taskGoal" => context["taskGoal"] = json!({"lifecycle":lifecycle}),
                    "baseSnapshot" => context["baseSnapshot"] = json!({"taskRequirements":{"lifecycle":lifecycle}}),
                    _ => context["task"] = json!({"requirementLifecycle":lifecycle}),
                }
            });
            for operation in ["阶段联合决策", "阶段格式修复（兼容模式）"] {
                let (prepared, schema) = crate::model_compatibility::prepare(&body, operation, false).unwrap();
                let schema = schema.unwrap();
                assert!(schema["required"].as_array().unwrap().contains(&json!("requirementReview")));
                let mut value = json!({"decision":"adjust","reason":"pending","summary":"pending","steps":[]});
                assert!(crate::schema_validation::validate(&schema, &value).is_err());
                value["requirementReview"] = Value::Null;
                assert!(crate::schema_validation::validate(&schema, &value).is_err());
                assert_eq!(schema["properties"]["requirementReview"]["type"], "object");
                let prompt = prepared["messages"].to_string();
                assert!(prompt.contains("required 中字段必须存在"));
                assert!(prompt.contains("requirementReview"));
            }
        }
        for lifecycle in [Value::Null, json!({"version":1,"revision":0})] {
            let body = with_request_context(request(strict), |c| c["taskGoal"] = json!({"lifecycle":lifecycle}));
            let schema = crate::model_compatibility::contract("阶段联合决策", &body).unwrap();
            assert!(crate::schema_validation::validate(&schema, &json!({"decision":"adjust","reason":"legacy","summary":"legacy","steps":[]})).is_ok());
        }
    }
}

#[test]
fn recorded_kind_error_uses_one_field_and_preserves_the_original_tool_action() {
    let initial = recorded_format_fixture("plan-kind-tool");
    let original: Value = serde_json::from_str(initial["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
    let body = with_request_context(request(false), |c| c["tools"] = json!([{
        "id":"server.resolve_connection","effect":"read","inputSchema":{"type":"object",
            "properties":{"host":{"type":"string"},"port":{"type":"integer"}},"required":["host"],"additionalProperties":false}}]));
    let (url, server) = provider(vec![(200, initial.clone()), (200, response(r#"{"value":"observe"}"#, "stop"))]);
    let result = run(&url, &body).unwrap();
    let result: Value = serde_json::from_str(result["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
    let mut expected = original.clone();
    expected["steps"][0]["kind"] = json!("observe");
    assert_eq!(result, expected);
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1]["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().contains("repairSchema"));
    // A provider ignoring the field envelope must not replace the candidate.
    let drift = json!({"steps":[{"kind":"change","title":"clone","description":"clone",
        "action":{"type":"shell","command":"git clone https://example.invalid/demo.git"},
        "expected":"clone","validation":"test -d demo","risk":"medium"}]});
    let (url, server) = provider(vec![(200, initial), (200, response(&drift.to_string(), "stop"))]);
    assert!(run(&url, &body).unwrap_err().contains("MODEL_FORMAT_INVALID"));
    assert_eq!(server.join().unwrap().len(), 2);
}

#[test]
fn missing_review_can_only_add_review_and_cannot_add_a_question_or_change_steps() {
    let body = with_request_context(request(false), |c| c["taskGoal"] = json!({"lifecycle":{"version":1,"revision":8}}));
    let initial = json!({"decision":"adjust","reason":"need evidence","summary":"pending","steps":[{
        "kind":"observe","title":"directory","description":"read directory","action":{"type":"shell","command":"pwd"},
        "expected":"directory","validation":"","risk":"low"}]});
    let review = json!({"baseRevision":8,"roundId":"round-fixture","focusOutcome":"pending","overallOutcome":"pending",
        "items":[{"requirementId":"goal-fixture","outcome":"unknown","evidenceIds":[],"reason":"pending evidence"}]});
    let (url, server) = provider(vec![(200, response(&initial.to_string(), "stop")), (200, response(&json!({"value":review}).to_string(), "stop"))]);
    let result = run_operation(&url, &body, "阶段联合决策").unwrap();
    let result: Value = serde_json::from_str(result["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
    assert_eq!(result["steps"], initial["steps"]);
    assert_eq!(result["decision"], initial["decision"]);
    assert!(result["requirementReview"].is_object());
    assert_eq!(server.join().unwrap().len(), 2);
    let mut drift = initial.clone();
    drift["requirementReview"] = review;
    drift["steps"] = json!([{"kind":"observe","action":{"type":"tool","toolId":"user.request_input","arguments":{}}}]);
    let (url, server) = provider(vec![(200, response(&initial.to_string(), "stop")), (200, response(&drift.to_string(), "stop"))]);
    assert!(run_operation(&url, &body, "阶段联合决策").is_err());
    assert_eq!(server.join().unwrap().len(), 2);
}

#[test]
fn recorded_malformed_responses_stop_after_one_regeneration_without_budget_growth() {
    for (operation, first, second) in [
        ("计划生成", "plan-missing-action-braces", "plan-missing-action-braces"),
        ("阶段联合决策", "stage-missing-action-brace", "stage-repair-action-drift"),
    ] {
        let (url, server) = provider(vec![(200, recorded_format_fixture(first)), (200, recorded_format_fixture(second))]);
        let error = run_operation(&url, &request(false), operation).unwrap_err();
        let trace: Value = serde_json::from_str(error.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap()).unwrap();
        assert_eq!(trace["modelError"]["stage"], "json_parse");
        assert_eq!(trace["modelError"]["rawStatus"], "stop");
        assert_eq!(trace["modelError"]["httpStatus"], 200);
        assert_eq!(trace["modelError"]["recoveryBudget"]["generations"], 2);
        assert_eq!(trace["modelError"]["recoveryBudget"]["recoveryBlocked"], false);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["max_tokens"], requests[1]["max_tokens"]);
        assert!(requests[1]["messages"].to_string().contains("只允许 kind=observe"));
    }
}

#[test]
fn syntax_regeneration_checks_shell_effects_even_when_the_model_says_observe() {
    for command in ["kill 12345", "systemctl restart example-app", "git clone https://example.invalid/demo.git", "printf x > /tmp/example-output", "firewall-cmd --zone=\"$zone\" --list-ports"] {
        let regenerated = json!({"steps":[{"kind":"observe","title":"inspect","description":"inspect",
            "action":{"type":"shell","command":command},"expected":"evidence","validation":"","risk":"low"}]});
        let (url, server) = provider(vec![(200, recorded_format_fixture("plan-missing-action-braces")), (200, response(&regenerated.to_string(), "stop"))]);
        let error = run(&url, &request(false)).unwrap_err();
        let error = typed_error(&error);
        assert_eq!(error["modelError"]["code"], "MODEL_RECOVERY_SCOPE_REJECTED", "{command}");
        assert_eq!(error["modelError"]["stage"], "format_repair_scope");
        assert_eq!(error["modelError"]["jsonPointer"], "/steps/0/action/command");
        assert_eq!(server.join().unwrap().len(), 2);
    }
    let regenerated = json!({"steps":[{"kind":"observe","title":"inspect","description":"inspect",
        "action":{"type":"shell","command":"pwd"},"expected":"directory","validation":"","risk":"low"}]});
    let (url, server) = provider(vec![(200, recorded_format_fixture("plan-missing-action-braces")), (200, response(&regenerated.to_string(), "stop"))]);
    assert!(run(&url, &request(false)).is_ok());
    assert_eq!(server.join().unwrap().len(), 2);
}

#[test]
fn task_5xv43s_valid_json_after_syntax_repair_reports_the_policy_gate_not_format_failure() {
    let step = |command: &str| json!({"kind":"observe","title":"read","description":"read",
        "action":{"type":"shell","command":command},"expected":"evidence","validation":"","risk":"low"});
    for (command, rejected) in [("firewall-cmd --zone=\"$zone\" --list-ports", true),
        ("firewall-cmd --zone=public --list-ports", false)] {
        let regenerated = json!({"decision":"adjust","reason":"need independent proof","summary":"read only",
            "steps":[step("ss -lntp"),step(command)]});
        let (url, server) = provider(vec![(200, response("{invalid-json", "stop")),
            (200, response(&regenerated.to_string(), "stop"))]);
        let result = run_operation(&url, &request(false), "阶段联合决策");
        if rejected {
            let error = typed_error(&result.unwrap_err());
            assert_eq!(error["modelError"]["code"], "MODEL_RECOVERY_SCOPE_REJECTED");
            assert_eq!(error["modelError"]["stage"], "format_repair_scope");
            assert_eq!(error["modelError"]["jsonPointer"], "/steps/1/action/command");
            assert_eq!(error["modelError"]["origin"], "core");
            assert_eq!(error["modelError"]["httpStatus"], 200);
            assert_eq!(error["modelError"]["retryable"], false);
            assert!(error["modelError"]["message"].as_str().unwrap().contains("无法被当前规则确认只读"));
            assert!(!error.to_string().contains(command));
        } else { assert!(result.is_ok()); }
        assert_eq!(server.join().unwrap().len(), 2, "policy refusal must not trigger another format repair");
    }
}

#[test]
fn kind_field_repair_cannot_relabel_a_mutating_command_as_observe() {
    let candidate = json!({"steps":[{"kind":"tool","title":"restart","description":"restart",
        "action":{"type":"shell","command":"systemctl restart example-app"},
        "expected":"active","validation":"","risk":"medium"}]});
    let (url, server) = provider(vec![(200, response(&candidate.to_string(), "stop")), (200, response(r#"{"value":"observe"}"#, "stop"))]);
    let error = run(&url, &request(false)).unwrap_err();
    let error = typed_error(&error);
    assert_eq!(error["modelError"]["code"], "MODEL_RECOVERY_SCOPE_REJECTED");
    assert_eq!(error["modelError"]["jsonPointer"], "/steps/0/action/command");
    assert_eq!(server.join().unwrap().len(), 2);
}

#[test]
fn syntax_recovery_cannot_switch_to_interaction_or_managed_service() {
    for step in [
        json!({"kind":"observe","title":"ask","description":"ask","action":{"type":"tool","toolId":"user.request_input","arguments":{}},"expected":"input","validation":"","risk":"low"}),
        json!({"kind":"observe","title":"read","description":"read","action":{"type":"shell","command":"pwd"},"executionScope":"user_action","expected":"directory","validation":"","risk":"low"}),
        json!({"kind":"observe","title":"read","description":"read","action":{"type":"shell","command":"pwd"},"executionScope":"managed_service","expected":"directory","validation":"","risk":"low"}),
    ] {
        let body = with_request_context(request(false), |c| c["tools"] = json!([{
            "id":"user.request_input","effect":"interaction","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}]));
        let (url, server) = provider(vec![(200, recorded_format_fixture("plan-missing-action-braces")),
            (200, response(&json!({"steps":[step]}).to_string(), "stop"))]);
        assert!(run(&url, &body).unwrap_err().contains("format_repair_scope"));
        assert_eq!(server.join().unwrap().len(), 2);
    }
}

#[test]
fn shell_scope_placement_preserves_envelope_and_rejects_conflicting_or_invalid_fields() {
    let body = request(false);
    let schema = crate::model_compatibility::contract("计划生成", &body).unwrap();
    let base = json!({"steps":[{"kind":"observe","title":"read","description":"read",
        "action":{"type":"shell","command":"pwd","executionScope":"isolated_exec"},
        "expected":"directory","validation":"","risk":"low"}]});
    for duplicate in [false, true] {
        let mut value = base.clone();
        if duplicate { value["steps"][0]["executionScope"] = json!("isolated_exec"); }
        let mut payload = response(&value.to_string(), "stop");
        payload["id"] = json!("unchanged-envelope");
        payload["usage"] = json!({"total_tokens":44});
        let mut expected = value;
        expected["steps"][0]["action"].as_object_mut().unwrap().remove("executionScope");
        expected["steps"][0]["executionScope"] = json!("isolated_exec");
        let mut expected_payload = payload.clone();
        expected_payload["choices"][0]["message"]["content"] = json!(expected.to_string());
        crate::model_compatibility::normalize_response_with_wire(&mut payload, &schema, None).unwrap();
        assert_eq!(payload, expected_payload);
    }
    for scenario in ["conflict", "parent-null", "invalid", "child-null", "unknown-extra", "root-action"] {
        let mut value = base.clone();
        match scenario {
            "conflict" => value["steps"][0]["executionScope"] = json!("agent_session"),
            "parent-null" => value["steps"][0]["executionScope"] = Value::Null,
            "invalid" => value["steps"][0]["action"]["executionScope"] = json!("not-a-scope"),
            "child-null" => value["steps"][0]["action"]["executionScope"] = Value::Null,
            "unknown-extra" => value["steps"][0]["action"]["cwd"] = json!("/different-directory"),
            _ => value["action"] = json!({"type":"shell","executionScope":"isolated_exec","command":"pwd"}),
        }
        let mut payload = response(&value.to_string(), "stop");
        let original = payload.clone();
        assert!(crate::model_compatibility::normalize_response_with_wire(&mut payload, &schema, None).is_err(), "{scenario}");
        assert_eq!(payload, original, "{scenario}: failed normalization must not publish a partial correction");
    }
    let wire = crate::model_schema::compile(&schema).unwrap().schema;
    let mut strict_value = base;
    for field in ["validationScope", "runtimeClass", "sessionContextChange", "recovery", "retryBasis"] {
        strict_value["steps"][0][field] = Value::Null;
    }
    strict_value["steps"][0].as_object_mut().unwrap().remove("title");
    let mut payload = response(&strict_value.to_string(), "stop");
    let original = payload.clone();
    let diagnostic = crate::model_compatibility::normalize_response_with_wire(&mut payload, &schema, Some(&wire)).unwrap_err();
    assert_eq!(diagnostic.stage, "wire_validation");
    assert_eq!(diagnostic.json_pointer.as_deref(), Some("/steps/0/title"));
    assert_eq!(payload, original);
}

#[test]
fn shell_scope_normalization_never_enters_tool_arguments_and_keeps_field_repair_working() {
    let body = with_request_context(request(false), |context| {
        context["tools"] = json!([{"id":"test.named-scope","effect":"read","inputSchema":{
            "type":"object","properties":{"executionScope":{"type":"string"}},"required":["executionScope"],"additionalProperties":false}}]);
    });
    let schema = crate::model_compatibility::contract("计划生成", &body).unwrap();
    let value = json!({"steps":[{"kind":"observe","title":"read","description":"read",
        "action":{"type":"tool","toolId":"test.named-scope","arguments":{"executionScope":"isolated_exec"}},
        "expected":"result","validation":"","risk":"low"}]});
    let mut payload = response(&value.to_string(), "stop");
    let original = payload.clone();
    crate::model_compatibility::normalize_response_with_wire(&mut payload, &schema, None).unwrap();
    assert_eq!(payload, original);
    let mut misplaced_tool = value;
    misplaced_tool["steps"][0]["action"]["executionScope"] = json!("isolated_exec");
    let mut payload = response(&misplaced_tool.to_string(), "stop");
    let original = payload.clone();
    assert!(crate::model_compatibility::normalize_response_with_wire(&mut payload, &schema, None).is_err());
    assert_eq!(payload, original);

    let mut candidate = json!({"steps":[{"kind":"observe","title":"read","description":"read",
        "action":{"type":"shell","command":"pwd","executionScope":"isolated_exec"},
        "expected":"directory","validation":"","risk":"invalid"}]});
    let (url, server) = provider(vec![(200, response(&candidate.to_string(), "stop")), (200, response(r#"{"value":"low"}"#, "stop"))]);
    let result = run(&url, &request(false)).unwrap();
    let result: Value = serde_json::from_str(result["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
    candidate["steps"][0]["action"].as_object_mut().unwrap().remove("executionScope");
    candidate["steps"][0]["executionScope"] = json!("isolated_exec");
    candidate["steps"][0]["risk"] = json!("low");
    assert_eq!(result, candidate);
    assert_eq!(server.join().unwrap().len(), 2);
}
