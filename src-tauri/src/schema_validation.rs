//! Shared Draft-07 profile. No coercion, default insertion or remote references.
use jsonschema::{Draft, Validator};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

fn compiled(schema: &Value) -> Result<Arc<Validator>, String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<Validator>>>> = OnceLock::new();
    let key = schema.to_string();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(validator) = cache.lock().map_err(|_| "契约缓存不可用")?.get(&key) {
        return Ok(Arc::clone(validator));
    }
    let validator = Arc::new(
        jsonschema::options()
            .with_draft(Draft::Draft7)
            .should_validate_formats(false)
            .build(schema)
            .map_err(|_| "无效的 Draft-07 契约")?,
    );
    let mut guard = cache.lock().map_err(|_| "契约缓存不可用")?;
    if guard.len() >= 256 {
        guard.clear();
    }
    guard.insert(key, Arc::clone(&validator));
    Ok(validator)
}

pub(crate) fn validate(schema: &Value, value: &Value) -> Result<(), String> {
    let validator = compiled(schema)?;
    validator
        .validate(value)
        .map_err(|_| "数据未满足 Draft-07 契约".into())
}

/// Compile without reading instance data. Invalid local contracts must fail
/// before the paid request, rather than being blamed on a model response.
pub(crate) fn preflight(schema: &Value) -> Result<(), String> {
    compiled(schema).map(|_| ())
}

#[derive(Debug)]
pub(crate) struct ValidationIssue {
    pub instance_path: String,
    pub schema_path: String,
    pub keyword: String,
    pub message: String,
}

fn fixed_string(schema: &Value) -> Option<&str> {
    let constant = schema.get("const").and_then(Value::as_str);
    let enumeration = schema.get("enum").and_then(Value::as_array);
    match (constant, enumeration) {
        (Some(value), None) => Some(value),
        (Some(value), Some(values)) if values.len() == 1 && values[0].as_str() == Some(value) => Some(value),
        (None, Some(values)) if values.len() == 1 => values[0].as_str(),
        _ => None,
    }
}

/// Only an explicit action discriminator can select an anyOf branch. Every
/// other branch must be excluded by that same discriminator; an untagged or
/// overlapping alternative keeps the original union diagnostic.
fn selected_action_branch(branches: &[Value], instance: &Value) -> Option<usize> {
    let action_type = instance.get("type")?.as_str()?;
    if !matches!(action_type, "shell" | "tool") {
        return None;
    }
    let tool_id = if action_type == "tool" { Some(instance.get("toolId")?.as_str()?) } else { None };
    let mut selected = None;
    for (index, branch) in branches.iter().enumerate() {
        if branch.get("type")?.as_str()? != "object" {
            return None;
        }
        let expected_type = fixed_string(&branch["properties"]["type"])?;
        if expected_type != action_type {
            continue;
        }
        let required = branch["required"].as_array()?;
        if !required.iter().any(|field| field.as_str() == Some("type")) {
            return None;
        }
        if let Some(tool_id) = tool_id {
            if fixed_string(&branch["properties"]["toolId"])? != tool_id {
                continue;
            }
            if !required.iter().any(|field| field.as_str() == Some("toolId")) {
                return None;
            }
        }
        if selected.replace(index).is_some() {
            return None;
        }
    }
    selected
}

fn issue_for_error(schema: &Value, error: &jsonschema::ValidationError<'_>, depth: usize) -> ValidationIssue {
    let schema_path = error.schema_path().to_string();
    // Reuse the validator's existing branch errors. Re-validating a detached
    // subschema could change reference resolution or the meaning of anyOf.
    if depth < 16 {
        if let jsonschema::error::ValidationErrorKind::AnyOf { context } = error.kind() {
            if let Some(branches) = schema.pointer(&schema_path).and_then(Value::as_array) {
                if let Some(index) = selected_action_branch(branches, error.instance().as_ref()) {
                    if let Some(nested) = context.get(index).and_then(|errors| errors.first()) {
                        return issue_for_error(schema, nested, depth + 1);
                    }
                }
            }
        }
    }
    let mut instance_path = error.instance_path().to_string();
    let keyword = error.kind().keyword().to_owned();
    let message = match error.kind() {
        jsonschema::error::ValidationErrorKind::Required { property } => {
            let property = property.as_str().unwrap_or("");
            instance_path.push('/');
            instance_path.push_str(&property.replace('~', "~0").replace('/', "~1"));
            format!("缺少契约要求的必填字段 {}", property.chars().take(128).collect::<String>())
        }
        jsonschema::error::ValidationErrorKind::Type { .. } => {
            format!("字段类型不符合契约，应为 {}", schema.pointer(&schema_path)
                .map(Value::to_string).unwrap_or_else(|| "规定类型".into()))
        }
        jsonschema::error::ValidationErrorKind::AdditionalProperties { unexpected } => {
            if let Some(property) = unexpected.iter().min() {
                instance_path.push('/');
                instance_path.push_str(&property.replace('~', "~0").replace('/', "~1"));
            }
            "包含契约未声明的额外字段".into()
        }
        jsonschema::error::ValidationErrorKind::Enum { .. } => {
            "字段值不在契约允许的枚举范围内".into()
        }
        _ => format!("字段未通过本地契约的 {keyword} 约束"),
    };
    ValidationIssue { instance_path, keyword, schema_path, message }
}

