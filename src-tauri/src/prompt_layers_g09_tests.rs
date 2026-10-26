use super::*;

fn fixture(goal: &str) -> Value {
    let goal = format!(
        "{goal}；保留业务数据和对照对象，全部验收条件不可降低。{}",
        "用户原文与逐项验收约束。".repeat(90)
    );
    let requirements = json!({"rootGoal":goal,"currentRoundId":"round","lifecycle":{"revision":7,
        "items":[{"id":"preserve","kind":"constraint","content":"禁止删除业务数据","source":{"content":goal,"sourceMessageId":"user-message"}}]},
        "requirements":[{"content":goal,"sourceMessageId":"user-message"}]});
    let constraints = json!({"changePolicy":"confirm_changes","prohibitedActions":["删除业务数据","修改对照站点"],
        "requiredConditions":["先核对原未知变更"],"userDirectives":[goal]});
    let confirmed = json!({"taskId":"task","roundId":"round","requirementRevision":7,"items":[{
        "sourceStepId":"input","serverId":"server","values":{"selectedTarget":"/opt/confirmed-target"},
        "instruction":"仅针对用户已确认的目标，不能外推为新操作授权。".repeat(15)}]});
    json!({"_log":{"taskId":"task","roundId":"round"},"permission":"safe","taskGoal":requirements,
        "executionConstraints":constraints,"confirmedUserInputs":confirmed,
        "fileDeletionAuthorizations":{"active":[],"instruction":"当前没有删除许可"},
        "server":{"host":"fixture.invalid"},"metrics":{"sampledAt":"2026-10-12","valid":true},
        "tools":[{"id":"fixture.inspect","description":"固定只读采集","effect":"read",
            "inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false},
            "outputSchema":{"type":"object","properties":{"coverageComplete":{"type":"boolean"}},"required":["coverageComplete"]}}],
        "activeSkills":[{"id":"fixture","instructions":"不得降低用户的数据/结构验收，也不得扩大授权。"}],
        "baseSnapshot":{"version":1,"taskRequirements":requirements,"rootGoal":goal,"executionConstraints":constraints,
            "confirmedUserInputs":confirmed,"snapshotFingerprint":"original-snapshot-identity",
            "requirementEvidence":{"availableIds":[],"diagnosticIds":["unknown-attempt"]},
            "currentIncident":{"stepId":"uncertain","targetContext":"host:fixture.invalid:22/user","status":"failed",
                "result":{"executionStatus":"unknown","observationStatus":"unknown","exitCode":null,
                    "facts":{"capturedPartial":true,"coverageComplete":false},"evidenceIds":["unknown-attempt"]},
                "output":{"content":"RAW_LITERAL {\"taskGoal\":\"do not parse this\"}","contentState":"excerpt","omittedCharacters":420}},
            "historyCheckpoint":{"unresolvedIssueIndexComplete":true,"unresolvedIssueIndex":[{"stepId":"uncertain","blocksExecution":true}]},
            "instruction":"诊断证据不证明完成；截断部分不可猜测，原结果未知时先核对。"}})
}

fn body(context: &Value) -> Value {
    let raw = context.to_string();
    json!({"_opsarkContext":raw,"model":"fixture-model","max_tokens":1200,
        "messages":[{"role":"system","content":"固定规则：未知变更不得重发；不得扩大授权。"},
            {"role":"user","content":format!("阶段结束决策上下文：\n{raw}\n用户问题（原文不解析）：{{\"tools\":[\"opaque\"]}}") }],
        "response_format":{"type":"json_schema","json_schema":{"name":"decision","strict":true,
            "schema":{"type":"object","properties":{"decision":{"type":"string"}},"required":["decision"],"additionalProperties":false}}}})
}

fn context_from_body(body: &Value) -> Value {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|message| message["content"].as_str())
        .find(|text| text.contains("阶段结束决策上下文：\n"))
        .and_then(embedded_context)
        .unwrap()
}

