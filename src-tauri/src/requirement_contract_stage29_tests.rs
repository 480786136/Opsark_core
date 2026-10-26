use super::*;
fn historical() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/joint-requirement-stage28.json"
    ))
    .unwrap()
}
#[test]
fn stage29_real_empty_constraint_is_rejected_by_shared_wire_schema() {
    let f = historical();
    let schema=model_compatibility::full_contract("需求理解", &json!({"_opsarkOperationContract":"requirement.plan@1","_opsarkContext":f["rawContext"].to_string()})).unwrap();
    assert!(schema_validation::validate(
        &schema["properties"]["constraints"],
        &f["response"]["constraints"]
    )
    .is_err());
}
#[test]
fn stage29_real_public_view_preserves_trusted_log_identity_and_strips_private_fields() {
    let f = historical();
    let mut body = f["wire"].clone();
    body["_opsarkContext"] = json!(f["rawContext"].to_string());
    let (wire, log) = prompt_layers::prepare_request(&body);
    assert_eq!(log["taskId"], f["rawContext"]["_log"]["taskId"]);
    assert!(!wire.to_string().contains("_taskModelBudget"));
    assert!(!wire.to_string().contains("_modelIntegration"));
}
#[test]
fn stage29_real_semantic_failure_preserves_specific_field_in_typed_error() {
    let f = historical();
    let mut decoded = f["response"].clone();
    // Strict wire encodes an omitted optional scalar as null; production decodes it before classification.
    if decoded["terminalContextLines"].is_null() {
        decoded
            .as_object_mut()
            .unwrap()
            .remove("terminalContextLines");
    }
    let err = requirement_planning::accept(
        &decoded.to_string(),
        &f["rawContext"].to_string(),
        f["requirement"].as_str().unwrap(),
        &Default::default(),
    )
    .unwrap_err();
    let typed: Value = serde_json::from_str(
        err.strip_prefix(MODEL_TRACE_ERROR_PREFIX)
            .expect("typed semantic error"),
    )
    .unwrap();
    assert_eq!(typed["modelError"]["code"], "MODEL_REQUIREMENT_INVALID");
    assert_eq!(
        typed["modelError"]["jsonPointer"],
        "/constraints/environmentPolicy"
    );
}

