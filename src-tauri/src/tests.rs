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
fn normalizes_boolean_true_validation_only_at_the_model_input_boundary() {
    let response = r#"{"steps":[{"kind":"observe","title":"读取项目结构","description":"获取项目目录树","command":"opsark-tool files.get_structure {\"rootPath\":\"/opt/app\"}","expected":"获得项目目录树","validation":true,"risk":"low"}]}"#;
    let steps: Vec<AiPlanStep> = parse_model_array_field(response, "steps").unwrap();

    assert_eq!(steps[0].validation, "true");
    assert!(validate_ai_plan_contract(&steps, &AiGenerationSettings::default()).is_ok());
    assert_eq!(
        serde_json::to_value(&steps[0]).unwrap()["validation"],
        json!("true")
    );

    let focused_repair = r#"{"repair":{"stepIndex":1,"replacementSteps":[{"kind":"observe","title":"检查软件","description":"检查 node 是否可用","command":"opsark-tool software.check {\"names\":[\"node\"]}","expected":"获得软件状态","validation":true,"risk":"low"}]}}"#;
    let repair: AiPlanRepairEnvelope = parse_model_json(focused_repair).unwrap();
    assert_eq!(repair.repair.replacement_steps[0].validation, "true");
}

#[test]
fn normalizes_empty_validation_only_for_well_formed_model_tool_steps() {
    let mut tool_step = AiPlanStep {
        kind: "observe".into(),
        title: "读取项目结构".into(),
        description: "获取项目目录树".into(),
        command: r#"opsark-tool files.get_structure {"rootPath":"/opt/app"}"#.into(),
        expected: "获得项目目录树".into(),
        validation: "  ".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };
    let shell_step = AiPlanStep {
        kind: "observe".into(),
        title: "检查目录".into(),
        description: "检查项目目录".into(),
        command: "test -d /opt/app".into(),
        expected: "目录存在".into(),
        validation: "".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };
    let malformed_tool_step = AiPlanStep {
        command: "opsark-tool files.get_structure".into(),
        ..tool_step.clone()
    };

    assert_eq!(
        normalize_model_tool_validations(std::slice::from_mut(&mut tool_step)),
        1
    );
    assert_eq!(tool_step.validation, "true");
    assert!(validate_ai_plan_contract(&[tool_step], &AiGenerationSettings::default()).is_ok());

    let mut unaffected = vec![shell_step, malformed_tool_step.clone()];
    assert_eq!(normalize_model_tool_validations(&mut unaffected), 0);
    assert!(unaffected[0].validation.is_empty());
    assert!(unaffected[1].validation.trim().is_empty());
    assert!(
        validate_ai_plan_contract(&[malformed_tool_step], &AiGenerationSettings::default())
            .unwrap_err()
            .contains("opsark-tool 协议不完整")
    );
}

#[test]
fn rejects_other_non_string_validation_values_at_the_model_input_boundary() {
    for validation in ["false", "null", "0", "{}", "[]"] {
        let response = format!(
            r#"{{"steps":[{{"kind":"observe","title":"检查","description":"检查状态","command":"opsark-tool software.check {{\"names\":[\"node\"]}}","expected":"获得状态","validation":{validation},"risk":"low"}}]}}"#
        );
        let parsed = parse_model_array_field::<AiPlanStep>(&response, "steps");
        assert!(parsed.is_err(), "validation={validation} must be rejected");
    }
}

#[test]
fn boolean_true_compatibility_does_not_allow_meaningless_shell_validation() {
    let response = r#"{"steps":[{"kind":"change","title":"创建文件","description":"创建目标文件","command":"touch /tmp/opsark-result","expected":"目标文件存在","validation":true,"risk":"low"}]}"#;
    let steps: Vec<AiPlanStep> = parse_model_array_field(response, "steps").unwrap();

    assert_eq!(steps[0].validation, "true");
    let result = validate_ai_plan_contract(&steps, &AiGenerationSettings::default())
        .and_then(|_| convert_ai_plan_steps(steps));
    assert!(
        result.unwrap_err().contains("无业务意义的 validation"),
        "ordinary Shell validation must remain strict"
    );
}

