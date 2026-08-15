use super::*;

#[test]
fn repairs_missing_presentational_plan_fields_but_rejects_missing_execution_fields() {
    let missing_title = r#"{"steps":[{"description":"检查目标是否正常。","command":"custom-tool inspect","expected":"","validation":"custom-tool inspect >/dev/null","risk":"low"}]}"#;
    let repairable = parse_model_array_field(missing_title, "steps").unwrap();
    assert!(
        validate_ai_plan_contract(&repairable, &AiGenerationSettings::default())
            .unwrap_err()
            .contains("title")
    );
    let normalized = convert_ai_plan_steps(repairable).unwrap();
    assert_eq!(normalized[0].title, "检查目标是否正常");
    assert!(!normalized[0].expected.is_empty());

    let missing_command = r#"{"steps":[{"title":"检查","description":"检查目标","expected":"返回状态","validation":"custom-tool inspect >/dev/null","risk":"low"}]}"#;
    let error = convert_ai_plan_steps(parse_model_array_field(missing_command, "steps").unwrap())
        .unwrap_err();
    assert!(error.contains("command 或 validation"));
}

#[test]
fn plan_length_limits_are_optional_and_allow_multiline_commands() {
    let long_command = format!("echo start\n{}", "x".repeat(1500));
    let steps = vec![AiPlanStep {
        title: "一个超过旧标题长度限制但依然是合法计划步骤的完整标题".into(),
        description: "读取并处理真实环境信息".into(),
        command: long_command,
        expected: "获得完整结果".into(),
        validation: "test -f /tmp/result\nprintf 'ok\\n'".into(),
        risk: Some("low".into()),
    }];
    assert!(validate_ai_plan_contract(&steps, &AiGenerationSettings::default()).is_ok());

    let limited = AiGenerationSettings {
        limit_output: true,
        max_text_chars: 10,
        max_command_chars: 100,
        ..AiGenerationSettings::default()
    };
    assert!(validate_ai_plan_contract(&steps, &limited).is_err());
}

#[test]
fn plan_step_count_limit_is_only_applied_when_enabled() {
    let steps = (0..8)
        .map(|index| AiPlanStep {
            title: format!("步骤 {}", index + 1),
            description: "执行必要操作".into(),
            command: format!("echo {index}"),
            expected: "命令正常完成".into(),
            validation: "true".into(),
            risk: Some("low".into()),
        })
        .collect::<Vec<_>>();

    let unlimited = AiGenerationSettings::default();
    assert!(validate_ai_plan_contract(&steps, &unlimited).is_ok());
    assert_eq!(convert_ai_plan_steps(steps.clone()).unwrap().len(), 8);

    let limited = AiGenerationSettings {
        limit_output: true,
        max_plan_steps: 6,
        ..AiGenerationSettings::default()
    };
    assert!(validate_ai_plan_contract(&steps, &limited)
        .unwrap_err()
        .contains("不能超过配置的 6 个"));
}

#[test]
fn parses_answer_and_execute_requirement_intents() {
    let answer: AiRequirementDecision =
        serde_json::from_str(r#"{"intent":"answer","answer":"这是风险咨询。","constraints":null}"#)
            .unwrap();
    assert_eq!(answer.intent, "answer");

    let execute: AiRequirementDecision = serde_json::from_str(
        r#"{"intent":"execute","answer":"","constraints":{"changePolicy":"requested_changes_only","environmentPolicy":"preserve","failurePolicy":"best_effort","prohibitedActions":["升级宿主运行时"],"requiredConditions":["保留当前环境"],"userDirectives":["尽力尝试"]}}"#,
    )
    .unwrap();
    assert_eq!(execute.intent, "execute");
    let constraints =
        normalize_execution_constraints(Some(serde_json::from_value(execute.constraints).unwrap()));
    assert_eq!(constraints.environment_policy, "preserve");
    assert_eq!(constraints.failure_policy, "best_effort");
    assert_eq!(constraints.prohibited_actions, vec!["升级宿主运行时"]);

    let mixed_stage = r#"{"intent":"execute","answer":"","constraints":null,"steps":[]}"#;
    assert!(serde_json::from_str::<AiRequirementDecision>(mixed_stage).is_err());
}

#[test]
fn grep_no_match_is_a_valid_empty_query_result() {
    assert!(is_valid_empty_result(
        "ps -ef | grep java | grep -v grep",
        1,
        ""
    ));
    assert!(!is_valid_empty_result("systemctl is-active nginx", 1, ""));
    assert!(!is_valid_empty_result(
        "grep java /missing/file",
        2,
        "No such file"
    ));
}

#[test]
fn demo_high_risk_command_requires_explicit_approval() {
    assert!(!execute_command("rm -rf /tmp/explicit-target".into(), false).success);
    assert!(execute_command("rm -rf /tmp/explicit-target".into(), true).success);
}
