//! Offline-only joint requirement/plan regression cases. Never call real endpoints.
use super::*;

#[test]
fn joint_requirement_contract_contains_classification_and_full_action_schema() {
    let body = json!({"_opsarkOperationContract":"requirement.plan@1", "_opsarkContext":
        json!({"tools":[{"id":"fixture.read","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}}]}).to_string()});
    let schema = model_compatibility::full_contract("需求理解", &body).unwrap();
    assert_eq!(schema["properties"]["steps"]["type"], "array");
    assert!(schema["required"]
        .as_array()
        .unwrap()
        .contains(&json!("intent")));
    assert!(schema["required"]
        .as_array()
        .unwrap()
        .contains(&json!("steps")));
    assert!(schema["properties"]["steps"]
        .to_string()
        .contains("fixture.read"));
}

fn context() -> Value {
    json!({"permission":"observe", "tools":[{"id":"files.read_content","effect":"read",
        "inputSchema":{"type":"object","properties":{"path":{"type":"string","minLength":1}},"required":["path"],"additionalProperties":false},
        "outputDescription":"返回文件正文及截断状态"}],
        "requirementSubmission":{"baseRevision":0,"sourceMessageId":"m1","content":"读取配置B"},
        "taskGoal":{"rootGoal":"读取配置A","currentRoundId":"original-round"},
        "_modelRecovery":{"operationId":next_plan_step_id("joint-test",0),"startedAtMs":unix_now(),
            "maxGenerations":2,"maxTransportAttempts":2,"maxElapsedMs":360000,"maxTotalTokens":250000},
        "_modelOutputRecovery":{"strategy":"initial"}})
}
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn step() -> Value {
    json!({"kind":"observe","title":"读取配置B","description":"只读读取配置B",
        "action":{"type":"tool","toolId":"files.read_content","arguments":{"path":"/srv/B.json"}},
        "expected":"获得配置B正文","validation":"","risk":"low"})
}
fn output() -> Value {
    json!({"intent":"execute","relation":"new_goal","answer":"","selectedSkillIds":[],"terminalContextLines":0,
        "constraints":{"changePolicy":"read_only","environmentPolicy":"preserve","failurePolicy":"strict",
            "prohibitedActions":[],"requiredConditions":[],"userDirectives":[]},
        "requirementUpdate":{"baseRevision":0,"sourceMessageId":"m1","additions":[
            {"id":"read-b","kind":"goal","content":"读取配置B","sourceQuote":"读取配置B","supersedes":[]}],"changes":[],"focusIds":["read-b"]},
        "steps":[step()]})
}
fn accept(value: &Value, ctx: &Value) -> Result<RequirementProcessingResult, String> {
    requirement_planning::accept(
        &value.to_string(),
        &ctx.to_string(),
        "读取配置B",
        &AiGenerationSettings::default(),
    )
}
fn runtime<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
fn capabilities(protocol: &str) -> Value {
    json!({"version":"model-capabilities@2","revision":"offline-stage26","supportedProtocols":[protocol],"preferredProtocol":protocol,
        "outputModes":{"json_object":"supported","json_schema":"supported"},"parameterAdapter":"openai",
        "tokenField":if protocol=="responses" {"max_output_tokens"} else {"max_completion_tokens"},"defaultOutputTokens":5000,"maxOutputTokens":16000,
        "budgetSemantics":"total_output","strictFlag":"required","store":"supported",
        "parameterRules":{"reasoningEfforts":["none","low","medium","high","xhigh"],"thinkingEnabled":false,"frequencyPenalty":false,
            "temperature":"supported","topP":"supported","presencePenalty":"unsupported"},"evidence":{"source":"user_declared"}})
}

#[test]
fn joint_selection_requires_current_submission_tools_consistent_directory_and_no_active_skills_or_repairs(
) {
    let ctx = context();
    assert!(requirement_planning::eligible(
        &ctx.to_string(),
        "读取配置B",
        &[]
    ));
    for (key, value) in [
        ("tools", json!([])),
        ("tools", Value::Null),
        ("skillDirectory", json!([{}])),
        ("activeSkills", json!([{}])),
        ("workflowPhase", json!("protocol_repair")),
        ("planGenerationRepair", json!({})),
        ("protocolReplan", json!({})),
        ("operationalRepair", json!({})),
        ("protocolRepairBudget", json!({})),
        ("_modelOutputRecovery", json!({"strategy":"regenerate"})),
        (
            "requirementSubmission",
            json!({"baseRevision":0,"sourceMessageId":"m1","content":"另一条消息"}),
        ),
    ] {
        let mut invalid = ctx.clone();
        invalid[key] = value;
        assert!(
            !requirement_planning::eligible(&invalid.to_string(), "读取配置B", &[]),
            "{key}"
        );
    }
    let skill: ModelSkillDefinition = serde_json::from_value(
        json!({"id":"s","name":"s","description":"s","version":1,"instructions":"s"}),
    )
    .unwrap();
    assert!(!requirement_planning::eligible(
        &ctx.to_string(),
        "读取配置B",
        &[skill]
    ));
}

#[test]
fn joint_acceptance_projects_current_requirement_but_returns_only_pending_proposals() {
    let ctx = context();
    let frozen = ctx.clone();
    let accepted = accept(&output(), &ctx).unwrap();
    assert_eq!(ctx, frozen);
    assert_eq!(accepted.intent, "execute");
    assert!(accepted.plan_error.is_none());
    assert_eq!(
        accepted.requirement_update.as_ref().unwrap()["focusIds"],
        json!(["read-b"])
    );
    assert_eq!(accepted.plan.len(), 1);
    assert_eq!(accepted.plan[0].status, "pending");
    assert!(
        matches!(accepted.plan[0].action.as_ref(),Some(StepAction::Tool{tool_id,..}) if tool_id=="files.read_content")
    );
}

#[test]
fn joint_acceptance_rejects_stale_message_revision_quotes_focus_and_unknown_skills() {
    for (pointer, value) in [
        ("/requirementUpdate/baseRevision", json!(2)),
        ("/requirementUpdate/sourceMessageId", json!("old")),
        (
            "/requirementUpdate/additions/0/sourceQuote",
            json!("虚构原文"),
        ),
        ("/requirementUpdate/focusIds", json!([])),
        ("/selectedSkillIds", json!(["invented"])),
        ("/constraints/changePolicy", json!("unspecified")),
    ] {
        let mut invalid = output();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(accept(&invalid, &context()).is_err(), "{pointer}");
    }
}

#[test]
fn joint_plan_errors_preserve_valid_classification_and_original_unexecuted_candidate() {
    for steps in [
        json!([]),
        json!([{ "kind":"observe","title":"bad","description":"bad",
        "action":{"type":"shell","command":"touch /tmp/not-executed"},"expected":"bad","validation":"","risk":"low"}]),
    ] {
        let mut invalid = output();
        invalid["steps"] = steps;
        let accepted = accept(&invalid, &context()).unwrap();
        assert_eq!(accepted.intent, "execute");
        assert_eq!(accepted.relation.as_deref(), Some("new_goal"));
        assert!(accepted.requirement_update.is_some());
        assert!(accepted.plan.is_empty());
        let error: Value = serde_json::from_str(accepted.plan_error.as_ref().unwrap()).unwrap();
        assert!(error["kind"] == "plan_protocol_failure" || error.get("issue").is_some());
    }
}

#[test]
fn joint_answer_cancel_and_terminal_requests_have_no_plan_and_cannot_smuggle_actions() {
    for (intent, relation, answer, lines) in [
        ("answer", json!("side_question"), "说明", 0),
        ("answer", json!("cancel_goal"), "已记录取消", 0),
        ("terminal_context", Value::Null, "", 1),
    ] {
        let mut value = output();
        value["intent"] = json!(intent);
        value["relation"] = relation;
        value["answer"] = json!(answer);
        value["terminalContextLines"] = json!(lines);
        value["constraints"] = Value::Null;
        value["requirementUpdate"] = Value::Null;
        value["steps"] = json!([]);
        let accepted = accept(&value, &context()).unwrap();
        assert!(accepted.plan.is_empty());
        value["steps"] = json!([step()]);
        assert!(accept(&value, &context()).is_err());
    }
}

#[test]
fn joint_output_limits_and_tool_visibility_remain_local_plan_gates() {
    let mut value = output();
    value["steps"] = json!([step(), step()]);
    let settings = AiGenerationSettings {
        limit_output: true,
        max_plan_steps: 1,
        ..Default::default()
    };
    let accepted = requirement_planning::accept(
        &value.to_string(),
        &context().to_string(),
        "读取配置B",
        &settings,
    )
    .unwrap();
    assert!(accepted.plan.is_empty());
    assert!(accepted.plan_error.unwrap().contains("steps"));
    value["steps"] = json!([step()]);
    value["steps"][0]["action"]["toolId"] = json!("invented");
    assert!(accept(&value, &context()).unwrap().plan_error.is_some());
}

#[test]
fn joint_request_keeps_owner_and_budget_without_stale_readonly_projection_or_duplicate_rules() {
    let mut ctx = context();
    ctx["executionConstraints"] = json!({"changePolicy":"read_only"});
    ctx["requirementSubmission"]["baseLifecycle"] = json!({"private-test-marker":"not-for-wire"});
    let original = ctx.clone();
    let body = requirement_planning::request(
        "fixture",
        "读取配置B",
        &ctx.to_string(),
        &Default::default(),
    )
    .unwrap();
    assert_eq!(ctx, original);
    assert_eq!(body["_opsarkContext"], ctx.to_string());
    let system = body["messages"][0]["content"].as_str().unwrap();
    assert_eq!(system.matches(SECRET_PLACEHOLDER_RULE).count(), 1);
    assert_eq!(system.matches(STRICT_JSON_OUTPUT_RULE).count(), 1);
    assert!(system.contains(REQUIREMENT_RELATION_RULE));
    assert!(!system.contains("本阶段不生成计划"));
    assert!(!body["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("not-for-wire"));
    assert!(body["messages"][1]["content"]
        .as_str()
        .unwrap()
        .starts_with("分类上下文：\n"));
}

#[test]
fn joint_schema_and_wire_preserve_both_protocols_and_reject_empty_tool_path() {
    for protocol in ["chat_completions", "responses"] {
        let mut ctx = context();
        ctx["_modelIntegration"] = json!({"apiProtocol":protocol,"outputPolicy":"require_schema",
            "capabilitiesV2":capabilities(protocol)});
        let body = requirement_planning::request(
            "fixture",
            "读取配置B",
            &ctx.to_string(),
            &Default::default(),
        )
        .unwrap();
        let (adapted, _) = model_compatibility::prepare(&body, "需求理解", false).unwrap();
        assert_eq!(
            adapted["_opsarkSchemaCompilation"]["contractVersion"],
            "requirement.plan@1"
        );
        let schema = model_compatibility::full_contract("需求理解", &body).unwrap();
        assert!(schema_validation::validate(&schema, &output()).is_ok());
        let mut invalid = output();
        invalid["steps"][0]["action"]["arguments"]["path"] = json!("");
        assert!(schema_validation::validate(&schema, &invalid).is_err());
    }
    let old = model_compatibility::full_contract("需求理解", &json!({})).unwrap();
    assert!(old["properties"].get("steps").is_none());
}

fn provider(responses: Vec<Value>) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let mut requests = vec![];
        for response in responses {
            let deadline = Instant::now() + std::time::Duration::from_secs(5);
            let (mut socket, _) = loop {
                match listener.accept() {
                    Ok(socket) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "missing loopback request");
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = vec![];
            let mut chunk = [0u8; 8192];
            loop {
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        requests.push(
                            serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap(),
                        );
                        break;
                    }
                }
            }
            let response = response.to_string();
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).unwrap();
        }
        requests
    });
    (endpoint, handle)
}
fn response(value: &Value, protocol: &str) -> Value {
    if protocol == "responses" {
        json!({"id":"offline-response","status":"completed","output":[{"type":"message","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":value.to_string()}]}],"usage":{"input_tokens":40,"output_tokens":60,"total_tokens":100}})
    } else {
        json!({"choices":[{"message":{"content":value.to_string()},"finish_reason":"stop"}],"usage":{"prompt_tokens":40,"completion_tokens":60,"total_tokens":100}})
    }
}
fn wire_output() -> Value {
    let mut value = output();
    value["requirementUpdate"]["acceptanceCoverage"] = Value::Null;
    for field in [
        "executionScope",
        "validationScope",
        "runtimeClass",
        "sessionContextChange",
        "recovery",
        "retryBasis",
    ] {
        value["steps"][0][field] = Value::Null;
    }
    value
}
fn call(ctx: Value, endpoint: String) -> Result<RequirementProcessingResult, String> {
    runtime(process_requirement_with_log(
        "offline-key".into(),
        endpoint,
        "fixture".into(),
        "读取配置B".into(),
        ctx.to_string(),
        vec![],
        None,
        Some(10),
        None,
        true,
    ))
}

#[test]
fn joint_real_entry_uses_one_loopback_call_in_both_protocols_and_records_usage_once() {
    for protocol in ["chat_completions", "responses"] {
        let mut ctx = context();
        ctx["_modelIntegration"] = json!({"apiProtocol":protocol,"outputPolicy":"require_schema","capabilitiesV2":capabilities(protocol)});
        let (endpoint, server) = provider(vec![response(&wire_output(), protocol)]);
        let accepted = call(ctx, endpoint).unwrap();
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(accepted.plan.len(), 1);
        assert!(accepted.plan_error.is_none());
        assert_eq!(accepted.developer_trace.attempts.len(), 1);
        let trace = serde_json::to_value(&accepted.developer_trace).unwrap();
        assert_eq!(trace["attempts"][0]["stage"], "requirement_planning");
        assert!(!requests[0].to_string().contains("_modelRecovery"));
        assert_eq!(
            accepted.developer_trace.attempts[0]
                .response
                .as_ref()
                .unwrap()["usage"]["total_tokens"],
            100
        );
    }
}

#[test]
fn legacy_context_still_classifies_then_plans_without_hidden_joint_fallback() {
    let mut ctx = context();
    ctx.as_object_mut().unwrap().remove("tools");
    ctx["_modelCapabilities"] = json!({"protocol":"chat_completions","version":"offline-stage26","structuredOutput":"json_object",
        "parameterAdapter":"portable","tokenField":"max_tokens","defaultOutputTokens":5000,"maxOutputTokens":10000});
    let mut classified = output();
    classified.as_object_mut().unwrap().remove("steps");
    let mut shell = step();
    shell["action"] = json!({"type":"shell","command":"cat /srv/B.json"});
    let (endpoint, server) = provider(vec![
        response(&classified, "chat_completions"),
        response(&json!({"steps":[shell]}), "chat_completions"),
    ]);
    let accepted = call(ctx, endpoint).unwrap();
    assert!(accepted.plan_error.is_none(), "{:?}", accepted.plan_error);
    assert_eq!(accepted.plan.len(), 1);
    assert_eq!(server.join().unwrap().len(), 2);
}

#[test]
fn joint_semantic_classification_failure_stops_after_one_call_and_never_plans_or_falls_back() {
    let mut invalid = wire_output();
    invalid["requirementUpdate"]["sourceMessageId"] = json!("stale");
    let mut ctx = context();
    ctx["_modelIntegration"] = json!({"apiProtocol":"chat_completions","outputPolicy":"require_schema","capabilitiesV2":capabilities("chat_completions")});
    let (endpoint, server) = provider(vec![response(&invalid, "chat_completions")]);
    assert!(call(ctx, endpoint).unwrap_err().contains("需求版本"));
    assert_eq!(server.join().unwrap().len(), 1);
}

#[test]
fn joint_calls_share_the_original_generation_cap_instead_of_opening_another_operation() {
    let mut ctx = context();
    ctx["_modelRecovery"]["maxGenerations"] = json!(1);
    ctx["_modelIntegration"] = json!({"apiProtocol":"chat_completions","outputPolicy":"require_schema","capabilitiesV2":capabilities("chat_completions")});
    let (endpoint, server) = provider(vec![response(&wire_output(), "chat_completions")]);
    assert!(call(ctx.clone(), endpoint.clone()).is_ok());
    assert_eq!(server.join().unwrap().len(), 1);
    let error = call(ctx, endpoint).unwrap_err();
    assert!(error.contains("MODEL_RECOVERY_BUDGET_EXHAUSTED"));
}

#[test]
fn joint_does_not_project_change_tools_using_preclassification_readonly_constraints() {
    let mut ctx = context();
    ctx["executionConstraints"] = json!({"changePolicy":"read_only"});
    ctx["tools"].as_array_mut().unwrap().push(
        json!({"id":"fixture.change","effect":"change","requiresTargetChange":true,
        "inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
    );
    ctx["_modelIntegration"] = json!({"apiProtocol":"chat_completions","outputPolicy":"require_schema","capabilitiesV2":capabilities("chat_completions")});
    let body = requirement_planning::request(
        "fixture",
        "读取配置B",
        &ctx.to_string(),
        &Default::default(),
    )
    .unwrap();
    let preview =
        model::preview_model_request("http://127.0.0.1:1/v1", &body, "需求理解", false).unwrap();
    assert!(preview["request"].to_string().contains("fixture.change"));
}

#[test]
fn joint_invalid_arguments_retain_parameter_cause_and_do_not_buy_another_repair_window() {
    let mut ctx = context();
    ctx["_modelRecovery"]["maxElapsedMs"] = json!(2000);
    ctx["_modelIntegration"] = json!({"apiProtocol":"chat_completions","outputPolicy":"require_schema","capabilitiesV2":capabilities("chat_completions")});
    let mut invalid = wire_output();
    invalid["steps"][0]["action"]["arguments"]["path"] = json!("");
    let (endpoint, server) = provider(vec![response(&invalid, "chat_completions")]);
    let accepted = call(ctx, endpoint).unwrap();
    assert_eq!(server.join().unwrap().len(), 1);
    assert!(accepted.plan.is_empty());
    assert_eq!(accepted.intent, "execute");
    let error = accepted.plan_error.expect("parameter rejection must remain explicit");
    assert!(error.contains("TOOL_ARGUMENT_INVALID"));
    assert!(error.contains("rejectedCandidateExecuted"));
    let issue: Value = serde_json::from_str(error.strip_prefix(MODEL_TRACE_ERROR_PREFIX).unwrap()).unwrap();
    assert_eq!(issue["modelError"]["recoveryBudget"]["maxElapsedMs"], 2000);
    assert_eq!(issue["modelError"]["recoveryBudget"]["generations"], 1);
    assert_eq!(issue["modelError"]["recoveryBudget"]["fieldRepairs"], 0);
    assert_eq!(issue["modelError"]["recoveryBudget"]["candidateRegenerations"], 0);
}

#[test]
fn joint_target_correction_replaces_only_the_named_goal_and_keeps_constraints_active() {
    let requirement = "刚才说错了，改为读取配置B，配置A不要动";
    let mut ctx = context();
    ctx["requirementSubmission"] = json!({"baseRevision":1,"sourceMessageId":"correction","content":requirement,
        "baseLifecycle":{"version":1,"revision":1,"items":[{"id":"old-a","kind":"goal","content":"读取配置A","status":"active","source":{},"evidenceIds":[]}],"focus":{"requirementIds":["old-a"]}}});
    let mut value = output();
    value["relation"] = json!("supplement");
    value["requirementUpdate"] = json!({"baseRevision":1,"sourceMessageId":"correction","changes":[],"additions":[
        {"id":"new-b","kind":"goal","content":"读取配置B","sourceQuote":"读取配置B","supersedes":["old-a"]},
        {"id":"keep-a","kind":"constraint","content":"配置A不要动","sourceQuote":"配置A不要动","supersedes":[]}],"focusIds":["new-b","keep-a"]});
    let accepted = requirement_planning::accept(
        &value.to_string(),
        &ctx.to_string(),
        requirement,
        &Default::default(),
    )
    .unwrap();
    assert!(accepted.plan_error.is_none());
    assert_eq!(
        accepted.requirement_update.as_ref().unwrap()["focusIds"],
        json!(["new-b", "keep-a"])
    );
    let projected = requirement_contract::project_classified_context(
        &ctx.to_string(),
        Some("supplement"),
        accepted.requirement_update.as_ref(),
        requirement,
        Some(&serde_json::to_value(accepted.constraints).unwrap()),
    )
    .unwrap();
    let projected: Value = serde_json::from_str(&projected).unwrap();
    let items = projected["taskGoal"]["lifecycle"]["items"]
        .as_array()
        .unwrap();
    assert!(items.iter().all(|item| item["id"] != "old-a"));
    assert!(items
        .iter()
        .any(|item| item["id"] == "new-b" && item["status"] == "active"));
    assert!(items
        .iter()
        .any(|item| item["id"] == "keep-a" && item["status"] == "active"));
    assert_eq!(projected["taskGoal"]["lifecycle"]["revision"], 2);
}

fn with_skill() -> (Value, Vec<ModelSkillDefinition>) {
    let mut ctx = context();
    ctx["skillDirectory"] =
        json!([{"id":"skill","name":"配置读取","description":"适用于配置读取","version":1}]);
    ctx["_modelIntegration"] = json!({"apiProtocol":"chat_completions","outputPolicy":"require_schema","capabilitiesV2":capabilities("chat_completions")});
    let skills=vec![serde_json::from_value(json!({"id":"skill","name":"配置读取","description":"适用于配置读取","version":1,"instructions":"STAGE26-FULL-SKILL-RULE"})).unwrap()];
    (ctx, skills)
}
fn call_with_skills(
    ctx: Value,
    skills: Vec<ModelSkillDefinition>,
    endpoint: String,
) -> Result<RequirementProcessingResult, String> {
    runtime(process_requirement_with_log(
        "offline-key".into(),
        endpoint,
        "fixture".into(),
        "读取配置B".into(),
        ctx.to_string(),
        skills,
        None,
        Some(10),
        None,
        true,
    ))
}

#[test]
fn available_but_unselected_skills_still_allow_one_joint_call_without_loading_instructions() {
    let (ctx, skills) = with_skill();
    assert!(requirement_planning::eligible(
        &ctx.to_string(),
        "读取配置B",
        &skills
    ));
    let (endpoint, server) = provider(vec![response(&wire_output(), "chat_completions")]);
    let accepted = call_with_skills(ctx, skills, endpoint).unwrap();
    assert!(accepted.plan_error.is_none());
    assert!(accepted.selected_skill_ids.is_empty());
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(!requests[0].to_string().contains("STAGE26-FULL-SKILL-RULE"));
}

#[test]
fn selected_skill_loads_full_rules_before_separate_plan_without_reclassification() {
    let (ctx, skills) = with_skill();
    let mut selected = wire_output();
    selected["selectedSkillIds"] = json!(["skill"]);
    selected["steps"] = json!([]);
    let (endpoint, server) = provider(vec![
        response(&selected, "chat_completions"),
        response(&json!({"steps":wire_output()["steps"]}), "chat_completions"),
    ]);
    let accepted = call_with_skills(ctx, skills, endpoint).unwrap();
    assert!(accepted.plan_error.is_none(), "{:?}", accepted.plan_error);
    assert_eq!(accepted.plan.len(), 1);
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(!requests[0].to_string().contains("STAGE26-FULL-SKILL-RULE"));
    assert!(requests[1].to_string().contains("STAGE26-FULL-SKILL-RULE"));
    assert_eq!(
        accepted.developer_trace.attempts[0].stage,
        "requirement_planning"
    );
    assert_eq!(
        accepted.developer_trace.attempts[1].stage,
        "plan_generation"
    );
}

#[test]
fn selecting_skill_cannot_smuggle_a_plan_before_full_rules_are_loaded() {
    let (ctx, skills) = with_skill();
    let mut invalid = wire_output();
    invalid["selectedSkillIds"] = json!(["skill"]);
    let (endpoint, server) = provider(vec![response(&invalid, "chat_completions")]);
    assert!(call_with_skills(ctx, skills, endpoint)
        .unwrap_err()
        .contains("必须先加载完整规则"));
    assert_eq!(server.join().unwrap().len(), 1);
}

#[test]
fn selected_skill_plan_keeps_the_original_generation_budget() {
    let (mut ctx, skills) = with_skill();
    ctx["_modelRecovery"]["maxGenerations"] = json!(1);
    let mut selected = wire_output();
    selected["selectedSkillIds"] = json!(["skill"]);
    selected["steps"] = json!([]);
    let (endpoint, server) = provider(vec![response(&selected, "chat_completions")]);
    let accepted = call_with_skills(ctx, skills, endpoint).unwrap();
    assert!(accepted.plan.is_empty());
    assert!(accepted
        .plan_error
        .unwrap()
        .contains("MODEL_RECOVERY_BUDGET_EXHAUSTED"));
    assert_eq!(server.join().unwrap().len(), 1);
}

#[test]
fn skill_planning_hints_are_preserved_and_do_not_imply_an_active_skill() {
    let (mut ctx, skills) = with_skill();
    ctx["skillEvidence"] = json!([{"skillId":"skill","stageId":"discover","observed":[]}]);
    assert!(requirement_planning::eligible(
        &ctx.to_string(),
        "读取配置B",
        &skills
    ));
    let body = requirement_planning::request(
        "fixture",
        "读取配置B",
        &ctx.to_string(),
        &Default::default(),
    )
    .unwrap();
    assert!(body["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("skillEvidence"));
    ctx["activeSkills"] = json!([{"id":"skill","instructions":"full rules"}]);
    assert!(!requirement_planning::eligible(
        &ctx.to_string(),
        "读取配置B",
        &skills
    ));
}

#[test]
fn joint_rollout_is_opt_in_and_does_not_treat_unknown_values_as_enabled() {
    assert!(!requirement_planning::enabled(None));
    for value in ["", "0", "true", "enabled", " 1 "] {
        assert!(!requirement_planning::enabled(Some(value)));
    }
    assert!(requirement_planning::enabled(Some("1")));
}

#[test]
fn disabled_joint_rollout_preserves_the_original_two_call_path() {
    let mut ctx = context();
    ctx["_modelIntegration"] = json!({"apiProtocol":"chat_completions","outputPolicy":"require_schema","capabilitiesV2":capabilities("chat_completions")});
    let mut classification = wire_output();
    classification.as_object_mut().unwrap().remove("steps");
    let (endpoint, server) = provider(vec![
        response(&classification, "chat_completions"),
        response(&json!({"steps":wire_output()["steps"]}), "chat_completions"),
    ]);
    let accepted = runtime(process_requirement_with_log(
        "offline-key".into(),
        endpoint,
        "fixture".into(),
        "读取配置B".into(),
        ctx.to_string(),
        vec![],
        None,
        Some(10),
        None,
        false,
    ))
    .unwrap();
    assert!(accepted.plan_error.is_none());
    assert_eq!(server.join().unwrap().len(), 2);
    assert_eq!(
        accepted.developer_trace.attempts[0].stage,
        "requirement_classification"
    );
    assert_eq!(
        accepted.developer_trace.attempts[1].stage,
        "plan_generation"
    );
}

#[test]
#[ignore = "explicit local historical wire reconstruction; no model or SSH access"]
fn stage26_historical_wire_cost_offline_replay() {
    let fixture: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("OPSARK_STAGE26_FIXTURE").unwrap()).unwrap(),
    )
    .unwrap();
    let mut records = vec![];
    for sample in fixture["samples"].as_array().unwrap() {
        let ctx = sample["context"].to_string();
        let requirement = sample["requirement"].as_str().unwrap();
        let skills: Vec<ModelSkillDefinition> = sample["context"]["skillDirectory"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                serde_json::from_value(
                    json!({"id":item["id"],"name":item["name"],"description":item["description"],
                "version":item["version"],"instructions":"offline-public-directory-only"}),
                )
                .unwrap()
            })
            .collect();
        assert!(requirement_planning::eligible(&ctx, requirement, &skills));
        let settings = AiGenerationSettings {
            max_output_tokens: Some(sample["outputLimit"].as_u64().unwrap()),
            ..Default::default()
        };
        let body =
            requirement_planning::request("gpt-6.1-sol", requirement, &ctx, &settings).unwrap();
        let schema = model_compatibility::full_contract("需求理解", &body).unwrap();
        let separate =
            model_compatibility::full_contract("计划生成", &json!({"_opsarkContext":ctx})).unwrap();
        assert_eq!(
            schema["properties"]["steps"],
            separate["properties"]["steps"]
        );
        let preview =
            model::preview_model_request("http://127.0.0.1:1/v1", &body, "需求理解", false)
                .unwrap();
        let original =
            sample["classificationWire"].to_string().len() + sample["planWire"].to_string().len();
        let joint = preview["request"].to_string().len();
        records.push(json!({"name":sample["name"],"unit":"utf8_bytes_not_tokens","legacyCalls":2,"jointCandidateCalls":1,
            "historicalClassificationBytes":sample["classificationWire"].to_string().len(),"historicalPlanBytes":sample["planWire"].to_string().len(),
            "historicalCombinedBytes":original,"jointReconstructedBytes":joint,"savedBytes":original as i64-joint as i64,
            "answerOnlyAdditionalBytes":joint as i64-sample["classificationWire"].to_string().len() as i64,
            "planSchemaPreserved":true,"request":preview["request"]}));
    }
    std::fs::write(
        std::env::var("OPSARK_STAGE26_RESULT").unwrap(),
        serde_json::to_vec_pretty(
            &json!({"method":"historical-public-wire-reconstruction","records":records}),
        )
        .unwrap(),
    )
    .unwrap();
}
