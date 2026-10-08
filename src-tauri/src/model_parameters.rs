use serde_json::{json, Value};

pub(crate) fn apply(body: &mut Value, parameters: &Value) -> Result<(), String> {
    if parameters.is_null() { return Ok(()); }
    let values = parameters.as_object().ok_or("Invalid model parameters")?;
    for (key, value) in values {
        let bounds = match key.as_str() {
            "temperature" => Some((0.0, 2.0)), "top_p" => Some((0.0, 1.0)),
            "frequency_penalty" | "presence_penalty" => Some((-2.0, 2.0)),
            "max_tokens" | "max_completion_tokens" | "max_output_tokens" | "outputBudget" => Some((1.0, 1_000_000.0)),
            _ => None,
        };
        if let Some((min, max)) = bounds {
            let number = value.as_f64().ok_or_else(|| format!("Invalid {key}"))?;
            if !number.is_finite() || number < min || number > max || ((key.contains("tokens") || key == "outputBudget") && number.fract() != 0.0) {
                return Err(format!("{key}: expected {min}..{max}"));
            }
            body[key] = if key.contains("tokens") || key == "outputBudget" {json!(number as u64)} else {value.clone()};
        } else if key == "reasoning_effort" && value.as_str().is_some_and(|v| !v.is_empty() && v.len() <= 32 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')) {
            body[key] = value.clone();
        } else if key == "thinking" && matches!(value.as_str(), Some("default" | "enabled" | "disabled")) {
            if value == "default" { body.as_object_mut().unwrap().remove("thinking"); }
            else { body[key] = json!({"type":value}); }
        } else { return Err(format!("Unsupported model parameter: {key}")); }
    }
    if ["max_tokens", "max_completion_tokens", "max_output_tokens", "outputBudget"].iter().filter(|key| values.contains_key(**key)).count() > 1 { return Err("Choose one output token parameter".into()); }
    for semantic in ["outputBudget", "max_output_tokens"] {
        if let Some(value) = body.as_object_mut().unwrap().remove(semantic) { body.as_object_mut().unwrap().remove("max_completion_tokens"); body["max_tokens"] = value; }
    }
    if values.contains_key("max_completion_tokens") { body.as_object_mut().unwrap().remove("max_tokens"); }
    Ok(())
}

pub(crate) fn prepare(body: &Value) -> Result<Value, String> {
    let mut body = body.clone();
    if let Some(raw) = body["_opsarkContext"].as_str().map(str::to_owned) {
        if let Ok(mut context) = serde_json::from_str::<Value>(&raw) {
            // Recovery identity/limits belong to Core, never to the provider or prompt.
            let recovery = context.as_object_mut().and_then(|value| value.remove("_modelRecovery"));
            if let Some(object) = context.as_object_mut() { object.remove("_modelOutputRecovery"); }
            if let Some(parameters) = context.as_object_mut().and_then(|value| value.remove("_requestParameters")) {
                apply(&mut body, &parameters)?;
            }
            if recovery.is_some() || context.to_string() != raw {
                let clean = context.to_string();
                if let Some(messages) = body["messages"].as_array_mut() {
                    for message in messages {
                        if let Some(content) = message["content"].as_str() {
                            message["content"] = json!(content.replace(&raw, &clean));
                        }
                    }
                }
                body["_opsarkContext"] = json!(clean);
            }
        }
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overrides_without_changing_protocol() {
        let mut body = json!({"max_tokens":700,"thinking":{"type":"disabled"},"response_format":{"type":"json_object"}});
        apply(&mut body, &json!({"temperature":0,"max_completion_tokens":2000,"thinking":"default"})).unwrap();
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("thinking").is_none());
        assert_eq!(body["temperature"],0);
        assert_eq!(body["response_format"]["type"],"json_object");
    }
    #[test]
    fn integral_float_budget_preserves_the_explicit_integer_amount() {
        let mut body=json!({"max_tokens":5000});
        apply(&mut body,&json!({"outputBudget":1000.0})).unwrap();
        assert_eq!(body["max_tokens"].as_u64(),Some(1000));
        assert_eq!(body.to_string(),"{\"max_tokens\":1000}");
    }
    #[test]
    fn rejects_invalid_and_protected_fields() {
        for params in [json!({"temperature":3}),json!({"model":"other"}),json!({"max_tokens":1.5}),json!({"max_tokens":2,"max_completion_tokens":3})] {
            assert!(apply(&mut json!({}), &params).is_err());
        }
    }
    #[test]
    fn removes_parameters_from_prompt() {
        let raw = json!({"_requestParameters":{"top_p":0.8},"evidence":"keep"}).to_string();
        let result = prepare(&json!({"_opsarkContext":raw,"messages":[{"role":"user","content":raw}]})).unwrap();
        assert_eq!(result["top_p"],0.8);
        assert!(!result.to_string().contains("_requestParameters"));
        assert!(result.to_string().contains("keep"));
    }
    #[test]
    fn removes_recovery_metadata_without_losing_business_context() {
        let raw = json!({"_modelRecovery":{"operationId":"private-budget-id","maxGenerations":2},
            "_modelOutputRecovery":{"strategy":"regenerate"},"evidence":"keep"}).to_string();
        let result = prepare(&json!({"max_tokens":500,"_opsarkContext":raw,
            "messages":[{"role":"user","content":format!("服务器上下文：\n{raw}")}]})).unwrap();
        assert!(!result.to_string().contains("_modelRecovery"));
        assert!(!result.to_string().contains("_modelOutputRecovery"));
        assert!(!result.to_string().contains("private-budget-id"));
        assert!(result.to_string().contains("keep"));
        assert_eq!(result["max_tokens"],500);
    }
}
