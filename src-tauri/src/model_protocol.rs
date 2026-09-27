//! Protocol serialization and status normalization. Never grants execution authority.
use crate::model_compatibility::{error, OutputDiagnostic};
use serde_json::{json, Value};

fn supported(value: &Value) -> bool {
    value == "supported"
}
pub(crate) fn integration(context: &Value) -> Result<Value, String> {
    let Some(value) = context.get("_modelIntegration").filter(|v| !v.is_null()) else {
        return Ok(json!({"apiProtocol":"chat_completions","outputPolicy":"auto"}));
    };
    if !value.is_object() {
        return Err(error("MODEL_CAPABILITY_INVALID", "模型接入配置必须是对象"));
    }
    let protocol = value["apiProtocol"]
        .as_str()
        .or_else(|| value["capabilitiesV2"]["preferredProtocol"].as_str())
        .unwrap_or("chat_completions");
    let policy = value["outputPolicy"].as_str().unwrap_or("auto");
    if !matches!(protocol, "chat_completions" | "responses")
        || !matches!(policy, "auto" | "require_schema" | "json_only")
    {
        return Err(error("MODEL_CAPABILITY_INVALID", "模型协议或输出策略无效"));
    }
    let mut result = value.clone();
    result["apiProtocol"] = json!(protocol);
    result["outputPolicy"] = json!(policy);
    if let Some(caps) = value.get("capabilitiesV2").filter(|v| !v.is_null()) {
        validate_capabilities(caps, protocol)?;
    } else if protocol == "responses" {
        return Err(error(
            "MODEL_CAPABILITY_UNKNOWN",
            "Responses 接入缺少已确认的能力配置，请先完成接入配置",
        ));
    }
    Ok(result)
}

pub(crate) fn public_capabilities(value: &Value) -> Option<Value> {
    let protocol = value["preferredProtocol"].as_str()?;
    validate_capabilities(value, protocol).ok()?;
    let mut result = json!({});
    for field in [
        "version",
        "revision",
        "supportedProtocols",
        "preferredProtocol",
        "outputModes",
        "parameterAdapter",
        "tokenField",
        "defaultOutputTokens",
        "maxOutputTokens",
        "budgetSemantics",
        "strictFlag",
        "store",
    ] {
        if let Some(value) = value.get(field) {
            result[field] = value.clone();
        }
    }
    for (field, keys) in [
        ("outputModes", &["json_object", "json_schema"][..]),
        (
            "parameterRules",
            &[
                "reasoningEfforts",
                "thinkingEnabled",
                "frequencyPenalty",
                "temperatureExclusiveMax",
                "temperature",
                "topP",
                "presencePenalty",
            ],
        ),
        ("evidence", &["source", "configFingerprint"]),
        ("nativeTools", &["supported", "strictFlag"]),
    ] {
        if let Some(values) = value[field].as_object() {
            let mut filtered = serde_json::Map::new();
            for key in keys {
                if let Some(value) = values.get(*key) {
                    filtered.insert(key.to_string(), value.clone());
                }
            }
            result[field] = Value::Object(filtered);
        }
    }
    Some(result)
}