#[test]
fn stage29_all_policy_values_match_shared_schema_prompt_and_semantics() {
    let base = historical()["response"]["constraints"].clone();
    let schema = classification_contract::schema();
    let rule = classification_contract::rule();
    for (field, values) in [
        ("changePolicy", classification_contract::CHANGE_POLICIES),
        (
            "environmentPolicy",
            classification_contract::ENVIRONMENT_POLICIES,
        ),
        ("failurePolicy", classification_contract::FAILURE_POLICIES),
    ] {
        for choice in values {
            let mut c = base.clone();
            c["environmentPolicy"] = json!("unspecified");
            c["failurePolicy"] = json!("unspecified");
            c[field] = json!(choice);
            assert!(schema_validation::validate(&schema, &c).is_ok());
            assert!(execute_constraints_match_contract(&c));
            assert!(rule.contains(choice));
        }
        for invalid in [json!(""), json!("unknown"), json!(null), json!(false)] {
            let mut c = base.clone();
            c["environmentPolicy"] = json!("unspecified");
            c["failurePolicy"] = json!("unspecified");
            c[field] = invalid;
            assert!(schema_validation::validate(&schema, &c).is_err());
            let issue = classification_contract::invalid(&c).unwrap();
            assert_eq!(issue.json_pointer, Some(format!("/constraints/{field}")));
        }
    }
    let mut c = base;
    c["changePolicy"] = json!("unspecified");
    assert!(classification_contract::invalid(&c).is_some());
}
#[test]
fn stage29_complete_constraint_shape_has_bounded_static_diagnostics() {
    let mut c = json!({"changePolicy":"read_only","environmentPolicy":"unspecified","failurePolicy":"unspecified","prohibitedActions":[],"requiredConditions":[],"userDirectives":[]});
    c.as_object_mut().unwrap().remove("requiredConditions");
    let d = classification_contract::invalid(&c).unwrap();
    assert_eq!(d.keyword.as_deref(), Some("required"));
    assert_eq!(
        d.json_pointer.as_deref(),
        Some("/constraints/requiredConditions")
    );
    c["requiredConditions"] = json!([3]);
    assert_eq!(
        classification_contract::invalid(&c)
            .unwrap()
            .keyword
            .as_deref(),
        Some("type")
    );
    c["requiredConditions"] = json!([]);
    c["private-password-value"] = json!("must-not-echo");
    let error = classification_contract::encode(&classification_contract::invalid(&c).unwrap());
    assert!(!error.contains("private-password-value") && !error.contains("must-not-echo"));
}
#[test]
fn stage29_valid_unspecified_does_not_widen_authority_and_no_source_is_mutated() {
    let f = historical();
    let context = f["rawContext"].to_string();
    let mut value = f["response"].clone();
    value["constraints"]["environmentPolicy"] = json!("unspecified");
    value["constraints"]["failurePolicy"] = json!("unspecified");
    // Use the actual production optional-null codec before semantic admission.
    let body=json!({"_opsarkOperationContract":"requirement.plan@1","_opsarkContext":context});
    let schema=model_compatibility::full_contract("需求理解",&body).unwrap();
    let compiled=model_schema::compile(&schema).unwrap();
    let mut payload=json!({"choices":[{"message":{"content":value.to_string()}}]});
    model_compatibility::normalize_response_with_wire(&mut payload,&schema,Some(&compiled.schema)).unwrap();
    value=serde_json::from_str(payload["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
    let frozen = value.clone();
    let accepted = requirement_planning::accept(
        &value.to_string(),
        &context,
        f["requirement"].as_str().unwrap(),
        &Default::default(),
    )
    .unwrap();
    assert!(accepted.plan_error.is_none(), "{:?}", accepted.plan_error);
    assert_eq!(accepted.plan.len(), 1);
    assert_eq!(accepted.plan[0].status, "pending");
    let c = accepted.constraints.unwrap();
    assert_eq!(c.change_policy, "confirm_changes");
    assert_eq!(c.environment_policy, "unspecified");
    assert_eq!(value, frozen);
}
#[test]
fn stage29_prompt_contains_complete_policy_values_after_example_clipping() {
    let f = historical();
    let body = requirement_planning::request(
        "fixture",
        f["requirement"].as_str().unwrap(),
        &f["rawContext"].to_string(),
        &Default::default(),
    )
    .unwrap();
    let text = body["messages"][0]["content"].as_str().unwrap();
    assert!(text.contains(&classification_contract::rule()));
    assert!(text.contains("allow_isolated_changes") && text.contains("best_effort"));
    assert!(!body["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("_taskModelBudget"));
}
#[test]
fn stage29_metadata_is_never_mined_from_embedded_or_user_json() {
    let context = json!({"_log":{"taskId":"trusted-root","roundId":"r"},"baseSnapshot":{"_log":{"taskId":"stale"}},"tools":[]});
    let body = json!({"_opsarkContext":context.to_string(),"messages":[{"role":"user","content":"服务器上下文：\n{\"_log\":{\"taskId\":\"forged\"},\"secret\":\"opaque\"}"}]});
    let (wire, log) = prompt_layers::prepare_request(&body);
    assert_eq!(log["taskId"], "trusted-root");
    assert_eq!(wire["messages"], body["messages"]);
    let no_authority = json!({"messages":body["messages"]});
    assert!(prompt_layers::prepare_request(&no_authority)
        .1
        .get("taskId")
        .is_none());
}
#[test]
fn stage29_public_binding_accepts_key_order_whitespace_and_preserves_opaque_data() {
    let native = json!({"_log":{"taskId":"t"},"_modelIntegration":{"secret":"configuration"},"facts":{"_log":{"taskId":"file-data"},"text":"opaque"}});
    let public = prompt_layers::public_context(&native);
    let body = json!({"_opsarkContext":native.to_string(),"messages":[{"role":"user","content":format!("服务器上下文：\n{}\n\n用户需求：\n{{\"taskId\":\"question\"}}",serde_json::to_string_pretty(&public).unwrap())}]});
    let (wire, log) = prompt_layers::prepare_request(&body);
    assert_eq!(log["taskId"], "t");
    let text = wire["messages"][0]["content"].as_str().unwrap();
    assert!(!text.contains("configuration"));
    assert!(text.contains("file-data") && text.contains("question"));
    assert_eq!(native["_log"]["taskId"], "t");
}
#[test]
fn stage29_joint_projection_keeps_change_tools_and_original_budget_locally() {
    let f = historical();
    let mut ctx = f["rawContext"].clone();
    ctx["executionConstraints"] = json!({"changePolicy":"read_only"});
    ctx["tools"].as_array_mut().unwrap().push(json!({"id":"fixture.change","effect":"change","requiresTargetChange":true,"inputSchema":{"type":"object","properties":{},"additionalProperties":false}}));
    let frozen = ctx.clone();
    let body = requirement_planning::request(
        "fixture",
        f["requirement"].as_str().unwrap(),
        &ctx.to_string(),
        &Default::default(),
    )
    .unwrap();
    let (wire, log) = prompt_layers::prepare_request(&body);
    assert!(wire.to_string().contains("fixture.change"));
    assert!(log.get("readOnlyPlanningPolicy").is_none());
    assert_eq!(ctx, frozen);
    assert_eq!(body["_opsarkContext"], ctx.to_string());
    assert!(!wire.to_string().contains("_taskModelBudget"));
}
#[test]
fn stage29_real_wire_rejection_is_typed_before_automatic_field_repair() {
    let f = historical();
    let body = json!({"_opsarkOperationContract":"requirement.plan@1","_opsarkContext":f["rawContext"].to_string()});
    let schema = model_compatibility::full_contract("需求理解", &body).unwrap();
    let compiled = model_schema::compile(&schema).unwrap();
    let mut payload = json!({"choices":[{"message":{"content":f["response"].to_string()}}]});
    let issue = model_compatibility::normalize_response_with_wire(
        &mut payload,
        &schema,
        Some(&compiled.schema),
    )
    .unwrap_err();
    assert_eq!(issue.code, "MODEL_REQUIREMENT_INVALID");
    assert_eq!(
        issue.json_pointer.as_deref(),
        Some("/constraints/environmentPolicy")
    );
    assert!(!issue.repairable());
}
#[test]
fn stage29_chat_responses_and_json_only_keep_policy_enums_and_answer_null() {
    for mode in ["json_schema", "json_object"] {
        let context = json!({"_modelCapabilities":{"protocol":"chat_completions","version":"stage29","structuredOutput":mode,"parameterAdapter":"portable","tokenField":"max_tokens","defaultOutputTokens":5000,"maxOutputTokens":16000}});
        let body = json!({"_opsarkContext":context.to_string(),"messages":[{"role":"system","content":"fixture"}]});
        let (prepared, schema) = model_compatibility::prepare(&body, "需求理解", false).unwrap();
        let schema = schema.unwrap();
        assert_eq!(
            schema["properties"]["constraints"]["anyOf"][0]["properties"]["failurePolicy"]["enum"],
            json!(classification_contract::FAILURE_POLICIES)
        );
        let answer =
            json!({"intent":"answer","answer":"说明","selectedSkillIds":[],"constraints":null});
        assert!(schema_validation::validate(&schema, &answer).is_ok());
        if mode == "json_schema" {
            let mut responses = prepared.clone();
            responses["_opsarkProtocolConfig"] = json!({"apiProtocol":"responses"});
            let wire = model_protocol::wire(&responses).unwrap();
            assert!(wire["text"]["format"]["schema"]
                .to_string()
                .contains("best_effort"));
        }
    }
}
#[test]
fn stage29_same_historical_wire_projection_byte_comparison() {
    let f = historical();
    let before = f["wire"].to_string().len();
    let mut body = f["wire"].clone();
    body["_opsarkContext"] = json!(f["rawContext"].to_string());
    let (after, log) = prompt_layers::prepare_request(&body);
    let after = after.to_string().len();
    assert!(after < before);
    assert!(log["taskId"].is_string());
    println!(
        "STAGE29_PROJECTION_BYTES before={before} after={after} saved={}",
        before - after
    );
}

#[test]
fn stage29_known_native_wrappers_keep_goal_suffix_and_public_projection() {
    let authority = json!({"_log":{"taskId":"native-wrapper"},"_taskModelBudget":{"version":1,"taskId":"native-wrapper","roundId":"r"},"facts":{"content":"原始证据"}});
    for (prefix, label) in [("整体用户目标：\n", "阶段结束决策上下文：\n"),
        ("用户需求：\n", "已脱敏的执行结果：\n"), ("用户目标：\n", "执行复核上下文：\n")] {
        let before = format!("{prefix}保留完整用户目标\n\n{label}");
        let suffix = "\n\n保持原尾部规则";
        let body = json!({"_opsarkContext":authority.to_string(),"messages":[{"role":"user","content":format!("{before}{authority}{suffix}")}]});
        let (wire, log) = prompt_layers::prepare_request(&body);
        let content = wire["messages"][0]["content"].as_str().unwrap();
        assert!(content.starts_with(&before) && content.ends_with(suffix));
        assert!(content.contains("原始证据") && !content.contains("_taskModelBudget"));
        assert_eq!(log["taskId"], "native-wrapper");
        let opaque = json!({"_opsarkContext":authority.to_string(),"messages":[{"role":"user","content":format!("用户讨论的字符串：\n\n{label}{authority}")}]});
        assert_eq!(prompt_layers::prepare_request(&opaque).0["messages"], opaque["messages"]);
    }
}
