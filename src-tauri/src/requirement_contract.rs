//! Wire schemas for scoped requirement changes and evidence-backed decisions.
use serde_json::{json, Value};
use std::collections::HashSet;

fn object(properties: Value) -> Value {
    let required: Vec<_> = properties.as_object().unwrap().keys().cloned().collect();
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn text() -> Value {
    json!({"type":"string","minLength":1})
}
fn strings() -> Value {
    json!({"type":"array","items":text()})
}
fn array(items: Value) -> Value {
    json!({"type":"array","items":items})
}
pub(crate) fn update() -> Value {
    object(json!({
        "baseRevision":{"type":"integer","minimum":0}, "sourceMessageId":text(),
        "additions":array(object(json!({"id":text(),"kind":{"type":"string","enum":["goal","constraint"]},
            "content":text(),"sourceQuote":text(),"supersedes":strings()}))),
        "changes":array(object(json!({"id":text(),"status":{"type":"string","enum":["active","deferred","cancelled"]},
            "sourceQuote":text(),"reason":text()}))), "focusIds":strings()
    }))
}
pub(crate) fn review() -> Value {
    object(
        json!({"baseRevision":{"type":"integer","minimum":0},"roundId":text(),
            "focusOutcome":{"type":"string","enum":["completed","pending"]},
            "overallOutcome":{"type":"string","enum":["completed","pending"]},
            "items":array(object(json!({"requirementId":text(),"outcome":{"type":"string","enum":["satisfied","unmet","unknown"]},
                "evidenceIds":strings(),"reason":text()})))
        }),
    )
}
/// The consumer requires a review once the trusted task has a requirement
/// revision. A legacy task with no lifecycle must keep its existing contract.
pub(crate) fn requires_review(context: &Value) -> bool {
    ["/taskGoal/lifecycle", "/baseSnapshot/taskRequirements/lifecycle", "/task/requirementLifecycle"]
        .iter()
        .filter_map(|path| context.pointer(path))
        .any(|lifecycle| lifecycle["revision"].as_u64().is_some_and(|revision| revision > 0))
}

/// Small, schema-derived contract shared by initial JSON-mode requests and repairs.
pub(crate) fn response_fields(schema: &Value) -> Value {
    let mut fields = serde_json::Map::new();
    for name in ["requirementReview", "blocking", "issueResolutions"] {
        if let Some(rule) = schema.pointer(&format!("/properties/{name}")) {
            fields.insert(name.to_owned(), rule.clone());
        }
    }
    Value::Object(fields)
}

pub(crate) fn response_field_contract(schema: &Value) -> Value {
    let properties = response_fields(schema);
    let required: Vec<_> = schema["required"].as_array().into_iter().flatten()
        .filter(|name| name.as_str().is_some_and(|name| properties.get(name).is_some()))
        .cloned().collect();
    json!({"required":required,"properties":properties})
}

pub(crate) fn blocking() -> Value {
    object(
        json!({"kind":{"type":"string","enum":["external","user_input"]},"reason":text(),"requirementIds":strings()}),
    )
}
pub(crate) fn resolutions() -> Value {
    array(object(
        json!({"issueId":text(),"evidenceIds":strings(),"reason":text()}),
    ))
}

/// Validate the user-message/version boundary before spending a planning call.
pub(crate) fn validate_update(
    intent: &str,
    relation: Option<&str>,
    update: Option<&Value>,
    context: &str,
    requirement: &str,
) -> Option<String> {
    let context: Value = serde_json::from_str(context).ok()?;
    let submission = context.get("requirementSubmission")?;
    if intent != "execute" {
        return update
            .filter(|value| !value.is_null())
            .map(|_| "旁问与终端上下文请求不能修改需求清单".into());
    }
    let Some(update) = update.filter(|value| value.is_object()) else {
        return Some(
            "缺少 requirementUpdate：必须明确本轮目标和仍有效要求，不能只返回旧分类字段".into(),
        );
    };
    if update["baseRevision"] != submission["baseRevision"]
        || update["sourceMessageId"] != submission["sourceMessageId"]
    {
        return Some("requirementUpdate 必须绑定当前需求版本和用户消息".into());
    }
    if submission["content"]
        .as_str()
        .is_some_and(|content| content != requirement)
    {
        return Some("需求输入与本地用户消息不一致，不能投影其他消息的要求".into());
    }
    let Some(additions) = update["additions"].as_array() else {
        return Some("requirementUpdate.additions 必须是数组".into());
    };
    let Some(changes) = update["changes"].as_array() else {
        return Some("requirementUpdate.changes 必须是数组".into());
    };
    let Some(focus) = update["focusIds"].as_array() else {
        return Some("requirementUpdate.focusIds 必须是数组".into());
    };
    if focus.is_empty() {
        return Some("本轮必须明确至少一个有效需求 ID".into());
    }
    if relation == Some("continue") && (!additions.is_empty() || !changes.is_empty()) {
        return Some(
            "继续请求只能更新 focus，不能新增、修改、取消或暂缓要求；有变更请使用 supplement"
                .into(),
        );
    }
    for item in additions.iter().chain(changes) {
        if !item["sourceQuote"]
            .as_str()
            .is_some_and(|quote| !quote.trim().is_empty() && requirement.contains(quote))
        {
            return Some("需求修改必须引用本次用户消息中的真实原文 sourceQuote".into());
        }
    }
    updated_lifecycle(&context, relation.unwrap_or(""), update, requirement).err()
}

fn effective(item: &Value) -> bool {
    matches!(item["status"].as_str(), Some("active" | "satisfied"))
}

fn unique_strings(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        let mut seen = HashSet::new();
        items.iter().all(|item| {
            item.as_str()
                .is_some_and(|text| !text.trim().is_empty() && seen.insert(text))
        })
    })
}