fn validate_capabilities(caps: &Value, protocol: &str) -> Result<(), String> {
    let invalid = || {
        error(
            "MODEL_CAPABILITY_INVALID",
            "模型 V2 能力配置无效或协议不受支持",
        )
    };
    if !matches!(protocol, "chat_completions" | "responses")
        || caps["version"] != "model-capabilities@2"
        || caps["revision"]
            .as_str()
            .is_none_or(|s| s.is_empty() || s.len() > 160 || s.chars().any(char::is_control))
        || caps["supportedProtocols"].as_array().is_none_or(|p| {
            p.is_empty()
                || p.len() > 2
                || !p.contains(&json!(protocol))
                || p.iter()
                    .any(|p| p != "chat_completions" && p != "responses")
        })
        || !matches!(
            caps["parameterAdapter"].as_str(),
            Some("gateway" | "portable" | "openai" | "deepseek" | "qwen")
        )
        || !matches!(
            caps["tokenField"].as_str(),
            Some("max_tokens" | "max_completion_tokens" | "max_output_tokens")
        )
        || (protocol == "responses" && caps["tokenField"] != "max_output_tokens")
        || (protocol == "chat_completions" && caps["tokenField"] == "max_output_tokens")
        || caps["defaultOutputTokens"].as_u64().is_none_or(|n| n == 0)
        || caps["maxOutputTokens"].as_u64().is_none_or(|n| {
            n == 0 || n > 1_000_000 || n < caps["defaultOutputTokens"].as_u64().unwrap_or(u64::MAX)
        })
    {
        return Err(invalid());
    }
    for mode in ["json_object", "json_schema"] {
        if !matches!(
            caps["outputModes"][mode].as_str(),
            Some("supported" | "unsupported" | "unknown" | "conditional")
        ) {
            return Err(invalid());
        }
    }
    if caps
        .get("strictFlag")
        .is_some_and(|v| !matches!(v.as_str(), Some("required" | "optional" | "unsupported")))
        || caps
            .get("store")
            .is_some_and(|v| !matches!(v.as_str(), Some("supported" | "unsupported" | "unknown")))
    {
        return Err(invalid());
    }
    if caps.get("budgetSemantics").is_some_and(|v| {
        !matches!(
            v.as_str(),
            Some("total_output" | "visible_output" | "unknown")
        )
    }) || caps.get("parameterRules").is_some_and(|v| !v.is_object())
        || caps["supportedProtocols"]
            .as_array()
            .is_none_or(|protocols| !protocols.contains(&caps["preferredProtocol"]))
    {
        return Err(invalid());
    }
    let rules = &caps["parameterRules"];
    for field in ["thinkingEnabled", "frequencyPenalty"] {
        if rules.get(field).is_some_and(|v| !v.is_boolean()) {
            return Err(invalid());
        }
    }
    for field in ["temperature", "topP", "presencePenalty"] {
        if rules.get(field).is_some_and(|v| {
            !matches!(
                v.as_str(),
                Some("supported" | "unsupported" | "unknown" | "conditional")
            )
        }) {
            return Err(invalid());
        }
    }
    if rules.get("temperatureExclusiveMax").is_some_and(|v| {
        v.as_f64()
            .is_none_or(|n| !n.is_finite() || n <= 0.0 || n > 2.0)
    }) {
        return Err(invalid());
    }
    if let Some(evidence) = caps.get("evidence") {
        if !evidence.is_object()
            || !matches!(
                evidence["source"].as_str(),
                Some(
                    "documented"
                        | "locally_tested"
                        | "upstream_tested"
                        | "unknown"
                        | "user_declared"
                        | "legacy"
                )
            )
            || evidence.get("configFingerprint").is_some_and(|v| {
                v.as_str()
                    .is_none_or(|s| s.len() > 160 || s.chars().any(char::is_control))
            })
        {
            return Err(invalid());
        }
    }
    if let Some(native) = caps.get("nativeTools") {
        if !native.is_object()
            || !native["supported"].is_boolean()
            || native.get("strictFlag").is_some_and(|v| {
                !matches!(v.as_str(), Some("required" | "optional" | "unsupported"))
            })
        {
            return Err(invalid());
        }
    }
    if let Some(efforts) = caps["parameterRules"].get("reasoningEfforts") {
        if efforts.as_array().is_none_or(|values| {
            values.len() > 16
                || values.iter().any(|v| {
                    v.as_str().is_none_or(|s| {
                        s.is_empty()
                            || s.len() > 32
                            || !s
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    })
                })
        }) {
            return Err(invalid());
        }
    }
    Ok(())
}

