use super::*;

fn diagnosis(command: &str) -> AiPlanStep {
    serde_json::from_value(json!({"kind":"observe","title":"Inspect failed host","description":"Collect read-only evidence",
        "command":command,"expected":"Evidence for the original failure","validation":"","risk":"low",
        "recovery":{"failedStepId":"failed-init","targetContext":"original-target","purpose":"diagnose"}})).unwrap()
}

#[test]
fn recovery_audit_is_optional_and_replanned_verification_can_change_method() {
    let mut ordinary = diagnosis("uname -a");
    ordinary.recovery = None;
    let mut verification = diagnosis("test -s /opt/report/build/report.zip");
    verification.expected = "A nonempty build artifact exists".into();
    verification.recovery.as_mut().unwrap()["purpose"] = json!("verify");
    let steps = vec![ordinary, verification.clone()];

    validate_ai_plan_contract(&steps, &AiGenerationSettings::default()).unwrap();
    let converted = convert_ai_plan_steps(steps).unwrap();
    assert!(converted[0].recovery.is_none());
    assert!(converted[0].recovery_rule_version.is_none());
    assert_eq!(converted[1].command, verification.command);
    assert_eq!(converted[1].expected, verification.expected);
    assert_eq!(converted[1].recovery, verification.recovery);
    assert_eq!(converted[1].status, "pending");
}

#[test]
fn verification_audit_never_bypasses_observe_safety() {
    let mut step = diagnosis("touch /tmp/forged-build-evidence");
    step.recovery.as_mut().unwrap()["purpose"] = json!("verify");
    let rejected = validate_ai_plan_contract(&[step.clone()], &AiGenerationSettings::default()).unwrap_err();
    let converted = convert_ai_plan_steps(vec![step]).unwrap_err();
    assert_eq!(rejected, converted);
    assert_eq!(recovery_rules::decode_issue(&rejected).unwrap().code, "OBSERVE_COMMAND_MUTATION");
}

#[test]
fn recovery_prompt_distinguishes_historical_facts_from_future_acceptance_methods() {
    assert!(PLAN_STEP_OUTPUT_CONTRACT.contains("recovery 是可选的历史关联元数据"));
    assert!(PLAN_STEP_OUTPUT_CONTRACT.contains("调整后续步骤、剩余计划及验收方法"));
    assert!(PLAN_STEP_OUTPUT_CONTRACT.contains("不可改写的执行事实"));
    assert!(PLAN_STEP_OUTPUT_CONTRACT.contains("仍须通过安全、授权和真实执行证据检查"));
    assert!(!PLAN_STEP_OUTPUT_CONTRACT.contains("verify 应引用 failedAttempt.verification 中的验收契约"));
}

#[test]
fn recovery_incident_is_rejected_before_conversion_with_exact_shared_issue() {
    let step = diagnosis("TMPD=$(mktemp -d); uname >\"$TMPD/info\"; rm -rf \"$TMPD\"");
    let rejected =
        validate_ai_plan_contract(&[step.clone()], &AiGenerationSettings::default()).unwrap_err();
    let converted = convert_ai_plan_steps(vec![step]).unwrap_err();
    assert_eq!(rejected, converted);
    let issue = recovery_rules::decode_issue(&rejected).unwrap();
    assert_eq!(issue.code, "RECOVERY_DIAGNOSE_MUTATION");
    assert_eq!(issue.matched_token.as_deref(), Some("mktemp"));
    assert_eq!(issue.field_path, "steps[0].command");
    assert_eq!(plan_error_step_index(&rejected, 1), Some(1));
}

#[test]
fn recovery_command_only_patch_succeeds_and_exports_rule_version() {
    let original = diagnosis("rm /tmp/diagnostic");
    let issue =
        recovery_rules::metadata_issue(&serde_json::to_value(&original).unwrap(), 0).unwrap();
    let fixed = diagnosis("set -o pipefail; rpm -q conntrack-tools | head -n 20");
    let mut steps = vec![original];
    apply_recovery_step_repair(
        &mut steps,
        AiPlanStepRepair {
            step_index: 1,
            replacement_steps: vec![fixed],
        },
        &issue,
    )
    .unwrap();
    validate_ai_plan_contract(&steps, &AiGenerationSettings::default()).unwrap();
    let converted = convert_ai_plan_steps(steps).unwrap();
    assert_eq!(
        converted[0].recovery_rule_version,
        Some(recovery_rules::version())
    );
}

