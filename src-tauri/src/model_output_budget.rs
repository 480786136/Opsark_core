//! Core-owned ceiling adaptation. It never changes response schemas, prompts,
//! execution authority, explicit output overrides, or persistent total budgets.
use serde_json::{json, Value};

/// Format policy (auto/require_schema/json_only) is deliberately unrelated.
/// Only known business builders without an explicit user output override opt in.
pub(crate) fn policy(context: &Value, original: &Value, prepared: &Value, request_name: &str) -> Option<Value> {
    if ["outputBudget", "max_tokens", "max_completion_tokens", "max_output_tokens"].into_iter()
        .any(|field| context["_requestParameters"].get(field).is_some()) { return None; }
    let original_output_fields = ["max_tokens", "max_completion_tokens", "max_output_tokens"].into_iter()
        .filter(|field| original.get(*field).is_some()).count();
    if original_output_fields > 1 || (original_output_fields > 0
        && matches!(request_name,"计划生成"|"阶段联合决策"|"阶段格式修复（兼容模式）")) {
        // These builders only place an output field in the original body when
        // AiGenerationSettings explicitly selects it. Automatic mode omits it
        // and the compatibility compiler supplies a bounded per-request default.
        return None;
    }
    let core_floor = match request_name {
        "需求理解" => 1536,
        "计划生成" | "阶段联合决策" | "阶段格式修复（兼容模式）" => 4096,
        "模型总结" | "结果复核" => 2048,
        _ => return None,
    };
    let declared_default = prepared.pointer("/_opsarkProtocolConfig/capabilitiesV2/defaultOutputTokens")
        .or_else(|| context.pointer("/_modelCapabilities/defaultOutputTokens"))
        .and_then(Value::as_u64).unwrap_or(0);
    Some(json!({"version":1,"coreMinimumOutputTokens":core_floor,
        "declaredDefaultOutputTokens":declared_default,"source":"core_business_builder_without_explicit_output_override"}))
}

pub(crate) fn minimum(policy: &Value, wire: &Value) -> Option<u64> {
    if policy["version"] != 1 || policy["source"] != "core_business_builder_without_explicit_output_override" { return None; }
    let original = ["max_tokens", "max_completion_tokens", "max_output_tokens"].into_iter()
        .filter_map(|field| wire.get(field)).map(Value::as_u64).collect::<Option<Vec<_>>>()?;
    if original.len() != 1 { return None; }
    let floor = policy["coreMinimumOutputTokens"].as_u64().filter(|n| matches!(*n,1536|2048|4096))?;
    Some(floor.max(policy["declaredDefaultOutputTokens"].as_u64()?.min(original[0])))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_known_core_builders_without_explicit_output_override_are_adaptable() {
        for name in ["需求理解","计划生成","阶段联合决策","模型总结","结果复核"] {
            assert!(policy(&json!({}),&json!({}),&json!({}),name).is_some());
            for key in ["outputBudget","max_tokens","max_completion_tokens","max_output_tokens"] {
                assert!(policy(&json!({"_requestParameters":{key:16384}}),&json!({}),&json!({}),name).is_none());
            }
            assert!(policy(&json!({}),&json!({"max_tokens":16384,"max_completion_tokens":16384}),&json!({}),name).is_none());
        }
        for name in ["unknown","模型参数测试","模型结构测试","模型业务测试"] {
            assert!(policy(&json!({}),&json!({}),&json!({}),name).is_none());
        }
        for name in ["计划生成","阶段联合决策","阶段格式修复（兼容模式）"] {
            assert!(policy(&json!({}),&json!({"max_tokens":16384}),&json!({}),name).is_none());
        }
    }
    #[test]
    fn configured_default_is_an_engineering_floor_and_does_not_change_format_policy() {
        for format in ["auto","require_schema","json_only"] {
            let configured=json!({"_opsarkProtocolConfig":{"outputPolicy":format,"capabilitiesV2":{"defaultOutputTokens":5000}}});
            let configured_policy=policy(&json!({}),&json!({}),&configured,"阶段联合决策").unwrap();
            assert_eq!(minimum(&configured_policy,&json!({"max_output_tokens":16384})),Some(5000));
            assert_eq!(minimum(&configured_policy,&json!({"max_tokens":3000})),Some(4096));
        }
        let legacy=policy(&json!({"_modelCapabilities":{"defaultOutputTokens":5000}}),&json!({}),&json!({}),"计划生成").unwrap();
        assert_eq!(minimum(&legacy,&json!({"max_completion_tokens":16384})),Some(5000));
        assert!(minimum(&legacy,&json!({"max_tokens":16384,"max_output_tokens":16384})).is_none());
    }
}