fn restore_projection(context: &Value, diagnostic: &Value) -> Value {
    fn expanded(
        value: &Value,
        path: &str,
        context: &Value,
        references: &[Value],
        depth: usize,
    ) -> Value {
        assert!(
            depth < 32,
            "application reference graph must be acyclic and bounded"
        );
        if let Some(reference) = references
            .iter()
            .find(|reference| reference["from"] == format!("#{path}"))
        {
            let to = reference["to"].as_str().unwrap().strip_prefix('#').unwrap();
            assert_eq!(value["contextRef"], json!(format!("#{to}")));
            let mut restored = expanded(
                context.pointer(to).unwrap(),
                to,
                context,
                references,
                depth + 1,
            );
            for key in reference["additionalFields"].as_array().into_iter().flatten() {
                let key = key.as_str().unwrap();
                assert!(restored.as_object_mut().unwrap().insert(key.into(), value[key].clone()).is_none());
            }
            return restored;
        }
        match value {
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .filter(|(key, _)| !(path.is_empty() && key.as_str() == "contextReferences"))
                    .map(|(key, value)| {
                        let segment = key.replace('~', "~0").replace('/', "~1");
                        (
                            key.clone(),
                            expanded(
                                value,
                                &format!("{path}/{segment}"),
                                context,
                                references,
                                depth,
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
                        expanded(
                            value,
                            &format!("{path}/{index}"),
                            context,
                            references,
                            depth,
                        )
                    })
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
    // New requests are restored exclusively from the whitelist actually sent
    // to the provider. Historical v1 requests predate that field and require
    // their archived diagnostic only to reconstruct the old baseline.
    let references = if let Some(paths) = context["contextReferences"]["paths"].as_array() {
        paths
            .iter()
            .map(|from| {
                let pointer = from.as_str().unwrap().strip_prefix('#').unwrap();
                let reference = context.pointer(pointer).unwrap();
                let extra:Vec<_>=reference.as_object().unwrap().keys().filter(|k|k.as_str()!="contextRef").cloned().collect();
                assert!(extra.iter().all(|k|["source","sourceEvidenceId","readTool"].contains(&k.as_str())));
                json!({"from":from,"to":reference["contextRef"].as_str().unwrap(),"additionalFields":extra})
            })
            .collect::<Vec<_>>()
    } else {
        diagnostic["references"].as_array().unwrap().clone()
    };
    expanded(context, "", context, &references, 0)
}

fn requirement_views_fixture() -> Value {
    let source = json!({"content":"用户原文：更新应用并验证数据库结构，保留全部业务数据；禁止更改对照站点。".repeat(8),
        "sourceMessageId":"message-new","sourceRoundId":"round-new","relation":"supplement"});
    let goal = json!({"id":"goal","kind":"goal","content":"发布新应用并验证数据库结构",
        "source":source,"status":"active","acceptance":{"strategy":"application_review","sourceQuote":"验证数据库结构"},
        "lastReview":{"outcome":"unknown","reason":"只完成部署，数据结构验收未决","evidenceIds":["partial-receipt"]}});
    let constraint = json!({"id":"preserve","kind":"constraint","content":"保留业务数据和对照站点",
        "source":source,"status":"active","acceptance":{"strategy":"general_review","sourceQuote":"保留全部业务数据"},
        "evidenceIds":[],"supersedes":[]});
    let mut context = fixture("用户后续补充要求");
    context["taskGoal"]["requirements"] = json!([source]);
    context["taskGoal"]["lifecycle"]["items"] = json!([goal, constraint]);
    context["taskGoal"]["requirementContext"] = json!({"revision":7,
        "focus":[goal,constraint],"activeGoals":[goal],"activeConstraints":[constraint],"deferred":[],
        "historical":[{"id":"old-goal","status":"completed","summary":"旧目标仅作参考"}],"omittedHistoricalCount":1});
    context["baseSnapshot"]["taskRequirements"] = context["taskGoal"].clone();
    context
}

#[test]
fn shares_exact_requirement_views_and_sources_without_losing_acceptance_status_or_membership() {
    let original = requirement_views_fixture();
    let (prepared, log) = prepare_request(&body(&original));
    let projected = context_from_body(&prepared);
    let mut expected = original.clone();
    for key in ["_log", "tools", "activeSkills"] {
        expected.as_object_mut().unwrap().remove(key);
    }
    assert_eq!(
        restore_projection(&projected, &log["contextProjection"]),
        expected
    );
    assert_eq!(
        restore_projection(&projected, &Value::Null),
        expected,
        "provider-visible reference whitelist alone must restore complete semantics"
    );
    assert_eq!(
        projected["taskGoal"]["requirementContext"]["focus"],
        json!({"contextRef":"#/taskGoal/lifecycle/items"})
    );
    assert_eq!(
        projected["taskGoal"]["requirementContext"]["activeGoals"][0],
        json!({"contextRef":"#/taskGoal/lifecycle/items/0"})
    );
    assert_eq!(
        projected["taskGoal"]["requirementContext"]["activeConstraints"][0],
        json!({"contextRef":"#/taskGoal/lifecycle/items/1"})
    );
    assert_eq!(
        projected["taskGoal"]["requirements"][0],
        json!({"contextRef":"#/taskGoal/lifecycle/items/0/source"})
    );
    assert_eq!(
        projected["taskGoal"]["lifecycle"]["items"],
        original["taskGoal"]["lifecycle"]["items"]
    );
    assert_eq!(
        projected["baseSnapshot"]["currentIncident"],
        original["baseSnapshot"]["currentIncident"]
    );
    assert_eq!(
        projected["taskGoal"]["requirementContext"]["historical"],
        original["taskGoal"]["requirementContext"]["historical"]
    );
    assert!(prepared.to_string().len() < body(&original).to_string().len());
}

#[test]
fn differing_or_reordered_requirement_views_keep_their_own_evidence_and_order() {
    let mut context = requirement_views_fixture();
    context["taskGoal"]["requirementContext"]["activeGoals"][0]["lastReview"]["outcome"] =
        json!("completed");
    context["taskGoal"]["requirementContext"]["activeConstraints"][0]["source"]["sourceRoundId"] =
        json!("older-round");
    context["taskGoal"]["requirementContext"]["focus"]
        .as_array_mut()
        .unwrap()
        .reverse();
    context["taskGoal"]["requirements"][0]["sourceMessageId"] = json!("different-source");
    // Opaque application evidence can contain a reference-looking object;
    // only the owned projection paths participate in reference expansion.
    context["baseSnapshot"]["currentIncident"]["result"]["facts"]["opaque"] =
        json!({"contextRef":"#/taskGoal/rootGoal"});
    let original = context.clone();
    let diagnostic = reference_equal_context_fields(&mut context).unwrap();
    assert_eq!(restore_projection(&context, &diagnostic), original);
    for field in ["activeGoals", "activeConstraints"] {
        assert_eq!(
            context["taskGoal"]["requirementContext"][field],
            original["taskGoal"]["requirementContext"][field]
        );
    }
    assert_eq!(
        context["taskGoal"]["requirements"],
        original["taskGoal"]["requirements"]
    );
    assert_eq!(
        context["taskGoal"]["requirementContext"]["focus"][0],
        json!({"contextRef":"#/taskGoal/lifecycle/items/1"})
    );
    assert_eq!(
        context["taskGoal"]["requirementContext"]["focus"][1],
        json!({"contextRef":"#/taskGoal/lifecycle/items/0"})
    );
    assert_eq!(
        context["baseSnapshot"]["currentIncident"],
        original["baseSnapshot"]["currentIncident"]
    );
}

#[test]
fn references_only_equal_fixed_fields_and_restores_every_goal_authorization_and_unknown_fact() {
    let original_context = fixture("回退到上一发布版本");
    let original_body = body(&original_context);
    let retained = original_body.clone();
    let (prepared, log) = prepare_request(&original_body);
    let projected = context_from_body(&prepared);
    let mut expected = original_context.clone();
    for key in ["_log", "tools", "activeSkills"] {
        expected.as_object_mut().unwrap().remove(key);
    }
    assert_eq!(
        restore_projection(&projected, &log["contextProjection"]),
        expected
    );
    assert_eq!(
        original_body, retained,
        "native validators must still receive the original full context"
    );
    assert_eq!(
        projected["baseSnapshot"]["currentIncident"],
        expected["baseSnapshot"]["currentIncident"]
    );
    assert_eq!(
        projected["baseSnapshot"]["historyCheckpoint"],
        expected["baseSnapshot"]["historyCheckpoint"]
    );
    assert_eq!(
        projected["fileDeletionAuthorizations"],
        expected["fileDeletionAuthorizations"]
    );
    assert_eq!(
        prepared["response_format"],
        original_body["response_format"]
    );
    let policy: Value = serde_json::from_str(
        prepared["messages"][1]["content"]
            .as_str()
            .unwrap()
            .strip_prefix(POLICY_LABEL)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(policy["tools"], original_context["tools"]);
    assert_eq!(policy["activeSkills"], original_context["activeSkills"]);
    assert!(prepared["messages"][2]["content"]
        .as_str()
        .unwrap()
        .ends_with("用户问题（原文不解析）：{\"tools\":[\"opaque\"]}"));
}

#[test]
fn stale_scope_revision_or_constraints_are_never_merged_with_current_authority() {
    let mut context = fixture("核对数据库结构和数据");
    context["baseSnapshot"]["taskRequirements"]["lifecycle"]["revision"] = json!(6);
    context["baseSnapshot"]["executionConstraints"]["changePolicy"] =
        json!("requested_changes_only");
    context["baseSnapshot"]["confirmedUserInputs"]["items"][0]["serverId"] =
        json!("different-server");
    let original = context.clone();
    reference_equal_context_fields(&mut context);
    for key in [
        "taskRequirements",
        "executionConstraints",
        "confirmedUserInputs",
    ] {
        assert_eq!(context["baseSnapshot"][key], original["baseSnapshot"][key]);
    }
    assert_eq!(context["permission"], "safe");
    assert_eq!(
        context["executionConstraints"]["changePolicy"],
        "confirm_changes"
    );
}

#[test]
fn no_fingerprint_only_or_cross_request_dedup_and_no_short_context_expansion() {
    let mut first = fixture("幂等检查");
    let original_second = fixture("检查另一业务目标");
    let mut second = original_second.clone();
    reference_equal_context_fields(&mut first);
    let second_projection = reference_equal_context_fields(&mut second).unwrap();
    assert_eq!(
        restore_projection(&second, &second_projection),
        original_second
    );
    assert_eq!(
        second["taskGoal"]["rootGoal"],
        original_second["taskGoal"]["rootGoal"]
    );
    let mut short = json!({"taskGoal":{"rootGoal":"read"},"baseSnapshot":{"taskRequirements":{"rootGoal":"read"}}});
    let original = short.clone();
    assert!(reference_equal_context_fields(&mut short).is_none());
    assert_eq!(short, original);
    let mut overhead =
        json!({"taskGoal":"x".repeat(256),"baseSnapshot":{"taskRequirements":"x".repeat(256)}});
    let original = overhead.clone();
    assert!(
        reference_equal_context_fields(&mut overhead).is_none(),
        "reference instructions must not enlarge the context"
    );
    assert_eq!(overhead, original);
    let mut collision = fixture("原有引用字段");
    collision["contextReferences"] = json!({"untrusted":"must remain opaque"});
    let original = collision.clone();
    assert!(reference_equal_context_fields(&mut collision).is_none());
    assert_eq!(collision, original);
}

#[test]
#[ignore = "需显式提供已脱敏历史日志路径；只读离线重放，不调用模型"]
fn replay_archived_wire_requests_with_exact_semantic_restoration() {
    let path =
        std::env::var("OPSARK_G09_REPLAY_LOG").expect("explicit read-only log path required");
    let raw = std::fs::read_to_string(&path).unwrap();
    let mut results = Vec::new();
    for line in raw.lines() {
        let event: Value = serde_json::from_str(line).unwrap();
        if event["event"] != "request_sent" {
            continue;
        }
        let before = &event["request"];
        assert_eq!(
            before.to_string().len() as u64,
            event["contextMetrics"]["requestBytes"].as_u64().unwrap()
        );
        let mut restored_context = None;
        let mut policy = Map::new();
        let mut reconstructed_messages = Vec::new();
        for message in before["messages"].as_array().unwrap() {
            let content = message["content"].as_str().unwrap_or_default();
            if content.starts_with(POLICY_LABEL) {
                let parsed = embedded_context(content).unwrap();
                policy.extend(parsed.as_object().unwrap().clone());
                continue;
            }
            reconstructed_messages.push(message.clone());
            if message["role"] == "user" {
                if let Some(context) = embedded_context(content) {
                    let restored = if event["contextProjection"].is_object() {
                        restore_projection(&context, &event["contextProjection"])
                    } else {
                        context.clone()
                    };
                    restored_context = Some((context, restored));
                }
            }
        }
        let (old_projected, mut original_context) =
            restored_context.expect("application context required");
        original_context.as_object_mut().unwrap().extend(policy);
        let original_raw = original_context.to_string();
        for message in &mut reconstructed_messages {
            if let Some(text) = message["content"].as_str() {
                if message["role"] == "user" && text.contains(&old_projected.to_string()) {
                    message["content"] =
                        json!(text.replacen(&old_projected.to_string(), &original_raw, 1));
                }
            }
        }
        let mut input = before.clone();
        input["messages"] = json!(reconstructed_messages);
        input["_opsarkContext"] = json!(original_raw);
        let retained = input.clone();
        let (after, diagnostic) = prepare_request(&input);
        assert_eq!(
            input, retained,
            "replay never mutates native original context"
        );
        assert_eq!(after["response_format"], before["response_format"]);
        assert_eq!(after["max_tokens"], before["max_tokens"]);
        assert_eq!(after["messages"][0], before["messages"][0]);
        let mut actual_context = None;
        let mut actual_policy = Map::new();
        for message in after["messages"].as_array().unwrap() {
            let content = message["content"].as_str().unwrap_or_default();
            if let Some(projected) = embedded_context(content) {
                if content.starts_with(POLICY_LABEL) {
                    actual_policy.extend(projected.as_object().unwrap().clone());
                } else {
                    actual_context = Some(if diagnostic["contextProjection"].is_object() {
                        restore_projection(&projected, &Value::Null)
                    } else {
                        projected
                    });
                }
            }
        }
        let mut actual_context = actual_context.unwrap();
        actual_context
            .as_object_mut()
            .unwrap()
            .extend(actual_policy);
        assert_eq!(
            actual_context, original_context,
            "all goal, authority, failed/unknown facts, tools and acceptance restore exactly"
        );
        assert!(
            after.to_string().len() <= before.to_string().len(),
            "projection must never enlarge the actual wire"
        );
        results.push(
            json!({"requestId":event["requestId"],"requestName":event["requestName"],
            "beforeWireBytes":before.to_string().len(),"afterWireBytes":after.to_string().len(),
            "savedWireBytes":before.to_string().len()-after.to_string().len(),
            "exactSemanticRestoration":true,"newProjection":diagnostic.get("contextProjection"),
            "afterMetrics":request_metrics(&after)}),
        );
    }
    assert!(!results.is_empty());
    println!(
        "G09历史离线重放 {}",
        json!({"sourcePath":path,"callsModel":false,"unit":"utf8_bytes_not_tokens",
        "historicalCostsUnchanged":true,"requests":results})
    );
}

#[test]
fn measures_complete_chat_and_responses_wire_layers_and_preserves_output_limits() {
    let (prepared, _) = prepare_request(&body(&fixture("站点部署")));
    for protocol in ["chat_completions", "responses"] {
        let mut prepared = prepared.clone();
        prepared["_opsarkProtocolConfig"] = json!({"apiProtocol":protocol});
        let wire = crate::model_protocol::wire(&prepared).unwrap();
        let retained = wire.clone();
        let metrics = request_metrics(&wire);
        assert_eq!(wire, retained);
        assert_eq!(metrics["wireProtocol"], protocol);
        assert_eq!(
            metrics["requestBytes"].as_u64().unwrap(),
            wire.to_string().len() as u64
        );
        let mut changed_instructions = wire.clone();
        changed_instructions["instructions"] = json!("另一条固定规则");
        assert_ne!(
            metrics["stablePrefixFingerprint"],
            request_metrics(&changed_instructions)["stablePrefixFingerprint"]
        );
        assert_eq!(metrics["layerPartitionValid"], true);
        let layers = metrics["layers"].as_object().unwrap();
        assert_eq!(
            layers
                .values()
                .map(|value| value.as_u64().unwrap())
                .sum::<u64>(),
            wire.to_string().len() as u64
        );
        for field in [
            "systemPromptBytes",
            "fixedRulesBytes",
            "toolSchemaBytes",
            "authorityAndGoalBytes",
            "historyEvidenceBytes",
            "dynamicFactsBytes",
            "responseSchemaBytes",
        ] {
            assert!(layers[field].as_u64().unwrap() > 0, "{protocol}: {field}");
        }
        assert_eq!(metrics["sections"].as_array().unwrap().len(), 3);
        assert_eq!(
            metrics["configuredOutputLimits"][if protocol == "responses" {
                "max_output_tokens"
            } else {
                "max_tokens"
            }],
            1200
        );
        assert_eq!(metrics["exactTokens"], false);
    }
}

#[test]
#[ignore = "显式提供历史日志及本次编译工具目录；离线重放，不调用模型"]
fn replay_archived_tool_directory_eligibility_preserves_every_applicable_contract_and_fact() {
    let path = std::env::var("OPSARK_G13_REPLAY_LOG").unwrap();
    let catalog_path = std::env::var("OPSARK_G13_TOOL_CATALOG").unwrap();
    let catalog: Value = serde_json::from_str(&std::fs::read_to_string(catalog_path).unwrap()).unwrap();
    assert_eq!(catalog["version"], 1);
    let catalog = catalog["tools"].as_array().unwrap();
    let mut results = Vec::new();
    for line in std::fs::read_to_string(&path).unwrap().lines() {
        let event: Value = serde_json::from_str(line).unwrap();
        if event["event"] != "request_sent" { continue; }
        let before = &event["request"];
        let mut messages = Vec::new();
        let mut policy = Map::new();
        let mut contexts = None;
        for message in before["messages"].as_array().unwrap() {
            let text = message["content"].as_str().unwrap_or_default();
            if text.starts_with(POLICY_LABEL) {
                policy.extend(embedded_context(text).unwrap().as_object().unwrap().clone());
                continue;
            }
            messages.push(message.clone());
            if message["role"] == "user" {
                if let Some(projected) = embedded_context(text) {
                    let restored = if projected.get("contextReferences").is_some() {
                        restore_projection(&projected, &event["contextProjection"])
                    } else { projected.clone() };
                    contexts = Some((projected, restored));
                }
            }
        }
        let (old_projected, mut original) = contexts.unwrap();
        original.as_object_mut().unwrap().extend(policy);
        let mut candidate = original.clone();
        if let Some(tools) = candidate.get_mut("tools").and_then(Value::as_array_mut) {
            for tool in tools {
                if let Some(compiled) = catalog.iter().find(|item| item["id"] == tool["id"]) {
                    let mut without_policy = compiled.clone();
                    without_policy.as_object_mut().unwrap().remove("requiresTargetChange");
                    // No version/ID-only matching: an edited or older tool
                    // definition cannot silently acquire this eligibility.
                    if *tool == without_policy && compiled["requiresTargetChange"] == true {
                        tool["requiresTargetChange"] = json!(true);
                    }
                }
            }
        }
        let raw = candidate.to_string();
        for message in &mut messages {
            if message["role"] == "user" {
                if let Some(text) = message["content"].as_str() {
                    if text.contains(&old_projected.to_string()) {
                        message["content"] = json!(text.replacen(&old_projected.to_string(), &raw, 1));
                    }
                }
            }
        }
        let mut input = before.clone();
        input["messages"] = json!(messages);
        input["_opsarkContext"] = json!(raw);
        let retained = input.clone();
        let (after, diagnostic) = prepare_request(&input);
        assert_eq!(input, retained);
        assert_eq!(after["response_format"], before["response_format"]);
        assert_eq!(after["max_tokens"], before["max_tokens"]);
        assert_eq!(after["messages"][0], before["messages"][0]);
        let mut expected = original;
        let excluded = diagnostic["toolDirectoryProjection"]["excludedToolIds"].as_array().cloned().unwrap_or_default();
        if let Some(tools) = expected.get_mut("tools").and_then(Value::as_array_mut) {
            tools.retain(|tool| !excluded.contains(&tool["id"]));
        }
        let mut actual = None;
        let mut actual_policy = Map::new();
        for message in after["messages"].as_array().unwrap() {
            let text = message["content"].as_str().unwrap_or_default();
            if let Some(context) = embedded_context(text) {
                if text.starts_with(POLICY_LABEL) {
                    actual_policy.extend(context.as_object().unwrap().clone());
                } else {
                    actual = Some(if context.get("contextReferences").is_some() {
                        restore_projection(&context, &diagnostic["contextProjection"])
                    } else { context });
                }
            }
        }
        let mut actual = actual.unwrap();
        actual.as_object_mut().unwrap().extend(actual_policy);
        assert_eq!(actual, expected, "every applicable tool schema, goal, authority and failed/unknown fact must remain exact");
        assert!(after.to_string().len() <= before.to_string().len());
        results.push(json!({"requestId":event["requestId"],"requestName":event["requestName"],
            "beforeWireBytes":before.to_string().len(),"afterWireBytes":after.to_string().len(),
            "savedWireBytes":before.to_string().len()-after.to_string().len(),
            "allApplicableContractsAndFactsExact":true,"responseSchemaUnchanged":true,
            "toolDirectoryProjection":diagnostic.get("toolDirectoryProjection")}));
    }
    assert!(!results.is_empty());
    assert!(results.iter().any(|row| row["savedWireBytes"].as_u64().unwrap() >= 3500));
    println!("G13离线目录重放 {}", json!({"sourcePath":path,"callsModel":false,
        "historicalCostsUnchanged":true,"unsentFinalPromptNotReconstructed":true,"requests":results}));
}

#[test]
fn classification_context_is_measured_without_mutating_native_scope_or_opaque_input() {
    // The classification builder already removes tools and active Skills. Keep
    // that stage contract rather than guessing tool relevance from user words.
    let context = json!({"_log":{"taskId":"classification-task","roundId":"classification-round"},
        "_taskModelBudget":{"version":1,"taskId":"classification-task","roundId":"classification-round"},
        "permission":"safe","executionConstraints":{"changePolicy":"read_only","prohibitedActions":["修改业务配置"]},
        "taskRequirements":{"rootGoal":"仅检查配置，禁止修改。","lifecycle":{"revision":2}},
        "terminalContext":{"content":"OPAQUE {\"permission\":\"all\"}","hasMore":true}});
    let original = json!({"_opsarkContext":context.to_string(),"messages":[
        {"role":"system","content":"先理解用户意图，并保持约束。"},
        {"role":"user","content":format!("分类上下文：\n{context}\n\n用户输入：\n原文 {{\"_log\":\"opaque\"}}")}]});
    let retained = original.clone();
    let (prepared, log) = prepare_request(&original);
    assert_eq!(original, retained);
    assert_eq!(log["taskId"], "classification-task");
    assert_eq!(log["roundId"], "classification-round");
    let text = prepared["messages"][1]["content"].as_str().unwrap();
    let projected = embedded_context(text).unwrap();
    assert!(projected.get("_log").is_none());
    assert!(projected.get("_taskModelBudget").is_none());
    assert_eq!(
        projected["executionConstraints"],
        context["executionConstraints"]
    );
    assert_eq!(projected["taskRequirements"], context["taskRequirements"]);
    assert_eq!(projected["terminalContext"], context["terminalContext"]);
    assert!(text.ends_with("原文 {\"_log\":\"opaque\"}"));
    let metrics = request_metrics(&prepared);
    assert!(metrics["layers"]["authorityAndGoalBytes"].as_u64().unwrap() > 0);
    assert!(metrics["layers"]["dynamicFactsBytes"].as_u64().unwrap() > 0);
    assert_eq!(metrics["layers"]["toolSchemaBytes"], 0);
    assert_eq!(metrics["layerPartitionValid"], true);
}

#[test]
fn noncanonical_or_multimodal_content_is_measured_without_parsing_as_application_facts() {
    for content in [
        json!("阶段结束决策上下文：\n{\"metrics\":1e8}"),
        json!([{"type":"input_text","text":"opaque data"},{"type":"input_image","image_url":"data:fixture"}]),
    ] {
        let wire = json!({"input":[{"role":"user","content":content}],"instructions":"规则","max_output_tokens":99});
        let metrics = request_metrics(&wire);
        assert_eq!(metrics["layers"]["dynamicFactsBytes"], 0);
        assert_eq!(metrics["layerPartitionValid"], true);
        assert_eq!(
            metrics["layers"]
                .as_object()
                .unwrap()
                .values()
                .map(|v| v.as_u64().unwrap())
                .sum::<u64>(),
            wire.to_string().len() as u64
        );
    }
}

#[test]
fn synthetic_full_wire_byte_experiments_are_not_token_or_business_success_claims() {
    for scenario in [
        "幂等需求",
        "站点发布",
        "数据库数据与结构验收",
        "版本回退及数据保留",
    ] {
        let (after, log) = prepare_request(&body(&fixture(scenario)));
        let projected = context_from_body(&after);
        let restored = restore_projection(&projected, &log["contextProjection"]);
        let mut before = after.clone();
        let text = before["messages"][2]["content"]
            .as_str()
            .unwrap()
            .replace(&projected.to_string(), &restored.to_string());
        before["messages"][2]["content"] = json!(text);
        assert!(after.to_string().len() < before.to_string().len());
        println!(
            "G09字节实验 {}",
            json!({"scenario":scenario,"synthetic":true,"unit":"utf8_bytes_not_tokens",
            "beforeWireBytes":before.to_string().len(),"afterWireBytes":after.to_string().len(),
            "savedWireBytes":before.to_string().len()-after.to_string().len(),"afterMetrics":request_metrics(&after)})
        );
    }
}

#[test]
fn decision_metadata_references_restore_exact_sources_and_never_parse_raw_objects() {
    let mut context=fixture("跨阶段采集");
    let scope=json!({"targetId":"server-a","sessionId":"session-a","generation":1,"scope":"isolated_exec",
        "persistence":"command","doesNotProve":["agent_session_state","user_shell_loaded","new_shell_auto_load"]});
    let steps:Vec<Value>=(0..4).map(|i| {
        let id=format!("step-{i}");let evidence_id=format!("evidence-{i}");
        let archive=json!({"taskId":"original-task-identity","roundId":"original-round-identity",
            "serverId":"server-a","stepId":id,"sourceEvidenceId":evidence_id,
            "targetContext":"server-a/round-a/session-a/generation-one/original-source",
            "evidenceId":format!("{:064x}",i+1),"fingerprint":format!("raw-fingerprint-{i}"),
            "characters":4096,"capturedPartial":i==1});
        let mut reference=archive.clone();reference["source"]=json!("main");reference["readTool"]=json!("evidence.read");
        let facts=json!({"literal":"user content: {\"contextRef\":\"#/do-not-interpret\"}".repeat(12)});
        json!({"stepId":id,"targetContext":archive["targetContext"],"result":{"facts":facts},
            "output":{"content":format!("ORIGINAL_OBSERVATION_{i}"),"references":[reference]},
            "evidence":{"items":[{"id":evidence_id,"source":"main","archive":archive,"scope":scope,"facts":facts}]}})
    }).collect();
    context["baseSnapshot"]["currentPlan"]=json!({"steps":steps});
    let (after,log)=prepare_request(&body(&context));
    let projected=context_from_body(&after);
    let mut expected=context;expected.as_object_mut().unwrap().remove("_log");
    expected.as_object_mut().unwrap().remove("tools");expected.as_object_mut().unwrap().remove("activeSkills");
    assert_eq!(restore_projection(&projected,&log["contextProjection"]),expected);
    assert!(log["contextProjection"]["references"].as_array().unwrap().iter().any(|r|r.get("additionalFields").is_some()));
    assert!(projected["baseSnapshot"]["currentPlan"]["steps"][0]["result"]["facts"]["literal"].as_str().unwrap().contains("#/do-not-interpret"));
}

#[test]
fn metadata_sharing_preserves_target_differences_and_rejects_invalid_archive_origin() {
    let mut context=fixture("作用域不能串用");
    let first=json!({"taskId":"task","stepId":"first","sourceEvidenceId":"proof","targetContext":"target-a",
        "evidenceId":"a".repeat(64),"fingerprint":"original-fingerprint","characters":4096,"capturedPartial":true});
    let mut reference=first.clone();reference["source"]=json!("main");reference["readTool"]=json!("evidence.read");
    context["baseSnapshot"]["currentPlan"]=json!({"steps":[{"stepId":"other-step","targetContext":"target-b",
        "output":{"content":"not an observation of target-a","references":[reference]},
        "evidence":{"items":[{"id":"proof","archive":first,"scope":{"targetId":"target-b"},"facts":{}}]}}]});
    let (wire,log)=prepare_request(&body(&context));let projected=context_from_body(&wire);
    assert_eq!(projected.pointer("/baseSnapshot/currentPlan/steps/0/output/references"),
        context.pointer("/baseSnapshot/currentPlan/steps/0/output/references"));
    let restored=restore_projection(&projected,&log["contextProjection"]);
    assert_eq!(restored["baseSnapshot"]["currentPlan"],context["baseSnapshot"]["currentPlan"]);
    assert_eq!(restored["baseSnapshot"]["currentPlan"]["steps"][0]["evidence"]["items"][0]["archive"]["capturedPartial"],true);
}

#[test]
#[ignore = "explicit offline replay requires frozen local test artifacts; never calls provider"]
fn stage16_frozen_requests_offline_replay() {
    let path=std::env::var("OPSARK_STAGE16_NATIVE_FIXTURE").expect("explicit frozen fixture path");
    let fixture:Value=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut records=Vec::new();
    for sample in fixture["samples"].as_array().unwrap() {
        let (after,log)=prepare_request(&sample["body"]);
        let projected=context_from_body(&after);
        let restored=restore_projection(&projected,&log["contextProjection"]);
        let mut before_context=projected.clone();
        let new_references:Vec<Value>=log["contextProjection"]["references"].as_array().unwrap().iter()
            .filter(|r|r["from"].as_str().unwrap().contains("/evidence/") || r["from"].as_str().unwrap().contains("/output/references/"))
            .cloned().collect();
        for reference in &new_references {
            let from=reference["from"].as_str().unwrap().strip_prefix('#').unwrap();
            *before_context.pointer_mut(from).unwrap()=restored.pointer(from).unwrap().clone();
        }
        if let Some(paths)=before_context.pointer_mut("/contextReferences/paths").and_then(Value::as_array_mut) {
            paths.retain(|p|!new_references.iter().any(|r|r["from"]==*p));
        }
        let instruction=before_context["contextReferences"]["instruction"].as_str().unwrap().to_owned();
        before_context["contextReferences"]["instruction"]=json!(instruction.split(" 登记的归档引用可另含").next().unwrap());
        let mut before=after.clone();
        for message in before["messages"].as_array_mut().unwrap() {
            if let Some(text)=message["content"].as_str().filter(|s|s.contains("阶段结束决策上下文：\n")) {
                message["content"]=json!(text.replace(&projected.to_string(),&before_context.to_string()));
            }
        }
        let source:Value=serde_json::from_str(sample["body"]["_opsarkContext"].as_str().unwrap()).unwrap();
        let mut expected=source.clone();
        for key in ["_log","tools","activeSkills"] {expected.as_object_mut().unwrap().remove(key);}
        for pointer in ["/baseSnapshot","/task"] {
            if let Some(object)=expected.pointer_mut(pointer).and_then(Value::as_object_mut) {
                for key in ["_log","_taskModelBudget","_modelRequestLifecycle","_modelRecovery"] { object.remove(key); }
            }
        }
        assert_eq!(restored,expected,"full context restoration must retain all original evidence and authority");
        let before_bytes=before.to_string().len();let after_bytes=after.to_string().len();
        let required=after_bytes+1024+5000;let available=sample["available"].as_u64().unwrap();
        records.push(json!({"sample":sample["name"],"actualRejectedWireBytes":sample["actualRejectedWireBytes"],
            "reconstructedBeforeBytes":before_bytes,"afterWireBytes":after_bytes,"savedWireBytes":before_bytes-after_bytes,
            "available":available,"requiredAtOriginalFloor":required,"admittedAtOriginalFloor":required as u64<=available,
            "metadataReferences":new_references.len(),"layers":request_metrics(&after)["layers"],
            "exactRestoration":true,"providerCalls":0,"unit":"utf8_bytes_not_actual_tokens"}));
    }
    if let Ok(path)=std::env::var("OPSARK_STAGE16_NATIVE_RESULT") {
        use std::io::Write;
        let mut f=std::fs::OpenOptions::new().write(true).create_new(true).open(path).unwrap();
        f.write_all(serde_json::to_string_pretty(&records).unwrap().as_bytes()).unwrap();
    }
    for record in &records { println!("第十六批离线回放 {record}"); }
    assert!(records.iter().all(|r|r["admittedAtOriginalFloor"]==true),"original budget floor must still admit each replay");
}