#[test]
fn recovery_patch_rejects_replanning_and_stops_identical_output() {
    let original = diagnosis("rm /tmp/diagnostic");
    let issue =
        recovery_rules::metadata_issue(&serde_json::to_value(&original).unwrap(), 0).unwrap();
    for field in [
        "kind",
        "risk",
        "expected",
        "validation",
        "recovery",
        "title",
        "description",
    ] {
        let mut value = serde_json::to_value(&original).unwrap();
        value["command"] = json!("uname -a");
        value[field] = if field == "recovery" {
            json!({"failedStepId":"forged","targetContext":"other","purpose":"repair"})
        } else {
            json!("changed")
        };
        let patch: AiPlanStep = serde_json::from_value(value).unwrap();
        let mut steps = vec![original.clone()];
        let error = apply_recovery_step_repair(
            &mut steps,
            AiPlanStepRepair {
                step_index: 1,
                replacement_steps: vec![patch],
            },
            &issue,
        )
        .unwrap_err();
        assert!(error.contains("PROTOCOL_REPAIR_SCOPE_VIOLATION"), "{field}");
        assert_eq!(steps[0].command, original.command);
    }
    let mut steps = vec![original.clone()];
    let error = apply_recovery_step_repair(
        &mut steps,
        AiPlanStepRepair {
            step_index: 1,
            replacement_steps: vec![original.clone()],
        },
        &issue,
    )
    .unwrap_err();
    assert!(error.contains("PROTOCOL_REPAIR_NO_PROGRESS"));
    let error = apply_recovery_step_repair(
        &mut steps,
        AiPlanStepRepair {
            step_index: 1,
            replacement_steps: vec![original.clone(), original],
        },
        &issue,
    )
    .unwrap_err();
    assert!(error.contains("PROTOCOL_REPAIR_SCOPE_VIOLATION"));
}

