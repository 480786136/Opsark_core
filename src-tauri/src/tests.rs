use super::*;

#[test]
fn detects_compact_periodic_long_running_review_context() {
    assert!(is_periodic_long_running_review(
        r#"{"trigger":"periodic_long_running","reviewRound":1}"#
    ));
    assert!(!is_periodic_long_running_review(
        r#"{"trigger":"overall_goal_completion"}"#
    ));
    assert!(!is_periodic_long_running_review("not-json"));
}

#[test]
fn rejects_incomplete_tool_commands_before_the_model_repair_loop_finishes() {
    let tool_step = |command: &str| AiPlanStep {
        kind: "change".into(),
        title: "读取项目结构".into(),
        description: "获取项目目录树以识别部署入口".into(),
        command: command.into(),
        expected: "获得项目目录树".into(),
        validation: "true".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };

    for command in [
        "opsark-tool",
        "opsark-tool files.get_structure",
        "opsark-tool files.get_structure []",
        "opsark-tool files.get_structure {bad-json}",
    ] {
        let step = tool_step(command);
        let error = validate_ai_plan_contract(
            std::slice::from_ref(&step),
            &AiGenerationSettings::default(),
        )
        .unwrap_err();
        assert!(error.contains("opsark-tool 协议不完整"), "{error}");
        let repair = plan_repair_instruction(&error, Some(&[step]));
        assert!(repair.contains("opsark-tool <toolId> <JSON参数对象>"));
        assert!(repair.contains("inputSchema"));
    }

    for command in [
        r#"opsark-tool files.get_structure {"rootPath":"/opt/shiyi-blo"}"#,
        "opsark-tool files.get_structure --root-path /opt/shiyi-blo",
        r#"opsark-tool --files.get_structure {"rootPath":"/opt/shiyi-blo"}"#,
    ] {
        assert!(
            validate_ai_plan_contract(&[tool_step(command)], &AiGenerationSettings::default(),)
                .is_ok()
        );
    }
}

#[test]
fn rejects_tools_forbidden_by_active_skills_without_blocking_shell_or_allowed_tools() {
    let context = r#"{
        "activeSkills": [
            {
                "id": "project-source-acquisition",
                "forbiddenToolIds": ["server.resolve_connection", "server.connect"]
            },
            {
                "id": "another-skill",
                "forbiddenToolIds": ["server.connect", ""]
            }
        ]
    }"#;
    let forbidden = active_skill_forbidden_tool_ids(context).unwrap();
    assert_eq!(forbidden.len(), 2);
    assert!(forbidden.contains("server.resolve_connection"));
    assert!(forbidden.contains("server.connect"));

    let step = |command: &str, validation: &str| AiPlanStep {
        kind: "change".into(),
        title: "执行步骤".into(),
        description: "根据 active Skill 执行最小流程".into(),
        command: command.into(),
        expected: "获得可验证结果".into(),
        validation: validation.into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };

    let blocked = step(
        r#"opsark-tool server.resolve_connection {"serverId":"server-1"}"#,
        "true",
    );
    let error = validate_active_skill_tool_policy(&[blocked], &forbidden).unwrap_err();
    assert!(error.contains("第 1 个计划步骤"), "{error}");
    assert!(error.contains("active Skill 禁止工具"), "{error}");
    assert!(error.contains("server.resolve_connection"), "{error}");
    let repair = plan_repair_instruction(&error, None);
    assert!(repair.contains("activeSkills.instructions"));
    assert!(repair.contains("凭据通道"));
    assert!(repair.contains("必要能力不存在"));

    let blocked_legacy_syntax = step(
        r#"opsark-tool --server.connect {"credentialRef":"credential-1"}"#,
        "true",
    );
    assert!(validate_active_skill_tool_policy(&[blocked_legacy_syntax], &forbidden).is_err());

    let allowed_tool = step(
        r#"opsark-tool user.request_input {"title":"凭据","description":"收集凭据","fields":[]}"#,
        "true",
    );
    let shell = step(
        "git ls-remote https://gitee.com/example/repo.git",
        "test -d /opt",
    );
    assert!(validate_active_skill_tool_policy(&[allowed_tool, shell], &forbidden).is_ok());
}