#[test]
fn plan_prompts_require_the_true_json_string_for_tool_validation() {
    for prompt in [PLAN_STEP_OUTPUT_CONTRACT, GENERAL_PLAN_SYSTEM] {
        assert!(prompt.contains(r#""validation":"true""#), "{prompt}");
        assert!(
            prompt.contains("禁止输出 JSON 布尔值 true")
                || prompt.contains("不得输出 JSON 布尔值 true")
        );
    }

    let repair = plan_repair_instruction(
        "第 1 个模型工具步骤的 validation 必须固定为 JSON 字符串 \"true\"",
        None,
    );
    assert!(repair.contains(r#""validation":"true""#));
    assert!(repair.contains("禁止输出 JSON 布尔值 true"));
}

#[test]
fn clarification_prompts_distinguish_discoverable_facts_from_user_decisions() {
    assert!(GENERAL_PLAN_SYSTEM.contains("先区分可查证的环境事实与必须由用户作出的决定"));
    assert!(GENERAL_PLAN_SYSTEM.contains("有限、最少必要的只读发现步骤"));
    assert!(GENERAL_PLAN_SYSTEM.contains("不得把可自行查证的事实全部转交用户"));
    assert!(GENERAL_PLAN_SYSTEM.contains("当前计划必须只有一个 user.request_input 步骤"));
    assert!(GENERAL_PLAN_SYSTEM.contains("用可执行的替代方案偷换原目标"));
    assert!(GENERAL_PLAN_SYSTEM.contains("已明确回答且仍适用于同一目标的问题必须复用"));
    assert!(GENERAL_PLAN_SYSTEM.contains("已有未回答问题时复用原问题并保持等待"));
    assert!(GENERAL_PLAN_SYSTEM.contains("“继续、托管、批准”不替代未回答的具体问题"));
    assert!(GENERAL_PLAN_SYSTEM.contains("user.request_input 只收集输入，不改变目标环境，应使用 kind=observe"));
    assert!(GENERAL_PLAN_SYSTEM.contains("必须保持真实阻断；不得用 Shell 模拟提问、猜测回答"));
    for prompt in [GENERAL_PLAN_SYSTEM, NEXT_STAGE_DECISION_SYSTEM, GENERAL_REVIEW_SYSTEM] {
        assert!(prompt.contains("等待用户不是业务执行失败"));
    }
}

#[test]
fn clarification_prompts_use_known_choices_without_inventing_or_preselecting_answers() {
    assert!(GENERAL_PLAN_SYSTEM.contains("按 context.tools 中 user.request_input 的 inputSchema 构造"));
    assert!(GENERAL_PLAN_SYSTEM.contains("只读发现已给出候选时，优先使用 select 字段"));
    assert!(GENERAL_PLAN_SYSTEM.contains("options 必须是 1 至 100 个 {value,label} 对象"));
    assert!(GENERAL_PLAN_SYSTEM.contains("value 按原值精确唯一"));
    assert!(GENERAL_PLAN_SYSTEM.contains("开放信息使用 text，敏感值使用 password"));
    assert!(GENERAL_PLAN_SYSTEM.contains("候选未知时不得编造 options"));
    assert!(GENERAL_PLAN_SYSTEM.contains("所有字段不得设置默认值或预选项"));
    assert!(GENERAL_PLAN_SYSTEM.contains("重大操作的确认或授权须独立保留，不能由目标选择代替，不得默认同意"));
    assert!(GENERAL_PLAN_SYSTEM.contains("实际候选及其标识必须来自已知事实"));
    assert!(GENERAL_PLAN_SYSTEM.contains("示例不替代 context.tools 中的 schema"));
    assert!(!GENERAL_PLAN_SYSTEM.contains("普通决定使用 text 字段"));
}

#[test]
fn select_input_survives_the_model_plan_parser_and_normalizers_unchanged() {
    let args = json!({
        "title": "确认操作目标",
        "description": "只读发现已得到两个候选，等待用户明确选择。",
        "fields": [{
            "key": "target", "label": "操作目标", "description": "请选择本次操作的目标。",
            "type": "select", "required": true,
            "options": [
                {"value": "target-a", "label": "目标 A"},
                {"value": "Target-B", "label": "目标 B"}
            ]
        }]
    });
    let command = format!("opsark-tool user.request_input {args}");
    let visible = HashSet::from(["user.request_input".to_string()]);

    for validation in [json!("true"), json!(true), json!("")] {
        let response = json!({"steps": [{
            "kind": "observe", "title": "确认操作目标", "description": "收集缺少的目标选择。",
            "command": command, "expected": "用户明确选择本次操作目标。", "validation": validation,
            "risk": "low", "executionScope": "user_action"
        }]}).to_string();
        let mut steps: Vec<AiPlanStep> = parse_model_array_field(&response, "steps").unwrap();
        normalize_model_tool_validations(&mut steps);
        normalize_recoverable_plan_failure_masks(&mut steps);
        validate_ai_plan_contract(&steps, &AiGenerationSettings::default()).unwrap();
        validate_visible_tool_policy(&steps, Some(&visible)).unwrap();
        let converted = convert_ai_plan_steps(steps).unwrap();

        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0].kind, "observe");
        assert_eq!(converted[0].execution_scope, "user_action");
        assert_eq!(converted[0].validation, "true");
        assert_eq!(converted[0].command, command);
        let preserved: Value = serde_json::from_str(
            converted[0].command.strip_prefix("opsark-tool user.request_input ").unwrap(),
        ).unwrap();
        assert_eq!(preserved, args);
    }
}

#[test]
fn clarification_keeps_the_existing_execute_classification_contract() {
    assert!(GENERAL_REQUIREMENT_SYSTEM.contains("仍返回 execute"));
    assert!(GENERAL_REQUIREMENT_SYSTEM.contains("由后续规划通过 user.request_input 询问并等待"));
    assert!(GENERAL_REQUIREMENT_SYSTEM.contains("用户回答已有待决问题通常是 supplement"));
    assert!(GENERAL_REQUIREMENT_SYSTEM.contains("复用仍然有效的授权"));

    let response = json!({
        "intent": "execute", "relation": "supplement", "answer": "",
        "constraints": {
            "changePolicy": "requested_changes_only", "environmentPolicy": "unspecified",
            "failurePolicy": "unspecified", "prohibitedActions": [],
            "requiredConditions": [], "userDirectives": []
        },
        "terminalContextLines": 0, "selectedSkillIds": []
    });
    let decision: AiRequirementDecision = serde_json::from_value(response.clone()).unwrap();
    assert!(classification_contract_error(&decision, None).is_none());
    let mut unsupported = response;
    unsupported["intent"] = json!("clarify");
    let decision: AiRequirementDecision = serde_json::from_value(unsupported).unwrap();
    assert!(classification_contract_error(&decision, None).is_some());
}

#[test]
fn clarification_uses_one_tool_step_in_the_existing_next_stage_contract() {
    let command = format!(
        "opsark-tool user.request_input {}",
        json!({
            "title": "确认操作范围", "description": "当前有多个可能目标，需要先明确本次范围。",
            "fields": [{"key": "target", "label": "操作目标", "description": "请指定本次操作的目标。",
                "type": "select", "required": true,
                "options": [{"value": "target-a", "label": "目标 A"}, {"value": "target-b", "label": "目标 B"}]}]
        })
    );
    let response = json!({
        "decision": "adjust", "reason": "缺少目标选择，等待用户明确范围。", "summary": "等待目标选择。",
        "steps": [{"kind": "observe", "title": "确认操作目标", "description": "收集当前缺少的用户决定。",
            "command": command, "expected": "用户明确选择本次操作目标。", "validation": "true", "risk": "low",
            "executionScope": "user_action"}]
    });
    let raw: AiNextStageDecision = parse_model_json(&response.to_string()).unwrap();
    let visible = HashSet::from(["user.request_input".to_string()]);
    let converted = validate_and_convert_ai_next_stage(
        raw, &AiGenerationSettings::default(), &HashSet::new(), Some(&visible),
    ).unwrap();
    assert_eq!(converted.decision, "adjust");
    assert_eq!(converted.steps.len(), 1);
    assert_eq!(converted.steps[0].command, command);
    assert_eq!(converted.steps[0].execution_scope, "user_action");
    assert!(NEXT_STAGE_DECISION_SYSTEM.contains("steps 中只能有一个 user.request_input 步骤"));
    assert!(NEXT_STAGE_DECISION_SYSTEM.contains("用户回答只解决对应决定，不证明整体目标完成"));
}

#[test]
fn review_routes_missing_user_decisions_to_planning_without_adding_steps() {
    assert!(GENERAL_REVIEW_SYSTEM.contains("返回 adjust，reason 明确待决事项及影响"));
    assert!(GENERAL_REVIEW_SYSTEM.contains("交由现有规划生成唯一 user.request_input 步骤并等待"));
    assert!(GENERAL_REVIEW_SYSTEM.contains("本复核协议没有 steps 字段"));
    assert!(GENERAL_REVIEW_SYSTEM.contains("不得因无法在此输出提问步骤而谎称 complete"));
    let review: AiStepReview = serde_json::from_value(json!({
        "decision": "adjust", "reason": "需明确目标范围，由规划询问并等待。", "summary": "等待用户决定。"
    })).unwrap();
    let serialized = serde_json::to_value(review).unwrap();
    assert_eq!(serialized.as_object().unwrap().len(), 3);
    assert_eq!(serialized["decision"], "adjust");
    assert!(serialized.get("steps").is_none());
}

#[test]
fn next_stage_complete_requires_empty_steps_and_serializes_the_public_contract() {
    let settings = AiGenerationSettings::default();
    let forbidden = HashSet::new();
    let complete = AiNextStageDecision {
        decision: " complete ".into(),
        reason: " 已有作用域匹配的结构化证据 ".into(),
        summary: " 整体目标已经验收 ".into(),
        steps: Vec::new(),
    };

    let converted =
        validate_and_convert_ai_next_stage(complete, &settings, &forbidden, None).unwrap();
    assert_eq!(converted.decision, "complete");
    assert!(converted.steps.is_empty());
    let value = serde_json::to_value(converted).unwrap();
    assert_eq!(
        value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<HashSet<_>>(),
        HashSet::from([
            "decision".to_string(),
            "reason".to_string(),
            "summary".to_string(),
            "steps".to_string(),
        ])
    );

    let invalid = AiNextStageDecision {
        decision: "complete".into(),
        reason: "错误地同时给出计划".into(),
        summary: "契约不一致".into(),
        steps: vec![AiPlanStep::default()],
    };
    assert!(
        validate_and_convert_ai_next_stage(invalid, &settings, &forbidden, None)
            .unwrap_err()
            .contains("complete 时 steps 必须为空数组")
    );
}

#[test]
fn next_stage_non_complete_decisions_require_a_valid_plan() {
    let settings = AiGenerationSettings::default();
    for decision in ["continue", "adjust"] {
        let empty = AiNextStageDecision {
            decision: decision.into(),
            reason: "目标尚未完成".into(),
            summary: "需要下一阶段".into(),
            steps: Vec::new(),
        };
        let error = validate_and_convert_ai_next_stage(empty, &settings, &HashSet::new(), None)
            .unwrap_err();
        assert!(error.contains("steps 至少需要 1 个元素"), "{error}");
    }

    let response = r#"{"decision":"continue","reason":"还需读取目录","summary":"进入最小发现阶段","steps":[{"kind":"observe","title":"读取项目结构","description":"获取项目目录树","command":"opsark-tool files.get_structure {\"rootPath\":\"/opt/app\"}","expected":"获得项目目录树","validation":true,"risk":"low"}]}"#;
    let raw: AiNextStageDecision = parse_model_json(response).unwrap();
    assert_eq!(raw.steps[0].validation, "true");
    let converted =
        validate_and_convert_ai_next_stage(raw, &settings, &HashSet::new(), None).unwrap();
    assert_eq!(converted.decision, "continue");
    assert_eq!(converted.steps.len(), 1);
    assert_eq!(converted.steps[0].validation, "true");
}

#[test]
fn next_stage_reuses_shell_validation_and_active_skill_tool_gates() {
    let settings = AiGenerationSettings::default();
    let tool_response = r#"{"decision":"adjust","reason":"需要改用 Skill 允许的凭据通道","summary":"当前工具被禁用","steps":[{"kind":"observe","title":"解析连接","description":"解析目标服务器连接","command":"opsark-tool server.resolve_connection {\"serverId\":\"server-1\"}","expected":"获得连接信息","validation":"true","risk":"low"}]}"#;
    let raw: AiNextStageDecision = parse_model_json(tool_response).unwrap();
    let forbidden = HashSet::from(["server.resolve_connection".to_string()]);
    let error = validate_and_convert_ai_next_stage(raw, &settings, &forbidden, None).unwrap_err();
    assert!(error.contains("active Skill 禁止工具"), "{error}");

    let shell_response = r#"{"decision":"continue","reason":"还需创建结果文件","summary":"执行变更阶段","steps":[{"kind":"change","title":"创建文件","description":"创建结果文件","command":"touch /tmp/opsark-result","expected":"结果文件存在","validation":true,"risk":"low"}]}"#;
    let raw: AiNextStageDecision = parse_model_json(shell_response).unwrap();
    let error =
        validate_and_convert_ai_next_stage(raw, &settings, &HashSet::new(), None).unwrap_err();
    assert!(error.contains("无业务意义的 validation"), "{error}");
}

#[test]
fn next_stage_request_has_an_explicit_evidence_gate_and_opt_in_token_limit() {
    let unlimited = AiGenerationSettings::default();
    let body = build_next_stage_request_body(
        "model-a",
        "完成整体目标",
        r#"{"baseSnapshot":{},"activeSkills":[]}"#,
        &unlimited,
    );
    assert!(body.get("max_tokens").is_none());
    let system = body["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains(GENERAL_PLAN_SYSTEM));
    assert!(system.contains("完成证据门禁"));
    assert!(system.contains(
        "计划文字、步骤标题、expected、阶段 summary、模型 review、指令和待执行步骤都不是完成证据"
    ));
    assert!(system.contains(r#""validation":"true""#));
    assert!(system.contains("decision=complete 时 steps 必须严格为空数组"));

    let limited = AiGenerationSettings {
        limit_output: true,
        max_plan_steps: 4,
        max_output_tokens: 777,
        max_text_chars: 160,
        max_command_chars: 1800,
    };
    let body = build_next_stage_request_body("model-a", "目标", "{}", &limited);
    assert_eq!(body["max_tokens"], json!(777));
    assert!(body["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("steps 不超过 4 个"));
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
fn rejects_tools_not_exposed_in_the_current_planning_context() {
    let visible = context_visible_tool_ids(
        r#"{"tools":[{"id":"software.check"},{"id":"user.request_input"}]}"#,
    )
    .unwrap()
    .unwrap();
    let tool_step = |tool_id: &str| AiPlanStep {
        kind: "observe".into(),
        title: "调用工具".into(),
        description: "调用当前阶段工具".into(),
        command: format!(r#"opsark-tool {tool_id} {{"names":["node"]}}"#),
        expected: "获得结构化结果".into(),
        validation: "true".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };

    assert!(validate_visible_tool_policy(&[tool_step("software.check")], Some(&visible)).is_ok());
    let error = validate_visible_tool_policy(&[tool_step("files.get_structure")], Some(&visible))
        .unwrap_err();
    assert!(error.contains("当前规划上下文未开放工具"), "{error}");
    assert!(plan_repair_instruction(&error, None).contains("context.tools"));

    let empty = context_visible_tool_ids(r#"{"tools":[]}"#)
        .unwrap()
        .unwrap();
    assert!(validate_visible_tool_policy(&[tool_step("software.check")], Some(&empty)).is_err());
    assert!(context_visible_tool_ids(r#"{"otherContext":true}"#)
        .unwrap()
        .is_none());
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
            .contains("validation 必须固定为 JSON 字符串 \"true\"")
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
fn focused_plan_repair_context_omits_history_and_unrelated_tool_schemas() {
    let context = json!({
        "_log": {"taskId": "task-1", "phaseIndex": 4},
        "_requestParameters": {"temperature": 0},
        "taskGoal": {"rootGoal": "deploy app"},
        "server": {"id": "server-1", "os": "linux"},
        "executionConstraints": {"changePolicy": "requested_changes_only"},
        "confirmedUserInputs": {"registry": {"value": "mirror.example"}},
        "planGenerationRepair": {"originalPlan": [{"id": "step-1"}], "error": "repair only"},
        "instruction": "repair the original protocol only",
        "activeSkills": [],
        "tools": [
            {"id": "files.read_content", "inputSchema": {"type": "object"}},
            {"id": "software.check", "inputSchema": {"type": "object"}}
        ],
        "baseSnapshot": {"historyCheckpoint": "x".repeat(50_000)},
        "recentPhases": ["old evidence"],
        "recoveredEvidence": ["duplicate evidence"]
    })
    .to_string();
    let invalid = AiPlanStep {
        kind: "observe".into(),
        title: "read".into(),
        description: "read".into(),
        command: r#"opsark-tool files.read_content {"path":"/tmp/a"}"#.into(),
        expected: "content".into(),
        validation: "false".into(),
        risk: Some("low".into()),
        ..AiPlanStep::default()
    };

    let compact = focused_plan_repair_context(
        &context,
        "第 1 个计划步骤的 validation 必须固定为 true",
        &invalid,
    )
    .unwrap();
    let parsed: Value = serde_json::from_str(&compact).unwrap();

    assert_eq!(parsed["workflowPhase"], "focused_plan_repair");
    assert_eq!(parsed["_requestParameters"]["temperature"], 0);
    assert_eq!(
        parsed["confirmedUserInputs"]["registry"]["value"],
        "mirror.example"
    );
    assert_eq!(parsed["server"]["id"], "server-1");
    assert_eq!(parsed["planGenerationRepair"]["error"], "repair only");
    assert_eq!(parsed["instruction"], "repair the original protocol only");
    assert!(parsed.get("baseSnapshot").is_none());
    assert!(parsed.get("recentPhases").is_none());
    assert!(parsed.get("recoveredEvidence").is_none());
    assert_eq!(parsed["tools"].as_array().unwrap().len(), 1);
    assert_eq!(parsed["tools"][0]["id"], "files.read_content");
    assert!(compact.len() < 2_000);
}

#[test]
fn malformed_tool_repair_keeps_the_visible_catalog_but_not_history() {
    let context = json!({
        "tools": [
            {"id": "files.read_content", "inputSchema": {"type": "object"}},
            {"id": "software.check", "inputSchema": {"type": "object"}}
        ],
        "baseSnapshot": {"historyCheckpoint": "x".repeat(20_000)}
    })
    .to_string();
    let invalid = AiPlanStep {
        command: "opsark-tool".into(),
        ..AiPlanStep::default()
    };
    let compact = focused_plan_repair_context(
        &context,
        "第 1 个计划步骤的 opsark-tool 协议不完整",
        &invalid,
    )
    .unwrap();
    let parsed: Value = serde_json::from_str(&compact).unwrap();

    assert_eq!(parsed["tools"].as_array().unwrap().len(), 2);
    assert!(parsed.get("baseSnapshot").is_none());
}

#[test]
fn focused_repair_preserves_nested_authority_without_copying_evidence() {
    let context = json!({
        "baseSnapshot": {
            "task": {"permission": "safe", "title": "read only"},
            "executionConstraints": {"changePolicy": "read_only", "reason": "no writes"},
            "rootGoal": "inspect app",
            "currentPlan": {"output": "PRIVATE_EVIDENCE".repeat(5_000)}
        }
    });
    let invalid = AiPlanStep::default();
    let compact = focused_plan_repair_context(&context.to_string(), "repair", &invalid).unwrap();
    let parsed: Value = serde_json::from_str(&compact).unwrap();
    assert_eq!(parsed["permission"], "safe");
    assert_eq!(parsed["executionConstraints"]["changePolicy"], "read_only");
    assert_eq!(parsed["taskGoal"]["rootGoal"], "inspect app");
    assert!(!compact.contains("PRIVATE_EVIDENCE"));
    assert!(compact.len() < 1_000);

    let mut current = context;
    current["permission"] = json!("readonly");
    current["executionConstraints"] = json!({"changePolicy": "read_only", "reason": "new current restriction"});
    let compact = focused_plan_repair_context(&current.to_string(), "repair", &invalid).unwrap();
    let parsed: Value = serde_json::from_str(&compact).unwrap();
    assert_eq!(parsed["permission"], "readonly");
    assert_eq!(parsed["executionConstraints"]["reason"], "new current restriction");
}

#[test]
fn fingerprints_plan_safety_failures_by_step_field_and_rule() {
    let empty_fallback = plan_failure_fingerprint(
        "第 3 个计划步骤的 command 未通过执行前安全检查（EMPTY_SUCCESS_FALLBACK：以 || true（或等价空操作）结束）；必须修复",
        12,
    )
    .unwrap();
    let pipeline = plan_failure_fingerprint(
        "第 3 个计划步骤的 command 未通过执行前安全检查（PIPELINE_STATUS_LOST：关键命令 | head/tail）；必须修复",
        12,
    )
    .unwrap();
    let later_empty_fallback = plan_failure_fingerprint(
        "第 12 个计划步骤的 command 未通过执行前安全检查（EMPTY_SUCCESS_FALLBACK：以 || true（或等价空操作）结束）；必须修复",
        12,
    )
    .unwrap();

    assert_eq!(empty_fallback.step_index, 3);
    assert_eq!(empty_fallback.field, "command");
    assert_eq!(empty_fallback.failure_id, "EMPTY_SUCCESS_FALLBACK");
    assert_eq!(pipeline.failure_id, "PIPELINE_STATUS_LOST");
    assert_eq!(later_empty_fallback.step_index, 12);
    assert_ne!(empty_fallback, pipeline);
    assert_ne!(empty_fallback, later_empty_fallback);
}

#[test]
fn repair_budget_allows_a_progressing_safety_failure_chain() {
    let fingerprint = |step_index, failure_id: &str| PlanFailureFingerprint {
        step_index,
        field: "command",
        failure_id: failure_id.into(),
    };
    let mut budget = PlanRepairBudget::default();

    assert!(budget.try_start_call(false));
    budget.observe_failure(Some(fingerprint(3, "EMPTY_SUCCESS_FALLBACK")), false);
    assert!(budget.try_start_call(true));
    budget.observe_failure(Some(fingerprint(3, "PIPELINE_STATUS_LOST")), true);
    assert!(budget.try_start_call(true));
    budget.observe_failure(Some(fingerprint(12, "EMPTY_SUCCESS_FALLBACK")), true);

    // The observed production chain made progress on every repair. A third
    // focused repair must still be available for the newly exposed step 12.
    assert!(budget.try_start_call(true));
    assert_eq!(budget.total_model_calls, 4);
    assert_eq!(budget.focused_repair_calls, 3);
    assert!(budget.stop_reason.is_none());
}

#[test]
fn repair_budget_stops_after_two_unchanged_focused_repairs() {
    let failure = PlanFailureFingerprint {
        step_index: 3,
        field: "command",
        failure_id: "EMPTY_SUCCESS_FALLBACK".into(),
    };
    let mut budget = PlanRepairBudget::default();

    assert!(budget.try_start_call(false));
    budget.observe_failure(Some(failure.clone()), false);
    for _ in 0..PLAN_MAX_STAGNANT_REPAIRS {
        assert!(budget.try_start_call(true));
        budget.observe_failure(Some(failure.clone()), true);
    }

    assert!(!budget.try_start_call(true));
    assert_eq!(budget.total_model_calls, 3);
    assert_eq!(budget.focused_repair_calls, 2);
    assert!(budget.stop_reason().contains("同一计划校验失败"));
}

#[test]
fn repair_budget_enforces_full_generation_and_total_hard_limits() {
    let mut full_budget = PlanRepairBudget::default();
    for _ in 0..PLAN_MAX_FULL_GENERATION_CALLS {
        assert!(full_budget.try_start_call(false));
    }
    assert!(!full_budget.try_start_call(false));
    assert!(full_budget.stop_reason().contains("完整计划生成硬上限"));

    let mut total_budget = PlanRepairBudget::default();
    for _ in 0..PLAN_MAX_FULL_GENERATION_CALLS {
        assert!(total_budget.try_start_call(false));
    }
    for _ in 0..PLAN_MAX_FOCUSED_REPAIR_CALLS {
        assert!(total_budget.try_start_call(true));
    }
    assert_eq!(total_budget.total_model_calls, PLAN_MAX_TOTAL_MODEL_CALLS);
    assert!(!total_budget.try_start_call(true));
    assert!(total_budget.stop_reason().contains("模型调用硬上限"));
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
        recovery: None,
        recovery_rule_version: None,
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
    assert!(value.get("recovery").is_none());
}

#[test]
fn structured_recovery_survives_plan_conversion_and_rejects_invalid_purpose() {
    let payload = json!({"kind":"observe", "title":"Verify original postcondition", "description":"Recheck",
        "command":"test -d /opt/project-a/dist", "validation":"", "expected":"Artifact exists", "risk":"low",
        "recovery":{"failedStepId":"failed-build-a", "targetContext":"target-a", "purpose":"verify"}});
    let parsed: AiPlanStep = serde_json::from_value(payload.clone()).unwrap();
    let converted = convert_ai_plan_steps(vec![parsed]).unwrap();
    assert_eq!(serde_json::to_value(&converted[0]).unwrap()["recovery"], payload["recovery"]);
    let mut invalid = payload.clone();
    invalid["recovery"]["purpose"] = json!("complete");
    assert!(convert_ai_plan_steps(vec![serde_json::from_value(invalid).unwrap()]).unwrap_err().contains("recovery"));
    let mut invalid = payload;
    invalid["recovery"]["extra"] = json!(true);
    let invalid: AiPlanStep = serde_json::from_value(invalid).unwrap();
    let issue = recovery_rules::decode_issue(&convert_ai_plan_steps(vec![invalid]).unwrap_err()).unwrap();
    assert_eq!(issue.code, "RECOVERY_INVALID_METADATA");
    assert!(PLAN_STEP_OUTPUT_CONTRACT.contains("recovery"));
    assert!(NEXT_STAGE_OUTPUT_CONTRACT.contains("recovery"));
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
            allowed_tool_ids: Some(vec!["user.request_input".into()]),
            forbidden_tool_ids: vec!["server.resolve_connection".into()],
        },
        ModelSkillDefinition {
            id: "project-build".into(),
            name: "项目依赖与构建".into(),
            description: "构建代码项目".into(),
            version: 1,
            instructions: "BUILD_WORKFLOW".into(),
            allowed_tool_ids: Some(vec!["files.read_content".into()]),
            forbidden_tool_ids: Vec::new(),
        },
    ];
    let context = r#"{"skillDirectory":[{"id":"project-source-acquisition"},{"id":"project-build"}],"activeSkills":[],"tools":[{"id":"server.resolve_connection"},{"id":"files.read_content"}]}"#;
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
    assert_eq!(value["tools"], json!([{"id":"files.read_content"}]));
}

#[test]
fn skill_allow_lists_preserve_visible_clarification_without_overriding_tool_blocks() {
    let mut skill = ModelSkillDefinition {
        id: "bounded-workflow".into(), name: "有限工作流".into(),
        description: "仅允许读取指定内容".into(), version: 1,
        instructions: "按已确认目标读取内容".into(),
        allowed_tool_ids: Some(vec!["files.read_content".into()]),
        forbidden_tool_ids: Vec::new(),
    };
    let selected = vec![skill.id.clone()];
    let context = r#"{"tools":[{"id":"files.read_content"},{"id":"user.request_input"},{"id":"evidence.read"},{"id":"files.get_structure"}]}"#;
    let question = AiPlanStep {
        command: r#"opsark-tool user.request_input {"title":"确认目标","fields":[{"key":"target","label":"目标","description":"请指定操作目标。","type":"text","required":true}]}"#.into(),
        ..AiPlanStep::default()
    };

    let enriched = context_with_selected_skills(context, &[skill.clone()], &selected, None).unwrap();
    let visible = context_visible_tool_ids(&enriched).unwrap().unwrap();
    assert_eq!(visible, HashSet::from([
        "files.read_content".to_string(), "user.request_input".to_string(), "evidence.read".to_string(),
    ]));
    assert!(validate_visible_tool_policy(std::slice::from_ref(&question), Some(&visible)).is_ok());

    // Disabled/non-planner tools are removed by the frontend before this wire
    // context is built. The backend must never synthesize an absent schema.
    let disabled_context = r#"{"tools":[{"id":"files.read_content"},{"id":"evidence.read"}]}"#;
    let enriched = context_with_selected_skills(disabled_context, &[skill.clone()], &selected, None).unwrap();
    let visible = context_visible_tool_ids(&enriched).unwrap().unwrap();
    assert!(!visible.contains("user.request_input"));
    assert!(validate_visible_tool_policy(std::slice::from_ref(&question), Some(&visible)).is_err());

    skill.forbidden_tool_ids.push("user.request_input".into());
    let enriched = context_with_selected_skills(context, &[skill], &selected, None).unwrap();
    let visible = context_visible_tool_ids(&enriched).unwrap().unwrap();
    assert!(!visible.contains("user.request_input"));
    let forbidden = active_skill_forbidden_tool_ids(&enriched).unwrap();
    assert!(validate_active_skill_tool_policy(std::slice::from_ref(&question), &forbidden).is_err());
    assert!(validate_visible_tool_policy(&[question], Some(&visible)).is_err());
}

#[test]
fn classification_context_omits_planning_only_payloads() {
    let context = r#"{"server":{"host":"example"},"tools":[{"id":"files.read_content","inputSchema":{"type":"object"}}],"secretVariables":[{"key":"TOKEN"}],"serverCredentialGroups":[{"ref":"group"}],"activeSkills":[{"id":"old"}],"skillDirectory":[{"id":"project-source-acquisition"}],"knownExecutionFacts":{"completedSteps":[]}}"#;
    let compact = requirement_classification_context(context).unwrap();
    let value: Value = serde_json::from_str(&compact).unwrap();

    assert!(value.get("tools").is_none());
    assert!(value.get("secretVariables").is_none());
    assert!(value.get("serverCredentialGroups").is_none());
    assert!(value.get("activeSkills").is_none());
    assert!(value.get("skillDirectory").is_some());
    assert!(value.get("knownExecutionFacts").is_some());
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
fn routes_untracked_background_repair_to_a_proven_service_manager() {
    let error = "第 4 个计划步骤将进程脱离执行器跟踪";
    let instruction = plan_repair_instruction(error, None);

    assert!(instruction.contains("systemctl"));
    assert!(instruction.contains("Docker/Compose"));
    assert!(instruction.contains("Supervisor"));
    assert!(instruction.contains("kind=observe"));
    assert!(instruction.contains("executionScope=managed_service"));
    assert!(instruction.contains("只修改 executionScope"));
}

#[test]
fn build_blockers_cannot_plan_deployment_before_artifact_evidence() {
    assert!(GENERAL_PLAN_SYSTEM.contains("当前阻断发生在依赖解析、编译、打包或镜像构建阶段"));
    assert!(GENERAL_PLAN_SYSTEM.contains("构建产物未经结构化程序证据确认前"));
    assert!(
        GENERAL_PLAN_SYSTEM.contains("不得生成启动、后台运行、部署、端口探测或应用健康检查步骤")
    );
}

#[test]
fn initial_readonly_classification_repairs_only_a_proven_fresh_task() {
    let response = json!({"intent":"execute","relation":"side_question","answer":"",
        "constraints":{"changePolicy":"read_only","environmentPolicy":"unspecified","failurePolicy":"unspecified",
            "prohibitedActions":[],"requiredConditions":[],"userDirectives":[]},
        "terminalContextLines":0,"selectedSkillIds":[]});
    let fresh = json!({"conversationHistory":[],"knownExecutionFacts":{"completedSteps":[]}});
    let mut decision: AiRequirementDecision = serde_json::from_value(response.clone()).unwrap();
    let error = classification_contract_error(&decision, None).unwrap();
    assert!(error.contains("execute.relation"));
    assert!(!error.contains("constraints 必须"));
    assert!(normalize_initial_readonly_relation(
        &mut decision,
        &fresh.to_string()
    ));
    assert_eq!(decision.relation.as_deref(), Some("new_goal"));
    assert_eq!(decision.constraints, response["constraints"]);
    assert!(classification_contract_error(&decision, None).is_none());

    for context in [
        json!({}),
        json!({"conversationHistory":[]}),
        json!({"conversationHistory":[{"role":"user","content":"prior"}],"knownExecutionFacts":{"completedSteps":[]}}),
        json!({"conversationHistory":[],"knownExecutionFacts":{"completedSteps":[{"id":"old"}]}}),
        json!({"taskGoal":{"rootGoal":"deploy"},"conversationHistory":[],"knownExecutionFacts":{"completedSteps":[]}}),
        json!({"previousExecution":{},"conversationHistory":[],"knownExecutionFacts":{"completedSteps":[]}}),
    ] {
        let mut decision: AiRequirementDecision = serde_json::from_value(response.clone()).unwrap();
        assert!(!normalize_initial_readonly_relation(
            &mut decision,
            &context.to_string()
        ));
        assert_eq!(decision.relation.as_deref(), Some("side_question"));
    }
    for policy in [
        "unspecified",
        "requested_changes_only",
        "allow_necessary_changes",
    ] {
        let mut decision: AiRequirementDecision = serde_json::from_value(response.clone()).unwrap();
        decision.constraints["changePolicy"] = json!(policy);
        assert!(!normalize_initial_readonly_relation(
            &mut decision,
            &fresh.to_string()
        ));
    }
}

#[test]
fn classification_feedback_identifies_the_invalid_field() {
    let response = json!({"intent":"execute","relation":"new_goal","answer":"",
        "constraints":{"changePolicy":"read_only","environmentPolicy":"unspecified","failurePolicy":"unspecified",
            "prohibitedActions":[],"requiredConditions":[],"userDirectives":[]},
        "terminalContextLines":0,"selectedSkillIds":[]});
    let mut answer: AiRequirementDecision = serde_json::from_value(response.clone()).unwrap();
    answer.answer = "explanation".into();
    assert!(classification_contract_error(&answer, None)
        .unwrap()
        .contains("answer"));
    let mut lines: AiRequirementDecision = serde_json::from_value(response.clone()).unwrap();
    lines.terminal_context_lines = 10;
    assert!(classification_contract_error(&lines, None)
        .unwrap()
        .contains("terminalContextLines"));
    let mut constraints: AiRequirementDecision = serde_json::from_value(response).unwrap();
    constraints.constraints["changePolicy"] = json!("unspecified");
    assert!(classification_contract_error(&constraints, None)
        .unwrap()
        .contains("constraints"));
    assert_eq!(
        classification_contract_error(&constraints, Some("unknown Skill".into())).as_deref(),
        Some("unknown Skill")
    );
}
