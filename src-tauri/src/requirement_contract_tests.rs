use super::*;

fn static_acceptance_fixture() -> (Value, Value, String) {
    let source = "将 /srv/releases/site.tar.gz 发布到 http://site.example/，保留旧网站且不影响其他站点".to_string();
    let context = json!({"requirementSubmission":{"baseRevision":0,"sourceMessageId":"static-source",
        "content":source,"acceptanceContractVersion":1}});
    let delta = json!({"baseRevision":0,"sourceMessageId":"static-source","changes":[],
        "additions":[
            {"id":"publish","kind":"goal","content":"发布静态站点","sourceQuote":source,"supersedes":[]},
            {"id":"preserve","kind":"constraint","content":"保留旧网站且不影响其他站点",
                "sourceQuote":"保留旧网站且不影响其他站点","supersedes":[]}],
        "focusIds":["publish","preserve"],"acceptanceCoverage":[
            {"requirementId":"publish","strategy":"static_site","sourceQuote":source,"reason":"交付指定压缩包到网站入口",
                "staticSite":{"artifactPath":"/srv/releases/site.tar.gz","entryUrl":"http://site.example/",
                    "preserveExisting":true,"preserveOtherSites":true}},
            {"requirementId":"preserve","strategy":"general_review","sourceQuote":"保留旧网站且不影响其他站点",
                "reason":"保护约束持续生效，并由站点条件核对备份与对照资源"}]});
    (context, delta, source)
}

#[test]
fn new_submissions_require_exact_acceptance_coverage_but_legacy_remains_readable() {
    let (context, delta, source) = static_acceptance_fixture();
    let valid = |context: &Value, delta: &Value| requirement_contract::validate_update(
        "execute", Some("new_goal"), Some(delta), &context.to_string(), &source);
    assert!(valid(&context, &delta).is_none());
    let mut missing = delta.clone();
    missing.as_object_mut().unwrap().remove("acceptanceCoverage");
    assert!(valid(&context, &missing).unwrap().contains("acceptanceCoverage"));
    let mut legacy = context.clone();
    legacy["requirementSubmission"].as_object_mut().unwrap().remove("acceptanceContractVersion");
    assert!(valid(&legacy, &missing).is_none());
    let mut future = context.clone();
    future["requirementSubmission"]["acceptanceContractVersion"] = json!(2);
    assert!(valid(&future, &delta).unwrap().contains("版本不支持"));
    for invalid in [json!([]), json!([delta["acceptanceCoverage"][0]]),
        json!([delta["acceptanceCoverage"][0], delta["acceptanceCoverage"][0]]),
        json!([delta["acceptanceCoverage"][0], {"requirementId":"unknown","strategy":"general_review",
            "sourceQuote":"保留旧网站","reason":"不能引用未知要求"}])] {
        let mut changed = delta.clone();
        changed["acceptanceCoverage"] = invalid;
        assert!(valid(&context, &changed).is_some());
    }
}

#[test]
fn acceptance_contract_rejects_invented_sources_and_strategy_shape_changes() {
    let (context, delta, source) = static_acceptance_fixture();
    for (pointer, value) in [
        ("/acceptanceCoverage/0/sourceQuote", json!("非用户原文")),
        ("/acceptanceCoverage/0/reason", json!(" ")),
        ("/acceptanceCoverage/0/staticSite/artifactPath", json!("/other/current.tar.gz")),
        ("/acceptanceCoverage/0/staticSite/entryUrl", json!("http://attacker.example/")),
        ("/acceptanceCoverage/0/strategy", json!("general_review")),
        ("/acceptanceCoverage/0/strategy", json!("unknown")),
        ("/acceptanceCoverage/0/staticSite", Value::Null),
        ("/additions/0/kind", json!("constraint")),
    ] {
        let mut invalid = delta.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(requirement_contract::validate_update("execute", Some("new_goal"),
            Some(&invalid), &context.to_string(), &source).is_some(), "{pointer}");
    }
    let mut pending = delta;
    pending["acceptanceCoverage"][0]["staticSite"]["artifactPath"] = Value::Null;
    pending["acceptanceCoverage"][0]["staticSite"]["entryUrl"] = Value::Null;
    assert!(requirement_contract::validate_update("execute", Some("new_goal"),
        Some(&pending), &context.to_string(), &source).is_none());
}