fn lifecycle_base(context: &Value, revision: u64) -> Value {
    context
        .pointer("/requirementSubmission/baseLifecycle")
        .or_else(|| context.pointer("/taskGoal/lifecycle"))
        .or_else(|| context.pointer("/baseSnapshot/taskRequirements/lifecycle"))
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(
            || json!({"version":1,"revision":revision,"items":[],"focus":{"requirementIds":[]}}),
        )
}

/// Mirrors applyTaskRequirementUpdate: classification changes obligations, never
/// completion. The private full base supplies exact historical sources locally.
fn updated_lifecycle(
    context: &Value,
    relation: &str,
    delta: &Value,
    requirement: &str,
) -> Result<Value, String> {
    crate::schema_validation::validate(&update(), delta)
        .map_err(|error| format!("requirementUpdate 结构无效：{error}"))?;
    if !matches!(
        relation,
        "new_goal" | "replace_goal" | "supplement" | "continue"
    ) {
        return Err("非执行关系不能投影需求更新".into());
    }
    let revision = delta["baseRevision"]
        .as_u64()
        .ok_or("需求版本必须是非负整数")?;
    if matches!(relation, "supplement" | "continue")
        && revision > 0
        && context
            .pointer("/requirementSubmission/baseLifecycle")
            .is_none()
        && context.pointer("/taskGoal/lifecycle").is_none()
        && context
            .pointer("/baseSnapshot/taskRequirements/lifecycle")
            .is_none()
    {
        return Err("需求完整基线缺失，不能将未知旧要求视为空清单".into());
    }
    let base = lifecycle_base(context, revision);
    if base["version"] != 1
        || base["revision"].as_u64() != Some(revision)
        || !base["items"].is_array()
    {
        return Err("需求版本已变化或本地需求清单无效，旧决策不能覆盖当前要求".into());
    }
    let related = matches!(relation, "supplement" | "continue");
    let mut items = if related {
        base["items"].as_array().unwrap().clone()
    } else {
        Vec::new()
    };
    let mut original_ids = HashSet::new();
    if !items.iter().all(|item| {
        item["id"]
            .as_str()
            .is_some_and(|id| !id.is_empty() && original_ids.insert(id.to_owned()))
            && item["content"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty())
            && matches!(item["kind"].as_str(), Some("goal" | "constraint"))
            && matches!(
                item["status"].as_str(),
                Some("active" | "satisfied" | "deferred" | "superseded" | "cancelled")
            )
            && item["source"].is_object()
            && item["evidenceIds"].is_array()
    }) {
        return Err("本地需求清单缺少完整条目，不能从历史摘要猜测恢复".into());
    }
    let additions = delta["additions"].as_array().unwrap();
    let changes = delta["changes"].as_array().unwrap();
    if relation == "continue" && (!additions.is_empty() || !changes.is_empty()) {
        return Err("继续请求只能更新 focus，不能变更要求；有变更请使用 supplement".into());
    }
    let mut added_ids = HashSet::new();
    if additions.iter().any(|item| {
        let id = item["id"].as_str().unwrap();
        id.trim().is_empty()
            || original_ids.contains(id)
            || !added_ids.insert(id.to_owned())
            || item["content"].as_str().unwrap().trim().is_empty()
    }) {
        return Err("新增需求标识重复或复用了历史需求标识".into());
    }
    for change in additions.iter().chain(changes) {
        if !change["sourceQuote"]
            .as_str()
            .is_some_and(|quote| !quote.trim().is_empty() && requirement.contains(quote))
        {
            return Err("需求修改必须引用本次用户消息中的真实原文 sourceQuote".into());
        }
    }
    let round_id = context
        .pointer("/taskGoal/currentRoundId")
        .or_else(|| context.pointer("/baseSnapshot/taskRequirements/currentRoundId"))
        .filter(|value| value.is_string())
        .cloned();
    let created_at = context
        .pointer("/requirementSubmission/createdAt")
        .filter(|value| value.is_string())
        .cloned();
    let mut source = json!({"content":requirement,"relation":if relation == "continue" {"supplement"} else {relation},
        "source":"user_message","sourceMessageId":delta["sourceMessageId"]});
    if let Some(created_at) = &created_at {
        source["createdAt"] = created_at.clone();
    }
    let replaceable: HashSet<String> = items
        .iter()
        .filter(|item| effective(item) || item["status"] == "deferred")
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect();
    let mut touched = HashSet::new();
    for addition in additions {
        if !unique_strings(&addition["supersedes"]) {
            return Err("被替代需求标识不合法".into());
        }
        for id in addition["supersedes"].as_array().unwrap() {
            let id = id.as_str().unwrap();
            if !replaceable.contains(id) {
                return Err("只能替代现有有效或暂缓需求，独立目标不能继承旧任务要求".into());
            }
            let previous = items.iter_mut().find(|item| item["id"] == id).unwrap();
            previous["status"] = json!("superseded");
            if previous.get("supersededBy").is_none() {
                previous["supersededBy"] = addition["id"].clone();
            }
            touched.insert(id.to_owned());
        }
        let mut item = json!({"id":addition["id"],"kind":addition["kind"],"content":addition["content"],
            "source":source,"status":"active","supersedes":addition["supersedes"],"evidenceIds":[]});
        if let Some(created_at) = &created_at {
            item["lastChangedAt"] = created_at.clone();
        }
        items.push(item);
    }
    for change in changes {
        let id = change["id"].as_str().unwrap();
        if !original_ids.contains(id)
            || !touched.insert(id.to_owned())
            || change["reason"].as_str().unwrap().trim().is_empty()
        {
            return Err("需求状态变更引用了不可修改的条目或缺少原因".into());
        }
        let item = items.iter_mut().find(|item| item["id"] == id).unwrap();
        if matches!(item["status"].as_str(), Some("superseded" | "cancelled")) {
            return Err("需求状态变更引用了不可修改的条目".into());
        }
        item["status"] = change["status"].clone();
        if change["status"] == "active" {
            item["evidenceIds"] = json!([]);
            item.as_object_mut().unwrap().remove("lastReview");
            item.as_object_mut().unwrap().remove("lastChangedAt");
            if let Some(created_at) = &created_at {
                item["lastChangedAt"] = created_at.clone();
            }
        }
    }
    let focus = delta["focusIds"].as_array().unwrap();
    if focus.is_empty()
        || !unique_strings(&delta["focusIds"])
        || focus.iter().any(|id| {
            !items
                .iter()
                .any(|item| item["id"] == *id && effective(item))
        })
    {
        return Err("本轮处理范围必须引用有效需求".into());
    }
    if additions.iter().any(|item| !focus.contains(&item["id"])) {
        return Err("新增要求必须纳入本轮处理范围".into());
    }
    let mut projected = json!({"version":1,"revision":revision.checked_add(1).ok_or("需求版本超出范围")?,"items":items,
        "focus":{"sourceMessageId":delta["sourceMessageId"],"requirementIds":focus}});
    if let Some(round_id) = round_id {
        projected["focus"]["roundId"] = round_id;
    }
    Ok(projected)
}

