use serde_json::{json, Map, Value};

/// A missing plan needs a focused proposal, not another copy of every Skill and
/// historical phase. Authority and current evidence are never inferred from the
/// rejected model prose; omitted history remains explicitly unavailable.
pub(crate) fn repair_context(raw: &str) -> Option<Value> {
    let context: Value = serde_json::from_str(raw).ok()?;
    let failure = &context["protocolReplan"];
    if failure["errorCode"] != "next_stage_response_invalid" {
        return None;
    }
    let rejected: Value =
        serde_json::from_str(failure["rejectedResponse"]["content"].as_str()?).ok()?;
    // Inspect structure rather than localized parser wording: a response may
    // be missing summary as well, which the parser reports before steps.
    if rejected.get("steps").is_some() {
        return None;
    }
    if !matches!(rejected["decision"].as_str(), Some("continue" | "adjust")) {
        return None;
    }
    let mut compact = Map::new();
    for key in [
        "_log",
        "_requestParameters",
        "taskGoal",
        "server",
        "permission",
        "executionConstraints",
        "confirmedUserInputs",
        "authentication",
        "secretVariables",
        "serverCredentialGroups",
        "tools",
        "protocolRepairBudget",
    ] {
        if let Some(value) = context.get(key) {
            compact.insert(key.into(), value.clone());
        }
    }
    let snapshot = &context["baseSnapshot"];
    if !compact.contains_key("_log") {
        if let Some(log) = snapshot.get("_log") {
            compact.insert("_log".into(), log.clone());
        }
    }
    compact.insert("currentEvidence".into(), json!({
        "currentIncident": snapshot["currentIncident"],
        "currentPlan": snapshot["currentPlan"],
        "currentToolResults": snapshot["currentToolResults"],
        "snapshotFingerprint": snapshot["snapshotFingerprint"],
        "historyOmitted": true,
        "instruction": "仅以上述真实证据及已确认输入规划；历史未展开不等于尚未执行。不得从被拒摘要推断成功，不得重复变更；证据不足时仅生成最小只读诊断或真实提问。"
    }));
    compact.insert("formatRepair".into(), json!({
        "validationError": failure["rule"], "rejectedResponse": rejected,
        "requiredDecision": rejected["decision"],
        "instruction": "上次响应缺少 steps。保留决策方向，返回完整 JSON 和至少一个真实可执行步骤；不能用空 steps 或改判 complete 消除格式错误。只修复当前最小下一步，不重新总结全部历史。"
    }));
    Some(Value::Object(compact))
}

pub(crate) fn response_format(decision: &Value) -> Value {
    let strings = ["title", "description", "command", "expected", "validation"];
    let mut properties = Map::new();
    for key in strings {
        properties.insert(key.into(), json!({"type":"string"}));
    }
    properties.insert(
        "kind".into(),
        json!({"type":"string","enum":["observe","change"]}),
    );
    properties.insert(
        "risk".into(),
        json!({"type":"string","enum":["low","medium","high"]}),
    );
    json!({"type":"json_schema", "json_schema": {"name":"next_stage_format_repair", "strict":true,
    "schema": {"type":"object", "additionalProperties":false,
        "required":["decision","reason","summary","steps"], "properties": {
            "decision":{"type":"string","enum":[decision]},
            "reason":{"type":"string"}, "summary":{"type":"string"},
            "steps":{"type":"array", "items":{"type":"object", "additionalProperties":false,
                "required":["kind","title","description","command","expected","validation","risk"],
                "properties": properties}}
        }}}})
}

/// Only explicit capability refusal permits format downgrade. Auth, billing,
/// timeouts, malformed schemas and generic 400s must retain their real meaning.
pub(crate) fn schema_unsupported(error: &str) -> bool {
    let Some(raw) = error.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    let status = value["modelError"]["httpStatus"].as_u64();
    let message = value["modelError"]["message"]
        .as_str()
        .unwrap_or("")
        .to_lowercase();
    matches!(status, Some(400 | 422))
        && (message.contains("json_schema") || message.contains("response_format"))
        && ["not supported", "unsupported", "does not support", "不支持"]
            .iter()
            .any(|word| message.contains(word))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn focuses_repair_without_dropping_authority_or_current_evidence() {
        let raw = json!({"protocolReplan":{"errorCode":"next_stage_response_invalid", "rule":"missing field `steps`",
            "rejectedResponse":{"content":"{\"decision\":\"continue\",\"reason\":\"need evidence\",\"summary\":\"unfinished\"}"}},
            "tools":[{"id":"files.get_structure"}],"executionConstraints":{"changePolicy":"readonly"},
            "confirmedUserInputs":{"items":[{"value":"no overwrite"}]},"activeSkills":["long skill"],
            "baseSnapshot":{"currentIncident":{"result":{"exitCode":1}},"historyCheckpoint":"history".repeat(10000)}});
        let repair = repair_context(&raw.to_string()).unwrap();
        assert_eq!(repair["executionConstraints"], raw["executionConstraints"]);
        assert_eq!(repair["confirmedUserInputs"], raw["confirmedUserInputs"]);
        assert_eq!(repair["tools"], raw["tools"]);
        assert_eq!(
            repair["currentEvidence"]["currentIncident"]["result"]["exitCode"],
            1
        );
        assert!(repair.get("activeSkills").is_none());
        assert!(repair.get("baseSnapshot").is_none());
        assert!(repair.to_string().len() < raw.to_string().len() / 4);
        assert_eq!(
            response_format(&json!("continue"))["json_schema"]["schema"]["required"],
            json!(["decision", "reason", "summary", "steps"])
        );
        assert!(repair_context("{}").is_none());
    }
    #[test]
    fn downgrade_requires_explicit_schema_capability_error() {
        for (status, message, expected) in [
            (400, "json_schema not supported", true),
            (422, "response_format unsupported", true),
            (400, "invalid schema", false),
            (401, "json_schema not supported", false),
            (429, "json_schema not supported", false),
            (500, "json_schema not supported", false),
        ] {
            let error = format!(
                "{}{}",
                crate::MODEL_TRACE_ERROR_PREFIX,
                json!({"modelError":{"httpStatus":status,"message":message}})
            );
            assert_eq!(schema_unsupported(&error), expected);
        }
    }
}
