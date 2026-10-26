use super::*;

fn context() -> Value {
    json!({"taskGoal":{"rootGoal":"读取服务日志及资源状态；禁止修改配置和重启。"},
        "executionConstraints":{"changePolicy":"read_only","prohibitedActions":["修改配置","重启"]},
        "permission":"safe","server":{"host":"fixture.invalid","hostCapabilities":{
            "identity":{"serverId":"fixture","host":"fixture.invalid","port":22,"username":"operator","connectionGeneration":9},
            "source":{"kind":"native_operations_probe","toolCallId":"probe-source","evidenceId":"capability-evidence"},
            "collectedAt":"2026-10-13T00:00:00Z","expiresAt":"2026-10-13T00:05:00Z",
            "facts":[{"name":"ss","supported":false},{"name":"netstat","supported":true},{"name":"jq","supported":null}] }},
        "knownExecutionFacts":{"completedSteps":[],"instruction":"历史观察不是当前状态"},
        "tools":[{"id":"software.check","effect":"read","planMode":"read_batch","completionMode":"refine",
            "inputSchema":{"type":"object","properties":{"names":{"type":"array","items":{"type":"string"}}}}}],
        "_taskModelBudget":{"version":1,"taskId":"fixed-task","roundId":"fixed-round","maxTaskTokens":250000},
        "_modelRecovery":{"operationId":"fixed-operation","startedAtMs":1000,"maxElapsedMs":360000}})
}