fn requirement_context(state: &Value) -> Value {
    let items = state["items"].as_array().unwrap();
    let focus_ids = state["focus"]["requirementIds"].as_array().unwrap();
    let historical: Vec<_> = items
        .iter()
        .filter(|item| {
            (!effective(item) && item["status"] != "deferred")
                || item["kind"] == "goal"
                    && item["status"] == "satisfied"
                    && !focus_ids.contains(&item["id"])
        })
        .collect();
    let history: Vec<_> = historical.iter().skip(historical.len().saturating_sub(24)).map(|item| {
        let content = item["content"].as_str().unwrap();
        let summary = if content.chars().count() > 160 { format!("{}…", content.chars().take(160).collect::<String>()) } else {content.into()};
        let mut value = json!({"id":item["id"],"kind":item["kind"],"status":item["status"],"summary":summary,"evidenceIds":item["evidenceIds"]});
        if let Some(id) = item["source"].get("sourceMessageId") { value["sourceMessageId"] = id.clone(); }
        value
    }).collect();
    json!({"revision":state["revision"],
        "focus":items.iter().filter(|item| focus_ids.contains(&item["id"]) && effective(item)).collect::<Vec<_>>(),
        "activeGoals":items.iter().filter(|item| item["kind"] == "goal" && item["status"] == "active").collect::<Vec<_>>(),
        "activeConstraints":items.iter().filter(|item| item["kind"] == "constraint" && effective(item)).collect::<Vec<_>>(),
        "deferred":items.iter().filter(|item| item["status"] == "deferred").collect::<Vec<_>>(),
        "historicalCount":historical.len(),"omittedHistoricalCount":historical.len().saturating_sub(24),"historical":history})
}

