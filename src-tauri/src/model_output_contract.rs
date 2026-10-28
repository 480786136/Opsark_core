//! Render the current operation's shape from its actual business schema.
//! Examples are unexecuted format illustrations, never facts or authorization.
use serde_json::{json, Map, Value};

pub(crate) const MARKER: &str = "{{OPSARK_OUTPUT_CONTRACT}}";

fn required(schema: &Value) -> Vec<&str> {
    schema["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

fn object_branch(schema: &Value) -> &Value {
    schema["anyOf"]
        .as_array()
        .and_then(|branches| branches.iter().find(|s| s["type"] == "object"))
        .unwrap_or(schema)
}

/// Only a schema-shaped illustration. This is never used to normalize responses.
fn illustration(schema: &Value) -> Value {
    if let Some(value) = schema.get("const") {
        return value.clone();
    }
    if let Some(value) = schema["enum"].as_array().and_then(|values| values.first()) {
        return value.clone();
    }
    if let Some(branch) = schema["anyOf"]
        .as_array()
        .and_then(|branches| branches.first())
    {
        return illustration(branch);
    }
    match schema["type"].as_str() {
        Some("object") => Value::Object(
            required(schema)
                .into_iter()
                .map(|key| (key.into(), illustration(&schema["properties"][key])))
                .collect::<Map<_, _>>(),
        ),
        Some("array") => json!([]),
        Some("integer" | "number") => schema.get("minimum").cloned().unwrap_or(json!(0)),
        Some("boolean") => json!(false),
        Some("null") => Value::Null,
        _ => json!("示例"),
    }
}

fn step_example(schema: &Value) -> Value {
    let mut step = illustration(schema);
    step["kind"] = json!("observe");
    step["title"] = json!("读取运行时间");
    step["description"] = json!("只读查询当前系统的运行时间和负载");
    step["action"] = json!({"type":"shell","command":"uptime"});
    step["expected"] = json!("获得运行时间和负载信息");
    step["validation"] = json!("");
    step["risk"] = json!("low");
    step
}

fn lifecycle(context: &Value) -> &Value {
    [
        "/taskGoal/lifecycle",
        "/baseSnapshot/taskRequirements/lifecycle",
        "/task/requirementLifecycle",
    ]
    .into_iter()
    .filter_map(|path| context.pointer(path))
    .find(|value| value["revision"].as_u64().is_some_and(|n| n > 0))
    .unwrap_or(&Value::Null)
}

pub(crate) fn examples(schema: &Value, context: &Value) -> Vec<Value> {
    let properties = &schema["properties"];
    let mut example = illustration(schema);
    if properties.get("intent").is_some() {
        example = json!({"intent":"execute","relation":"new_goal","answer":"",
            "constraints":{"changePolicy":"read_only","environmentPolicy":"unspecified","failurePolicy":"unspecified",
                "prohibitedActions":[],"requiredConditions":[],"userDirectives":[]},
            "terminalContextLines":0,"selectedSkillIds":[]});
        if context["requirementSubmission"].is_object() {
            let rule = object_branch(&properties["requirementUpdate"]);
            let mut update = illustration(rule);
            update["baseRevision"] = context["requirementSubmission"]["baseRevision"]
                .as_u64()
                .unwrap_or(0)
                .into();
            update["sourceMessageId"] = context["requirementSubmission"]["sourceMessageId"]
                .as_str()
                .unwrap_or("示例消息ID")
                .into();
            update["additions"] = json!([{"id":"示例目标ID","kind":"goal","content":"读取运行时间",
                "sourceQuote":"读取运行时间","supersedes":[]}]);
            update["focusIds"] = json!(["示例目标ID"]);
            if required(rule).contains(&"acceptanceCoverage") {
                update["acceptanceCoverage"] = json!([{"requirementId":"示例目标ID","strategy":"general_review",
                    "sourceQuote":"读取运行时间","reason":"依据当前运行时间输出验收示例目标"}]);
            }
            example["requirementUpdate"] = update;
        }
    }
    if let Some(step) = properties.pointer("/steps/items") {
        example["steps"] = json!([step_example(step)]);
    }
    if let Some(step) = properties.pointer("/repair/properties/replacementSteps/items") {
        example["repair"]["stepIndex"] = json!(1);
        example["repair"]["replacementSteps"] = json!([step_example(step)]);
    }
    if properties.get("decision").is_some() {
        example["decision"] = context
            .pointer("/formatRepair/requiredDecision")
            .filter(|v| v.is_string())
            .cloned()
            .unwrap_or(json!("continue"));
        example["reason"] = json!("尚需获取运行时间证据");
        example["summary"] = json!("查询运行时间后再验收目标");
    }
    if required(schema).contains(&"requirementReview") {
        let review = &mut example["requirementReview"];
        review["baseRevision"] = lifecycle(context)["revision"].as_u64().unwrap_or(0).into();
        review["roundId"] = lifecycle(context)
            .pointer("/focus/roundId")
            .and_then(Value::as_str)
            .or_else(|| {
                context
                    .pointer("/taskGoal/currentRoundId")
                    .and_then(Value::as_str)
            })
            .or_else(|| lifecycle(context)["roundId"].as_str())
            .unwrap_or("示例轮次ID")
            .into();
        review["focusOutcome"] = json!("pending");
        review["overallOutcome"] = json!("pending");
        if let Some(ids) = lifecycle(context)
            .pointer("/focus/requirementIds")
            .and_then(Value::as_array)
        {
            review["items"] = Value::Array(ids.iter().filter(|id| id.is_string()).take(2).map(|id| json!({
                "requirementId":id,"outcome":"unknown","evidenceIds":[],"reason":"示例尚未取得所需证据，不声明完成"
            })).collect());
        }
    }
    let mut examples = vec![example.clone()];
    if properties.get("intent").is_some() {
        for (intent, relation, answer, lines) in [
            (
                "answer",
                json!("side_question"),
                "uptime 用于读取系统运行时间和负载。",
                0,
            ),
            ("terminal_context", Value::Null, "", 80),
        ] {
            let mut branch = example.clone();
            branch["intent"] = json!(intent);
            branch["relation"] = relation;
            branch["answer"] = json!(answer);
            branch["terminalContextLines"] = json!(lines);
            branch["constraints"] = Value::Null;
            branch.as_object_mut().unwrap().remove("requirementUpdate");
            if properties.get("steps").is_some() {
                branch["steps"] = json!([]);
            }
            examples.push(branch);
        }
    }
    examples
}

pub(crate) fn render(schema: &Value, context: &Value) -> String {
    let required_fields = required(schema);
    let optional: Vec<_> = schema["properties"]
        .as_object()
        .into_iter()
        .flat_map(|p| p.keys())
        .filter(|key| !required_fields.contains(&key.as_str()))
        .map(String::as_str)
        .collect();
    let mut text = format!("当前操作的输出契约由实际校验 Schema 生成：只返回 JSON 对象，顶层必填字段为 {}；可选字段为 {}。其他字段禁止。\n",
        required_fields.join("、"), optional.join("、"));
    if let Some(step) = schema
        .pointer("/properties/steps/items")
        .or_else(|| schema.pointer("/properties/repair/properties/replacementSteps/items"))
    {
        text.push_str(&format!("每个步骤对象必填字段为 {}。expected、validation、risk 以及声明时的 evidenceRequirements 都属于步骤层，禁止放进 action。\n", required(step).join("、")));
        let optional: Vec<_> = step["properties"]
            .as_object()
            .into_iter()
            .flat_map(|properties| properties.keys())
            .filter(|key| !required(step).contains(&key.as_str()))
            .map(String::as_str)
            .collect();
        text.push_str(&format!(
            "步骤可选字段为 {}，其他字段禁止。\n",
            optional.join("、")
        ));
        text.push_str(&format!("kind 只能为 {}，risk 只能为 {}；title、description、expected 与 Shell 命令非空，validation 为字符串。\n",
            step["properties"]["kind"]["enum"], step["properties"]["risk"]["enum"]));
        if step["properties"].get("evidenceRequirements").is_some() {
            text.push_str("每个步骤显式提供 evidenceRequirements 数组：需要文件正文时填 [\"file_content\"]，并选择 providedEvidence 支持该类型的工具；Shell 和其他步骤填 []。空数组不能撤销真实正文需求，也不构成执行或验收证据。\n");
        }
    }
    if context["requirementSubmission"].is_object() && schema["properties"].get("intent").is_some()
    {
        text.push_str(&format!("execute 分支必须提供 requirementUpdate；该对象必填字段为 {}。baseRevision/sourceMessageId 使用当前提交原值，focusIds 包含所有本轮新增 goal 和 constraint 的 ID。\n",
            required(object_branch(&schema["properties"]["requirementUpdate"])).join("、")));
    }
    text.push_str("以下完整示例仅演示本轮字段、类型与层级；示例目标、ID、动作、授权和证据均不可照抄，实际决策必须来自当前用户需求与真实上下文：\n");
    for example in examples(schema, context) {
        text.push_str(&format!("{example}\n"));
    }
    text
}

/// Replace all format anchors before wire conversion. Business/safety rules stay intact.
pub(crate) fn apply(body: &mut Value, schema: &Value, context: &Value) {
    let contract = render(schema, context);
    let Some(messages) = body["messages"].as_array_mut() else {
        return;
    };
    let mut replaced = false;
    for message in messages.iter_mut().filter(|m| m["role"] == "system") {
        if let Some(text) = message["content"].as_str().filter(|s| s.contains(MARKER)) {
            message["content"] = json!(text.replace(MARKER, &contract));
            replaced = true;
        }
    }
    if !replaced && schema.pointer("/properties/steps").is_some() {
        messages.insert(0, json!({"role":"system","content":contract}));
    }
}
