//! One unexecuted joint proposal when no Skill expansion is selected. All local
//! classification, lifecycle, plan and frontend admission gates still apply.
use super::*;

/// Explicit per-process rollout only: joint prompts can cost more for answers
/// and Skill-selected requests. Do not change the production default offline.
pub(crate) fn enabled(value: Option<&str>) -> bool {
    value == Some("1")
}

pub(crate) fn eligible(context: &str, requirement: &str, skills: &[ModelSkillDefinition]) -> bool {
    let Ok(context) = serde_json::from_str::<Value>(context) else {
        return false;
    };
    let available: HashSet<_> = skills.iter().map(|skill| skill.id.as_str()).collect();
    let directory = context["skillDirectory"].as_array();
    let directory_matches = if skills.is_empty() {
        context.get("skillDirectory").is_none() || directory.is_some_and(Vec::is_empty)
    } else {
        directory.is_some_and(|items| {
            let ids: Option<HashSet<_>> = items.iter().map(|item| item["id"].as_str()).collect();
            ids.is_some_and(|ids| ids.len() == items.len() && ids == available)
        })
    };
    directory_matches
        && available.len() == skills.len()
        && ["activeSkills"].iter().all(|key| {
            context
                .get(key)
                .is_none_or(|value| value.as_array().is_some_and(Vec::is_empty))
        })
        && context["tools"]
            .as_array()
            .is_some_and(|tools| !tools.is_empty())
        && context["requirementSubmission"]["baseRevision"]
            .as_u64()
            .is_some()
        && context["requirementSubmission"]["sourceMessageId"]
            .as_str()
            .is_some_and(|id| !id.trim().is_empty())
        && context["requirementSubmission"]["content"] == requirement
        && context.get("workflowPhase").is_none()
        && [
            "planGenerationRepair",
            "protocolReplan",
            "operationalRepair",
            "protocolRepairBudget",
        ]
        .iter()
        .all(|key| context.get(key).is_none())
        && matches!(
            context
                .pointer("/_modelOutputRecovery/strategy")
                .and_then(Value::as_str),
            None | Some("initial")
        )
}

pub(crate) fn request(
    model: &str,
    requirement: &str,
    context: &str,
    settings: &AiGenerationSettings,
) -> Result<Value, String> {
    let authority: Value = serde_json::from_str(context).map_err(|error| error.to_string())?;
    let public = prompt_layers::public_context(&authority);
    // No classification-only prohibition/examples and no duplicate secret/JSON
    // rule. Keep the classification policy plus the actual ordinary planner.
    let classification =
        GENERAL_REQUIREMENT_SYSTEM.replacen("本阶段不生成计划", "本次同时提出未执行计划", 1);
    let contract = REQUIREMENT_CLASSIFICATION_CONTRACT.split("以下示例").next().unwrap()
        .replacen("本阶段只做需求分类、任务关系判断、终端上下文判断、执行约束提取和 Skill 选择，禁止输出 steps、command、validation 或执行计划。",
            "先判断需求分类、关系、终端上下文及执行约束，再在同一对象内提出未执行计划。", 1);
    let plan_contract = PLAN_STEP_OUTPUT_CONTRACT.replacen(
        "输出必须是只包含 steps 数组的对象，steps 必须至少有 1 个元素。",
        "本次联合对象同时包含需求分类字段和 steps：execute且未选Skill时必须有至少一个真实步骤；已选Skill、answer和terminal_context的steps必须为空。", 1);
    let planner = plan_generation_system(false, &plan_contract, &next_stage_limit_rule(settings));
    let instruction = "联合分类与规划：只输出一个对象，保留 intent、relation、answer、constraints、terminalContextLines、selectedSkillIds、requirementUpdate 并增加 steps。仍按skillDirectory语义选择Skill，不得为省调用而漏选。selectedSkillIds为空且intent=execute时，同次提出非空计划；选中任何Skill时steps必须为空，由Core先加载完整Skill规则后独立规划，不能在未读规则时猜测计划。先按本次用户消息投影requirementUpdate，再依据更新后的有效要求和本次constraints规划，不能沿用被替代目标或把旧约束当作本次授权。咨询、取消或需要更多终端内容时steps=[]。所有计划均未执行，仍须本地校验和正常审批；能力、路径、必要输入不明确时先安排取证或user.request_input，不编造结果。无Skill的execute不能用空steps掩盖计划失败。";
    Ok(
        json!({"_opsarkOperationContract":"requirement.plan@1", "_opsarkContext":context,
        "model":model, "messages":[
            {"role":"system","content":format!("{classification}\n{contract}\n{}\n{REQUIREMENT_RELATION_RULE}\n{}\n{instruction}\n{planner}", classification_contract::rule(), requirement_contract::update_rule())},
            // Classification label prevents stale pre-classification read_only
            // constraints from projecting change tools out of this joint call.
            {"role":"user","content":format!("分类上下文：\n{public}\n\n用户输入：\n{requirement}")}],
        "thinking":{"type":"disabled"},"response_format":{"type":"json_object"},
        "max_tokens":settings.max_output_tokens.unwrap_or(5000).max(256)}),
    )
}

