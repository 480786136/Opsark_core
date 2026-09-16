use super::*;

fn diagnosis(command: &str) -> AiPlanStep {
    serde_json::from_value(json!({"kind":"observe","title":"Inspect failed host","description":"Collect read-only evidence",
        "command":command,"expected":"Evidence for the original failure","validation":"","risk":"low",
        "recovery":{"failedStepId":"failed-init","targetContext":"original-target","purpose":"diagnose"}})).unwrap()
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
        &HashSet::new(),
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
