use serde_json::{json, Value};

pub(crate) fn apply(body: &mut Value, parameters: &Value) -> Result<(), String> {
    if parameters.is_null() { return Ok(()); }
    let values = parameters.as_object().ok_or("Invalid model parameters")?;
    for (key, value) in values {
        let bounds = match key.as_str() {
            "temperature" => Some((0.0, 2.0)), "top_p" => Some((0.0, 1.0)),
            "frequency_penalty" | "presence_penalty" => Some((-2.0, 2.0)),
            "max_tokens" | "max_completion_tokens" => Some((1.0, 1_000_000.0)),
            _ => None,
        };
        if let Some((min, max)) = bounds {
            let number = value.as_f64().ok_or_else(|| format!("Invalid {key}"))?;
            if !number.is_finite() || number < min || number > max || (key.contains("tokens") && number.fract() != 0.0) {
                return Err(format!("{key}: expected {min}..{max}"));
            }
            body[key] = value.clone();
        } else if key == "reasoning_effort" && matches!(value.as_str(), Some("low" | "medium" | "high")) {
            body[key] = value.clone();
        } else if key == "thinking" && matches!(value.as_str(), Some("default" | "enabled" | "disabled")) {
            if value == "default" { body.as_object_mut().unwrap().remove("thinking"); }
            else { body[key] = json!({"type":value}); }
        } else { return Err(format!("Unsupported model parameter: {key}")); }
    }
    if values.contains_key("max_tokens") && values.contains_key("max_completion_tokens") { return Err("Choose one output token parameter".into()); }
    if values.contains_key("max_completion_tokens") { body.as_object_mut().unwrap().remove("max_tokens"); }
    Ok(())
}

pub(crate) fn prepare(body: &Value) -> Result<Value, String> {
    let mut body = body.clone();
    if let Some(raw) = body["_opsarkContext"].as_str().map(str::to_owned) {
        if let Ok(mut context) = serde_json::from_str::<Value>(&raw) {
            if let Some(parameters) = context.as_object_mut().and_then(|value| value.remove("_requestParameters")) {
                apply(&mut body, &parameters)?;
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
}