fn rejected(error: &str, steps: &[AiPlanStep]) -> String {
    if let Some(error) = recovery_failure_envelope(error, steps, &PlanRepairBudget::default()) {
        return error;
    }
    let steps: Vec<Value> = steps
        .iter()
        .enumerate()
        .map(|(index, step)| {
            let mut value = serde_json::to_value(step).unwrap();
            value["id"] = json!(next_plan_step_id("rejected-step", index));
            value["status"] = json!("pending");
            value
        })
        .collect();
    json!({"kind":"plan_protocol_failure","validationError":error,"steps":steps,"rejectedPlanExecuted":false}).to_string()
}

#[cfg(test)]
pub(crate) fn accept(
    content: &str,
    context: &str,
    requirement: &str,
    settings: &AiGenerationSettings,
) -> Result<RequirementProcessingResult, String> {
    accept_with_skills(content, context, requirement, settings, &[])
}

fn accept_with_skills(
    content: &str,
    context: &str,
    requirement: &str,
    settings: &AiGenerationSettings,
    skills: &[ModelSkillDefinition],
) -> Result<RequirementProcessingResult, String> {
    let mut value: Value = parse_model_json(content)?;
    let steps_value = value
        .as_object_mut()
        .and_then(|value| value.remove("steps"))
        .ok_or("联合响应缺少steps")?;
    let decision: AiRequirementDecision =
        serde_json::from_value(value).map_err(|error| error.to_string())?;
    if decision.intent == "execute" {
        if let Some(issue) = classification_contract::invalid(&decision.constraints) {
            return Err(classification_contract::encode(&issue));
        }
    }
    let available: HashSet<_> = skills.iter().map(|skill| skill.id.as_str()).collect();
    let selected: HashSet<_> = decision
        .selected_skill_ids
        .iter()
        .map(String::as_str)
        .collect();
    let skill_error = (selected.len() != decision.selected_skill_ids.len()
        || !selected.is_subset(&available))
    .then(|| "selectedSkillIds包含重复、未启用或不存在的Skill".into());
    if let Some(error) = classification_contract_error(&decision, skill_error).or_else(|| {
        requirement_contract::validate_update(
            &decision.intent,
            decision.relation.as_deref(),
            decision.requirement_update.as_ref(),
            context,
            requirement,
        )
    }) {
        return Err(error);
    }
    let mut raw_steps: Vec<AiPlanStep> =
        serde_json::from_value(steps_value).map_err(|error| error.to_string())?;
    if decision.intent != "execute" {
        if !raw_steps.is_empty() {
            return Err("旁问、取消及终端上下文请求不能夹带执行计划".into());
        }
        return Ok(RequirementProcessingResult {
            intent: decision.intent.clone(),
            relation: decision.relation,
            answer: (decision.intent == "answer").then(|| decision.answer.trim().to_string()),
            terminal_context_lines: decision.terminal_context_lines,
            plan: vec![],
            constraints: None,
            selected_skill_ids: vec![],
            plan_error: None,
            requirement_update: decision.requirement_update,
            developer_trace: ModelDeveloperTrace::default(),
        });
    }
    let constraints = normalize_execution_constraints(Some(
        serde_json::from_value(decision.constraints).map_err(|error| error.to_string())?,
    ));
    if !decision.selected_skill_ids.is_empty() {
        if !raw_steps.is_empty() {
            return Err(
                "选择Skill后必须先加载完整规则，本次steps必须为空，不能接纳提前猜测的计划".into(),
            );
        }
        return Ok(RequirementProcessingResult {
            intent: "execute".into(),
            relation: decision.relation,
            answer: None,
            plan: vec![],
            constraints: Some(constraints),
            terminal_context_lines: 0,
            selected_skill_ids: decision.selected_skill_ids,
            requirement_update: decision.requirement_update,
            plan_error: None,
            developer_trace: ModelDeveloperTrace::default(),
        });
    }
    let projected = requirement_contract::project_classified_context(
        context,
        decision.relation.as_deref(),
        decision.requirement_update.as_ref(),
        requirement,
        Some(&serde_json::to_value(&constraints).map_err(|error| error.to_string())?),
    )?;
    let projected = context_with_selected_skills(&projected, &[], &[], None)?;
    let visible = context_visible_tool_ids(&projected)?;
    normalize_model_actions(&mut raw_steps);
    normalize_recoverable_plan_failure_masks(&mut raw_steps);
    let validation = validate_ai_plan_contract(&raw_steps, settings)
        .and_then(|_| validate_visible_tool_policy(&raw_steps, visible.as_ref()));
    let plan_result = validation.and_then(|_| convert_ai_plan_steps(raw_steps.clone()));
    let (plan, plan_error) = match plan_result {
        Ok(plan) => (plan, None),
        Err(error) => (vec![], Some(rejected(&error, &raw_steps))),
    };
    Ok(RequirementProcessingResult {
        intent: "execute".into(),
        relation: decision.relation,
        answer: None,
        plan,
        constraints: Some(constraints),
        terminal_context_lines: 0,
        selected_skill_ids: vec![],
        requirement_update: decision.requirement_update,
        plan_error,
        developer_trace: ModelDeveloperTrace::default(),
    })
}

