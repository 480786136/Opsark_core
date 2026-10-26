//! Shared classification policy values. Schema, prompt and local checks have
//! one source; invalid model values never become wider execution authority.
use crate::model_compatibility::OutputDiagnostic;
use serde_json::{json, Value};
pub(crate) const CHANGE_POLICIES: &[&str] = &[
    "read_only",
    "confirm_changes",
    "requested_changes_only",
    "allow_necessary_changes",
];
pub(crate) const ENVIRONMENT_POLICIES: &[&str] = &[
    "unspecified",
    "preserve",
    "allow_isolated_changes",
    "allow_host_changes",
];
pub(crate) const FAILURE_POLICIES: &[&str] = &["unspecified", "strict", "best_effort"];
const ARRAYS: &[&str] = &["prohibitedActions", "requiredConditions", "userDirectives"];
fn policies() -> [(&'static str, &'static [&'static str]); 3] {
    [
        ("changePolicy", CHANGE_POLICIES),
        ("environmentPolicy", ENVIRONMENT_POLICIES),
        ("failurePolicy", FAILURE_POLICIES),
    ]
}
pub(crate) fn schema() -> Value {
    let mut properties = serde_json::Map::new();
    for (name, values) in policies() {
        properties.insert(name.into(), json!({"type":"string","enum":values}));
    }
    for name in ARRAYS {
        properties.insert(
            (*name).into(),
            json!({"type":"array","items":{"type":"string"}}),
        );
    }
    json!({"type":"object","required":properties.keys().cloned().collect::<Vec<_>>(),"properties":properties,"additionalProperties":false})
}
pub(crate) fn rule() -> String {
    let fields = policies()
        .iter()
        .map(|(name, values)| format!("constraints.{name}={}", json!(values)))
        .collect::<Vec<_>>()
        .join("；");
    format!("分类约束共享契约：execute必须完整提供constraints六个字段。{fields}。各策略只允许所列字符串，禁止空字符串或null；用户未明确环境或失败策略时使用合法unspecified，changePolicy不得为unspecified。三个数组只记录用户明确要求，未知时用空数组；不得推测、扩展授权或用默认值掩盖非法模型响应。answer/terminal_context的constraints必须为null。")
}
fn issue(field: &str, keyword: &str) -> OutputDiagnostic {
    let mut diagnostic = OutputDiagnostic::new(
        "MODEL_REQUIREMENT_INVALID",
        "requirement_contract",
        "模型需求响应的约束字段未通过当前契约校验；候选未执行。",
    );
    diagnostic.json_pointer = Some(if field.is_empty() {
        "/constraints".into()
    } else {
        format!("/constraints/{field}")
    });
    diagnostic.keyword = Some(keyword.into());
    diagnostic
}
pub(crate) fn invalid(value: &Value) -> Option<OutputDiagnostic> {
    let Some(object) = value.as_object() else {
        return Some(issue("", "type"));
    };
    for (name, allowed) in policies() {
        match object.get(name) {
            None => return Some(issue(name, "required")),
            Some(value) if !value.is_string() => return Some(issue(name, "type")),
            Some(value) if !allowed.contains(&value.as_str().unwrap()) => {
                return Some(issue(name, "enum"))
            }
            _ => {}
        }
    }
    for name in ARRAYS {
        match object.get(*name) {
            None => return Some(issue(name, "required")),
            Some(value)
                if !value
                    .as_array()
                    .is_some_and(|items| items.iter().all(Value::is_string)) =>
            {
                return Some(issue(name, "type"))
            }
            _ => {}
        }
    }
    if object.keys().any(|key| {
        !policies().iter().any(|(name, _)| key == name) && !ARRAYS.contains(&key.as_str())
    }) {
        return Some(issue("", "additionalProperties"));
    }
    None
}
pub(crate) fn encode(diagnostic: &OutputDiagnostic) -> String {
    crate::model_compatibility::output_error(diagnostic, None)
}