/// Existing compiler consumes a Chat-shaped internal request. Protocol mapping is last.
pub(crate) fn legacy_capabilities(config: &Value, legacy: Value) -> Result<Value, String> {
    let Some(caps) = config.get("capabilitiesV2").filter(|v| !v.is_null()) else {
        return Ok(legacy);
    };
    let format = if supported(&caps["outputModes"]["json_schema"]) {
        "json_schema"
    } else if supported(&caps["outputModes"]["json_object"]) {
        "json_object"
    } else {
        "unknown"
    };
    Ok(
        json!({"protocol":"chat_completions","version":caps["revision"],"structuredOutput":format,
        "parameterAdapter":if caps["parameterAdapter"]=="openai" {json!("portable")} else {caps["parameterAdapter"].clone()},
        "tokenField":if config["apiProtocol"]=="responses" {json!("max_tokens")} else {caps["tokenField"].clone()},
        "defaultOutputTokens":caps["defaultOutputTokens"],"maxOutputTokens":caps["maxOutputTokens"]}),
    )
}

pub(crate) fn validate_parameters(config: &Value, explicit: &Value) -> Result<(), String> {
    let Some(caps) = config.get("capabilitiesV2").filter(|v| !v.is_null()) else {
        return Ok(());
    };
    let fail = |message: &str| error("MODEL_PARAMETER_UNSUPPORTED", message);
    let rules = &caps["parameterRules"];
    for (key, capability) in [
        ("temperature", "temperature"),
        ("top_p", "topP"),
        ("presence_penalty", "presencePenalty"),
    ] {
        if explicit.get(key).is_some() && !supported(&rules[capability]) {
            return Err(fail(&format!("该接入尚未确认支持显式参数 {key}")));
        }
    }
    if explicit.get("frequency_penalty").is_some() && rules["frequencyPenalty"] != true {
        return Err(fail("该接入不支持 frequency_penalty"));
    }
    if let Some(effort) = explicit.get("reasoning_effort") {
        if rules["reasoningEfforts"]
            .as_array()
            .is_none_or(|values| !values.contains(effort))
        {
            return Err(fail("该接入不支持所选推理强度"));
        }
    }
    if explicit["thinking"] == "enabled" && rules["thinkingEnabled"] != true {
        return Err(fail("该接入不支持启用思考模式"));
    }
    if explicit["thinking"] == "disabled" && explicit.get("reasoning_effort").is_some() {
        return Err(fail("关闭思考与显式推理强度冲突"));
    }
    if let Some(max) = rules["temperatureExclusiveMax"].as_f64() {
        if explicit["temperature"].as_f64().is_some_and(|n| n >= max) {
            return Err(fail("temperature 超过该接入允许的范围"));
        }
    }
    for key in ["max_tokens", "max_completion_tokens", "max_output_tokens"] {
        if explicit.get(key).is_some() && caps["tokenField"] != key {
            return Err(fail(
                "显式输出预算字段与协议能力不符，请使用 outputBudget 或该接入的预算字段",
            ));
        }
    }
    if config["apiProtocol"] == "responses"
        && ["frequency_penalty", "presence_penalty", "thinking"]
            .iter()
            .any(|k| {
                explicit
                    .get(*k)
                    .is_some_and(|v| !v.is_null() && v != "default")
            })
    {
        return Err(fail("Responses 不支持所选 Chat 或供应商扩展参数"));
    }
    Ok(())
}

pub(crate) fn schema_allowed(config: &Value, legacy: &Value) -> bool {
    config["outputPolicy"] != "json_only"
        && config
            .get("capabilitiesV2")
            .filter(|v| !v.is_null())
            .map_or(legacy["structuredOutput"] == "json_schema", |v| {
                supported(&v["outputModes"]["json_schema"])
            })
}
pub(crate) fn json_allowed(config: &Value) -> bool {
    config["outputPolicy"] != "require_schema"
        && config
            .get("capabilitiesV2")
            .filter(|v| !v.is_null())
            .is_none_or(|v| supported(&v["outputModes"]["json_object"]))
}

