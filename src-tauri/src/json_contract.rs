use serde::de::DeserializeOwned;
use serde_json::Value;

fn clean_json_content(content: &str) -> &str {
    let trimmed = content.trim();
    let without_open = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed);
    without_open
        .strip_suffix("```")
        .unwrap_or(without_open)
        .trim()
}

fn repair_invalid_json_escapes(content: &str) -> String {
    let chars: Vec<char> = content.chars().collect();
    let mut repaired = String::with_capacity(content.len());
    let mut in_string = false;
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        if !in_string {
            repaired.push(current);
            if current == '"' {
                in_string = true;
            }
            index += 1;
            continue;
        }
        if current == '"' {
            repaired.push(current);
            in_string = false;
            index += 1;
            continue;
        }
        if current == '\\' {
            let next = chars.get(index + 1).copied();
            if next.is_some_and(|value| {
                matches!(value, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u')
            }) {
                repaired.push(current);
            } else {
                // Model output often contains valid shell escapes that are invalid JSON escapes.
                repaired.push('\\');
                repaired.push('\\');
            }
            index += 1;
            continue;
        }
        repaired.push(current);
        index += 1;
    }
    repaired
}

/// Parses model output while preserving strict JSON preference and compatibility repairs.
pub(crate) fn parse_model_json<T: DeserializeOwned>(content: &str) -> Result<T, String> {
    let cleaned = clean_json_content(content);
    let repaired = repair_invalid_json_escapes(cleaned);
    serde_json::from_str(cleaned)
        .or_else(|_| serde_json::from_str(&repaired))
        .map_err(|strict_error| strict_error.to_string())
        .or_else(|strict_error| {
            json5::from_str(cleaned)
                .or_else(|_| json5::from_str(&repaired))
                .map_err(|lenient_error| {
                    format!("标准 JSON 解析失败：{strict_error}；宽松解析也失败：{lenient_error}")
                })
        })
}

/// Accepts either a direct array or an object containing the requested array field.
pub(crate) fn parse_model_array_field<T: DeserializeOwned>(
    content: &str,
    field: &str,
) -> Result<Vec<T>, String> {
    if let Ok(items) = parse_model_json::<Vec<T>>(content) {
        return Ok(items);
    }
    let object: Value = parse_model_json(content)?;
    serde_json::from_value(object.get(field).cloned().unwrap_or(Value::Null))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct TestStep {
        command: String,
        validation: String,
    }

    #[test]
    fn strips_markdown_fences_before_parsing() {
        let value: Value = parse_model_json("```json\n{\"ok\":true}\n```").unwrap();
        assert_eq!(value["ok"], true);
    }

    #[test]
    fn repairs_unescaped_shell_backslashes_inside_strings() {
        let invalid = r#"{"steps":[{"command":"grep -E '\s+java\.jar'","validation":"grep -q '\d' /tmp/result"}]}"#;
        assert!(serde_json::from_str::<Value>(invalid).is_err());

        let steps: Vec<TestStep> = parse_model_array_field(invalid, "steps").unwrap();
        assert_eq!(steps[0].command, "grep -E '\\s+java\\.jar'");
        assert_eq!(steps[0].validation, "grep -q '\\d' /tmp/result");
    }

    #[test]
    fn parses_lenient_object_array_when_standard_json_is_unavailable() {
        let loose = r#"{steps:[{command:'pwd',validation:'true',}],}"#;
        let steps: Vec<TestStep> = parse_model_array_field(loose, "steps").unwrap();
        assert_eq!(steps[0].command, "pwd");
    }

    #[test]
    fn parses_a_direct_array_without_an_object_wrapper() {
        let steps: Vec<TestStep> =
            parse_model_array_field(r#"[{"command":"pwd","validation":"true"}]"#, "steps").unwrap();
        assert_eq!(steps.len(), 1);
    }

    #[test]
    fn reports_both_strict_and_lenient_parser_failures() {
        let error = parse_model_json::<Value>("{not valid").unwrap_err();
        assert!(error.contains("标准 JSON 解析失败"));
        assert!(error.contains("宽松解析也失败"));
    }
}
