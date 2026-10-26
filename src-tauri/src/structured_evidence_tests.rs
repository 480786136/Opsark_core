use super::*;
fn proposal() -> Value {
    json!({"kind":"observe","title":"读取对象","description":"检查对象","expected":"结果正确","validation":"","risk":"low",
        "action":{"type":"tool","toolId":"files.read_content","arguments":{"path":"/fixture"}},"evidenceRequirements":["file_content"]})
}
fn body(marker: Value) -> Value {
    json!({"_opsarkContext":json!({"_planEvidenceContract":marker,"tools":[{"id":"files.read_content","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}}]}).to_string()})
}
#[test]
fn stage27_evidence_survives_conversion_and_rejected_candidate_serialization() {
    let step: AiPlanStep = serde_json::from_value(proposal()).unwrap();
    assert_eq!(
        serde_json::to_value(&step).unwrap()["evidenceRequirements"],
        json!(["file_content"])
    );
    validate_ai_plan_contract(
        std::slice::from_ref(&step),
        &AiGenerationSettings::default(),
    )
    .unwrap();
    let converted = convert_ai_plan_steps(vec![step]).unwrap();
    assert_eq!(
        serde_json::to_value(&converted[0]).unwrap()["evidenceRequirements"],
        json!(["file_content"])
    );
}
#[test]
fn stage27_evidence_legacy_omission_and_explicit_empty_remain_distinct() {
    let mut value = proposal();
    value
        .as_object_mut()
        .unwrap()
        .remove("evidenceRequirements");
    let legacy: AiPlanStep = serde_json::from_value(value.clone()).unwrap();
    assert!(serde_json::to_value(legacy)
        .unwrap()
        .get("evidenceRequirements")
        .is_none());
    value["evidenceRequirements"] = json!([]);
    let explicit: AiPlanStep = serde_json::from_value(value).unwrap();
    assert_eq!(
        serde_json::to_value(explicit).unwrap()["evidenceRequirements"],
        json!([])
    );
}
#[test]
fn stage27_evidence_malformed_declarations_are_rejected_by_serde() {
    for invalid in [
        json!(null),
        json!("file_content"),
        json!(["unknown"]),
        json!(["file_content", "file_content"]),
        json!([3]),
    ] {
        let mut value = proposal();
        value["evidenceRequirements"] = invalid;
        assert!(serde_json::from_value::<AiPlanStep>(value).is_err());
    }
}
#[test]
fn stage27_evidence_shell_declaration_cannot_grant_body_capability() {
    let mut value = proposal();
    value["action"] = json!({"type":"shell","command":"cat /fixture"});
    let step: AiPlanStep = serde_json::from_value(value.clone()).unwrap();
    assert!(validate_ai_plan_contract(&[step.clone()], &AiGenerationSettings::default()).is_err());
    assert!(convert_ai_plan_steps(vec![step]).is_err());
    value["evidenceRequirements"] = json!([]);
    assert!(validate_ai_plan_contract(
        &[serde_json::from_value(value).unwrap()],
        &AiGenerationSettings::default()
    )
    .is_ok());
}
#[test]
fn stage27_evidence_schema_is_required_only_for_negotiated_operations() {
    for name in [
        "计划生成",
        "阶段联合决策",
        "阶段格式修复（兼容模式）",
        "模型业务测试",
        "需求理解",
    ] {
        let mut input = body(json!({"version":1}));
        input["_opsarkOperationContract"] = json!("requirement.plan@1");
        let schema = model_compatibility::full_contract(name, &input).unwrap();
        let step = &schema["properties"]["steps"]["items"];
        assert!(step["required"]
            .as_array()
            .unwrap()
            .contains(&json!("evidenceRequirements")));
        for invalid in [
            None,
            Some(json!(null)),
            Some(json!(["unknown"])),
            Some(json!(["file_content", "file_content"])),
        ] {
            let mut p = proposal();
            p.as_object_mut().unwrap().remove("evidenceRequirements");
            if let Some(v) = invalid {
                p["evidenceRequirements"] = v;
            }
            assert!(schema_validation::validate(step, &p).is_err());
        }
        assert!(schema_validation::validate(step, &proposal()).is_ok());
        assert!(model_schema::compile(&schema).is_ok());
    }
    let old = model_compatibility::full_contract("计划生成", &json!({})).unwrap();
    assert!(old["properties"]["steps"]["items"]["properties"]
        .get("evidenceRequirements")
        .is_none());
    let review =
        model_compatibility::full_contract("结果复核", &body(json!({"version":1}))).unwrap();
    assert!(review["properties"].get("steps").is_none());
}
#[test]
fn stage27_evidence_unknown_version_fails_before_transport() {
    for marker in [
        json!(null),
        json!({"version":2}),
        json!({"version":1,"extra":true}),
        json!(1),
    ] {
        assert!(
            model_compatibility::prepare(&body(marker), "计划生成", false)
                .unwrap_err()
                .contains("PLAN_EVIDENCE_CONTRACT_UNSUPPORTED")
        );
    }
}

fn capabilities(protocol: &str) -> Value {
    json!({"version":"model-capabilities@2","revision":"offline-stage27","supportedProtocols":[protocol],"preferredProtocol":protocol,
        "outputModes":{"json_object":"supported","json_schema":"supported"},"parameterAdapter":"openai",
        "tokenField":if protocol=="responses" {"max_output_tokens"} else {"max_completion_tokens"},"defaultOutputTokens":5000,"maxOutputTokens":16000,
        "budgetSemantics":"total_output","strictFlag":"required","store":"supported",
        "parameterRules":{"reasoningEfforts":["none","low","medium","high","xhigh"],"thinkingEnabled":false,"frequencyPenalty":false,
            "temperature":"supported","topP":"supported","presencePenalty":"unsupported"},"evidence":{"source":"user_declared"}})
}
#[test]
fn stage27_evidence_chat_and_responses_wire_keep_the_same_required_declaration() {
    for protocol in ["chat_completions", "responses"] {
        let mut input = body(json!({"version":1}));
        let mut ctx: Value =
            serde_json::from_str(input["_opsarkContext"].as_str().unwrap()).unwrap();
        ctx["_modelIntegration"] = json!({"apiProtocol":protocol,"outputPolicy":"require_schema","capabilitiesV2":capabilities(protocol)});
        input["_opsarkContext"] = json!(ctx.to_string());
        input["messages"] = json!([{ "role":"user","content":ctx.to_string() }]);
        let (prepared, local) = model_compatibility::prepare(&input, "计划生成", false).unwrap();
        assert_eq!(prepared["_opsarkSchemaCompilation"]["evidenceContractVersion"], "plan.evidence@1");
        let wire = model_protocol::wire(&prepared).unwrap();
        let schema = if protocol == "responses" {
            &wire["text"]["format"]["schema"]
        } else {
            &wire["response_format"]["json_schema"]["schema"]
        };
        assert!(schema["properties"]["steps"]["items"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("evidenceRequirements")));
        assert!(local.unwrap().to_string().contains("evidenceRequirements"));
        assert!(wire.to_string().contains("providedEvidence"));
        assert_eq!(wire["store"], false);
    }
}
#[test]
fn stage27_evidence_json_only_also_receives_declaration_guidance_and_local_schema() {
    let mut input = body(json!({"version":1}));
    input["messages"] = json!([{ "role":"system","content":"只输出计划" }]);
    let (prepared, schema) = model_compatibility::prepare(&input, "计划生成", false).unwrap();
    assert_eq!(prepared["response_format"]["type"], "json_object");
    assert!(prepared["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("evidenceRequirements"));
    assert!(schema.unwrap()["properties"]["steps"]["items"]["required"]
        .as_array()
        .unwrap()
        .contains(&json!("evidenceRequirements")));
}
#[test]
fn stage27_evidence_scoped_shell_repair_preserves_explicit_empty_declaration() {
    let mut input = body(json!({"version":1}));
    let mut ctx: Value = serde_json::from_str(input["_opsarkContext"].as_str().unwrap()).unwrap();
    ctx["workflowPhase"] = json!("protocol_repair");
    ctx["protocolRepairBudget"] = json!({"remainingModelCalls":1});
    let mut p = proposal();
    p["action"] = json!({"type":"shell","command":"uname -a"});
    p["evidenceRequirements"] = json!([]);
    ctx["planGenerationRepair"] = json!({"responseMode":"rejected_fields","originalPlanMergedLocally":true,
        "previousModelOutput":[p],"originalStepIndices":[0],"diagnostic":{"allowedRepairPaths":["steps[0].action.command"]}});
    input["_opsarkContext"] = json!(ctx.to_string());
    let full = model_compatibility::full_contract("计划生成", &input).unwrap();
    let repair = scoped_model_repair::ScopedRepair::new("计划生成", &input, &full).unwrap();
    let merged = repair
        .merge(&json!({"steps[0].action.command":"uname -r"}))
        .unwrap();
    assert_eq!(merged["steps"][0]["evidenceRequirements"], json!([]));
    assert_eq!(merged["steps"][0]["action"]["command"], "uname -r");
}
#[test]
fn stage27_evidence_declaration_adds_bounded_wire_bytes_without_changing_output_budget() {
    let mut next = body(json!({"version":1}));
    next["messages"] = json!([{ "role":"system","content":"只输出计划" }]);
    let mut old = next.clone();
    let mut ctx: Value = serde_json::from_str(old["_opsarkContext"].as_str().unwrap()).unwrap();
    ctx.as_object_mut().unwrap().remove("_planEvidenceContract");
    old["_opsarkContext"] = json!(ctx.to_string());
    let (a, _) = model_compatibility::prepare(&old, "计划生成", false).unwrap();
    let (b, _) = model_compatibility::prepare(&next, "计划生成", false).unwrap();
    let a = model_protocol::wire(&a).unwrap();
    let b = model_protocol::wire(&b).unwrap();
    assert_eq!(a["max_tokens"], b["max_tokens"]);
    assert_eq!(a["max_completion_tokens"], b["max_completion_tokens"]);
    let before = a.to_string().len();
    let after = b.to_string().len();
    assert!(after > before && after - before < 1500);
    println!(
        "STAGE27_WIRE_BYTES old={before} new={after} delta={}",
        after - before
    );
}