/// Validate the complete classification independently of a rejected plan. The
/// original steps are discarded, never patched, approved or used as evidence.
fn classification_from_rejected_plan(
    rejected: &model::RejectedRequirementCandidate, body: &Value, context: &str,
    requirement: &str, settings: &AiGenerationSettings, skills: &[ModelSkillDefinition],
) -> Result<RequirementProcessingResult, String> {
    let text = message_content(&rejected.payload, "被拒候选缺少分类正文")?;
    let mut value: Value = serde_json::from_str(json_contract::normalize_json_wrapper(text))
        .map_err(|_| "被拒候选没有完整JSON分类")?;
    if value["intent"] != "execute" || value["selectedSkillIds"] != json!([]) {
        return Err("只能复用独立校验通过且未选择Skill的执行分类".into());
    }
    value.as_object_mut().ok_or("被拒候选不是对象")?.remove("steps");
    let classification_body = json!({"_opsarkContext":body["_opsarkContext"]});
    let schema = model_compatibility::full_contract("需求理解", &classification_body).ok_or("分类契约缺失")?;
    let mut payload = rejected.payload.clone();
    payload["choices"][0]["message"]["content"] = json!(value.to_string());
    // The original wire was rejected. Validate only the full classification
    // business contract here, then apply its existing optional-null codecs.
    model_compatibility::normalize_classification_projection(&mut payload, &schema)
        .map_err(|issue| model_compatibility::output_error(&issue, None))?;
    let mut classification: Value = serde_json::from_str(message_content(&payload, "分类正文缺失")?)
        .map_err(|_| "分类解码失败")?;
    classification["steps"] = json!([]);
    let mut accepted = accept_with_skills(&classification.to_string(), context, requirement, settings, skills)?;
    accepted.plan.clear();
    accepted.plan_error = Some(rejected.error.clone());
    Ok(accepted)
}