#[test]
fn acceptance_contract_rejects_unsafe_parameter_shapes_even_when_user_supplied() {
    for (field, invalid) in [("artifactPath", "/"), ("artifactPath", "/srv/../etc/archive.tar"),
        ("artifactPath", "/srv//archive.tar"), ("artifactPath", "/srv/\\archive.tar"),
        ("entryUrl", "file:///srv/site"), ("entryUrl", "https://user:password@site.example/"),
        ("entryUrl", "https://site.example/#fragment")] {
        let (mut context, mut delta, source) = static_acceptance_fixture();
        let source = format!("{source}，补充参数 {invalid}");
        context["requirementSubmission"]["content"] = json!(source);
        delta["acceptanceCoverage"][0]["staticSite"][field] = json!(invalid);
        assert!(requirement_contract::validate_update("execute", Some("new_goal"), Some(&delta),
            &context.to_string(), &source).is_some(), "{field}={invalid}");
    }
}

#[test]
fn acceptance_contract_survives_actual_planning_projection_and_continue() {
    let (context, delta, source) = static_acceptance_fixture();
    let projected = project(&context, "new_goal", &delta, &source, &Value::Null);
    let state = &projected["taskGoal"]["lifecycle"];
    assert_eq!(state["items"][0]["acceptance"]["staticSite"], delta["acceptanceCoverage"][0]["staticSite"]);
    assert_eq!(state["items"][1]["acceptance"]["strategy"], "general_review");
    assert!(state["items"][0]["acceptance"].get("requirementId").is_none());
    let next_context = json!({"requirementSubmission":{"baseRevision":1,"sourceMessageId":"continue-source",
        "content":"继续","acceptanceContractVersion":1,"baseLifecycle":state}});
    let mut next_delta = json!({"baseRevision":1,"sourceMessageId":"continue-source","additions":[],"changes":[],
        "focusIds":["publish","preserve"],"acceptanceCoverage":[]});
    let continued = project(&next_context, "continue", &next_delta, "继续", &Value::Null);
    assert_eq!(continued["taskGoal"]["lifecycle"]["items"][0]["acceptance"], state["items"][0]["acceptance"]);
    next_delta["acceptanceCoverage"] = json!([{"requirementId":"publish","strategy":"general_review",
        "sourceQuote":"继续","reason":"不能用继续重写历史验收契约"}]);
    assert!(requirement_contract::validate_update("execute", Some("continue"), Some(&next_delta),
        &next_context.to_string(), "继续").is_some());
}

#[test]
fn acceptance_contract_round_trips_in_both_model_protocols_and_strict_modes() {
    let (context, delta, source) = static_acceptance_fixture();
    let value = json!({"intent":"execute","relation":"new_goal","answer":"","terminalContextLines":0,
        "selectedSkillIds":[],"constraints":{"changePolicy":"requested_changes_only","environmentPolicy":"preserve",
            "failurePolicy":"strict","prohibitedActions":[],"requiredConditions":[],"userDirectives":[]},
        "requirementUpdate":delta});
    for protocol in ["chat_completions", "responses"] {
        for strict in [false, true] {
            let decoded = normalized("需求理解", protocol, strict, &value);
            assert_eq!(decoded["requirementUpdate"]["acceptanceCoverage"], delta["acceptanceCoverage"], "{protocol}/{strict}");
            assert!(requirement_contract::validate_update("execute", Some("new_goal"), decoded.get("requirementUpdate"),
                &context.to_string(), &source).is_none());
        }
    }
    assert!(requirement_contract::update_rule().contains(requirement_contract::ACCEPTANCE_RULE));
}

