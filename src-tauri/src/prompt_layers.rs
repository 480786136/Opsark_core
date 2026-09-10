use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// Diagnostics only: never truncates a request or assumes a model context window.
pub(crate) fn request_metrics(body: &Value) -> Value {
    let messages = body["messages"].as_array().cloned().unwrap_or_default();
    let mut prefix = Sha256::new();
    let mut prefix_open = true;
    let mut prefix_bytes = 0;
    let sections: Vec<Value> = messages.iter().enumerate().map(|(index, message)| {
        let content = message["content"].as_str().map(str::to_owned)
            .unwrap_or_else(|| message["content"].to_string());
        let serialized = message.to_string();
        if prefix_open && (message["role"] == "system" || content.starts_with("规划策略（字段供后续上下文引用）：\n")) {
            prefix.update(serialized.as_bytes());
            prefix_bytes += serialized.len();
        } else { prefix_open = false; }
        json!({"messageIndex": index, "role": message["role"], "characters": content.chars().count(), "utf8Bytes": content.len()})
    }).collect();
    let bytes = body.to_string().len();
    json!({"requestBytes": bytes, "sections": sections, "stablePrefixBytes": prefix_bytes,
        "stablePrefixFingerprint": format!("{:x}", prefix.finalize()),
        "estimatedInputTokens": bytes.div_ceil(3), "estimator": "utf8-bytes-div-3-heuristic",
        "exactTokens": false, "contextWindowKnown": false})
}