#[test]
fn read_only_directory_uses_explicit_target_change_policy_and_preserves_connection_and_inputs() {
    let mut context = context();
    context["tools"] = json!([
        {"id":"read","effect":"read","requiresTargetChange":true,"inputSchema":{"literal":{"requiresTargetChange":true}}},
        {"id":"connect","effect":"change","inputSchema":{"type":"object"}},
        {"id":"custom-unknown","effect":"change","requiresTargetChange":"true"},
        {"id":"input","effect":"interaction"},
        {"id":"transfer","effect":"change","requiresTargetChange":true,"description":"full target-write contract"},
        {"id":"confirm-write","effect":"interaction","requiresTargetChange":true},
        {"id":"delete","effect":"change","requiresTargetChange":true}
    ]);
    let before = body(&context, "阶段结束决策上下文：\n");
    let retained = before.clone();
    let (prepared, log) = prepare_request(&before);
    assert_eq!(before, retained);
    assert_eq!(prepared["response_format"], before["response_format"]);
    assert_eq!(prepared["max_tokens"], before["max_tokens"]);
    let policy = embedded_context(prepared["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(policy["tools"].as_array().unwrap().iter().map(|tool| tool["id"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["read", "connect", "custom-unknown", "input"]);
    assert_eq!(policy["tools"][0]["inputSchema"], context["tools"][0]["inputSchema"]);
    assert!(policy["tools"].as_array().unwrap().iter().all(|tool| tool.get("requiresTargetChange").is_none()));
    assert_eq!(log["toolDirectoryProjection"]["excludedToolIds"], json!(["transfer","confirm-write","delete"]));
    assert_eq!(log["toolDirectoryProjection"]["executionPermissionsUnchanged"], true);

    // A new request with a different confirmed change policy rebuilds the
    // directory from the full context; no cached read-only selection survives.
    for policy in ["confirm_changes", "requested_changes_only", "unspecified"] {
        context["executionConstraints"]["changePolicy"] = json!(policy);
        let (prepared, log) = prepare_request(&body(&context, "阶段结束决策上下文：\n"));
        let directory = embedded_context(prepared["messages"][1]["content"].as_str().unwrap()).unwrap();
        assert_eq!(directory["tools"].as_array().unwrap().len(), 7);
        assert!(log.get("toolDirectoryProjection").is_none());
    }
}

#[test]
fn tool_directory_projection_does_not_narrow_classification_or_scoped_repairs() {
    let mut context = context();
    context["tools"] = json!([{"id":"target-write","effect":"change","requiresTargetChange":true}]);
    for label in ["分类上下文：\n", "执行复核上下文：\n", "已脱敏的执行结果：\n"] {
        let (prepared, log) = prepare_request(&body(&context, label));
        let policy = embedded_context(prepared["messages"][1]["content"].as_str().unwrap()).unwrap();
        assert_eq!(policy["tools"].as_array().unwrap().len(), 1);
        assert!(log.get("toolDirectoryProjection").is_none());
    }
    for field in ["planGenerationRepair", "protocolReplan", "operationalRepair"] {
        let mut repair = context.clone();
        repair[field] = json!({"instruction":"retain the original local repair scope"});
        let (prepared, log) = prepare_request(&body(&repair, "阶段结束决策上下文：\n"));
        let policy = embedded_context(prepared["messages"][1]["content"].as_str().unwrap()).unwrap();
        assert_eq!(policy["tools"].as_array().unwrap().len(), 1);
        assert!(log.get("toolDirectoryProjection").is_none());
    }
}

fn body(context: &Value, label: &str) -> Value {
    let raw = context.to_string();
    json!({"_opsarkContext":raw,"model":"fixture-model","max_tokens":4096,
        "messages":[{"role":"system","content":"原授权、业务验收及输出规则。"},
            {"role":"user","content":format!("{label}{raw}\n用户原文：不能跳过必要检查") }],
        "response_format":{"type":"json_schema","json_schema":{"name":"fixture-plan","strict":true,
            "schema":{"type":"object","properties":{"steps":{"type":"array","items":{"type":"object"}}},
                "required":["steps"],"additionalProperties":false}}}})
}

fn planning_instruction(body: &Value) -> Option<&str> {
    body["messages"]
        .as_array()?
        .iter()
        .find(|message| message["role"] == "system")?["content"]
        .as_str()
}

fn application_context(body: &Value) -> Value {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user")
        .filter_map(|message| message["content"].as_str())
        .find(|text| !text.starts_with(POLICY_LABEL))
        .and_then(embedded_context)
        .unwrap()
}

fn expand_actual_wire_references(context: &Value) -> Value {
    let mut references = Map::new();
    if let Some(paths) = context["contextReferences"]["paths"].as_array() {
        assert_eq!(context["contextReferences"]["version"], 2);
        for path in paths {
            let from = path.as_str().unwrap().strip_prefix('#').unwrap();
            let reference = context.pointer(from).unwrap();
            assert_eq!(reference.as_object().unwrap().len(), 1);
            assert!(references
                .insert(from.into(), reference["contextRef"].clone())
                .is_none());
        }
    }
    fn expand(
        value: &Value,
        pointer: &str,
        root: &Value,
        references: &Map<String, Value>,
        stack: &mut Vec<String>,
    ) -> Value {
        if let Some(target) = references.get(pointer) {
            assert!(
                stack.len() < 32 && !stack.iter().any(|value| value == pointer),
                "acyclic reference graph required"
            );
            stack.push(pointer.into());
            let target = target.as_str().unwrap().strip_prefix('#').unwrap();
            let result = expand(
                root.pointer(target).unwrap(),
                target,
                root,
                references,
                stack,
            );
            stack.pop();
            return result;
        }
        match value {
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .filter(|(key, _)| !(pointer.is_empty() && key.as_str() == "contextReferences"))
                    .map(|(key, value)| {
                        (
                            key.clone(),
                            expand(
                                value,
                                &format!("{pointer}/{}", key.replace('~', "~0").replace('/', "~1")),
                                root,
                                references,
                                stack,
                            ),
                        )
                    })
                    .collect(),
            ),
            Value::Array(array) => Value::Array(
                array
                    .iter()
                    .enumerate()
                    .map(|(index, value)| {
                        expand(
                            value,
                            &format!("{pointer}/{index}"),
                            root,
                            references,
                            stack,
                        )
                    })
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
    expand(context, "", context, &references, &mut Vec::new())
}

#[test]
fn normal_read_only_planning_adds_organization_without_changing_authority_evidence_or_schema() {
    let original_context = context();
    let original = body(&original_context, "服务器上下文：\n");
    let retained = original.clone();
    let (prepared, diagnostic) = prepare_request(&original);
    assert_eq!(original, retained);
    assert_eq!(prepared["response_format"], original["response_format"]);
    assert_eq!(prepared["max_tokens"], original["max_tokens"]);
    assert_eq!(
        diagnostic["readOnlyPlanningPolicy"]["instructionOnly"],
        true
    );
    let rule = planning_instruction(&prepared).unwrap();
    assert!(rule.starts_with("原授权、业务验收及输出规则。"));
    assert!(rule.contains("同一批准计划应优先包含"));
    assert!(rule.contains("先取证或正常澄清"));
    assert!(rule.contains("不依赖未知返回值"));
    assert!(rule.contains("不得为合并阶段跳过必要工具"));
    assert!(rule.contains("不把预检成功当作完成"));
    let projected = application_context(&prepared);
    for key in [
        "executionConstraints",
        "taskGoal",
        "knownExecutionFacts",
        "server",
        "permission",
    ] {
        assert_eq!(projected[key], original_context[key]);
    }
    assert!(projected.get("_taskModelBudget").is_none());
    assert!(projected.get("_modelRecovery").is_none());
    assert_eq!(
        original_context["_taskModelBudget"]["maxTaskTokens"],
        250000
    );
    assert_eq!(original_context["_modelRecovery"]["startedAtMs"], 1000);
}

#[test]
fn organization_is_not_classification_review_or_permission_expansion() {
    for label in [
        "分类上下文：\n",
        "执行复核上下文：\n",
        "已脱敏的执行结果：\n",
    ] {
        let (prepared, log) = prepare_request(&body(&context(), label));
        assert!(!planning_instruction(&prepared)
            .unwrap()
            .contains(READ_ONLY_PLANNING_RULE));
        assert!(log.get("readOnlyPlanningPolicy").is_none());
    }
    for policy in ["unspecified", "confirm_changes", "requested_changes_only"] {
        let mut context = context();
        context["executionConstraints"]["changePolicy"] = json!(policy);
        context["taskGoal"]["rootGoal"] = json!("用户文字提到 read_only，仍不代表结构化授权");
        let (prepared, _) = prepare_request(&body(&context, "服务器上下文：\n"));
        assert!(!planning_instruction(&prepared)
            .unwrap()
            .contains(READ_ONLY_PLANNING_RULE));
    }
}

#[test]
fn field_local_protocol_and_decision_repairs_do_not_receive_new_planning_guidance() {
    for field in [
        "planGenerationRepair",
        "protocolReplan",
        "operationalRepair",
    ] {
        let mut context = context();
        context[field] = json!({"instruction":"仅修原指定字段，不重新规划"});
        let (prepared, log) = prepare_request(&body(&context, "服务器上下文：\n"));
        assert!(!planning_instruction(&prepared)
            .unwrap()
            .contains(READ_ONLY_PLANNING_RULE));
        assert!(log.get("readOnlyPlanningPolicy").is_none());
    }
    let mut context = context();
    context["workflowPhase"] = json!("protocol_repair");
    let (prepared, _) = prepare_request(&body(&context, "服务器上下文：\n"));
    assert!(!planning_instruction(&prepared)
        .unwrap()
        .contains(READ_ONLY_PLANNING_RULE));
    context.as_object_mut().unwrap().remove("workflowPhase");
    context["failedStep"] = json!({"offendingFields":["validation"]});
    let (prepared, _) = prepare_request(&body(&context, "服务器上下文：\n"));
    assert!(!planning_instruction(&prepared)
        .unwrap()
        .contains(READ_ONLY_PLANNING_RULE));
    for kind in ["scoped", "field", "repair_schema"] {
        let mut request = body(
            &super::read_only_planning_tests::context(),
            "服务器上下文：\n",
        );
        match kind {
            "scoped" => request["_opsarkOperationContract"] = json!("plan.repair@1"),
            "field" => {
                request["_opsarkSchemaCompilation"] =
                    json!({"contractVersion":"format.field-repair@1"})
            }
            _ => {
                request["response_format"]["json_schema"]["schema"]["properties"]["repair"] =
                    json!({"type":"object"})
            }
        }
        let (prepared, _) = prepare_request(&request);
        assert!(!planning_instruction(&prepared)
            .unwrap()
            .contains(READ_ONLY_PLANNING_RULE));
    }
}

#[test]
fn normal_stage_decision_retains_g09_exact_reference_graph_and_all_unknown_facts() {
    let mut context = context();
    let item = json!({"id":"unresolved-read","content":"实际读取资源和日志，保留全部验收条件。".repeat(30),
        "kind":"goal","status":"active","lastReview":{"outcome":"unknown","reason":"能力证据不是资源状态"},
        "source":{"sourceMessageId":"current-message","content":"仅检查，不改配置"}});
    context["workflowPhase"] = json!("decide_after_phase");
    context["taskGoal"]["lifecycle"] = json!({"revision":3,"items":[item]});
    context["taskGoal"]["requirementContext"] =
        json!({"focus":[item],"activeGoals":[item],"activeConstraints":[]});
    context["baseSnapshot"] = json!({"taskRequirements":context["taskGoal"],"currentIncident":{"status":"failed",
        "result":{"executionStatus":"unknown","facts":{"capturedPartial":true,"opaque":{"contextRef":"#/taskGoal/rootGoal"}}}}});
    let original = body(&context, "阶段结束决策上下文：\n");
    let (prepared, log) = prepare_request(&original);
    assert!(planning_instruction(&prepared)
        .unwrap()
        .contains(READ_ONLY_PLANNING_RULE));
    assert_eq!(log["contextProjection"]["version"], 2);
    let projected = application_context(&prepared);
    assert_eq!(projected["contextReferences"]["version"], 2);
    assert_eq!(
        projected["taskGoal"]["lifecycle"],
        context["taskGoal"]["lifecycle"]
    );
    assert_eq!(
        projected["baseSnapshot"]["currentIncident"],
        context["baseSnapshot"]["currentIncident"]
    );
    assert_eq!(prepared["response_format"], original["response_format"]);
}

#[test]
fn no_hidden_context_or_system_message_cannot_inject_or_elevate_planning_rules() {
    let mut original = body(&context(), "服务器上下文：\n");
    original.as_object_mut().unwrap().remove("_opsarkContext");
    assert_eq!(prepare_request(&original).0, original);
    let mut original = body(&context(), "服务器上下文：\n");
    original["messages"].as_array_mut().unwrap().remove(0);
    let (prepared, log) = prepare_request(&original);
    assert!(prepared["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|message| message["role"] == "user"));
    assert!(log.get("readOnlyPlanningPolicy").is_none());
}

#[test]
fn repeats_preserve_a_single_stable_rule_and_capability_validity_is_not_rewritten() {
    let original_context = context();
    let mut original = body(&original_context, "服务器上下文：\n");
    original["messages"][0]["content"] = json!(format!("原规则\n{READ_ONLY_PLANNING_RULE}"));
    let (prepared, _) = prepare_request(&original);
    assert_eq!(
        planning_instruction(&prepared)
            .unwrap()
            .matches(READ_ONLY_PLANNING_RULE)
            .count(),
        1
    );
    let projected = application_context(&prepared);
    assert_eq!(
        projected["server"]["hostCapabilities"],
        original_context["server"]["hostCapabilities"]
    );
    assert!(planning_instruction(&prepared)
        .unwrap()
        .contains("控制器有效期仍匹配"));
    assert!(planning_instruction(&prepared)
        .unwrap()
        .contains("null、未列出的能力、过期或失败不是支持"));
}

#[test]
fn satisfied_stage_retains_empty_completion_contract_and_does_not_create_probe_steps() {
    let mut context = context();
    context["workflowPhase"] = json!("decide_after_phase");
    context["taskGoal"]["lifecycle"] = json!({"revision":4,"lastReview":{"overallOutcome":"completed","focusOutcome":"completed"},
        "items":[{"id":"verified-goal","status":"satisfied","evidenceIds":["actual-read"],
            "lastReview":{"outcome":"satisfied","evidenceIds":["actual-read"],"reason":"当前目标真实验收充分"}}]});
    context["baseSnapshot"] = json!({"currentToolResults":[{"evidenceId":"actual-read","complete":true,"targetId":"fixture"}]});
    let mut original = body(&context, "阶段结束决策上下文：\n");
    original["response_format"]["json_schema"]["schema"]["properties"]["decision"] =
        json!({"enum":["complete","continue","adjust"]});
    original["response_format"]["json_schema"]["schema"]["properties"]["steps"]["minItems"] =
        json!(0);
    let (prepared, _) = prepare_request(&original);
    assert_eq!(prepared["response_format"], original["response_format"]);
    let projected = application_context(&prepared);
    assert_eq!(projected["taskGoal"], context["taskGoal"]);
    assert_eq!(projected["baseSnapshot"], context["baseSnapshot"]);
    assert!(
        projected.get("steps").is_none(),
        "guidance cannot create executable actions"
    );
    assert!(planning_instruction(&prepared)
        .unwrap()
        .contains("仍按原合同返回 complete、steps=[]"));
    assert!(planning_instruction(&prepared)
        .unwrap()
        .contains("不为组织计划制造新检查"));
}

#[test]
#[ignore = "需显式提供冻结历史wire路径；仅离线核对规划规则和既有G09，不调用模型"]
fn replay_archived_plans_accepts_only_the_new_system_rule_and_retains_exact_wire_contexts() {
    let path =
        std::env::var("OPSARK_PREFLIGHT_REPLAY_LOG").expect("explicit read-only log path required");
    let raw = std::fs::read_to_string(&path).unwrap();
    let mut results = Vec::new();
    for line in raw.lines() {
        let event: Value = serde_json::from_str(line).unwrap();
        if event["event"] != "request_sent" {
            continue;
        }
        let before = &event["request"];
        let mut policy = Map::new();
        let mut context = None;
        let mut messages = Vec::new();
        for message in before["messages"].as_array().unwrap() {
            let text = message["content"].as_str().unwrap_or_default();
            if text.starts_with(POLICY_LABEL) {
                policy.extend(embedded_context(text).unwrap().as_object().unwrap().clone());
                continue;
            }
            if message["role"] == "user" {
                if let Some(projected) = embedded_context(text) {
                    context = Some((projected.clone(), expand_actual_wire_references(&projected)));
                }
            }
            messages.push(message.clone());
        }
        let (projected, mut original_context) = context.unwrap();
        original_context.as_object_mut().unwrap().extend(policy);
        let original_raw = original_context.to_string();
        for message in &mut messages {
            if let Some(text) = message["content"].as_str() {
                if message["role"] == "user" && text.contains(&projected.to_string()) {
                    message["content"] =
                        json!(text.replacen(&projected.to_string(), &original_raw, 1));
                }
            }
        }
        let mut input = before.clone();
        input["messages"] = json!(messages);
        input["_opsarkContext"] = json!(original_raw);
        let retained = input.clone();
        let (prepared, diagnostic) = prepare_request(&input);
        assert_eq!(input, retained);
        for key in [
            "response_format",
            "max_tokens",
            "max_completion_tokens",
            "max_output_tokens",
            "model",
            "stream",
        ] {
            assert_eq!(
                prepared[key], before[key],
                "whole response contract and output parameters stay unchanged"
            );
        }
        assert_eq!(prepared["messages"].as_array().unwrap().iter().filter(|message| message["role"] != "system").collect::<Vec<_>>(),
            before["messages"].as_array().unwrap().iter().filter(|message| message["role"] != "system").collect::<Vec<_>>(),
            "every actual policy/context/user message must be byte-for-byte unchanged, including G09 references");
        let applied = diagnostic.get("readOnlyPlanningPolicy").is_some();
        let before_system = planning_instruction(before).unwrap();
        let expected = if applied && !before_system.contains(READ_ONLY_PLANNING_RULE) {
            format!("{before_system}\n{READ_ONLY_PLANNING_RULE}")
        } else {
            before_system.into()
        };
        assert_eq!(planning_instruction(&prepared), Some(expected.as_str()));
        let mut restored = None;
        let mut restored_policy = Map::new();
        for message in prepared["messages"].as_array().unwrap() {
            let text = message["content"].as_str().unwrap_or_default();
            if let Some(context) = embedded_context(text) {
                if text.starts_with(POLICY_LABEL) {
                    restored_policy.extend(context.as_object().unwrap().clone());
                } else {
                    restored = Some(expand_actual_wire_references(&context));
                }
            }
        }
        let mut restored = restored.unwrap();
        restored.as_object_mut().unwrap().extend(restored_policy);
        assert_eq!(
            restored, original_context,
            "wire-only whitelist restores all scope, source, authority, evidence and acceptance"
        );
        results.push(json!({"requestId":event["requestId"],"requestName":event["requestName"],
            "beforeWireBytes":before.to_string().len(),"afterWireBytes":prepared.to_string().len(),
            "addedWireBytes":prepared.to_string().len()-before.to_string().len(),"planningRuleApplied":applied,
            "allNonSystemMessagesExactlyEqual":true,"fullResponseAndOutputParametersEqual":true,
            "g09RestoredOnlyFromWireWhitelist":true,"hiddenDiagnosticUsedForExpansion":false}));
    }
    assert!(!results.is_empty());
    println!(
        "只读预检组织历史离线核对 {}",
        json!({"sourcePath":path,"callsModel":false,
        "unit":"utf8_bytes_not_tokens","doesNotProveFewerStagesOrLowerActualUsage":true,"requests":results})
    );
}