fn normalized(operation: &str, protocol: &str, strict: bool, value: &Value) -> Value {
    let schema = model_compatibility::contract(operation, &json!({})).unwrap();
    let compiled = model_schema::compile(&schema).unwrap();
    let mut wire_value = value.clone();
    if strict {
        // Strict wire schemas encode optional fields as required nullable ones.
        // Supply the provider's null placeholders, then verify normalization
        // removes them without changing legacy domain responses.
        if let Some(delta) = wire_value.get_mut("requirementUpdate").and_then(Value::as_object_mut) {
            let coverage = delta.entry("acceptanceCoverage").or_insert(Value::Null);
            if let Some(items) = coverage.as_array_mut() {
                for item in items {
                    item.as_object_mut().unwrap().entry("staticSite").or_insert(Value::Null);
                }
            }
        }
    }
    let mut payload = if protocol == "responses" {
        json!({"status":"completed","output":[{"type":"message","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":wire_value.to_string()}]}]})
    } else {
        json!({"choices":[{"message":{"role":"assistant","content":wire_value.to_string()},"finish_reason":"stop"}]})
    };
    model_protocol::normalize_response(&mut payload, protocol).unwrap();
    model_compatibility::normalize_response_with_wire(
        &mut payload,
        &schema,
        strict.then_some(&compiled.schema),
    )
    .unwrap();
    serde_json::from_str(
        payload["choices"][0]["message"]["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}

fn update() -> Value {
    json!({"baseRevision":2,"sourceMessageId":"message-firewall",
        "additions":[{"id":"goal-port-8081","kind":"goal","content":"8081/tcp 已加入永久规则",
            "sourceQuote":"将 8081 加入永久规则","supersedes":[]}],
        "changes":[{"id":"goal-external-entry","status":"deferred","sourceQuote":"其他先暂缓","reason":"用户本轮仅处理防火墙"}],
        "focusIds":["goal-port-8081"]})
}

fn review(focus: &str) -> Value {
    json!({"baseRevision":3,"roundId":"round-firewall","focusOutcome":focus,"overallOutcome":"pending",
        "items":[{"requirementId":"goal-port-8081","outcome":if focus == "completed" {"satisfied"} else {"unknown"},
            "evidenceIds":["evidence-firewall-query"],"reason":"永久规则和运行时规则已查询；外部访问入口仍另行处理"}]})
}

fn stage() -> Value {
    json!({"decision":"adjust","reason":"继续获取外部入口的只读证据","summary":"防火墙证据已保留",
        "steps":[{"kind":"observe","title":"检查规则","description":"读取同一目标的永久规则",
            "action":{"type":"shell","command":"firewall-cmd --permanent --query-port=8081/tcp"},
            "expected":"取得真实查询结果","validation":"","risk":"low",
            "executionScope":null,"validationScope":null,"runtimeClass":null,
            "sessionContextChange":null,"recovery":null,"retryBasis":null}],
        "planUpdate":null,"reconciliation":null,"requirementReview":review("pending"),
        "blocking":{"kind":"external","reason":"外部入口尚未可达","requirementIds":["goal-external-entry"]},
        "issueResolutions":[{"issueId":"issue-firewall-validation","evidenceIds":["evidence-firewall-query"],
            "reason":"后续独立查询补齐了此前被拦截的后置验收"}]})
}

#[test]
fn requirement_updates_round_trip_through_both_apis_and_output_modes() {
    let source = "将 8081 加入永久规则，其他先暂缓";
    let context = json!({"requirementSubmission":{"baseRevision":2,"sourceMessageId":"message-firewall",
        "baseLifecycle":{"version":1,"revision":2,"items":[requirement_item("goal-external-entry", "goal", "处理外部入口", "active")],
            "focus":{"requirementIds":["goal-external-entry"]}}}}).to_string();
    for protocol in ["chat_completions", "responses"] {
        for strict in [false, true] {
            for change in [Value::Null, update()] {
                let executing = !change.is_null();
                let value = json!({"intent":if executing {"execute"} else {"answer"},
                    "relation":if executing {"supplement"} else {"side_question"},
                    "answer":if executing {""} else {"历史结果仅作参考。"},
                    "constraints":if executing {json!({"changePolicy":"requested_changes_only","environmentPolicy":"preserve",
                        "failurePolicy":"strict","prohibitedActions":[],"requiredConditions":[],"userDirectives":[]})} else {Value::Null},
                    "terminalContextLines":0,"selectedSkillIds":[],"requirementUpdate":change});
                let decoded = normalized("需求理解", protocol, strict, &value);
                let native: AiRequirementDecision = serde_json::from_value(decoded).unwrap();
                assert_eq!(
                    native.requirement_update.as_ref(),
                    executing.then_some(&change)
                );
                assert!(requirement_contract::validate_update(
                    &native.intent,
                    native.relation.as_deref(),
                    native.requirement_update.as_ref(),
                    &context,
                    source
                )
                .is_none());
                let response = RequirementProcessingResult {
                    intent: native.intent,
                    relation: native.relation,
                    answer: Some(native.answer),
                    plan: Vec::new(),
                    constraints: if native.constraints.is_null() {
                        None
                    } else {
                        Some(serde_json::from_value(native.constraints).unwrap())
                    },
                    terminal_context_lines: native.terminal_context_lines,
                    selected_skill_ids: native.selected_skill_ids,
                    plan_error: None,
                    developer_trace: ModelDeveloperTrace::default(),
                    requirement_update: native.requirement_update,
                };
                let returned = serde_json::to_value(response).unwrap();
                if executing {
                    assert_eq!(
                        returned["requirementUpdate"], change,
                        "{protocol}, strict={strict}"
                    );
                } else {
                    assert!(
                        returned.get("requirementUpdate").is_none(),
                        "{protocol}, strict={strict}"
                    );
                }
            }
        }
    }
}

#[test]
fn stage_metadata_survives_wire_normalization_and_native_conversion() {
    for protocol in ["chat_completions", "responses"] {
        for strict in [false, true] {
            let value = stage();
            let decoded = normalized("阶段联合决策", protocol, strict, &value);
            let native: AiNextStageDecision = serde_json::from_value(decoded).unwrap();
            let converted = validate_next_stage_preserving_recovery(
                native,
                &AiGenerationSettings::default(),
                None,
            )
            .unwrap();
            let returned = serde_json::to_value(converted).unwrap();
            for field in ["requirementReview", "blocking", "issueResolutions"] {
                assert_eq!(
                    returned[field], value[field],
                    "{protocol}, strict={strict}, {field}"
                );
            }
            assert_eq!(returned["steps"].as_array().unwrap().len(), 1);
            assert_eq!(returned["steps"][0]["action"], value["steps"][0]["action"]);
        }
    }
}

#[test]
fn native_plan_rejection_retains_requirement_and_issue_decisions_in_both_error_envelopes() {
    for recovery_error in [false, true] {
        let mut value = stage();
        // These are rejected proposals only; no execution transport is involved.
        value["steps"][0]["action"]["command"] = json!(if recovery_error {
            "firewall-cmd --reload"
        } else {
            "opsark-tool"
        });
        let native: AiNextStageDecision = serde_json::from_value(value.clone()).unwrap();
        let error =
            validate_next_stage_preserving_recovery(native, &AiGenerationSettings::default(), None)
                .unwrap_err();
        let envelope: Value = serde_json::from_str(&error).unwrap();
        for field in ["requirementReview", "blocking", "issueResolutions"] {
            assert_eq!(
                envelope["nextStageDecision"][field], value[field],
                "recovery_error={recovery_error}, {field}"
            );
        }
        if recovery_error {
            assert_eq!(envelope["issue"]["code"], "OBSERVE_COMMAND_MUTATION");
            assert_eq!(envelope["steps"].as_array().unwrap().len(), 1);
        } else {
            assert_eq!(envelope["kind"], "plan_protocol_failure");
            assert_eq!(envelope["rejectedPlanExecuted"], false);
        }
    }
}

#[test]
fn completed_focus_with_pending_overall_accepts_empty_adjust_and_null_optional_fields() {
    for protocol in ["chat_completions", "responses"] {
        for strict in [false, true] {
            let value = json!({"decision":"adjust","reason":"本轮防火墙要求已满足，其他事项暂缓",
                "summary":"8081/tcp 永久规则和运行时规则已确认；外部入口仍待处理","steps":[],
                "planUpdate":null,"reconciliation":null,"requirementReview":review("completed"),
                "blocking":null,"issueResolutions":null});
            let decoded = normalized("阶段联合决策", protocol, strict, &value);
            let native: AiNextStageDecision = serde_json::from_value(decoded).unwrap();
            assert!(native.blocking.is_none());
            assert!(native.issue_resolutions.is_none());
            let result =
                validate_and_convert_ai_next_stage(native, &AiGenerationSettings::default(), None)
                    .unwrap();
            assert_eq!(result.decision, "adjust");
            assert!(result.steps.is_empty());
            assert_eq!(
                result.requirement_review.as_ref().unwrap()["focusOutcome"],
                "completed"
            );
            assert_eq!(
                result.requirement_review.as_ref().unwrap()["overallOutcome"],
                "pending"
            );
        }
    }
}

#[test]
fn requirement_lifecycle_keeps_full_context_and_allows_empty_adjust_during_missing_steps_repair() {
    let rejected = json!({"decision":"adjust","reason":"本轮已完成","summary":"永久规则已确认"});
    let mut context = json!({"protocolReplan":{"errorCode":"next_stage_response_invalid",
        "rejectedResponse":{"content":rejected.to_string()}},
        "baseSnapshot":{"currentToolResults":[{"evidenceId":"evidence-firewall-query","permanent":true,"runtime":true}]}});
    assert!(next_stage_format::repair_context(&context.to_string()).is_some());
    context["taskGoal"] = json!({"lifecycle":{"version":1,"revision":3},
        "requirementContext":{"focus":[{"id":"goal-port-8081"}],"deferred":[{"id":"goal-external-entry"}]}});
    let raw_context = context.to_string();
    assert!(next_stage_format::repair_context(&raw_context).is_none());
    let request = build_next_stage_request_body(
        "offline-test",
        "将 8081 加入永久规则",
        &raw_context,
        &AiGenerationSettings::default(),
    );
    let forwarded: Value =
        serde_json::from_str(request["_opsarkContext"].as_str().unwrap()).unwrap();
    assert_eq!(forwarded["baseSnapshot"], context["baseSnapshot"]);
    assert_eq!(forwarded["taskGoal"], context["taskGoal"]);
    assert!(forwarded.get("formatRepair").is_none());
    let repaired = json!({"decision":"adjust","reason":"本轮已完成，其他有效事项仍暂缓","summary":"规则已确认",
        "steps":[],"requirementReview":review("completed")});
    let payload = json!({"choices":[{"message":{"content":repaired.to_string()}}]});
    let native = parse_next_stage_with_format_guard(&payload, &raw_context).unwrap();
    let converted =
        validate_next_stage_preserving_recovery(native, &AiGenerationSettings::default(), None)
            .unwrap();
    assert_eq!(converted.requirement_review, Some(review("completed")));
    assert!(converted.steps.is_empty());
}

fn requirement_item(id: &str, kind: &str, content: &str, status: &str) -> Value {
    json!({"id":id,"kind":kind,"content":content,"status":status,
        "source":{"content":"部署网站，端口为8080，只允许内网访问","relation":"new_goal","source":"user_message",
            "sourceMessageId":"message-original","sourceRoundId":"round-original","createdAt":"2026-09-29T00:00:00Z"},
        "evidenceIds":if status == "satisfied" {vec!["evidence-deploy"]} else {vec![]}})
}

fn projection_fixture() -> (Value, Value, Value, String) {
    let current = "把端口改为8081，继续只允许内网访问".to_string();
    let private_history = format!("{}PRIVATE_UNCOMPRESSED_HISTORY", "历史完成过程".repeat(80));
    let base = json!({"version":1,"revision":5,"items":[
        requirement_item("goal-deploy", "goal", &private_history, "satisfied"),
        requirement_item("port-8080", "constraint", "端口为8080", "active"),
        requirement_item("internal-only", "constraint", "只允许内网访问", "active"),
        requirement_item("goal-external-entry", "goal", "排查外部入口502", "active")],
        "focus":{"roundId":"round-before","sourceMessageId":"message-original","requirementIds":["port-8080"]},
        "lastReview":{"revision":5,"roundId":"round-before","focusOutcome":"completed","overallOutcome":"pending"}});
    let mut visible = base.clone();
    visible["items"].as_array_mut().unwrap().remove(0);
    let context = json!({"taskGoal":{"rootGoal":"部署网站，端口为8080，只允许内网访问","currentInstruction":"继续检查8080",
        "currentRoundId":"round-before","lifecycle":visible,
        "requirementContext":{"focus":[{"id":"port-8080","content":"端口为8080"}],"activeConstraints":[{"id":"port-8080","content":"端口为8080"}]}},
        "requirementSubmission":{"sourceMessageId":"message-new","baseRevision":5,"content":current,
            "createdAt":"2026-09-29T01:00:00Z","baseLifecycle":base},
        "executionConstraints":{"changePolicy":"read_only","environmentPolicy":"preserve","failurePolicy":"strict",
            "userDirectives":["端口为8080"],"prohibitedActions":["禁止删除"],
            "requiredConditions":["端口为8080","只允许内网访问","旧版未映射限制"]},
        "baseSnapshot":{"requirementSubmission":{"baseLifecycle":base},"evidence":[{"id":"evidence-deploy"}]}});
    let delta = json!({"baseRevision":5,"sourceMessageId":"message-new","additions":[
        {"id":"port-8081","kind":"constraint","content":"端口为8081","sourceQuote":"把端口改为8081","supersedes":["port-8080"]}],
        "changes":[],"focusIds":["port-8081"]});
    let classified = json!({"changePolicy":"requested_changes_only","environmentPolicy":"unspecified","failurePolicy":"unspecified",
        "userDirectives":[],"prohibitedActions":[],"requiredConditions":["端口为8081"]});
    (context, delta, classified, current)
}

fn project(
    context: &Value,
    relation: &str,
    delta: &Value,
    current: &str,
    classified: &Value,
) -> Value {
    serde_json::from_str(
        &requirement_contract::project_classified_context(
            &context.to_string(),
            Some(relation),
            Some(delta),
            current,
            Some(classified),
        )
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn planning_projection_replaces_old_port_and_preserves_effective_constraints_and_history() {
    let (context, delta, classified, current) = projection_fixture();
    let projected = project(&context, "supplement", &delta, &current, &classified);
    let goal = &projected["taskGoal"];
    assert_eq!(goal["currentInstruction"], current);
    assert_eq!(goal["rootGoal"], context["taskGoal"]["rootGoal"]);
    assert_eq!(goal["lifecycle"]["revision"], 6);
    assert_eq!(
        goal["lifecycle"]["focus"]["requirementIds"],
        json!(["port-8081"])
    );
    assert_eq!(goal["lifecycle"]["focus"]["roundId"], "round-before");
    assert_eq!(goal["requirementContext"]["focus"][0]["id"], "port-8081");
    let active = goal["requirementContext"]["activeConstraints"]
        .as_array()
        .unwrap();
    assert_eq!(
        active
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["internal-only", "port-8081"]
    );
    let new_port = active
        .iter()
        .find(|item| item["id"] == "port-8081")
        .unwrap();
    assert_eq!(new_port["source"]["sourceMessageId"], "message-new");
    assert!(new_port["source"].get("sourceRoundId").is_none());
    assert_eq!(new_port["source"]["createdAt"], "2026-09-29T01:00:00Z");
    assert_eq!(new_port["lastChangedAt"], new_port["source"]["createdAt"]);
    let history = goal["requirementContext"]["historical"].as_array().unwrap();
    assert!(history.iter().any(|item| item["id"] == "goal-deploy"
        && item["status"] == "satisfied"
        && item["evidenceIds"] == json!(["evidence-deploy"])));
    assert!(history
        .iter()
        .any(|item| item["id"] == "port-8080" && item["status"] == "superseded"));
    assert!(!projected.to_string().contains("baseLifecycle"));
    assert!(!projected
        .to_string()
        .contains("PRIVATE_UNCOMPRESSED_HISTORY"));
    assert_eq!(
        projected["baseSnapshot"]["evidence"],
        context["baseSnapshot"]["evidence"]
    );
    assert_eq!(
        projected["baseSnapshot"]["taskRequirements"],
        projected["taskGoal"]
    );
    assert!(goal["lifecycle"].get("lastReview").is_none());
    assert_eq!(
        projected["executionConstraints"]["requiredConditions"],
        json!(["只允许内网访问", "旧版未映射限制", "端口为8081"])
    );
    assert_eq!(
        projected["executionConstraints"]["userDirectives"],
        json!([])
    );
    assert_eq!(
        projected["executionConstraints"]["prohibitedActions"],
        json!(["禁止删除"])
    );
    assert_eq!(
        projected["executionConstraints"]["environmentPolicy"],
        "preserve"
    );
    assert_eq!(projected["executionConstraints"]["failurePolicy"], "strict");
    assert_eq!(
        projected["executionConstraints"]["changePolicy"],
        "requested_changes_only"
    );
    assert_eq!(
        context["requirementSubmission"]["baseLifecycle"]["revision"],
        5
    );
}

#[test]
fn first_requirement_projects_empty_lifecycle_without_inventing_round_or_timestamp() {
    let current = "部署网站，仅内网访问";
    let context = json!({"taskGoal":{"lifecycle":{"version":1,"revision":0,"items":[],"focus":{"requirementIds":[]}}},
        "requirementSubmission":{"baseRevision":0,"sourceMessageId":"first-message","content":current,
            "baseLifecycle":{"version":1,"revision":0,"items":[],"focus":{"requirementIds":[]}}}});
    let delta = json!({"baseRevision":0,"sourceMessageId":"first-message","additions":[
        {"id":"deploy","kind":"goal","content":"部署网站","sourceQuote":"部署网站","supersedes":[]},
        {"id":"internal","kind":"constraint","content":"仅内网访问","sourceQuote":"仅内网访问","supersedes":[]}],
        "changes":[],"focusIds":["deploy","internal"]});
    let classified = projection_fixture().2;
    let projected = project(&context, "new_goal", &delta, current, &classified);
    assert_eq!(projected["taskGoal"]["rootGoal"], current);
    assert_eq!(projected["taskGoal"]["currentInstruction"], current);
    assert_eq!(projected["taskGoal"]["lifecycle"]["revision"], 1);
    assert!(projected["taskGoal"]["lifecycle"]["focus"]
        .get("roundId")
        .is_none());
    for item in projected["taskGoal"]["lifecycle"]["items"]
        .as_array()
        .unwrap()
    {
        assert_eq!(item["source"]["sourceMessageId"], "first-message");
        assert!(item["source"].get("sourceRoundId").is_none());
        assert!(item["source"].get("createdAt").is_none());
    }
}

#[test]
fn independent_and_replacement_goals_do_not_inherit_prior_obligations_or_constraints() {
    let (mut context, _, mut classified, _) = projection_fixture();
    let current = "检查数据库状态";
    context["requirementSubmission"]["content"] = json!(current);
    classified["changePolicy"] = json!("read_only");
    classified["requiredConditions"] = json!([]);
    let delta = json!({"baseRevision":5,"sourceMessageId":"message-new","additions":[
        {"id":"database-status","kind":"goal","content":current,"sourceQuote":current,"supersedes":[]}],
        "changes":[],"focusIds":["database-status"]});
    for relation in ["new_goal", "replace_goal"] {
        let projected = project(&context, relation, &delta, current, &classified);
        assert_eq!(projected["taskGoal"]["rootGoal"], current);
        assert_eq!(projected["taskGoal"]["lifecycle"]["revision"], 6);
        assert_eq!(
            projected["taskGoal"]["lifecycle"]["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            projected["taskGoal"]["requirementContext"]["historicalCount"],
            0
        );
        assert_eq!(
            projected["taskGoal"]["requirementContext"]["activeConstraints"],
            json!([])
        );
        assert_eq!(projected["executionConstraints"], classified);
        let mut cross_task = delta.clone();
        cross_task["additions"][0]["supersedes"] = json!(["port-8080"]);
        assert!(requirement_contract::validate_update(
            "execute",
            Some(relation),
            Some(&cross_task),
            &context.to_string(),
            current
        )
        .is_some());
    }
}

#[test]
fn classification_hides_full_private_lifecycle_but_validates_delta_against_it() {
    let (context, mut delta, _, current) = projection_fixture();
    let compact: Value =
        serde_json::from_str(&requirement_classification_context(&context.to_string()).unwrap())
            .unwrap();
    assert!(!compact.to_string().contains("baseLifecycle"));
    assert!(!compact.to_string().contains("PRIVATE_UNCOMPRESSED_HISTORY"));
    assert_eq!(
        compact["requirementSubmission"]["sourceMessageId"],
        "message-new"
    );
    // This completed item was intentionally omitted from the model lifecycle;
    // the immutable local base still supplies its exact identity for replacement.
    delta["additions"][0]["supersedes"] = json!(["goal-deploy"]);
    assert!(requirement_contract::validate_update(
        "execute",
        Some("supplement"),
        Some(&delta),
        &context.to_string(),
        &current
    )
    .is_none());
    delta["focusIds"] = json!(["missing-goal"]);
    assert!(requirement_contract::validate_update(
        "execute",
        Some("supplement"),
        Some(&delta),
        &context.to_string(),
        &current
    )
    .is_some());
}

#[test]
fn continuation_preserves_current_instruction_and_policy_but_cannot_change_obligations() {
    let (mut context, _, classified, _) = projection_fixture();
    let current = "继续";
    context["requirementSubmission"]["content"] = json!(current);
    let mut delta = json!({"baseRevision":5,"sourceMessageId":"message-new","additions":[],"changes":[],"focusIds":["goal-external-entry"]});
    let projected = project(&context, "continue", &delta, current, &classified);
    assert_eq!(
        projected["taskGoal"]["currentInstruction"],
        context["taskGoal"]["currentInstruction"]
    );
    assert_eq!(
        projected["executionConstraints"],
        context["executionConstraints"]
    );
    assert_eq!(
        projected["taskGoal"]["lifecycle"]["focus"]["requirementIds"],
        json!(["goal-external-entry"])
    );
    delta["changes"] = json!([{"id":"internal-only","status":"cancelled","sourceQuote":"继续","reason":"不能借继续取消约束"}]);
    assert!(requirement_contract::validate_update(
        "execute",
        Some("continue"),
        Some(&delta),
        &context.to_string(),
        current
    )
    .is_some());
    assert!(requirement_contract::project_classified_context(
        &context.to_string(),
        Some("continue"),
        Some(&delta),
        current,
        Some(&classified)
    )
    .is_err());
}

fn mixed_focus_fixture() -> (Value, Value, String) {
    let (mut context, _, mut constraints, _) = projection_fixture();
    let current = "检查8081状态，禁止修改配置".to_string();
    context["requirementSubmission"]["content"] = json!(current);
    constraints["changePolicy"] = json!("read_only");
    constraints["prohibitedActions"] = json!(["禁止删除"]);
    constraints["requiredConditions"] = json!(["禁止修改配置"]);
    let decision = json!({"intent":"execute","relation":"supplement","answer":"",
        "constraints":constraints,"terminalContextLines":0,"selectedSkillIds":[],
        "requirementUpdate":{"baseRevision":5,"sourceMessageId":"message-new",
            "additions":[
                {"id":"inspect-8081","kind":"goal","content":"检查8081状态","sourceQuote":"检查8081状态","supersedes":[]},
                {"id":"no-config-write","kind":"constraint","content":"禁止修改配置","sourceQuote":"禁止修改配置","supersedes":[]}],
            "changes":[],"focusIds":["inspect-8081"]}});
    (context, decision, current)
}

#[test]
fn mixed_goals_and_constraints_share_prompt_schema_and_focus_validation() {
    assert_eq!(requirement_contract::update()["properties"]["focusIds"]["description"], requirement_contract::FOCUS_RULE);
    assert!(requirement_contract::update_rule().contains(requirement_contract::FOCUS_RULE));
    for (focus, missing) in [(json!(["inspect-8081"]), "no-config-write"), (json!(["no-config-write"]), "inspect-8081")] {
        let (context, mut decision, current) = mixed_focus_fixture();
        decision["requirementUpdate"]["focusIds"] = focus;
        let error = requirement_contract::validate_update("execute", Some("supplement"),
            decision.get("requirementUpdate"), &context.to_string(), &current).unwrap();
        assert!(error.contains("requirementUpdate.focusIds"));
        assert!(error.contains(&format!("[\"{missing}\"]")));
        assert!(!error.contains("PRIVATE_UNCOMPRESSED_HISTORY"));
    }
    let (context, mut decision, current) = mixed_focus_fixture();
    decision["requirementUpdate"]["focusIds"] = json!(["inspect-8081", "no-config-write"]);
    for protocol in ["chat_completions", "responses"] {
        for strict in [false, true] {
            let wire = normalized("需求理解", protocol, strict, &decision);
            assert!(requirement_contract::validate_update("execute", Some("supplement"),
                wire.get("requirementUpdate"), &context.to_string(), &current).is_none());
        }
    }
    let projected = project(&context, "supplement", &decision["requirementUpdate"], &current, &decision["constraints"]);
    let active = projected["taskGoal"]["requirementContext"]["activeConstraints"].as_array().unwrap();
    assert!(active.iter().any(|item| item["id"] == "internal-only" && item["source"]["sourceMessageId"] == "message-original"));
    assert!(active.iter().any(|item| item["id"] == "no-config-write" && item["source"]["sourceMessageId"] == "message-new"));
    assert_eq!(projected["executionConstraints"]["prohibitedActions"], json!(["禁止删除"]));
}

#[test]
fn focused_repair_is_small_and_cannot_change_authority_sources_or_classification() {
    let (context, decision, current) = mixed_focus_fixture();
    let repair = requirement_contract::focus_repair(&decision, &context.to_string(), &current).unwrap();
    assert_eq!(repair["missingIds"], json!(["no-config-write"]));
    assert_eq!(repair["originalDecision"], decision);
    assert!(!repair.to_string().contains("PRIVATE_UNCOMPRESSED_HISTORY"));
    assert!(repair.to_string().len() < context.to_string().len());
    let mut fixed = decision.clone();
    fixed["requirementUpdate"]["focusIds"] = json!(["inspect-8081", "no-config-write"]);
    assert!(requirement_contract::validate_focus_repair(&repair, &fixed).is_none());
    assert!(requirement_contract::validate_update("execute", Some("supplement"),
        fixed.get("requirementUpdate"), &context.to_string(), &current).is_none());
    for (path, replacement) in [
        ("/constraints/changePolicy", json!("allow_necessary_changes")),
        ("/constraints/prohibitedActions", json!([])),
        ("/requirementUpdate/additions/1/sourceQuote", json!("任意写入")),
        ("/requirementUpdate/changes", json!([{"id":"internal-only","status":"cancelled"}])),
        ("/requirementUpdate/sourceMessageId", json!("different-message")),
        ("/relation", json!("replace_goal")),
        ("/intent", json!("answer")),
        ("/requirementUpdate/focusIds", json!(["no-config-write"])),
        ("/requirementUpdate/focusIds", json!(["inspect-8081", "no-config-write", "internal-only"])),
        ("/requirementUpdate/focusIds", json!(["inspect-8081", "no-config-write", "no-config-write"])),
    ] {
        let mut tampered = fixed.clone();
        *tampered.pointer_mut(path).unwrap() = replacement;
        assert!(requirement_contract::validate_focus_repair(&repair, &tampered).is_some(), "{path}");
    }
    assert!(requirement_contract::validate_focus_repair(&repair, &json!({})).is_some());
    assert_eq!(context["requirementSubmission"]["baseLifecycle"]["revision"], 5);
}

#[test]
fn focus_repair_does_not_mask_other_contract_errors_or_side_question_boundaries() {
    let (context, decision, current) = mixed_focus_fixture();
    for (path, replacement) in [
        ("/requirementUpdate/baseRevision", json!(4)),
        ("/requirementUpdate/sourceMessageId", json!("wrong-message")),
        ("/requirementUpdate/additions/1/sourceQuote", json!("非用户原文")),
        ("/requirementUpdate/focusIds", json!(["unknown"])),
        ("/relation", json!("continue")),
        ("/intent", json!("answer")),
        ("/intent", json!("terminal_context")),
    ] {
        let mut invalid = decision.clone();
        *invalid.pointer_mut(path).unwrap() = replacement;
        assert!(requirement_contract::focus_repair(&invalid, &context.to_string(), &current).is_none(), "{path}");
        assert!(requirement_contract::validate_update(invalid["intent"].as_str().unwrap(), invalid["relation"].as_str(),
            invalid.get("requirementUpdate"), &context.to_string(), &current).is_some(), "{path}");
    }
}