/// Mirrors mergeRequirementExecutionConstraints. Only exact retired content is
/// removed; unknown legacy paraphrases are not silently granted new authority.
fn merge_constraints(
    previous: Option<&Value>,
    classified: Option<&Value>,
    relation: &str,
    base: &Value,
    next: Option<&Value>,
) -> Option<Value> {
    let related = matches!(relation, "continue" | "supplement");
    let previous = previous.filter(|value| related && value.is_object());
    if relation == "continue" && previous.is_some() {
        return previous.cloned();
    }
    let Some(classified) = classified.filter(|value| value.is_object()) else {
        return previous.cloned();
    };
    let empty = Vec::new();
    let managed = next.is_some_and(|value| {
        value["revision"]
            .as_u64()
            .is_some_and(|revision| revision > 0)
    });
    let next_items = next
        .and_then(|value| value["items"].as_array())
        .unwrap_or(&empty);
    let effective_content: HashSet<_> = next_items
        .iter()
        .filter(|item| effective(item))
        .filter_map(|item| item["content"].as_str())
        .collect();
    let retired: HashSet<_> = base["items"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter(|item| {
            managed
                && related
                && effective(item)
                && next_items.iter().any(|candidate| {
                    candidate["id"] == item["id"]
                        && matches!(
                            candidate["status"].as_str(),
                            Some("superseded" | "cancelled" | "deferred")
                        )
                })
                && !effective_content.contains(item["content"].as_str().unwrap_or(""))
        })
        .filter_map(|item| item["content"].as_str())
        .collect();
    let mut result = classified.clone();
    for field in ["userDirectives", "prohibitedActions", "requiredConditions"] {
        let mut merged = Vec::new();
        for value in previous
            .and_then(|value| value[field].as_array())
            .unwrap_or(&empty)
            .iter()
            .chain(classified[field].as_array().unwrap_or(&empty))
        {
            if value.as_str().is_some_and(|text| !retired.contains(text)) && !merged.contains(value)
            {
                merged.push(value.clone());
            }
        }
        if managed && field == "requiredConditions" {
            for item in next_items
                .iter()
                .filter(|item| item["kind"] == "constraint" && effective(item))
            {
                if !retired.contains(item["content"].as_str().unwrap_or(""))
                    && !merged.contains(&item["content"])
                {
                    merged.push(item["content"].clone());
                }
            }
        }
        result[field] = json!(merged);
    }
    if managed {
        if let Some(previous) = previous {
            for field in ["environmentPolicy", "failurePolicy"] {
                if classified[field] == "unspecified" {
                    result[field] = previous[field].clone();
                }
            }
        }
    }
    Some(result)
}

/// This immutable source is for local projection only, never model prompt data.
pub(crate) fn strip_private_state(value: &mut Value) {
    if let Some(submission) = value
        .get_mut("requirementSubmission")
        .and_then(Value::as_object_mut)
    {
        submission.remove("baseLifecycle");
    }
    if let Some(snapshot) = value.get_mut("baseSnapshot") {
        strip_private_state(snapshot);
    }
}

/// Prepare the actual planning authority after classification. The store assigns
/// the final task/round identity after admission; this view keeps known IDs only.
pub(crate) fn project_classified_context(
    context: &str,
    relation: Option<&str>,
    delta: Option<&Value>,
    requirement: &str,
    classified_constraints: Option<&Value>,
) -> Result<String, String> {
    let mut value: Value =
        serde_json::from_str(context).map_err(|error| format!("需求投影上下文无效：{error}"))?;
    if !value.is_object() {
        return Err("需求投影上下文必须是对象".into());
    }
    let relation = relation.unwrap_or("new_goal");
    let delta = delta.filter(|value| !value.is_null());
    if let Some(error) = validate_update("execute", Some(relation), delta, context, requirement) {
        return Err(error);
    }
    let base = lifecycle_base(
        &value,
        delta
            .and_then(|item| item["baseRevision"].as_u64())
            .unwrap_or(0),
    );
    let previous_constraints = value
        .get("executionConstraints")
        .filter(|item| item.is_object())
        .or_else(|| {
            value
                .pointer("/previousExecution/executionConstraints")
                .filter(|item| item.is_object())
        })
        .cloned();
    let next = delta
        .map(|delta| updated_lifecycle(&value, relation, delta, requirement))
        .transpose()?;
    if let Some(next) = &next {
        let projected = requirement_context(next);
        let items = next["items"].as_array().unwrap();
        let focus = next["focus"]["requirementIds"].as_array().unwrap();
        let relevant: Vec<_> = items
            .iter()
            .filter(|item| {
                focus.contains(&item["id"])
                    || item["status"] == "active"
                    || item["status"] == "deferred"
                    || item["kind"] == "constraint" && effective(item)
            })
            .cloned()
            .collect();
        let mut sources: Vec<Value> = Vec::new();
        for item in &relevant {
            let source = &item["source"];
            if !sources.iter().any(|current| {
                if source["sourceMessageId"].is_string() {
                    current["sourceMessageId"] == source["sourceMessageId"]
                } else {
                    current["content"] == source["content"]
                        && current["relation"] == source["relation"]
                }
            }) {
                sources.push(source.clone());
            }
        }
        if !value["taskGoal"].is_object() {
            value["taskGoal"] = value
                .pointer("/baseSnapshot/taskRequirements")
                .filter(|item| item.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
        }
        let goal = value["taskGoal"].as_object_mut().unwrap();
        goal.insert("version".into(), json!(1));
        if matches!(relation, "new_goal" | "replace_goal")
            || !goal
                .get("rootGoal")
                .is_some_and(|item| item.as_str().is_some_and(|text| !text.trim().is_empty()))
        {
            goal.insert("rootGoal".into(), json!(requirement));
        }
        if relation != "continue"
            || !goal
                .get("currentInstruction")
                .is_some_and(|item| item.as_str().is_some_and(|text| !text.trim().is_empty()))
        {
            goal.insert(
                "currentInstruction".into(),
                json!(if relation == "continue" {
                    goal["rootGoal"].as_str().unwrap_or(requirement)
                } else {
                    requirement
                }),
            );
        }
        goal.insert("relation".into(), json!(relation));
        goal.insert("requirements".into(), json!(sources));
        let mut visible_state = next.clone();
        visible_state["items"] = json!(relevant);
        goal.insert("lifecycle".into(), visible_state);
        goal.insert("requirementContext".into(), projected);
        let goal = value["taskGoal"].clone();
        if let Some(snapshot) = value.get_mut("baseSnapshot").and_then(Value::as_object_mut) {
            snapshot.insert("taskRequirements".into(), goal.clone());
            if snapshot.contains_key("taskGoal") {
                snapshot.insert("taskGoal".into(), goal);
            }
        }
        value["requirementUpdate"] = delta.unwrap().clone();
        value["requirementUpdateInstruction"] = json!("当前 taskGoal.lifecycle/requirementContext 已按本次用户原文更新；按 focus 和仍有效目标/约束规划，历史仅作参考。当前 roundId 是分类时已知身份，执行前由 Core 绑定真实轮次，不得自行构造。更新仍须前端按版本复核，不扩大授权。");
    }
    if let Some(constraints) = merge_constraints(
        previous_constraints.as_ref(),
        classified_constraints,
        relation,
        &base,
        next.as_ref(),
    ) {
        value["executionConstraints"] = constraints;
    }
    strip_private_state(&mut value);
    serde_json::to_string(&value).map_err(|error| format!("需求投影序列化失败：{error}"))
}

pub(crate) const UPDATE_RULE: &str = "需求版本协议：context.requirementSubmission 存在且 intent=execute 时必须提供 requirementUpdate，baseRevision/sourceMessageId 使用上下文原值。additions 每项包含新 id、kind=goal|constraint、content、当前用户原文中的 sourceQuote、supersedes（被明确替代的旧 ID 数组）；changes 每项包含旧 id、status=active|deferred|cancelled、sourceQuote、reason；focusIds 是本轮直接处理的目标 ID。未变的旧项不必重传，不能通过遗漏取消要求，也不能把已完成目标重新当作待办。只在用户明确修改时替代/取消/暂缓，改端口不等于替换部署目标；只内网、禁止删除等有效约束必须保留。新目标拆分 goal 与 constraint，分类阶段不能声称满足目标。continue 只能选择已有有效 focus，additions 和 changes 必须为空；任何修改、取消、暂缓或恢复旧要求均分类 supplement，不得把‘继续’新增为目标。旁问/终端上下文请求不更新要求。独立新目标或整体替换的更新只包含新输入的条目，不继承旧目标。constraints 的三个文本数组尽可能使用对应有效需求条目的 content 原文，便于精确替代；不要把已被替代的旧端口或旧条件再次写入当前约束。";
pub(crate) const REVIEW_RULE: &str = "阶段验收协议：taskGoal.lifecycle.revision>0 时，按最新 focus、仍有效 goals/constraints 和真实证据输出 requirementReview={baseRevision,roundId,focusOutcome:completed|pending,overallOutcome:completed|pending,items:[{requirementId,outcome:satisfied|unmet|unknown,evidenceIds,reason}]}。focusOutcome 与 overallOutcome 只允许 completed|pending，unmet|unknown 仅用于 items[].outcome；未取得证据时 focusOutcome=pending。已完成历史只是参考，约束继续生效；未完成目标不得悄悄丢弃。focusOutcome=completed 表示本轮追加已完成，overallOutcome=pending 表示仍有其他有效目标未完成，此时可 adjust+steps=[]，summary交付本轮结果并明确未完事项，不重复旧步骤。只有 overallOutcome=completed 才能 decision=complete。对 satisfied 引用真实、适用目标与时效的证据，不把原验收被拦截覆盖后续成功查询，也不把旧成功当现在成功。独立只读验收本身就是证据，无需再为只读查询套一层独立验收。后续相关证据已解决历史问题时提供 issueResolutions=[{issueId,evidenceIds,reason}]，引用上下文真实 issueId，解释如何解决，保留原失败历史。空 adjust 在本轮尚未完成时必须附 blocking={kind:external|user_input,reason,requirementIds}；user_input 必须复用真实待答表单，否则生成唯一 user.request_input 步骤，不能只写‘等待用户’而没有问题。用户已明确的端口和方案不要重复确认。重复查询必须说明此前证据为何不足、失效或用户明确要求刷新；没有新缺口不得机械复查。";