pub(crate) async fn process(
    api_key: &str,
    endpoint: &str,
    model: &str,
    requirement: &str,
    context: &str,
    skills: &[ModelSkillDefinition],
    settings: AiGenerationSettings,
    timeout: u64,
    log: Option<&Path>,
) -> Result<RequirementProcessingResult, String> {
    let body = request(model, requirement, context, &settings)?;
    let started = Instant::now();
    let mut trace = ModelDeveloperTrace::default();
    let mut rejected = None;
    let response = model::post_requirement_candidate(
        &format!("{}/chat/completions", endpoint.trim_end_matches('/')),
        api_key,
        &body,
        timeout,
        log,
        &mut rejected,
    )
    .await;
    let mut result = response.as_ref().map_err(Clone::clone).and_then(|payload| {
        message_content(payload, "模型响应缺少联合理解与计划结果").and_then(|content| {
            accept_with_skills(content, context, requirement, &settings, skills)
        })
    });
    if result.is_err() {
        if let Some(candidate) = &rejected {
            let details: Value = candidate.error.strip_prefix(MODEL_TRACE_ERROR_PREFIX)
                .and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or_default();
            let authority: Value = serde_json::from_str(context).unwrap_or_default();
            if let Ok(classified) = classification_from_rejected_plan(candidate, &body, context, requirement, &settings, skills) {
                model::append_model_log(log, json!({"event":"joint_classification_validated_after_plan_rejection",
                    "requestId":details["modelError"]["requestKey"], "classificationValidated":true,
                    "rejectedCandidateExecuted":false,"recoveryBudget":details["modelError"]["recoveryBudget"]}), &authority);
                result = Ok(classified);
            } else {
                model::append_model_log(log, json!({"event":"joint_classification_reuse_stopped",
                    "requestId":details["modelError"]["requestKey"],"classificationValidated":false,
                    "reasonCode":"CLASSIFICATION_NOT_VALIDATED","rejectedCandidateExecuted":false,
                    "recoveryBudget":details["modelError"]["recoveryBudget"]}), &authority);
            }
        }
    }
    let error = result.as_ref().err().cloned().or_else(|| {
        result
            .as_ref()
            .ok()
            .and_then(|result| result.plan_error.clone())
    });
    record_model_attempt(
        &mut trace,
        "requirement_planning",
        1,
        started,
        body,
        response.ok(),
        error,
    );
    let mut accepted = result.map_err(|error| traced_model_error(error, &trace))?;
    if accepted.intent == "execute" && !accepted.selected_skill_ids.is_empty() {
        let projected = requirement_contract::project_classified_context(
            context,
            accepted.relation.as_deref(),
            accepted.requirement_update.as_ref(),
            requirement,
            Some(
                &serde_json::to_value(&accepted.constraints)
                    .map_err(|error| traced_model_error(error.to_string(), &trace))?,
            ),
        )
        .map_err(|error| traced_model_error(error, &trace))?;
        let projected =
            context_with_selected_skills(&projected, skills, &accepted.selected_skill_ids, None)
                .map_err(|error| traced_model_error(error, &trace))?;
        let plan = generate_ai_plan_with_trace(
            api_key.into(),
            endpoint.into(),
            model.into(),
            requirement.into(),
            projected,
            Some(settings),
            timeout,
            &mut trace,
            log,
        )
        .await;
        match plan {
            Ok(plan) => accepted.plan = plan,
            Err(error) => accepted.plan_error = Some(error),
        }
    }
    accepted.developer_trace = trace;
    Ok(accepted)
}

#[cfg(test)]
#[path = "requirement_recovery_stage31_tests.rs"]
mod stage31_tests;