/// Do not stringify ValidationError: it includes the rejected instance and may
/// expose credentials or server output. Paths and a keyword suffice for repair.
pub(crate) fn diagnose(schema: &Value, value: &Value) -> Result<(), ValidationIssue> {
    let validator = compiled(schema).map_err(|_| ValidationIssue {
        instance_path: String::new(),
        schema_path: String::new(),
        keyword: "schema".into(),
        message: "本地契约无效".into(),
    })?;
    validator.validate(value).map_err(|error| issue_for_error(schema, &error, 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_tool_contracts_and_validation_cases() {
        let contracts: Value =
            serde_json::from_str(include_str!("../../contracts/tool-contracts.json")).unwrap();
        let cases: Value =
            serde_json::from_str(include_str!("../../contracts/schema-cases.json")).unwrap();
        assert_eq!(
            contracts["dialect"],
            "http://json-schema.org/draft-07/schema#"
        );
        compiled(&contracts["resultSchema"]).unwrap();
        for tool in contracts["tools"].as_array().unwrap() {
            compiled(&tool["inputSchema"]).unwrap();
            if let Some(output) = tool.get("outputSchema") {
                compiled(output).unwrap();
            }
        }
        for case in cases["cases"].as_array().unwrap() {
            let schema = if let Some(schema) = case.get("schema") {
                schema
            } else if case["contract"] == "resultSchema" {
                &contracts["resultSchema"]
            } else {
                &contracts["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|tool| tool["id"] == case["toolId"])
                    .unwrap()[case["contract"].as_str().unwrap()]
            };
            assert_eq!(
                validate(schema, &case["value"]).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                diagnose(schema, &case["value"]).is_ok(),
                case["valid"].as_bool().unwrap(),
                "diagnostic acceptance must agree: {}",
                case["name"]
            );
        }
    }

    #[test]
    fn action_diagnostics_select_only_the_matching_tool_and_never_echo_values() {
        let schema = crate::model_compatibility::action_schema(&serde_json::json!([
            {"id":"first","inputSchema":{"type":"object","properties":{"host":{"type":"string"}},"required":["host"],"additionalProperties":false}},
            {"id":"second","inputSchema":{"type":"object","properties":{"port":{"type":"integer"}},"required":["port"],"additionalProperties":false}}
        ]));
        let value = serde_json::json!({"type":"tool","toolId":"second","arguments":{"port":"sensitive-value"}});
        let original = value.clone();
        let issue = diagnose(&schema, &value).unwrap_err();
        assert_eq!(issue.instance_path, "/arguments/port");
        assert_eq!(issue.schema_path, "/anyOf/2/properties/arguments/properties/port/type");
        assert_eq!(issue.keyword, "type");
        assert!(!issue.message.contains("sensitive-value"));
        assert_eq!(value, original);
        assert!(validate(&schema, &value).is_err());
        for ambiguous in [
            serde_json::json!({"type":"tool","toolId":"missing","arguments":{"port":22}}),
            serde_json::json!({"type":"tool","arguments":{"port":22}}),
            serde_json::json!({"type":"other","command":"uptime"}),
            serde_json::json!({"command":"uptime"}),
        ] {
            let issue = diagnose(&schema, &ambiguous).unwrap_err();
            assert_eq!(issue.keyword, "anyOf");
            assert_eq!(issue.instance_path, "");
        }
    }

    #[test]
    fn untagged_or_overlapping_anyof_keeps_union_diagnostic() {
        let tagged = serde_json::json!({"type":"object","properties":{"type":{"const":"shell"},"command":{"type":"string"}},"required":["type","command"],"additionalProperties":false});
        let generic = serde_json::json!({"type":"object","properties":{"value":{"type":"integer"}},"required":["value"]});
        for branches in [
            serde_json::json!([tagged, tagged]),
            serde_json::json!([tagged, generic]),
            serde_json::json!([generic, {"type":"array"}]),
        ] {
            let schema = serde_json::json!({"anyOf":branches});
            let issue = diagnose(&schema, &serde_json::json!({"type":"shell"})).unwrap_err();
            assert_eq!(issue.keyword, "anyOf");
            assert_eq!(issue.schema_path, "/anyOf");
            assert_eq!(issue.instance_path, "");
        }
    }

    #[test]
    fn extra_action_fields_use_escaped_pointer_and_const_discriminator() {
        let schema = serde_json::json!({"anyOf":[
            {"type":"object","properties":{"type":{"const":"shell"},"command":{"type":"string"}},"required":["type","command"],"additionalProperties":false},
            {"type":"object","properties":{"type":{"const":"tool"},"toolId":{"const":"check"}},"required":["type","toolId"],"additionalProperties":false}
        ]});
        let value = serde_json::json!({"type":"shell","command":"uptime","shell/name~hint":"secret"});
        let issue = diagnose(&schema, &value).unwrap_err();
        assert_eq!(issue.instance_path, "/shell~1name~0hint");
        assert_eq!(issue.schema_path, "/anyOf/0/additionalProperties");
        assert_eq!(issue.keyword, "additionalProperties");
        assert!(!issue.message.contains("secret"));
        let missing = diagnose(&schema, &serde_json::json!({"type":"shell"})).unwrap_err();
        assert_eq!(missing.instance_path, "/command");
        assert_eq!(missing.keyword, "required");
    }
}
