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
            validation: format!("printf '%s\\n' {index} | grep -qx {index}"),
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
fn validates_tool_protocol_without_embedding_catalog_workflows() {
    let input_step = AiPlanStep {
        title: "输入 SSH 连接信息".into(),
        description: "请用户提供目标服务器的 SSH 用户名和密码".into(),
        command: r#"opsark-tool user.request_input {"title":"SSH 连接信息","fields":[{"key":"username","label":"SSH 用户名","description":"用于登录 192.168.1.23","type":"text","required":true},{"key":"password","label":"SSH 密码","description":"用于验证 SSH 账号","type":"password","required":true}]}"#.into(),
        expected: "用户完成 SSH 连接参数输入".into(),
        validation: "true".into(),
        risk: Some("low".into()),
    };

    assert!(validate_ai_plan_contract(
        std::slice::from_ref(&input_step),
        &AiGenerationSettings::default()
    )
    .is_ok());
    assert!(convert_ai_plan_steps(vec![input_step.clone()]).is_ok());

    let extra_step = AiPlanStep {
        title: "立即连接".into(),
        description: "不应在参数输入前规划".into(),
        command: "ssh 192.168.1.23".into(),
        expected: "连接成功".into(),
        validation: "ssh -o BatchMode=yes 192.168.1.23 true".into(),
        risk: Some("medium".into()),
    };
    // planMode is trusted catalog metadata and is enforced by the frontend
    // normalizer; the Rust JSON validator stays independent of concrete IDs.
    assert!(
        validate_ai_plan_contract(&[input_step, extra_step], &AiGenerationSettings::default())
            .is_ok()
    );
}

#[test]
fn accepts_generic_model_tools_and_rejects_non_protocol_validation() {
    let connect = AiPlanStep {
        title: "在当前终端执行 SSH 登录".into(),
        description: "使用已安全收集的凭据在任务绑定终端登录目标服务器".into(),
        command: r#"opsark-tool server.connect {"host":"192.168.1.23","port":22,"username":"root","passwordSecretKey":"SSH_PASSWORD"}"#.into(),
        expected: "Opsark 完成真实 SSH 连接并获取服务器信息".into(),
        validation: "true".into(),
        risk: Some("low".into()),
    };
    assert!(validate_ai_plan_contract(
        std::slice::from_ref(&connect),
        &AiGenerationSettings::default()
    )
    .is_ok());
    assert!(convert_ai_plan_steps(vec![connect.clone()]).is_ok());

    let source_server_validation = AiPlanStep {
        title: "验证连接".into(),
        description: "错误地在原服务器执行校验".into(),
        command: "hostname && id && uptime".into(),
        expected: "目标服务器可用".into(),
        validation: "hostname".into(),
        risk: Some("low".into()),
    };
    assert!(validate_ai_plan_contract(
        &[connect.clone(), source_server_validation],
        &AiGenerationSettings::default()
    )
    .is_ok());

    let invalid = AiPlanStep {
        validation: "ssh root@192.168.1.23 true".into(),
        ..connect
    };
    assert!(
        validate_ai_plan_contract(&[invalid], &AiGenerationSettings::default())
            .unwrap_err()
            .contains("validation 必须固定为 true")
    );
}

#[test]
fn builds_targeted_plan_repair_feedback_for_meaningless_validation() {
    let previous = vec![AiPlanStep {
        title: "检查 SSH 端口".into(),
        description: "检查目标端口是否可达".into(),
        command: "nc -zvw5 69.33.213.101 22".into(),
        expected: "SSH 端口可达".into(),
        validation: "true".into(),
        risk: Some("low".into()),
    }];
    let instruction = plan_repair_instruction(
        "第 1 个计划步骤使用了无业务意义的 validation",
        Some(&previous),
    );

    assert!(instruction.contains("只有 command 以 opsark-tool 开头"));
    assert!(instruction.contains("仅为每个普通 Shell 步骤"));
    assert!(instruction.contains("nc -zvw5 69.33.213.101 22"));
    assert!(instruction.contains("仍必须返回完整"));
}

