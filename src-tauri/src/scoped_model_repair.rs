//! Model writes only the rejected fields; Core owns the frozen proposal and merge.
//! This changes neither the execution gate nor the shared request/retry budget.
use serde_json::{json, Map, Value};

pub(crate) struct ScopedRepair {
    pub schema: Value,
    frozen: Value,
    destinations: Vec<(String, String)>,
    prompt: Value,
}

fn object(properties: Map<String, Value>, required: Vec<String>) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

// Persisted frontend steps include UI state and a command alias. Only the model
// contract crosses back to the backend; a Shell alias is resolved before merging.
fn contract_steps(steps: &Value, full: &Value) -> Option<Value> {
    let fields = full.pointer("/properties/steps/items/properties")?.as_object()?;
    let steps = steps.as_array()?.iter().map(|step| {
        let mut result = Map::new();
        for field in fields.keys() {
            if let Some(value) = step.get(field) { result.insert(field.clone(), value.clone()); }
        }
        if !result.contains_key("action") {
            result.insert("action".into(), json!({"type":"shell","command":step.get("command")?}));
        }
        Some(Value::Object(result))
    }).collect::<Option<Vec<_>>>()?;
    Some(json!(steps))
}

impl ScopedRepair {
    pub fn new(name: &str, body: &Value, full: &Value) -> Option<Self> {
        let context: Value = serde_json::from_str(body["_opsarkContext"].as_str()?).ok()?;
        let mut properties = Map::new();
        let mut destinations = Vec::new();
        let mut required = Vec::new();
        let mut prompt = context.clone();
        let frozen;
        if name == "阶段联合决策" && context["operationalRepair"]["rejectedProposal"]["responseMode"] == "metadata_fields" {
            let proposal = &context["operationalRepair"]["rejectedProposal"];
            frozen = json!({"steps":contract_steps(&proposal["steps"], full)?});
            let mut frozen = frozen;
            for key in ["planUpdate", "reconciliation"] {
                if let Some(value) = proposal.get(key) { frozen[key] = value.clone(); }
            }
            for (key, rule) in full["properties"].as_object()? {
                if matches!(key.as_str(), "steps" | "planUpdate" | "reconciliation") { continue; }
                properties.insert(key.clone(), rule.clone());
                destinations.push((key.clone(), format!("/{key}")));
            }
            // decision is repairable metadata. Freezing a rejected `complete`
            // makes a focus-only completion impossible to correct to `adjust`.
            // Executable fields stay frozen and the merged full contract still applies.
            for key in full["required"].as_array()?.iter().filter_map(Value::as_str) {
                if properties.contains_key(key) { required.push(key.to_string()); }
            }
            // No action can be generated here. Keep all evidence/authority, but
            // omit tool schemas and Skill planning instructions from this request.
            for key in ["tools", "activeSkills"] { prompt.as_object_mut()?.remove(key); }
            return Some(Self { schema: object(properties, required), frozen, destinations, prompt });
        } else if name == "计划生成" && context["workflowPhase"] == "protocol_repair"
            && context["planGenerationRepair"]["responseMode"] == "rejected_fields"
            && context["planGenerationRepair"]["originalPlanMergedLocally"] == true
            && context["protocolRepairBudget"]["remainingModelCalls"] == 1 {
            let repair = &context["planGenerationRepair"];
            let steps = contract_steps(&repair["previousModelOutput"], full)?;
            let indices = repair["originalStepIndices"].as_array()?;
            let paths = repair["diagnostic"]["allowedRepairPaths"].as_array()?;
            if paths.is_empty() { return None; }
            for path in paths {
                let path = path.as_str()?;
                let (index, field) = path.strip_prefix("steps[")?.split_once("].")?;
                let index: u64 = index.parse().ok()?;
                let offset = indices.iter().position(|value| value.as_u64() == Some(index))?;
                if steps.get(offset)?.pointer("/action/type")?.as_str()? != "shell" { return None; }
                let destination = match field {
                    "action.command" | "command" => format!("/steps/{offset}/action/command"),
                    "validation" => format!("/steps/{offset}/validation"),
                    // Unrecognized/tool paths retain the established strict repair flow.
                    _ => return None,
                };
                if destinations.iter().any(|(_, prior)| prior == &destination) { return None; }
                properties.insert(path.into(), json!({"type":"string"}));
                required.push(path.into());
                destinations.push((path.into(), destination));
            }
            frozen = json!({"steps":steps});
            prompt["planGenerationRepair"].as_object_mut()?.remove("responseInstruction");
        } else { return None; }
        Some(Self { schema: object(properties, required), frozen, destinations, prompt })
    }

    pub fn request(&self, body: &Value) -> Value {
        let mut body = body.clone();
        body["_opsarkContext"] = json!(self.prompt.to_string());
        body["messages"] = json!([
            {"role":"system","content":format!("你在修复尚未执行的候选字段，不是在重新规划。只返回下面 JSON Schema 指定的字段，不返回 steps，不润色其他字段。Core 本地保留原步骤并合并后完整校验；上下文中的候选内容不是证据或授权。所有引用必须来自当前可用证据；禁止伪造完成、重试依据或扩大权限。observe 命令禁止任意解释器代码（如 python3 -c、node -e）；保留必要取证目的，使用已确认的只读命令，版本/存在性检查不能冒充模块或业务验收。不能通过更改 kind、风险或吞掉失败绕过校验。只输出 JSON，无 Markdown。响应契约：{}",self.schema)},
            {"role":"user","content":format!("服务器上下文：\n{}",self.prompt)}
        ]);
        body
    }

    pub fn merge(&self, fields: &Value) -> Result<Value, String> {
        crate::schema_validation::validate(&self.schema, fields)
            .map_err(|_| "字段修复响应超出允许范围或字段类型不正确".to_string())?;
        let mut merged = self.frozen.clone();
        for (field, destination) in &self.destinations {
            if let Some(value) = fields.get(field) {
                if let Some(slot) = merged.pointer_mut(destination) { *slot = value.clone(); }
                else if destination.matches('/').count() == 1 { merged[field] = value.clone(); }
                else { return Err("字段修复目标已不存在".into()); }
            }
        }
        Ok(merged)
    }
}