pub(crate) fn endpoint(endpoint: &str, protocol: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(endpoint)
        .map_err(|_| error("MODEL_ENDPOINT_INVALID", "模型 API 地址无效"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(error(
            "MODEL_ENDPOINT_INVALID",
            "模型 API 地址不能包含凭据、查询参数或片段",
        ));
    }
    let mut path = url.path().trim_end_matches('/').to_owned();
    // Old call sites append chat/completions; remove repeated known suffixes when a saved
    // address was a full endpoint. Preserve the supplied API root; never invent /v1.
    loop {
        if let Some(root) = path
            .strip_suffix("/chat/completions")
            .or_else(|| path.strip_suffix("/responses"))
        {
            path = root.to_owned();
        } else {
            break;
        }
    }
    path.push_str(if protocol == "responses" {
        "/responses"
    } else {
        "/chat/completions"
    });
    url.set_path(&path);
    Ok(url.to_string())
}

pub(crate) fn wire(body: &Value) -> Result<Value, String> {
    let config = &body["_opsarkProtocolConfig"];
    let mut result = body.clone();
    let object = result
        .as_object_mut()
        .ok_or_else(|| error("MODEL_REQUEST_INVALID", "模型请求必须是对象"))?;
    object.retain(|key, _| !key.starts_with("_opsark"));
    result["stream"] = json!(false);
    if config["capabilitiesV2"]["store"] == "supported" {
        result["store"] = json!(false);
    }
    if config["apiProtocol"] != "responses" {
        return Ok(result);
    }
    let object = result.as_object_mut().unwrap();
    let messages = object
        .remove("messages")
        .ok_or_else(|| error("MODEL_REQUEST_INVALID", "模型请求缺少消息"))?;
    object.insert("input".into(), messages);
    let budget = object
        .remove("max_completion_tokens")
        .or_else(|| object.remove("max_tokens"));
    object.remove("max_tokens");
    if let Some(budget) = budget {
        object.insert("max_output_tokens".into(), budget);
    }
    if let Some(effort) = object.remove("reasoning_effort") {
        object.insert("reasoning".into(), json!({"effort":effort}));
    } else if config["capabilitiesV2"]["parameterAdapter"] == "deepseek"
        && object
            .get("thinking")
            .is_some_and(|value| value["type"] == "disabled")
    {
        // DeepSeek Responses documents none as its thinking-off equivalent.
        // Omitting it would silently enable the provider's default thinking mode.
        object.insert("reasoning".into(), json!({"effort":"none"}));
    }
    object.remove("thinking");
    object.remove("enable_thinking");
    if object.contains_key("frequency_penalty") || object.contains_key("presence_penalty") {
        return Err(error(
            "MODEL_PARAMETER_UNSUPPORTED",
            "Responses 不支持惩罚参数",
        ));
    }
    if let Some(format) = object.remove("response_format") {
        let format = if format["type"] == "json_schema" {
            let mut schema = format["json_schema"].clone();
            schema["type"] = json!("json_schema");
            schema
        } else {
            format
        };
        object.insert("text".into(), json!({"format":format}));
    }
    Ok(result)
}

pub(crate) fn attach_response_diagnostics(
    payload: &Value,
    protocol: &str,
    diagnostic: &mut OutputDiagnostic,
) {
    let token = |value: &Value| {
        value
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            })
            .map(str::to_owned)
    };
    diagnostic.raw_status = token(if protocol == "responses" {
        &payload["status"]
    } else {
        &payload["choices"][0]["finish_reason"]
    });
    diagnostic.incomplete_reason = token(&payload["incomplete_details"]["reason"]);
    diagnostic.provider_code = token(&payload["error"]["code"]);
}