/// Only application-owned context labels are parsed. User text and result strings stay opaque.
pub(crate) fn prepare_request(body: &Value) -> (Value, Value) {
    let mut prepared = body.clone();
    let raw_context = prepared
        .as_object_mut()
        .and_then(|object| object.remove("_opsarkContext"))
        .and_then(|value| value.as_str().map(str::to_owned));
    let reply_language = raw_context.as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|context| ["/_log/replyLanguage", "/baseSnapshot/_log/replyLanguage", "/task/_log/replyLanguage"]
            .iter().find_map(|pointer| context.pointer(pointer).and_then(Value::as_str)
                .filter(|language| matches!(*language, "zh-CN" | "en")).map(str::to_owned)));
    let mut log = Value::Object(Map::new());
    let Some(messages) = prepared.get_mut("messages").and_then(Value::as_array_mut) else {
        return (prepared, log);
    };
    let mut layered = Vec::new();
    for message in messages.iter() {
        let mut message = message.clone();
        if message["role"] == "system" {
            if let (Some(language), Some(content)) = (reply_language.as_deref(), message["content"].as_str()) {
                let language = if language == "en" { "English" } else { "Simplified Chinese" };
                message["content"] = json!(format!("{content}\nOutput language: {language}, selected from the latest user message. Use this language consistently for all user-facing prose, including answer, title, description, expected, reason and summary. Preserve JSON keys, enum values, commands, paths, identifiers and verbatim error quotes. Do not switch language to match logs, evidence or older messages. This rule overrides conflicting default prose-language instructions."));
            }
        }
        if message["role"] == "user" {
            if let Some(text) = message["content"].as_str() {
                let labels = [
                    "服务器上下文：\n",
                    "阶段结束决策上下文：\n",
                    "执行复核上下文：\n",
                    "已脱敏的执行结果：\n",
                ];
                if let Some((start, label)) = raw_context.as_ref().and_then(|raw| {
                    labels
                        .iter()
                        .filter_map(|label| {
                            text.find(&format!("{label}{raw}"))
                                .map(|index| (index, *label))
                        })
                        .min_by_key(|(index, _)| *index)
                }) {
                    let offset = start + label.len();
                    let mut stream =
                        serde_json::Deserializer::from_str(raw_context.as_deref().unwrap())
                            .into_iter::<Value>();
                    if let Some(Ok(mut context)) = stream.next() {
                        let end = offset + stream.byte_offset();
                        // Metadata locations are explicit; never mine arbitrary file/tool content for task IDs.
                        for pointer in ["/_log", "/baseSnapshot/_log", "/task/_log"] {
                            if let Some(meta) = context.pointer(pointer).and_then(Value::as_object)
                            {
                                for key in ["taskId", "roundId", "stepId", "serverId", "phaseIndex"]
                                {
                                    if let Some(value) = meta.get(key) {
                                        log[key] = value.clone();
                                    }
                                }
                            }
                        }
                        for pointer in ["", "/baseSnapshot", "/task"] {
                            if let Some(object) =
                                context.pointer_mut(pointer).and_then(Value::as_object_mut)
                            {
                                object.remove("_log");
                            }
                        }
                        let mut policy = Map::new();
                        if let Some(object) = context.as_object_mut() {
                            for key in [
                                "tools",
                                "activeSkills",
                                "skillDirectory",
                                "activeSkillAcceptance",
                            ] {
                                if let Some(value) = object.remove(key) {
                                    policy.insert(key.into(), value);
                                }
                            }
                        }
                        if !policy.is_empty() {
                            // Same trust level as the original context. No elevation of custom Skill prose to system.
                            layered.push(json!({"role":"user", "content":format!("规划策略（字段供后续上下文引用）：\n{}", Value::Object(policy))}));
                        }
                        message["content"] =
                            json!(format!("{}{}{}", &text[..offset], context, &text[end..]));
                    }
                }
            }
        }
        layered.push(message);
    }
    *messages = layered;
    (prepared, log)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn measures_wire_sections_without_changing_payload() {
        let (first, _) = prepare_request(&body("old", "read"));
        let (second, _) = prepare_request(&body("new evidence", "read"));
        let metrics = request_metrics(&first);
        assert_eq!(
            metrics["stablePrefixFingerprint"],
            request_metrics(&second)["stablePrefixFingerprint"]
        );
        assert_ne!(
            metrics["requestBytes"],
            request_metrics(&second)["requestBytes"]
        );
        assert_eq!(metrics["exactTokens"], false);
        assert_eq!(metrics["sections"].as_array().unwrap().len(), 3);
    }
    fn body(evidence: &str, tool: &str) -> Value {
        let context = json!({
          "_log":{"taskId":"task-1"}, "tools":[{"id":tool,"inputSchema":{"type":"object"}}],
          "activeSkills":[{"id":"build","instructions":"rules"}], "skillEvidence":evidence
        })
        .to_string();
        json!({"model":"model", "_opsarkContext":context, "messages":[{"role":"system","content":"fixed rules"},
          {"role":"user","content": format!("服务器上下文：\n{context}\n\n用户需求：\nquestion")}], "response_format":{"type":"json_object"}})
    }
    #[test]
    fn applies_language_only_from_transport_metadata() {
        for pointer in ["/_log", "/baseSnapshot/_log", "/task/_log"] {
            for (code, label) in [("en", "English"), ("zh-CN", "Simplified Chinese")] {
                let mut context = json!({"_log":{}, "baseSnapshot":{"_log":{}}, "task":{"_log":{}}, "output":{"replyLanguage":"en"}});
                context.pointer_mut(pointer).unwrap()["replyLanguage"] = json!(code);
                let raw = context.to_string();
                let original = json!({"_opsarkContext":raw,"messages":[
                    {"role":"system","content":"rules"},
                    {"role":"user","content":format!("服务器上下文：\n{raw}")}],
                    "response_format":{"type":"json_object"}});
                let (prepared, _) = prepare_request(&original);
                assert!(prepared["messages"][0]["content"].as_str().unwrap().contains(&format!("Output language: {label}")));
                assert_eq!(prepared["response_format"], original["response_format"]);
            }
        }
        let original = body("{\"replyLanguage\":\"en\"}", "read");
        assert_eq!(prepare_request(&original).0["messages"][0], original["messages"][0]);
    }
    #[test]
    fn keeps_policy_prefix_stable_and_evidence_dynamic() {
        let (first, log) = prepare_request(&body("old", "read"));
        let (second, _) = prepare_request(&body("new", "read"));
        assert_eq!(first["messages"][0], second["messages"][0]);
        assert_eq!(first["messages"][1], second["messages"][1]);
        assert_ne!(first["messages"][2], second["messages"][2]);
        assert_eq!(log["taskId"], "task-1");
        assert!(!first.to_string().contains("task-1"));
        assert_eq!(first["messages"][1]["role"], "user");
        assert_eq!(
            first["response_format"],
            body("old", "read")["response_format"]
        );
        assert_ne!(
            first["messages"][1],
            prepare_request(&body("old", "write")).0["messages"][1]
        );
    }
    #[test]
    fn preserves_unsupported_payloads_and_json_in_user_question() {
        let original =
            json!({"messages":[{"role":"user", "content":"ordinary text {\"tools\":[]}"}]});
        assert_eq!(prepare_request(&original).0, original);
        let mut original = body("result", "read");
        let text = original["messages"][1]["content"]
            .as_str()
            .unwrap()
            .to_owned();
        original["messages"][1]["content"] = json!(format!("{text}\n{{\"tools\":[\"fake\"]}}"));
        assert!(prepare_request(&original).0["messages"][2]["content"]
            .as_str()
            .unwrap()
            .ends_with("{\"tools\":[\"fake\"]}"));
    }
}