#[test]
fn recovery_stop_envelope_retains_original_plan_and_consumed_budget() {
    let original = diagnosis("rm /tmp/diagnostic");
    let issue =
        recovery_rules::metadata_issue(&serde_json::to_value(&original).unwrap(), 0).unwrap();
    let budget = PlanRepairBudget {
        total_model_calls: 2,
        focused_repair_calls: 1,
        ..Default::default()
    };
    let error = json!({"issue":issue,"repairStopCode":"PROTOCOL_REPAIR_NO_PROGRESS"}).to_string();
    let output: Value = serde_json::from_str(
        &recovery_failure_envelope(&error, &[original.clone()], &budget).unwrap(),
    )
    .unwrap();
    assert_eq!(output["steps"][0]["command"], original.command);
    assert_eq!(output["repairAttempted"], true);
    assert_eq!(output["modelCalls"], 2);
    assert_eq!(output["focusedRepairCalls"], 1);
    assert_eq!(output["repairStopCode"], "PROTOCOL_REPAIR_NO_PROGRESS");
    assert_eq!(
        external_plan_call_limit(r#"{"protocolRepairBudget":{"remainingModelCalls":1}}"#),
        Some(1)
    );
    assert_eq!(
        external_plan_call_limit(r#"{"protocolRepairBudget":{"remainingModelCalls":0}}"#),
        Some(0)
    );
    assert_eq!(external_plan_call_limit("{}"), None);
}

#[test]
fn model_plan_ids_never_collide_across_same_second_generations() {
    let ids: HashSet<String> = (0..1000).map(|_| next_plan_step_id("ai-step", 0)).collect();
    assert_eq!(ids.len(), 1000);
}

#[test]
fn next_stage_recovery_failure_retains_original_business_decision_for_local_patch() {
    let decision = AiNextStageDecision {
        decision: "adjust".into(),
        reason: "Inspect the existing failure".into(),
        summary: "Read-only diagnosis".into(),
        steps: vec![diagnosis("mktemp -d")],
    };
    let error = validate_next_stage_preserving_recovery(
        decision,
        &AiGenerationSettings::default(),
        None,
    )
    .unwrap_err();
    let envelope: Value = serde_json::from_str(&error).unwrap();
    assert_eq!(envelope["steps"][0]["command"], "mktemp -d");
    assert_eq!(envelope["nextStageDecision"]["decision"], "adjust");
    assert_eq!(
        envelope["nextStageDecision"]["reason"],
        "Inspect the existing failure"
    );
    assert_eq!(envelope["repairAttempted"], false);
    assert_eq!(envelope["modelCalls"], 1);
    assert_eq!(envelope["issue"]["code"], "RECOVERY_DIAGNOSE_MUTATION");
}

#[test]
fn next_stage_hidden_tool_failure_preserves_the_rejected_plan_for_business_replanning() {
    let decision = AiNextStageDecision {
        decision: "continue".into(), reason: "Read project declarations".into(),
        summary: "Deployment is not complete".into(),
        steps: vec![AiPlanStep {
            kind: "observe".into(), title: "Read".into(), description: "Read evidence".into(),
            command: "opsark-tool files.get_structure {\"rootPath\":\"/opt/report\"}".into(),
            expected: "Project structure".into(), validation: "true".into(), risk: Some("low".into()),
            ..AiPlanStep::default()
        }],
    };
    let visible = HashSet::from(["evidence.read".to_string()]);
    let error = validate_next_stage_preserving_recovery(decision, &AiGenerationSettings::default(), Some(&visible)).unwrap_err();
    let envelope: Value = serde_json::from_str(&error).unwrap();
    assert_eq!(envelope["kind"], "plan_protocol_failure");
    assert_eq!(envelope["rejectedPlanExecuted"], false);
    assert_eq!(envelope["steps"][0]["status"], "pending");
    assert!(envelope["steps"][0]["id"].is_string());
    assert_eq!(envelope["nextStageDecision"]["decision"], "continue");
    assert!(envelope["validationError"].as_str().unwrap().contains("当前规划上下文未开放工具 files.get_structure"));
    assert!(GENERAL_PLAN_SYSTEM.contains("Skill 是领域流程参考") || GENERAL_PLAN_SYSTEM.contains("activeSkills 是领域流程参考"));
}

#[test]
fn next_stage_parse_failures_preserve_raw_responses_without_inventing_steps() {
    let incident = include_str!("../../src/services/fixtures/next-stage-missing-steps.json");
    for content in [
        incident,
        r#"{"decision":"complete","reason":"claimed success","summary":"done"}"#,
        r#"{"decision":"adjust","reason":"ask","summary":"waiting","steps":{}}"#,
        r#"{"decision":"continue","reason":"read","summary":"next","steps":[{"command":42}]}"#,
        r#"{"decision":"adjust","reason":null,"summary":"waiting","steps":[]}"#,
        r#"{"decision":"adjust","#,
        "",
    ] {
        let payload = json!({"choices":[{"message":{"content":content},"finish_reason":"stop"}]});
        let error = parse_next_stage_response(&payload).unwrap_err();
        let envelope: Value = serde_json::from_str(&error).unwrap();
        assert_eq!(envelope["kind"], "next_stage_response_invalid");
        assert_eq!(envelope["rawResponse"], content);
        assert_eq!(envelope["rejectedPlanExecuted"], false);
        assert!(envelope.get("steps").is_none());
        assert!(envelope.get("nextStageDecision").is_none());
        assert!(envelope["validationError"].as_str().unwrap().contains("阶段联合决策结构解析失败"));
    }
    let missing_content: Value = serde_json::from_str(&parse_next_stage_response(&json!({})).unwrap_err()).unwrap();
    assert_eq!(missing_content["kind"], "next_stage_response_invalid");
    assert_eq!(missing_content["rawResponse"], "");
}

#[test]
fn next_stage_explicit_empty_steps_still_requires_semantic_validation() {
    for decision in ["complete", "adjust", "continue"] {
        let content = json!({"decision":decision,"reason":"evidence-based reason","summary":"status","steps":[]}).to_string();
        let parsed = parse_next_stage_response(&json!({"choices":[{"message":{"content":content}}]})).unwrap();
        let result = validate_next_stage_preserving_recovery(parsed, &AiGenerationSettings::default(), None);
        if decision == "continue" {
            assert!(result.unwrap_err().contains("steps 至少需要 1 个元素"));
        } else {
            assert!(result.unwrap().steps.is_empty());
        }
    }
}