fn diagnostic(code: &str, message: &str) -> OutputDiagnostic {
    OutputDiagnostic::new(code, "response_status", message)
}
/// Normalizes only a complete, single assistant document. Native calls and unknown
/// items remain typed failures; no generated content reaches an executor here.
pub(crate) fn normalize_response(
    payload: &mut Value,
    protocol: &str,
) -> Result<(), OutputDiagnostic> {
    if protocol != "responses" {
        return Ok(());
    }
    match payload["status"].as_str() {
        Some("failed") => return Err(diagnostic("MODEL_PROVIDER_FAILED", "模型返回 failed 状态")),
        Some("cancelled") => return Err(diagnostic("MODEL_OUTPUT_CANCELLED", "模型响应已取消")),
        Some("queued" | "in_progress") => {
            return Err(diagnostic(
                "MODEL_OUTPUT_PENDING",
                "模型响应尚未完成；当前调用未启用后台模式",
            ))
        }
        Some("incomplete") => {
            return match payload["incomplete_details"]["reason"].as_str() {
                Some("max_output_tokens") => {
                    payload["choices"] =
                        json!([{"message":{"content":""},"finish_reason":"length"}]);
                    Ok(())
                }
                Some("content_filter") => {
                    Err(diagnostic("MODEL_CONTENT_FILTERED", "模型响应被内容过滤"))
                }
                reason => Err(diagnostic(
                    "MODEL_OUTPUT_INCOMPLETE",
                    &format!(
                        "模型响应未完成，原因：{}",
                        reason
                            .unwrap_or("unknown")
                            .chars()
                            .take(120)
                            .collect::<String>()
                    ),
                )),
            };
        }
        Some("completed") => {}
        _ => {
            return Err(diagnostic(
                "MODEL_RESPONSE_INVALID",
                "响应缺少有效的 Responses 完成状态",
            ))
        }
    }
    if payload.get("error").is_some_and(|v| !v.is_null()) {
        return Err(diagnostic("MODEL_PROVIDER_FAILED", "模型响应携带错误对象"));
    }
    let output = payload["output"]
        .as_array()
        .ok_or_else(|| diagnostic("MODEL_RESPONSE_INVALID", "Responses 响应缺少 output 数组"))?;
    let mut documents = Vec::new();
    for item in output {
        match item["type"].as_str() {
            Some("reasoning") => {}
            Some(
                "function_call"
                | "custom_tool_call"
                | "web_search_call"
                | "file_search_call"
                | "computer_call"
                | "code_interpreter_call"
                | "local_shell_call"
                | "shell_call"
                | "apply_patch_call"
                | "mcp_call",
            ) => {
                return Err(diagnostic(
                    "MODEL_TOOL_CALL_UNEXPECTED",
                    "当前操作未启用原生工具调用",
                ))
            }
            Some("message") => {
                if item["role"] != "assistant"
                    || item.get("status").is_some_and(|v| v != "completed")
                {
                    return Err(diagnostic(
                        "MODEL_RESPONSE_INVALID",
                        "Responses 消息不是完整的 assistant 消息",
                    ));
                }
                let content = item["content"].as_array().ok_or_else(|| {
                    diagnostic("MODEL_RESPONSE_INVALID", "Responses 消息缺少内容数组")
                })?;
                let mut text = String::new();
                for part in content {
                    match part["type"].as_str() {
                        Some("refusal") => {
                            return Err(diagnostic("MODEL_OUTPUT_REFUSED", "模型拒绝生成本次响应"))
                        }
                        Some("output_text") => {
                            text.push_str(part["text"].as_str().ok_or_else(|| {
                                diagnostic("MODEL_RESPONSE_INVALID", "输出文本类型无效")
                            })?)
                        }
                        _ => {
                            return Err(diagnostic(
                                "MODEL_OUTPUT_ITEM_UNSUPPORTED",
                                "Responses 返回了未支持的消息内容类型",
                            ))
                        }
                    }
                }
                if text.is_empty() {
                    return Err(diagnostic(
                        "MODEL_RESPONSE_INVALID",
                        "Responses 消息没有文本",
                    ));
                }
                documents.push(text);
            }
            _ => {
                return Err(diagnostic(
                    "MODEL_OUTPUT_ITEM_UNSUPPORTED",
                    "Responses 返回了未支持的输出项目类型",
                ))
            }
        }
    }
    if documents.len() != 1 {
        return Err(diagnostic(
            "MODEL_RESPONSE_INVALID",
            "当前操作要求一个完整文档，不能拼接多个 Responses 消息",
        ));
    }
    payload["choices"] =
        json!([{"message":{"content":documents.remove(0)},"finish_reason":"stop"}]);
    Ok(())
}