#[test]
fn validates_active_skill_tool_policy_context_shape() {
    assert!(active_skill_forbidden_tool_ids(r#"{"otherContext":true}"#)
        .unwrap()
        .is_empty());
    assert!(active_skill_forbidden_tool_ids(r#"{"activeSkills":{}}"#)
        .unwrap_err()
        .contains("activeSkills 必须是数组"));
    assert!(active_skill_forbidden_tool_ids(
        r#"{"activeSkills":[{"forbiddenToolIds":"server.connect"}]}"#
    )
    .unwrap_err()
    .contains("forbiddenToolIds 必须是数组"));
}

#[test]
fn repairs_missing_presentational_plan_fields_but_rejects_missing_execution_fields() {
    let missing_title = r#"{"steps":[{"kind":"change","description":"检查目标是否正常。","command":"custom-tool inspect","expected":"","validation":"custom-tool inspect >/dev/null","risk":"low"}]}"#;
    let repairable = parse_model_array_field(missing_title, "steps").unwrap();
    assert!(
        validate_ai_plan_contract(&repairable, &AiGenerationSettings::default())
            .unwrap_err()
            .contains("title")
    );
    let normalized = convert_ai_plan_steps(repairable).unwrap();
    assert_eq!(normalized[0].title, "检查目标是否正常");
    assert!(!normalized[0].expected.is_empty());

    let missing_command = r#"{"steps":[{"kind":"change","title":"检查","description":"检查目标","expected":"返回状态","validation":"custom-tool inspect >/dev/null","risk":"low"}]}"#;
    let error = convert_ai_plan_steps(parse_model_array_field(missing_command, "steps").unwrap())
        .unwrap_err();
    assert!(error.contains("kind/command/validation"));
}

#[test]
fn accepts_observation_steps_without_duplicate_validation() {
    let observe = AiPlanStep {
        kind: "observe".into(),
        title: "检查服务状态".into(),
        description: "只读获取进程与端口现状".into(),
        command: "systemctl status app.service --no-pager".into(),
        expected: "获得真实状态".into(),
        validation: String::new(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };
    assert!(validate_ai_plan_contract(
        std::slice::from_ref(&observe),
        &AiGenerationSettings::default(),
    )
    .is_ok());
    let converted = convert_ai_plan_steps(vec![observe]).unwrap();
    assert_eq!(converted[0].kind, "observe");
    assert!(converted[0].validation.is_empty());

    let invalid = AiPlanStep {
        kind: "observe".into(),
        title: "重复检查".into(),
        description: "错误地为观察步骤配置了后置校验".into(),
        command: "systemctl status app.service --no-pager".into(),
        expected: "获得真实状态".into(),
        validation: "systemctl is-active app.service".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };
    assert!(
        validate_ai_plan_contract(&[invalid], &AiGenerationSettings::default())
            .unwrap_err()
            .contains("validation 必须为空字符串")
    );
}

#[test]
fn preserves_optional_agent_session_execution_contract() {
    let raw: AiPlanStep = serde_json::from_value(json!({
        "kind": "change",
        "title": "加载 NVM 上下文",
        "description": "本任务后续步骤复用 NVM",
        "command": ". /root/.nvm/nvm.sh && node -v",
        "expected": "Agent 任务上下文可用",
        "validation": "test -s /root/.nvm/nvm.sh",
        "risk": "low",
        "executionScope": "agent_session",
        "validationScope": "isolated_exec",
        "runtimeClass": "bounded",
        "sessionContextChange": {
            "cwd": "/opt/app",
            "sourceFiles": ["/root/.nvm/nvm.sh"],
            "environment": { "NODE_ENV": "production" },
            "shell": "bash"
        }
    }))
    .unwrap();

    let converted = convert_ai_plan_steps(vec![raw]).unwrap();
    assert_eq!(converted[0].execution_scope, "agent_session");
    assert_eq!(
        converted[0].validation_scope.as_deref(),
        Some("isolated_exec")
    );
    assert_eq!(converted[0].runtime_class, "bounded");
    assert_eq!(
        converted[0].session_context_change.as_ref().unwrap()["cwd"],
        "/opt/app"
    );
}

#[test]
fn plan_length_limits_are_optional_and_allow_multiline_commands() {
    let long_command = format!("echo start\n{}", "x".repeat(1500));
    let steps = vec![AiPlanStep {
        kind: "change".into(),
        title: "一个超过旧标题长度限制但依然是合法计划步骤的完整标题".into(),
        description: "读取并处理真实环境信息".into(),
        command: long_command,
        expected: "获得完整结果".into(),
        validation: "test -f /tmp/result\nprintf 'ok\\n'".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
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
            kind: "change".into(),
            title: format!("步骤 {}", index + 1),
            description: "执行必要操作".into(),
            command: format!("echo {index}"),
            expected: "命令正常完成".into(),
            validation: format!("printf '%s\\n' {index} | grep -qx {index}"),
            risk: Some("low".into()),
            ..AiPlanStep::default()
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
        kind: "change".into(),
        title: "输入 SSH 连接信息".into(),
        description: "请用户提供目标服务器的 SSH 用户名和密码".into(),
        command: r#"opsark-tool user.request_input {"title":"SSH 连接信息","fields":[{"key":"username","label":"SSH 用户名","description":"用于登录 192.168.1.23","type":"text","required":true},{"key":"password","label":"SSH 密码","description":"用于验证 SSH 账号","type":"password","required":true}]}"#.into(),
        expected: "用户完成 SSH 连接参数输入".into(),
        validation: "true".into(),
        risk: Some("low".into()),
    ..AiPlanStep::default()
    };

    assert!(validate_ai_plan_contract(
        std::slice::from_ref(&input_step),
        &AiGenerationSettings::default()
    )
    .is_ok());
    assert!(convert_ai_plan_steps(vec![input_step.clone()]).is_ok());

    let extra_step = AiPlanStep {
        kind: "change".into(),
        title: "立即连接".into(),
        description: "不应在参数输入前规划".into(),
        command: "ssh 192.168.1.23".into(),
        expected: "连接成功".into(),
        validation: "ssh -o BatchMode=yes 192.168.1.23 true".into(),
        risk: Some("medium".into()),
        ..AiPlanStep::default()
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
        kind: "change".into(),
        title: "在当前终端执行 SSH 登录".into(),
        description: "使用已安全收集的凭据在任务绑定终端登录目标服务器".into(),
        command: r#"opsark-tool server.connect {"host":"192.168.1.23","port":22,"username":"root","passwordSecretKey":"SSH_PASSWORD"}"#.into(),
        expected: "Opsark 完成真实 SSH 连接并获取服务器信息".into(),
        validation: "true".into(),
        risk: Some("low".into()),
    ..AiPlanStep::default()
    };
    assert!(validate_ai_plan_contract(
        std::slice::from_ref(&connect),
        &AiGenerationSettings::default()
    )
    .is_ok());
    assert!(convert_ai_plan_steps(vec![connect.clone()]).is_ok());

    let source_server_validation = AiPlanStep {
        kind: "change".into(),
        title: "验证连接".into(),
        description: "错误地在原服务器执行校验".into(),
        command: "hostname && id && uptime".into(),
        expected: "目标服务器可用".into(),
        validation: "hostname".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };
    assert!(validate_ai_plan_contract(
        &[connect.clone(), source_server_validation],
        &AiGenerationSettings::default()
    )
    .is_ok());

    let invalid = AiPlanStep {
        kind: "change".into(),
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
fn rejects_server_connect_without_complete_credentials() {
    let incomplete = AiPlanStep {
        kind: "change".into(),
        title: "连接目标服务器".into(),
        description: "连接目标服务器".into(),
        command: "opsark-tool server.connect --host 192.168.1.237 --port 22 --passwordSecretKey TARGET_SSH_PASSWORD".into(),
        expected: "终端完成 SSH 登录".into(),
        validation: "true".into(),
        risk: Some("low".into()),
    ..AiPlanStep::default()
    };
    let error = validate_ai_plan_contract(
        std::slice::from_ref(&incomplete),
        &AiGenerationSettings::default(),
    )
    .unwrap_err();
    assert!(error.contains("server.connect 参数不完整"));
    let repair = plan_repair_instruction(&error, Some(&[incomplete]));
    assert!(repair.contains("user.request_input"));
    assert!(repair.contains("不得把当前源服务器地址当作目标地址"));

    let credential_ref = AiPlanStep {
        kind: "change".into(),
        title: "连接目标服务器".into(),
        description: "使用受管凭据连接".into(),
        command:
            "opsark-tool server.connect --host 192.168.1.237 --credentialRef managed-server:target"
                .into(),
        expected: "终端完成 SSH 登录".into(),
        validation: "true".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };
    assert!(validate_ai_plan_contract(&[credential_ref], &AiGenerationSettings::default()).is_ok());
}

#[test]
fn builds_targeted_plan_repair_feedback_for_meaningless_validation() {
    let previous = vec![AiPlanStep {
        kind: "change".into(),
        title: "检查 SSH 端口".into(),
        description: "检查目标端口是否可达".into(),
        command: "nc -zvw5 69.33.213.101 22".into(),
        expected: "SSH 端口可达".into(),
        validation: "true".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    }];
    let instruction = plan_repair_instruction(
        "第 1 个计划步骤使用了无业务意义的 validation",
        Some(&previous),
    );

    assert!(instruction.contains("只有 command 以 opsark-tool 开头"));
    assert!(instruction.contains("change 步骤"));
    assert!(instruction.contains("kind=observe"));
    assert!(instruction.contains("nc -zvw5 69.33.213.101 22"));
    assert!(instruction.contains("仍必须返回完整"));
    assert!(instruction.contains("独立、只读"));
}

#[test]
fn builds_credential_transport_specific_plan_repair_feedback() {
    let previous = vec![AiPlanStep {
        kind: "change".into(),
        title: "使用凭据克隆仓库".into(),
        description: "使用 ${secret.GIT_HTTP_CREDENTIAL} 访问 Gitee 仓库".into(),
        command: "GIT_ASKPASS=/tmp/askpass git clone https://gitee.com/team/app.git /opt/app"
            .into(),
        expected: "源码已获取".into(),
        validation: "git -C /opt/app rev-parse --verify HEAD".into(),
        risk: Some("high".into()),
        ..AiPlanStep::default()
    }];
    let error = validate_ai_plan_contract(&previous, &AiGenerationSettings::default()).unwrap_err();
    assert!(error.contains("ASKPASS_CREDENTIAL_SCRIPT"));

    let instruction = plan_repair_instruction(&error, Some(&previous));
    assert!(instruction.contains("删除 AskPass"));
    assert!(instruction.contains("原始仓库 URL"));
    assert!(instruction.contains("Username/Password"));
    assert!(instruction.contains("GIT_HTTP_CREDENTIAL"));
    assert!(!instruction.contains("上次计划掩盖了真实失败退出码"));
}

#[test]
fn rejects_credential_bound_git_step_that_disables_pty_prompts() {
    let previous = vec![AiPlanStep {
        kind: "change".into(),
        title: "使用已保存凭据认证预检".into(),
        description: "使用 server-credential:credential-gitee 访问 Gitee".into(),
        command: "GIT_TERMINAL_PROMPT=0 git -c credential.helper= ls-remote https://gitee.com/team/app.git HEAD".into(),
        expected: "返回远端 HEAD".into(),
        validation: "test -s /tmp/authenticated-head".into(),
        risk: Some("medium".into()),
    ..AiPlanStep::default()
    }];

    let error = validate_ai_plan_contract(&previous, &AiGenerationSettings::default()).unwrap_err();
    assert!(error.contains("禁用了交互认证提示"));
    let instruction = plan_repair_instruction(&error, Some(&previous));
    assert!(instruction.contains("GIT_TERMINAL_PROMPT=1"));
    assert!(instruction.contains("不得重新索取凭据"));
    assert!(instruction.contains("server-credential"));
}

#[test]
fn rejects_validation_that_waits_for_terminal_input() {
    let invalid = AiPlanStep {
        kind: "change".into(),
        title: "复核文件证据".into(),
        description: "检查上一条命令输出".into(),
        command: "stat /tmp/result".into(),
        expected: "获得文件证据".into(),
        validation: "grep -Eq '^PATH=/' && grep -Eq '^BYTES=12315$'".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };
    let error = validate_ai_plan_contract(
        std::slice::from_ref(&invalid),
        &AiGenerationSettings::default(),
    )
    .unwrap_err();
    assert!(error.contains("会等待终端标准输入"));
    assert!(
        plan_repair_instruction(&error, Some(&[invalid])).contains("不会继承 command 的标准输出")
    );

    let with_file = AiPlanStep {
        kind: "change".into(),
        title: "复核证据文件".into(),
        description: "读取证据文件".into(),
        command: "stat /tmp/result".into(),
        expected: "获得文件证据".into(),
        validation: "grep -Eq '^BYTES=12315$' /tmp/result.evidence".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };
    assert!(validate_ai_plan_contract(&[with_file], &AiGenerationSettings::default()).is_ok());

    let with_pipe = AiPlanStep {
        kind: "change".into(),
        title: "复核实时状态".into(),
        description: "重新读取真实状态".into(),
        command: "stat /tmp/result".into(),
        expected: "获得文件证据".into(),
        validation: "printf 'PATH=/tmp/result\n' | grep -Eq '^PATH=/'".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };
    assert!(validate_ai_plan_contract(&[with_pipe], &AiGenerationSettings::default()).is_ok());
}

#[test]
fn reports_the_exact_failure_mask_field_and_repair_action() {
    let masked_command = AiPlanStep {
        kind: "change".into(),
        title: "探测目标 SSH 认证".into(),
        description: "检查源服务器是否已有目标端认证".into(),
        command: "ssh -o BatchMode=yes target true || echo AUTH_MISSING".into(),
        expected: "获得认证状态".into(),
        validation: "ssh -o BatchMode=yes target true".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };
    let error = validate_ai_plan_contract(
        std::slice::from_ref(&masked_command),
        &AiGenerationSettings::default(),
    )
    .unwrap_err();

    assert!(error.contains("第 1 个计划步骤的 command"));
    assert!(error.contains("SSH/SCP/rsync 失败后仅 echo"));
    let instruction = plan_repair_instruction(&error, Some(&[masked_command]));
    assert!(instruction.contains("command 或 validation 以及命中的结构"));
    assert!(instruction.contains("拆成当前证据允许的单一阶段"));
    assert!(instruction.contains("set -o pipefail"));

    let status_validation = AiPlanStep {
        kind: "change".into(),
        title: "检查后端运行状态".into(),
        description: "区分运行、未运行和检查错误".into(),
        command: "pgrep -f -- '/opt/app/backend' || echo NOT_RUNNING".into(),
        expected: "获得后端运行状态分类".into(),
        validation: "pgrep -f -- '/opt/app/backend' >/dev/null || echo NOT_RUNNING".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };
    let status_error = validate_ai_plan_contract(
        std::slice::from_ref(&status_validation),
        &AiGenerationSettings::default(),
    )
    .unwrap_err();
    assert!(status_error.contains("VALIDATION_FAILURE_ECHOED"));
    let status_instruction = plan_repair_instruction(
        &status_error,
        Some(std::slice::from_ref(&status_validation)),
    );
    assert!(status_instruction.contains("完整状态分类"));
    assert!(status_instruction.contains("只把该命令文档明确规定的无匹配码"));
    assert!(status_instruction.contains("case \"$rc\""));
    assert!(status_instruction.contains("不得把 pgrep 的退出码规则套给 systemctl"));
    let classified_status = AiPlanStep {
        kind: "change".into(),
        command: "pgrep -f -- '/opt/app/backend' >/dev/null; rc=$?; case \"$rc\" in 0) echo RUNNING;; 1) echo NOT_RUNNING;; *) exit \"$rc\";; esac".into(),
        validation: "pgrep -f -- '/opt/app/backend' >/dev/null; rc=$?; case \"$rc\" in 0) echo RUNNING;; 1) echo NOT_RUNNING;; *) exit \"$rc\";; esac".into(),
        ..status_validation.clone()
    };
    assert!(
        validate_ai_plan_contract(&[classified_status], &AiGenerationSettings::default(),).is_ok()
    );

    let masked_validation = AiPlanStep {
        kind: "change".into(),
        title: "校验目标文件".into(),
        description: "校验目标文件完整性".into(),
        command: "scp source target:/tmp/part".into(),
        expected: "目标临时文件完整".into(),
        validation: "ssh target sha256sum /tmp/part; true".into(),
        risk: Some("medium".into()),
        ..AiPlanStep::default()
    };
    let validation_error =
        validate_ai_plan_contract(&[masked_validation], &AiGenerationSettings::default())
            .unwrap_err();
    assert!(validation_error.contains("第 1 个计划步骤的 validation"));
    assert!(validation_error.contains("以无条件 true 结束"));
}

#[test]
fn applies_a_focused_plan_step_repair_without_rewriting_other_steps() {
    let valid = AiPlanStep {
        kind: "change".into(),
        title: "保留步骤".into(),
        description: "已经正确".into(),
        command: "test -d /opt/app".into(),
        expected: "目录存在".into(),
        validation: "test -d /opt/app".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };
    let invalid = AiPlanStep {
        kind: "change".into(),
        title: "读取 npm 日志".into(),
        description: "展示构建输出".into(),
        command: "npm run build | tail -20".into(),
        expected: "构建成功".into(),
        validation: "test -f dist/index.html".into(),
        risk: Some("medium".into()),
        ..AiPlanStep::default()
    };
    let repaired = AiPlanStep {
        kind: "change".into(),
        command: "set -o pipefail\nnpm run build | tail -20".into(),
        ..invalid.clone()
    };
    let mut steps = vec![valid.clone(), invalid];
    let error = validate_ai_plan_contract(&steps, &AiGenerationSettings::default()).unwrap_err();
    assert_eq!(plan_error_step_index(&error, steps.len()), Some(2));
    let prompt = focused_plan_repair_instruction(&error, &steps, 2);
    assert!(prompt.contains("本轮仅修复第 2 步"));
    assert!(prompt.contains("replacementSteps"));
    assert!(!prompt.contains("上次完整计划"));

    apply_plan_step_repair(
        &mut steps,
        AiPlanStepRepair {
            step_index: 2,
            replacement_steps: vec![repaired],
        },
    )
    .unwrap();

    assert_eq!(steps[0].command, valid.command);
    assert!(validate_ai_plan_contract(&steps, &AiGenerationSettings::default()).is_ok());
}

#[test]
fn permits_repeated_observations_but_rejects_untracked_background_operations() {
    let step = AiPlanStep {
        kind: "change".into(),
        title: "复查仓库状态".into(),
        description: "允许在不同阶段重新观察同一个仓库".into(),
        command: "git -C /root/app status --short".into(),
        expected: "获得当前工作树状态".into(),
        validation: "git -C /root/app rev-parse --verify HEAD".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };
    assert!(
        validate_ai_plan_contract(&[step.clone(), step], &AiGenerationSettings::default(),).is_ok()
    );

    let detached = AiPlanStep {
        kind: "change".into(),
        title: "后台克隆".into(),
        description: "不应被接受".into(),
        command: "nohup git clone git@gitee.com:team/app.git /root/app >clone.log 2>&1 &".into(),
        expected: "仓库可用".into(),
        validation: "git -C /root/app rev-parse --verify HEAD".into(),
        risk: Some("medium".into()),
        ..AiPlanStep::default()
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
        kind: "change".into(),
        title: "下载工具链".into(),
        description: "不应掩盖失败".into(),
        command: "timeout 900 make download-toolchain || { echo failed; exit 0; }".into(),
        expected: "工具链完整".into(),
        validation: "test -f toolchain/bin/rustc".into(),
        risk: Some("medium".into()),
        ..AiPlanStep::default()
    };
    assert!(
        validate_ai_plan_contract(&[masked_command], &AiGenerationSettings::default())
            .unwrap_err()
            .contains("未通过执行前安全检查")
    );

    let masked_validation = AiPlanStep {
        kind: "change".into(),
        title: "校验工具链".into(),
        description: "必须检查真实产物".into(),
        command: "make download-toolchain".into(),
        expected: "工具链完整".into(),
        validation: "find toolchain -name rustc | head -n 1; true".into(),
        risk: Some("medium".into()),
        ..AiPlanStep::default()
    };
    assert!(
        validate_ai_plan_contract(&[masked_validation], &AiGenerationSettings::default())
            .unwrap_err()
            .contains("未通过执行前安全检查")
    );
    assert!(masks_failure_status("command || true"));
    assert!(masks_failure_status("command || { echo failed; exit 0; }"));
    assert!(masks_failure_status("find artifact -type f; true"));
    assert!(masks_failure_status(
        "set +e\nssh host true\nrc=$?\necho $rc\nexit 0"
    ));
    assert!(masks_failure_status(
        "set +e; mysql -e 'SHOW DATABASES'; echo '---EXIT:'$?'---'"
    ));
    assert!(masks_failure_status("mysql -e 'SHOW DATABASES' | head -20"));
    assert!(!masks_failure_status(
        "set +e; mysql -e 'SHOW DATABASES'; rc=$?; echo $rc; exit $rc"
    ));
    assert!(masks_failure_status("ssh host true || echo SSH_FAILED"));
    assert!(!masks_failure_status("test -f artifact && echo ready"));
    assert_eq!(
        failure_mask_reason("scp source target:/tmp/file || echo FAILED"),
        Some("SSH/SCP/rsync 失败后仅 echo，导致分支返回成功")
    );
}

#[test]
fn deterministically_preserves_failure_status_in_explicit_zero_exit_branches() {
    let original = "timeout 900 make build || { echo '构建失败'; cleanup_temp; exit 0; }";
    let repaired = preserve_explicit_failure_branch_status(original).unwrap();

    assert!(repaired.contains("__opsark_preserved_failure_status=$?;"));
    assert!(repaired.contains("echo '构建失败'; cleanup_temp;"));
    assert!(repaired.contains("exit \"$__opsark_preserved_failure_status\""));
    assert_eq!(failure_mask_reason(&repaired), None);

    let mut steps = vec![AiPlanStep {
        kind: "change".into(),
        title: "构建项目".into(),
        description: "运行真实构建".into(),
        command: original.into(),
        expected: "构建产物存在".into(),
        validation: "test -f dist/index.html || { echo missing; exit 0; }".into(),
        risk: Some("medium".into()),
        ..AiPlanStep::default()
    }];
    assert_eq!(normalize_recoverable_plan_failure_masks(&mut steps), 2);
    assert!(validate_ai_plan_contract(&steps, &AiGenerationSettings::default()).is_ok());

    let mut repeated = vec![AiPlanStep {
        kind: "change".into(),
        title: "多阶段检查".into(),
        description: "两个失败分支都必须保留状态".into(),
        command:
            "first || { echo first_failed; exit 0; }; second || { echo second_failed; exit 0; }"
                .into(),
        expected: "两个阶段均成功".into(),
        validation: "test -f artifact".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    }];
    assert_eq!(normalize_recoverable_plan_failure_masks(&mut repeated), 1);
    assert_eq!(
        repeated[0]
            .command
            .matches("__opsark_preserved_failure_status=$?;")
            .count(),
        2
    );
    assert_eq!(failure_mask_reason(&repeated[0].command), None);
}

#[test]
fn deterministic_failure_status_repair_ignores_quoted_or_ambiguous_text() {
    assert!(preserve_explicit_failure_branch_status("printf '%s' '|| { exit 0; }'").is_none());
    assert!(preserve_explicit_failure_branch_status("command || echo 'exit 0'").is_none());
    assert!(preserve_explicit_failure_branch_status("command; exit 0").is_none());
    assert!(
        preserve_explicit_failure_branch_status("command || { echo failed; exit 2; }").is_none()
    );
}

#[test]
fn reports_structured_plan_safety_fields_and_repairs_before_approval() {
    let command_issue = analyze_plan_step_safety_inner("command || true", "test -f result", false);
    assert!(!command_issue.safe);
    assert_eq!(
        command_issue.issue,
        Some(PlanSafetyIssue {
            field: "command".into(),
            rule_id: "EMPTY_SUCCESS_FALLBACK".into(),
            reason: "以 || true（或等价空操作）结束".into(),
            snippet: "|| true（或等价空操作）".into(),
            repairable: false,
        })
    );
    assert_eq!(command_issue.issues.len(), 1);

    let validation_issue = analyze_plan_step_safety_inner(
        "mysql -e 'SELECT 1'",
        "test -f result || echo missing",
        false,
    );
    assert_eq!(
        validation_issue
            .issue
            .as_ref()
            .map(|issue| issue.field.as_str()),
        Some("validation")
    );
    assert_eq!(
        validation_issue
            .issue
            .as_ref()
            .map(|issue| issue.rule_id.as_str()),
        Some("VALIDATION_FAILURE_ECHOED")
    );

    let both =
        analyze_plan_step_safety_inner("command || true", "test -f result || echo missing", false);
    assert_eq!(both.issues.len(), 2);
    assert_eq!(both.issues[0].field, "command");
    assert_eq!(both.issues[1].field, "validation");

    let repaired = analyze_plan_step_safety_inner(
        "build || { echo failed; exit 0; }",
        "test -f result || { echo missing; exit 0; }",
        true,
    );
    assert!(repaired.safe);
    assert_eq!(repaired.repaired_fields, vec!["command", "validation"]);
    assert!(repaired
        .normalized_command
        .contains("exit \"$__opsark_preserved_failure_status\""));
}

#[test]
fn plan_safety_ignores_quoted_failure_text_and_accepts_saved_status_exit() {
    assert!(
        analyze_plan_step_safety_inner(
            "printf '%s' '|| true'",
            "printf '%s' 'test || echo missing'",
            false,
        )
        .safe
    );
    assert!(
        analyze_plan_step_safety_inner(
            "set +e; mysql -e 'SELECT 1'; rc=$?; exit \"$rc\"",
            "test -f result",
            false,
        )
        .safe
    );
    assert!(
        analyze_plan_step_safety_inner("printf \\测试", "printf '%s' '中文 || true'", false,).safe
    );
}

#[test]
fn plan_safety_rejects_credential_exposure_channels() {
    let cases = [
        (
            "git clone 'https://user:${secret.GIT_HTTP_CREDENTIAL}@gitee.com/team/app.git'",
            "SECRET_IN_URL",
        ),
        (
            "git clone https://user:actual-token@gitee.com/team/app.git",
            "URL_EMBEDDED_CREDENTIAL",
        ),
        (
            "git clone https://developer%40example.com@gitee.com/team/app.git",
            "URL_EMBEDDED_CREDENTIAL",
        ),
        (
            "GIT_ASKPASS=/tmp/askpass git clone https://gitee.com/team/app.git",
            "ASKPASS_CREDENTIAL_SCRIPT",
        ),
        (
            "export GIT_HTTP_CREDENTIAL='actual-token'; git clone https://gitee.com/team/app.git",
            "SECRET_ENV_ASSIGNMENT",
        ),
        (
            "sshpass -p '${secret.SSH_PASSWORD}' ssh user@host true",
            "INSECURE_CREDENTIAL_HELPER",
        ),
        (
            "git config --global credential.helper store",
            "CREDENTIAL_PERSISTENCE",
        ),
    ];
    for (command, expected_rule) in cases {
        let analysis = analyze_plan_step_safety_inner(command, "test -f result", false);
        assert!(!analysis.safe, "unsafe command was accepted: {command}");
        assert_eq!(
            analysis.issue.as_ref().map(|issue| issue.rule_id.as_str()),
            Some(expected_rule),
            "unexpected rule for: {command}",
        );
    }
}

#[test]
fn plan_safety_requires_a_bare_https_url_for_pty_prompt_injection() {
    let analysis = analyze_plan_step_safety_inner(
        "timeout 20 git ls-remote https://developer%40example.com@gitee.com/team/app.git HEAD",
        "git -C /opt/app rev-parse --verify HEAD^{commit}",
        false,
    );
    assert!(!analysis.safe);
    assert_eq!(
        analysis.issue.as_ref().map(|issue| issue.rule_id.as_str()),
        Some("URL_EMBEDDED_CREDENTIAL")
    );
    assert!(
        analyze_plan_step_safety_inner(
            "PWD=/opt git -C /opt/app status --short",
            "git -C /opt/app rev-parse --is-inside-work-tree",
            false,
        )
        .safe
    );
}

#[test]
fn backend_safety_rejection_does_not_echo_resolved_command_or_secret() {
    let rejection = command_safety_rejection("mysql -pvery-secret || true").unwrap();
    assert!(!rejection.success);
    assert_eq!(rejection.exit_code, 126);
    assert!(rejection.output.contains("命令尚未发送到服务器"));
    assert!(!rejection.output.contains("very-secret"));
    assert!(!rejection.output.contains("mysql"));
}

#[test]
fn parses_answer_and_execute_requirement_intents() {
    let answer: AiRequirementDecision = serde_json::from_str(
        r#"{"intent":"answer","relation":"side_question","answer":"这是风险咨询。","constraints":null,"selectedSkillIds":[]}"#,
    )
    .unwrap();
    assert_eq!(answer.intent, "answer");
    assert_eq!(answer.relation.as_deref(), Some("side_question"));

    let execute: AiRequirementDecision = serde_json::from_str(
        r#"{"intent":"execute","relation":"continue","answer":"","constraints":{"changePolicy":"requested_changes_only","environmentPolicy":"preserve","failurePolicy":"best_effort","prohibitedActions":["升级宿主运行时"],"requiredConditions":["保留当前环境"],"userDirectives":["尽力尝试"]},"selectedSkillIds":["project-source-acquisition","project-build"]}"#,
    )
    .unwrap();
    assert_eq!(execute.intent, "execute");
    assert_eq!(execute.relation.as_deref(), Some("continue"));
    assert_eq!(
        execute.selected_skill_ids,
        vec!["project-source-acquisition", "project-build"]
    );
    assert!(execute_constraints_match_contract(&execute.constraints));
    let constraints =
        normalize_execution_constraints(Some(serde_json::from_value(execute.constraints).unwrap()));
    assert_eq!(constraints.environment_policy, "preserve");
    assert_eq!(constraints.failure_policy, "best_effort");
    assert_eq!(constraints.prohibited_actions, vec!["升级宿主运行时"]);

    let zero_match: AiRequirementDecision = serde_json::from_str(
        r#"{"intent":"execute","relation":"new_goal","answer":"","constraints":{"changePolicy":"read_only","environmentPolicy":"preserve","failurePolicy":"strict","prohibitedActions":[],"requiredConditions":[],"userDirectives":[]},"terminalContextLines":0,"selectedSkillIds":[]}"#,
    )
    .unwrap();
    assert!(zero_match.selected_skill_ids.is_empty());
    assert!(REQUIREMENT_CLASSIFICATION_CONTRACT.contains("零匹配是正常且合法的结果"));
    assert!(GENERAL_REQUIREMENT_SYSTEM.contains("不得选择最相近的 Skill 凑数"));
    assert!(execute_constraints_match_contract(&zero_match.constraints));

    let unspecified_constraints = json!({
        "changePolicy": "unspecified",
        "environmentPolicy": "unspecified",
        "failurePolicy": "unspecified",
        "prohibitedActions": [],
        "requiredConditions": [],
        "userDirectives": []
    });
    assert!(!execute_constraints_match_contract(
        &unspecified_constraints
    ));

    let legacy_capability_fields = r#"{"intent":"execute","relation":"new_goal","operation":"deploy","effect":"write","answer":"","constraints":{"changePolicy":"requested_changes_only","environmentPolicy":"unspecified","failurePolicy":"unspecified","prohibitedActions":[],"requiredConditions":[],"userDirectives":[]},"terminalContextLines":0,"selectedSkillIds":[]}"#;
    assert!(serde_json::from_str::<AiRequirementDecision>(legacy_capability_fields).is_err());

    let mixed_stage = r#"{"intent":"execute","answer":"","constraints":null,"steps":[]}"#;
    assert!(serde_json::from_str::<AiRequirementDecision>(mixed_stage).is_err());
}

#[test]
fn serializes_model_failure_with_complete_developer_trace() {
    let mut trace = ModelDeveloperTrace::default();
    record_model_attempt(
        &mut trace,
        "requirement_classification",
        1,
        std::time::Instant::now(),
        json!({"model": "test-model", "messages": [{"content": "request"}]}),
        Some(json!({"choices": []})),
        Some("模型响应缺少需求理解结果".into()),
    );

    let encoded = traced_model_error("分类失败".into(), &trace);
    let payload: Value = serde_json::from_str(
        encoded
            .strip_prefix(MODEL_TRACE_ERROR_PREFIX)
            .expect("trace prefix"),
    )
    .expect("valid trace json");

    assert_eq!(payload["message"], "分类失败");
    assert_eq!(
        payload["developerTrace"]["attempts"][0]["stage"],
        "requirement_classification"
    );
    assert_eq!(
        payload["developerTrace"]["attempts"][0]["response"]["choices"],
        json!([])
    );
    assert_eq!(
        payload["developerTrace"]["attempts"][0]["error"],
        "模型响应缺少需求理解结果"
    );
}

#[test]
fn omits_absent_optional_plan_fields_from_the_frontend_payload() {
    let step = PlanStep {
        id: "step-1".into(),
        kind: "observe".into(),
        title: "检查目录".into(),
        description: "检查目录是否存在".into(),
        command: "test -d /opt/ruoyi".into(),
        risk: "low".into(),
        expected: "得到目录状态".into(),
        validation: String::new(),
        execution_scope: "isolated_exec".into(),
        validation_scope: None,
        session_context_change: None,
        runtime_class: "bounded".into(),
        status: "pending".into(),
        output: None,
    };
    let value = serde_json::to_value(step).unwrap();

    assert!(value.get("validationScope").is_none());
    assert!(value.get("sessionContextChange").is_none());
    assert!(value.get("output").is_none());
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
            forbidden_tool_ids: vec!["server.resolve_connection".into()],
        },
        ModelSkillDefinition {
            id: "project-build".into(),
            name: "项目依赖与构建".into(),
            description: "构建代码项目".into(),
            version: 1,
            instructions: "BUILD_WORKFLOW".into(),
            forbidden_tool_ids: Vec::new(),
        },
    ];
    let context = r#"{"skillDirectory":[{"id":"project-source-acquisition"},{"id":"project-build"}],"activeSkills":[]}"#;
    let selected = vec![
        "project-build".to_string(),
        "project-source-acquisition".to_string(),
    ];
    let constraints = ExecutionConstraints {
        change_policy: "read_only".into(),
        environment_policy: "preserve".into(),
        failure_policy: "strict".into(),
        prohibited_actions: Vec::new(),
        required_conditions: Vec::new(),
        user_directives: vec!["只检查，不修改".into()],
    };
    let enriched =
        context_with_selected_skills(context, &definitions, &selected, Some(&constraints)).unwrap();
    let value: Value = serde_json::from_str(&enriched).unwrap();

    assert!(value.get("skillDirectory").is_none());
    assert_eq!(
        value["skillSelection"]["selectedSkillIds"],
        json!(["project-build", "project-source-acquisition"])
    );
    assert_eq!(value["activeSkills"][0]["id"], "project-build");
    assert_eq!(value["activeSkills"][1]["id"], "project-source-acquisition");
    assert_eq!(value["activeSkills"][0]["instructions"], "BUILD_WORKFLOW");
    assert_eq!(value["executionConstraints"]["changePolicy"], "read_only");
    assert_eq!(
        value["activeSkills"][1]["forbiddenToolIds"],
        json!(["server.resolve_connection"])
    );
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