#[test]
fn rejects_duplicate_steps_and_untracked_background_operations() {
    let step = AiPlanStep {
        title: "克隆仓库".into(),
        description: "前台克隆并等待结果".into(),
        command: "git clone git@gitee.com:team/app.git /root/app".into(),
        expected: "仓库可用".into(),
        validation: "git -C /root/app rev-parse --verify HEAD".into(),
        risk: Some("medium".into()),
    };
    assert!(
        validate_ai_plan_contract(&[step.clone(), step], &AiGenerationSettings::default(),)
            .unwrap_err()
            .contains("重复")
    );

    let detached = AiPlanStep {
        title: "后台克隆".into(),
        description: "不应被接受".into(),
        command: "nohup git clone git@gitee.com:team/app.git /root/app >clone.log 2>&1 &".into(),
        expected: "仓库可用".into(),
        validation: "git -C /root/app rev-parse --verify HEAD".into(),
        risk: Some("medium".into()),
    };
    assert!(
        validate_ai_plan_contract(&[detached], &AiGenerationSettings::default())
            .unwrap_err()
            .contains("执行器跟踪")
    );

    assert!(detaches_untracked_process("custom-tool apply &"));
    assert!(detaches_untracked_process("setsid -f custom-daemon"));
    assert!(detaches_untracked_process(
        "custom-daemon; disown; echo done"
    ));
    assert!(!detaches_untracked_process(
        "custom-tool apply && custom-tool verify"
    ));
    assert!(!detaches_untracked_process("custom-tool 'a&b' 2>&1"));
    assert!(!detaches_untracked_process("custom-tool &>output.log"));
    assert!(!detaches_untracked_process("custom-tool |& tee output.log"));

    let masked_command = AiPlanStep {
        title: "下载工具链".into(),
        description: "不应掩盖失败".into(),
        command: "timeout 900 make download-toolchain || { echo failed; exit 0; }".into(),
        expected: "工具链完整".into(),
        validation: "test -f toolchain/bin/rustc".into(),
        risk: Some("medium".into()),
    };
    assert!(
        validate_ai_plan_contract(&[masked_command], &AiGenerationSettings::default())
            .unwrap_err()
            .contains("掩盖")
    );

    let masked_validation = AiPlanStep {
        title: "校验工具链".into(),
        description: "必须检查真实产物".into(),
        command: "make download-toolchain".into(),
        expected: "工具链完整".into(),
        validation: "find toolchain -name rustc | head -n 1; true".into(),
        risk: Some("medium".into()),
    };
    assert!(
        validate_ai_plan_contract(&[masked_validation], &AiGenerationSettings::default())
            .unwrap_err()
            .contains("掩盖")
    );
    assert!(masks_failure_status("command || true"));
    assert!(masks_failure_status("command || { echo failed; exit 0; }"));
    assert!(masks_failure_status("find artifact -type f; true"));
    assert!(masks_failure_status(
        "set +e\nssh host true\nrc=$?\necho $rc\nexit 0"
    ));
    assert!(masks_failure_status("ssh host true || echo SSH_FAILED"));
    assert!(!masks_failure_status("test -f artifact && echo ready"));
}

#[test]
fn parses_answer_and_execute_requirement_intents() {
    let answer: AiRequirementDecision = serde_json::from_str(
        r#"{"intent":"answer","answer":"这是风险咨询。","constraints":null,"selectedSkillIds":[]}"#,
    )
    .unwrap();
    assert_eq!(answer.intent, "answer");

    let execute: AiRequirementDecision = serde_json::from_str(
        r#"{"intent":"execute","answer":"","constraints":{"changePolicy":"requested_changes_only","environmentPolicy":"preserve","failurePolicy":"best_effort","prohibitedActions":["升级宿主运行时"],"requiredConditions":["保留当前环境"],"userDirectives":["尽力尝试"]},"selectedSkillIds":["project-source-acquisition","project-build"]}"#,
    )
    .unwrap();
    assert_eq!(execute.intent, "execute");
    assert_eq!(
        execute.selected_skill_ids,
        vec!["project-source-acquisition", "project-build"]
    );
    let constraints =
        normalize_execution_constraints(Some(serde_json::from_value(execute.constraints).unwrap()));
    assert_eq!(constraints.environment_policy, "preserve");
    assert_eq!(constraints.failure_policy, "best_effort");
    assert_eq!(constraints.prohibited_actions, vec!["升级宿主运行时"]);

    let mixed_stage = r#"{"intent":"execute","answer":"","constraints":null,"steps":[]}"#;
    assert!(serde_json::from_str::<AiRequirementDecision>(mixed_stage).is_err());
}

#[test]
fn loads_only_model_selected_skills_into_plan_context() {
    let definitions = vec![
        ModelSkillDefinition {
            id: "project-source-acquisition".into(),
            name: "项目源码获取".into(),
            description: "获取代码项目".into(),
            version: 1,
            instructions: "SOURCE_WORKFLOW".into(),
        },
        ModelSkillDefinition {
            id: "project-build".into(),
            name: "项目依赖与构建".into(),
            description: "构建代码项目".into(),
            version: 1,
            instructions: "BUILD_WORKFLOW".into(),
        },
    ];
    let context = r#"{"skillDirectory":[{"id":"project-source-acquisition"},{"id":"project-build"}],"activeSkills":[]}"#;
    let selected = vec![
        "project-build".to_string(),
        "project-source-acquisition".to_string(),
    ];
    let enriched = context_with_selected_skills(context, &definitions, &selected).unwrap();
    let value: Value = serde_json::from_str(&enriched).unwrap();

    assert!(value.get("skillDirectory").is_none());
    assert_eq!(
        value["skillSelection"]["selectedSkillIds"],
        json!(["project-build", "project-source-acquisition"])
    );
    assert_eq!(value["activeSkills"][0]["id"], "project-build");
    assert_eq!(value["activeSkills"][1]["id"], "project-source-acquisition");
    assert_eq!(value["activeSkills"][0]["instructions"], "BUILD_WORKFLOW");
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
