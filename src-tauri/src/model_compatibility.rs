//! Wire compatibility only. Authorization and execution validation remain downstream.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) const OUTPUT_NORMALIZATION_VERSION: &str = "json-wrapper-and-shell-placement@3";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Capabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parameter_rules: Option<ParameterRules>,
    protocol: String,
    version: String,
    structured_output: String,
    parameter_adapter: String,
    token_field: String,
    default_output_tokens: u64,
    max_output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParameterRules {
    reasoning_efforts: Vec<String>,
    thinking_enabled: bool,
    frequency_penalty: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    temperature_exclusive_max: Option<f64>,
}

pub(crate) fn public_capabilities(value: &Value) -> Option<Value> {
    let caps: Capabilities = serde_json::from_value(value.clone()).ok()?;
    if let Some(rules) = &caps.parameter_rules {
        if rules.reasoning_efforts.len() > 3
            || rules
                .reasoning_efforts
                .iter()
                .any(|effort| !matches!(effort.as_str(), "low" | "medium" | "high"))
            || rules
                .temperature_exclusive_max
                .is_some_and(|n| !n.is_finite() || n <= 0.0 || n > 2.0)
        {
            return None;
        }
    }
    if caps.protocol != "chat_completions"
        || caps.version.len() > 80
        || !matches!(
            caps.structured_output.as_str(),
            "unknown" | "json_object" | "json_schema"
        )
        || !matches!(
            caps.parameter_adapter.as_str(),
            "gateway" | "portable" | "deepseek" | "qwen" | "openai"
        )
        || !matches!(
            caps.token_field.as_str(),
            "max_tokens" | "max_completion_tokens"
        )
        || caps.default_output_tokens == 0
        || caps.max_output_tokens == 0
        || caps.default_output_tokens > caps.max_output_tokens
        || caps.max_output_tokens > 1_000_000
    {
        return None;
    }
    serde_json::to_value(caps).ok()
}

fn object(required: Value, optional: Value) -> Value {
    let mut properties = required.as_object().unwrap().clone();
    let required: Vec<_> = properties.keys().cloned().collect();
    for (key, value) in optional.as_object().unwrap() {
        properties.insert(key.clone(), value.clone());
    }
    json!({"type":"object", "properties":properties, "required":required, "additionalProperties":false})
}
fn strings() -> Value {
    json!({"type":"array","items":{"type":"string"}})
}
fn nullable(schema: Value) -> Value {
    json!({"anyOf":[schema,{"type":"null"}]})
}
const METADATA_SCHEMA_MARKER: &str = "opsark:json-object-metadata";
fn metadata() -> Value {
    // Internal JSON objects remain structured. Only strict provider transports
    // need the JSON-string representation; this is not a command parser.
    json!({"$comment":METADATA_SCHEMA_MARKER,
        "anyOf":[{"type":"object"},{"type":"string"},{"type":"null"}],
        "description":"Optional business metadata. Never invent authority or evidence."})
}
pub(crate) fn action_schema(tools: &Value) -> Value {
    let mut variants = vec![object(
        json!({"type":{"type":"string","enum":["shell"]},"command":{"type":"string","minLength":1}}),
        json!({}),
    )];
    if let Some(tools) = tools.as_array() {
        for tool in tools {
            if tool["id"].is_string() && tool["inputSchema"].is_object() {
                variants.push(object(json!({"type":{"type":"string","enum":["tool"]},
                    "toolId":{"type":"string","enum":[tool["id"]]}, "arguments":tool["inputSchema"]}),json!({})));
            }
        }
    }
    json!({"anyOf":variants})
}
fn step(tools: &Value) -> Value {
    object(
        json!({"kind":{"type":"string","enum":["observe","change"]},
        "title":{"type":"string"},"description":{"type":"string"},"action":action_schema(tools),
        "expected":{"type":"string"},"validation":{"type":"string"},"risk":{"type":"string","enum":["low","medium","high"]}}),
        json!({"executionScope":nullable(json!({"type":"string","enum":crate::plan_contract::EXECUTION_SCOPES})),"validationScope":nullable(json!({"type":"string","enum":crate::plan_contract::VALIDATION_SCOPES})),
            "runtimeClass":nullable(json!({"type":"string","enum":crate::plan_contract::RUNTIME_CLASSES})),"sessionContextChange":metadata(),"recovery":metadata(),"retryBasis":metadata()}),
    )
}

/// A separate contract per operation; a review must never receive the plan schema.
pub(crate) fn contract(name: &str, body: &Value) -> Option<Value> {
    let full = full_contract(name, body)?;
    Some(crate::scoped_model_repair::ScopedRepair::new(name, body, &full)
        .map_or(full, |repair| repair.schema))
}

pub(crate) fn full_contract(name: &str, body: &Value) -> Option<Value> {
    let context: Value =
        serde_json::from_str(body["_opsarkContext"].as_str().unwrap_or("{}")).unwrap_or(json!({}));
    let steps = json!({"type":"array","items":step(&context["tools"])});
    let decision = json!({"type":"string","enum":["continue","adjust","complete"]});
    match name {
        "阶段联合决策" | "阶段格式修复（兼容模式）" => {
            let mut required = json!({"decision":decision,"reason":{"type":"string"},"summary":{"type":"string"},"steps":steps});
            let mut optional = json!({"planUpdate":metadata(),"reconciliation":metadata(),"blocking":nullable(crate::requirement_contract::blocking()),"issueResolutions":nullable(crate::requirement_contract::resolutions())});
            if crate::requirement_contract::requires_review(&context) {
                required["requirementReview"] = crate::requirement_contract::review();
            } else {
                optional["requirementReview"] = nullable(crate::requirement_contract::review());
            }
            Some(object(required, optional))
        },
        "计划生成" | "模型业务测试" => {
            let focused = body["_opsarkOperationContract"] == "plan.repair@1"
                || body["messages"].as_array().is_some_and(|messages| {
                    messages.iter().any(|m| {
                        m["role"] == "system"
                            && m["content"]
                                .as_str()
                                .is_some_and(|s| s.contains("本轮是局部计划修复，只允许返回"))
                    })
                });
            Some(if focused {
                object(
                    json!({"repair":object(json!({"stepIndex":{"type":"integer"},"replacementSteps":steps}),json!({}))}),
                    json!({}),
                )
            } else {
                object(json!({"steps":steps}), json!({}))
            })
        }
        "需求理解" => Some(object(
            json!({"intent":{"type":"string","enum":["answer","execute","terminal_context"]},
            "answer":{"type":"string"},"selectedSkillIds":strings(),"constraints":nullable(object(json!({
                "changePolicy":{"type":"string"},"environmentPolicy":{"type":"string"},"failurePolicy":{"type":"string"},
                "prohibitedActions":strings(),"requiredConditions":strings(),"userDirectives":strings()}),json!({})))}),
            json!({"relation":nullable(json!({"type":"string"})),"terminalContextLines":nullable(json!({"type":"integer"})),"requirementUpdate":nullable(crate::requirement_contract::update())}),
        )),
        "结果复核" => Some(object(
            json!({"decision":decision,"reason":{"type":"string"},"summary":{"type":"string"}}),
            json!({
            "acceptance":nullable(object(json!({"status":{"type":"string","enum":["proven","not_met","unknown"]},"reason":{"type":"string"},"evidenceIds":strings()}),json!({}))),
            "recoveryAction":nullable(object(json!({"kind":{"type":"string"},"reason":{"type":"string"},"steps":{"type":"array","items":object(json!({
                "stepId":{"type":"string"},"relation":{"type":"string","enum":["independent","dependent","unknown"]},"reason":{"type":"string"}}),json!({}))}}),json!({}))) }),
        )),
        "Skill 生成" => Some(object(
            json!({"name":{"type":"string"},"category":{"type":"string"},"description":{"type":"string"},"matchRules":strings(),"instructions":{"type":"string"}}),
            json!({}),
        )),
        "模型结构测试" => Some(object(
            json!({"ok":{"type":"boolean","enum":[true]}}),
            json!({}),
        )),
        _ => None,
    }
}

fn contract_version(name: &str, schema: &Value) -> &'static str {
    match name {
        "计划生成" if schema["properties"].get("repair").is_some() => "plan.repair@1",
        "计划生成" if schema["properties"].get("steps").is_none() => "plan.fields-repair@1",
        "计划生成" => "plan.generate@1",
        "阶段联合决策" if schema["properties"].get("steps").is_none() => "stage.metadata-repair@2",
        "阶段联合决策" | "阶段格式修复（兼容模式）" => "stage.decide@2",
        "需求理解" => "requirement.classify@1",
        "结果复核" => "result.review@1",
        "Skill 生成" => "skill.draft@1",
        "模型结构测试" => "model.probe@1",
        "模型业务测试" => "model.business-probe@1",
        _ => "text@1",
    }
}

// Null is a strict-wire sentinel only for properties optional in the original
// operation schema. Required/null business values are never silently removed.
fn omit_optional_nulls(value: &mut Value, schema: &Value) {
    if let Some(variants) = schema["anyOf"].as_array() {
        if let Some(branch) = variants.iter().find(|branch| {
            if branch["type"] == "array" {
                return value.is_array();
            }
            branch["type"] == "object"
                && value.is_object()
                && branch["properties"].as_object().is_some_and(|props| {
                    branch["required"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .all(|key| {
                            let rule = &props[key];
                            rule["enum"]
                                .as_array()
                                .is_none_or(|choices| choices.contains(&value[key]))
                                && rule
                                    .get("const")
                                    .is_none_or(|expected| expected == &value[key])
                        })
                })
        }) {
            omit_optional_nulls(value, branch);
            return;
        }
    }
    if let Some(map) = value.as_object_mut() {
        let required = schema["required"].as_array().cloned().unwrap_or_default();
        map.retain(|key, value| {
            !(value.is_null()
                && schema["properties"].get(key).is_some()
                && !required.contains(&json!(key)))
        });
        for (key, value) in map {
            if let Some(rule) = schema["properties"].get(key) {
                omit_optional_nulls(value, rule);
            }
        }
    } else if let Some(items) = value.as_array_mut() {
        for value in items {
            omit_optional_nulls(value, &schema["items"]);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputDiagnostic {
    pub code: String,
    pub stage: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incomplete_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json_pointer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyword: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
}

impl OutputDiagnostic {
    pub(crate) fn new(code: &str, stage: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            stage: stage.into(),
            message: message.into(),
            raw_status: None,
            incomplete_reason: None,
            provider_code: None,
            json_pointer: None,
            schema_path: None,
            keyword: None,
            line: None,
            column: None,
        }
    }

    pub(crate) fn repairable(&self) -> bool {
        self.code == "MODEL_OUTPUT_TRUNCATED"
            || (self.code == "MODEL_FORMAT_INVALID"
                && matches!(
                    self.stage.as_str(),
                    "json_parse" | "wire_validation" | "business_validation" | "metadata_decode"
                ))
    }
}

impl std::fmt::Display for OutputDiagnostic {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub(crate) fn output_error(diagnostic: &OutputDiagnostic, http_status: Option<u16>) -> String {
    let mut model_error = serde_json::to_value(diagnostic).expect("diagnostic is serializable");
    model_error["origin"] = json!("core");
    model_error["retryable"] = json!(false);
    if let Some(status) = http_status {
        model_error["httpStatus"] = json!(status);
    }
    format!(
        "{}{}",
        crate::MODEL_TRACE_ERROR_PREFIX,
        json!({"message":diagnostic.message,"modelError":model_error})
    )
}

pub(crate) fn error(code: &str, message: &str) -> String {
    output_error(&OutputDiagnostic::new(code, "request", message), None)
}

/// Remove private adapter configuration before prompt composition or HTTP serialization.
pub(crate) fn prepare(
    body: &Value,
    name: &str,
    gateway: bool,
) -> Result<(Value, Option<Value>), String> {
    let mut body = body.clone();
    let raw = body["_opsarkContext"].as_str().unwrap_or("{}").to_owned();
    let mut context: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    // Official requests are configured by the platform, including old saved overrides.
    if gateway {
        context.as_object_mut().map(|c| c.remove("_requestParameters"));
    }
    let integration = crate::model_protocol::integration(&context)?;
    context.as_object_mut().map(|c| c.remove("_modelIntegration"));
    let caps = context
        .as_object_mut()
        .and_then(|c| c.remove("_modelCapabilities"))
        .filter(|v| !v.is_null());
    let caps = match caps {
        Some(value) => public_capabilities(&value).ok_or_else(|| {
            error(
                "MODEL_CAPABILITY_INVALID",
                "模型能力配置无效，请检查接入协议和预算",
            )
        })?,
        None => json!({}),
    };
    let caps = crate::model_protocol::legacy_capabilities(&integration, caps)?;
    let explicit = context["_requestParameters"].clone();
    crate::model_protocol::validate_parameters(&integration, &explicit)?;
    if integration.get("capabilitiesV2").filter(|v| !v.is_null()).is_none() && explicit.get("reasoning_effort").is_some_and(|v| !matches!(v.as_str(),Some("low"|"medium"|"high"))) {
        return Err(error("MODEL_PARAMETER_UNSUPPORTED", "旧接入能力没有声明该推理强度"));
    }
    let adapter =
        caps["parameterAdapter"]
            .as_str()
            .unwrap_or(if gateway { "gateway" } else { "portable" });
    if !gateway && adapter == "gateway" {
        return Err(error(
            "MODEL_CAPABILITY_INVALID",
            "直连模型不能使用官方网关参数适配器",
        ));
    }
    let clean = context.to_string();
    if let Some(messages) = body["messages"].as_array_mut() {
        for message in messages {
            if let Some(text) = message["content"].as_str() {
                message["content"] = json!(text.replace(&raw, &clean));
            }
        }
    }
    if body.get("_opsarkContext").is_some() {
        body["_opsarkContext"] = json!(clean);
    }
    body = crate::model_parameters::prepare(&body)
        .map_err(|message| error("MODEL_PARAMETER_UNSUPPORTED", &message))?;
    let default_thinking = explicit.get("thinking").is_none();
    if default_thinking && !matches!(adapter, "deepseek" | "qwen") {
        body.as_object_mut().unwrap().remove("thinking");
    }
    if adapter == "openai" {
        if body["thinking"]["type"] == "enabled" || body.get("reasoning_effort").is_some() {
            return Err(error(
                "MODEL_PARAMETER_UNSUPPORTED",
                "非推理接入配置不支持所选思考参数",
            ));
        }
        body.as_object_mut().unwrap().remove("thinking");
    }
    if adapter == "deepseek" {
        let responses = integration["apiProtocol"] == "responses";
        if let Some(effort) = body["reasoning_effort"].as_str() {
            if !matches!(effort, "low" | "high" | "max") && !(responses && effort == "none") {
                return Err(error("MODEL_PARAMETER_UNSUPPORTED", "该 DeepSeek 协议不能保持所选推理强度的原意；请选择已声明且不被供应商映射的档位"));
            }
            if explicit["thinking"] == "disabled" && effort != "none" {
                return Err(error("MODEL_PARAMETER_UNSUPPORTED", "关闭思考与显式推理强度冲突，请调整参数"));
            }
            body["thinking"] = json!({"type":if effort == "none" {"disabled"} else {"enabled"}});
        } else if default_thinking && body.get("thinking").is_none() {
            // Match business calls' existing non-thinking default in small probes.
            // An explicit thinking=default still selects the provider default.
            body["thinking"] = json!({"type":"disabled"});
        }
    }
    if adapter == "deepseek" {
        // DeepSeek's documented current mode semantics: temperature/penalties
        // are ignored while thinking; top_p only works while thinking at >=0.95.
        let thinking = body.get("thinking").is_none() || body["thinking"]["type"] == "enabled";
        if thinking && ["temperature", "presence_penalty", "frequency_penalty"].iter().any(|key| explicit.get(*key).is_some()) {
            return Err(error("MODEL_PARAMETER_UNSUPPORTED", "DeepSeek 思考模式不生效的 temperature/presence_penalty/frequency_penalty 不能作为显式参数发送，请清空这些值或关闭思考"));
        }
        if explicit.get("top_p").is_some() && (!thinking || explicit["top_p"].as_f64().is_none_or(|n| n < 0.95)) {
            return Err(error("MODEL_PARAMETER_UNSUPPORTED", "DeepSeek top_p 仅在思考模式且范围为 0.95–1 时生效，不能发送会被忽略或钳位的显式值"));
        }
        if thinking {
            for key in ["temperature", "presence_penalty", "frequency_penalty"] {body.as_object_mut().unwrap().remove(key);}
        }
        if !thinking || body["top_p"].as_f64().is_some_and(|n| n < 0.95) {body.as_object_mut().unwrap().remove("top_p");}
    }
    if adapter == "qwen" {
        if body.get("reasoning_effort").is_some()
            || body.get("frequency_penalty").is_some()
            || body["temperature"].as_f64().is_some_and(|v| v >= 2.0)
        {
            return Err(error(
                "MODEL_PARAMETER_UNSUPPORTED",
                "该千问兼容配置不支持所选参数组合",
            ));
        }
        let thinking = body["thinking"]["type"] == "enabled";
        if thinking {
            return Err(error(
                "MODEL_PARAMETER_UNSUPPORTED",
                "当前非流式结构化调用不支持该配置的思考模式",
            ));
        }
        body.as_object_mut().unwrap().remove("thinking");
        body["enable_thinking"] = json!(false);
    }
    let field =
        caps["tokenField"]
            .as_str()
            .unwrap_or(if body.get("max_completion_tokens").is_some() {
                "max_completion_tokens"
            } else {
                "max_tokens"
            });
    let other = if field == "max_tokens" {
        "max_completion_tokens"
    } else {
        "max_tokens"
    };
    if let Some(value) = body.as_object_mut().unwrap().remove(other) {
        body[field] = value;
    }
    let connection_limit = caps["maxOutputTokens"].as_u64().unwrap_or(16384);
    let budget = if gateway {
        connection_limit
    } else {
        body[field].as_u64().unwrap_or(connection_limit)
    };
    if budget == 0 || budget > caps["maxOutputTokens"].as_u64().unwrap_or(1_000_000) {
        return Err(error(
            "MODEL_OUTPUT_BUDGET_INVALID",
            "请求输出预算超过模型接入配置上限，请调整预算",
        ));
    }
    // An explicit, paid connection probe must not inherit a large business budget.
    body[field] = json!(if matches!(name, "模型结构测试" | "模型参数测试") {
        budget.min(64)
    } else if name == "模型业务测试" {
        budget.min(1200)
    } else {
        budget
    });
    let schema = contract(name, &body);
    if let Some(schema) = &schema {
        let use_schema = crate::model_protocol::schema_allowed(&integration, &caps);
        if !use_schema && !crate::model_protocol::json_allowed(&integration) {
            return Err(error("MODEL_CAPABILITY_UNKNOWN", "当前输出策略没有已确认可用的结构输出能力，请配置或测试接入能力"));
        }
        let compiled = if use_schema { Some(crate::model_schema::compile(schema)) } else { None };
        match compiled {
            Some(Ok(compiled)) => {
                body["response_format"] = json!({"type":"json_schema","json_schema":{"name":"opsark_response","strict":true,"schema":compiled.schema}});
                if integration.get("capabilitiesV2").filter(|v| !v.is_null()).is_some() && integration["capabilitiesV2"]["strictFlag"] != "required" {
                    body["response_format"]["json_schema"].as_object_mut().unwrap().remove("strict");
                }
                body["_opsarkSchemaCompilation"] = compiled.report;
            }
            Some(Err(failure)) if !crate::model_protocol::json_allowed(&integration)
                || integration.get("capabilitiesV2").filter(|v| !v.is_null()).is_none()
                || !crate::model_schema::json_fallback_safe(schema) => {
                let mut diagnostic = OutputDiagnostic::new("MODEL_SCHEMA_UNSUPPORTED", "schema_compile", &failure.message);
                diagnostic.schema_path = Some(failure.schema_path); diagnostic.keyword = Some(failure.keyword);
                return Err(output_error(&diagnostic, None));
            }
            failure => {
                body["response_format"] = json!({"type":"json_object"});
                use sha2::{Digest, Sha256};
                body["_opsarkSchemaCompilation"] = json!({"dialect":"json_object-local-validation@1",
                    "outcome":"local_only", "businessSchemaDigest":format!("{:x}", Sha256::digest(schema.to_string().as_bytes()))});
                if let Some(Err(failure)) = failure {
                    body["_opsarkSchemaCompilation"]["fallback"] = json!({"reason":"operation_schema_compile","message":failure.message,"schemaPath":failure.schema_path,"keyword":failure.keyword});
                }
            }
        }
        let fields = crate::requirement_contract::response_fields(schema);
        if fields.as_object().is_some_and(|fields| !fields.is_empty()) {
            if let Some(messages) = body["messages"].as_array_mut() {
                let contract = crate::requirement_contract::response_field_contract(schema);
                let instruction = format!("以下是当前操作补充字段的 JSON Schema。required 中字段必须存在并满足类型，不得用 null 代替必填对象；其余字段提供时也须满足契约。不得混用汇总状态与单项验收状态：{contract}");
                if let Some(message) = messages.iter_mut().find(|message| message["role"] == "system" && message["content"].is_string()) {
                    message["content"] = json!(format!("{}\n{instruction}", message["content"].as_str().unwrap()));
                } else {
                    messages.insert(0, json!({"role":"system", "content":instruction}));
                }
            }
        }
        body["_opsarkSchemaCompilation"]["contractVersion"] = json!(contract_version(name, schema));
        body["_opsarkSchemaCompilation"]["normalizationVersion"] = json!(OUTPUT_NORMALIZATION_VERSION);
        body["_opsarkSchemaCompilation"]["capabilityVersion"] = caps["version"].clone();
        body["_opsarkSchemaCompilation"]["protocol"] = integration["apiProtocol"].clone();
        crate::schema_validation::preflight(schema).map_err(|_| {
            output_error(
                &OutputDiagnostic::new(
                    "MODEL_SCHEMA_INVALID",
                    "schema_compile",
                    "当前操作的本地业务契约无效，请求未发送",
                ),
                None,
            )
        })?;
    }
    body["_opsarkProtocolConfig"] = integration;
    Ok((body, schema))
}

fn pointer_segment(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// Shell scopes/runtime belong to the step. Accept only lossless placement
/// correction: an already valid string, with an absent or identical destination.
/// Do not descend into tool arguments or infer defaults from null/conflicting data.
fn normalize_shell_execution_scope(value: &mut Value, schema: &Value) {
    for (value_path, schema_path) in [
        ("/steps", "/properties/steps/items"),
        ("/repair/replacementSteps", "/properties/repair/properties/replacementSteps/items"),
    ] {
        let Some(step_schema) = schema.pointer(schema_path) else { continue };
        let Some(steps) = value.pointer_mut(value_path).and_then(Value::as_array_mut) else { continue };
        for step in steps {
            if step.pointer("/action/type").and_then(Value::as_str) != Some("shell") { continue; }
            for field in ["executionScope", "validationScope", "runtimeClass"] {
                let Some(scope_schema) = step_schema["properties"].get(field) else { continue };
                let Some(scope) = step["action"].get(field).filter(|value| value.is_string()).cloned() else { continue };
                if !validates(&scope, scope_schema)
                    || step.get(field).is_some_and(|existing| existing != &scope) {
                    continue;
                }
                step[field] = scope;
                step["action"].as_object_mut().unwrap().remove(field);
            }
            for field in ["arguments", "toolId"] {
                if step["action"].get(field).is_some_and(Value::is_null) {
                    step["action"].as_object_mut().unwrap().remove(field);
                }
            }
        }
    }
}

fn decode_metadata(value: &mut Value, schema: &Value) -> Result<(), OutputDiagnostic> {
    decode_metadata_at(value, schema, "", "")
}

fn decode_metadata_at(
    value: &mut Value,
    schema: &Value,
    pointer: &str,
    schema_path: &str,
) -> Result<(), OutputDiagnostic> {
    // Follow schema locations, not property names. A tool argument named
    // `recovery` must retain its own declared type and cannot bypass validation.
    if schema["$comment"] == METADATA_SCHEMA_MARKER {
        if let Some(encoded) = value.as_str() {
            let failure = |message: &str| {
                let mut diagnostic =
                    OutputDiagnostic::new("MODEL_FORMAT_INVALID", "metadata_decode", message);
                diagnostic.json_pointer = Some(pointer.into());
                diagnostic.schema_path = Some(schema_path.into());
                diagnostic
            };
            if encoded.len() > 131_072 {
                return Err(failure("扩展元数据超过单字段解码上限"));
            }
            *value = serde_json::from_str(encoded).map_err(|error| {
                let mut diagnostic = failure("扩展元数据不是合法 JSON 对象");
                diagnostic.line = Some(error.line());
                diagnostic.column = Some(error.column());
                diagnostic
            })?;
        }
        if !value.is_object() && !value.is_null() {
            let mut diagnostic = OutputDiagnostic::new(
                "MODEL_FORMAT_INVALID",
                "metadata_decode",
                "扩展元数据必须是 JSON 对象",
            );
            diagnostic.json_pointer = Some(pointer.into());
            diagnostic.schema_path = Some(schema_path.into());
            return Err(diagnostic);
        }
        return Ok(());
    }
    if let Some(variants) = schema["anyOf"].as_array() {
        if let Some((index, branch)) = variants
            .iter()
            .enumerate()
            .find(|(_, branch)| validates(value, branch))
        {
            return decode_metadata_at(
                value,
                branch,
                pointer,
                &format!("{schema_path}/anyOf/{index}"),
            );
        }
    }
    if let Some(map) = value.as_object_mut() {
        for (key, child) in map {
            if let Some(rule) = schema["properties"].get(key) {
                let key = pointer_segment(key);
                decode_metadata_at(
                    child,
                    rule,
                    &format!("{pointer}/{key}"),
                    &format!("{schema_path}/properties/{key}"),
                )?;
            }
        }
    } else if let Some(items) = value.as_array_mut() {
        for (index, child) in items.iter_mut().enumerate() {
            decode_metadata_at(
                child,
                &schema["items"],
                &format!("{pointer}/{index}"),
                &format!("{schema_path}/items"),
            )?;
        }
    }
    Ok(())
}

fn validates(value: &Value, schema: &Value) -> bool {
    crate::schema_validation::validate(schema, value).is_ok()
}

fn check_value(value: &Value, schema: &Value, stage: &str) -> Result<(), OutputDiagnostic> {
    crate::schema_validation::diagnose(schema, value).map_err(|issue| {
        let mut diagnostic = OutputDiagnostic::new("MODEL_FORMAT_INVALID", stage, &issue.message);
        diagnostic.json_pointer = Some(issue.instance_path);
        diagnostic.schema_path = Some(issue.schema_path);
        diagnostic.keyword = Some(issue.keyword);
        diagnostic
    })
}

pub(crate) fn normalize_response_with_wire(
    payload: &mut Value,
    schema: &Value,
    wire: Option<&Value>,
) -> Result<(), OutputDiagnostic> {
    let envelope_error = || {
        OutputDiagnostic::new(
            "MODEL_RESPONSE_INVALID",
            "response_envelope",
            "接口响应缺少合法的 Chat 文本消息",
        )
    };
    let message = payload
        .pointer("/choices/0/message")
        .filter(|message| message.is_object())
        .ok_or_else(envelope_error)?;
    if message
        .get("refusal")
        .is_some_and(|refusal| !refusal.is_null() && refusal.as_str() != Some(""))
    {
        return Err(OutputDiagnostic::new(
            "MODEL_OUTPUT_REFUSED",
            "response_status",
            "模型拒绝生成本次内容，未执行格式修复",
        ));
    }
    if message.get("tool_calls").is_some_and(|calls| {
        !calls.is_null() && calls.as_array().is_none_or(|calls| !calls.is_empty())
    }) || message
        .get("function_call")
        .is_some_and(|call| !call.is_null())
    {
        return Err(OutputDiagnostic::new(
            "MODEL_RESPONSE_INVALID",
            "response_envelope",
            "当前操作需要业务 JSON，接口却返回了原生工具调用",
        ));
    }
    let content = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(envelope_error)?;
    let content = crate::json_contract::normalize_json_wrapper(content);
    let mut value: Value = serde_json::from_str(content).map_err(|error| {
        let mut diagnostic = OutputDiagnostic::new(
            "MODEL_FORMAT_INVALID",
            "json_parse",
            "响应正文不是完整合法 JSON",
        );
        diagnostic.line = Some(error.line());
        diagnostic.column = Some(error.column());
        diagnostic
    })?;
    normalize_shell_execution_scope(&mut value, schema);
    if let Some(wire) = wire {
        check_value(&value, wire, "wire_validation")?;
        omit_optional_nulls(&mut value, schema);
    }
    check_value(&value, schema, "business_validation")?;
    decode_metadata(&mut value, schema)?;
    check_value(&value, schema, "business_validation")?;
    payload["choices"][0]["message"]["content"] = json!(value.to_string());
    Ok(())
}

#[cfg(test)]
fn normalize_response(payload: &mut Value, schema: &Value) -> Result<(), OutputDiagnostic> {
    normalize_response_with_wire(payload, schema, None)
}

#[cfg(test)]
mod json_wrapper_tests {
    use super::*;

    fn payload(content: &str) -> Value {
        json!({"choices":[{"message":{"content":content},"finish_reason":"stop"}]})
    }

    #[test]
    fn complete_fences_and_exterior_bom_are_normalized_without_generation() {
        let schema = object(json!({"ok":{"type":"boolean"}}), json!({}));
        for content in [
            "```json\n{\"ok\":true}\n```",
            "```\n{\"ok\":true}\n```",
            " \u{feff}\r\n```json\r\n{\"ok\":true}\r\n```\r\n ",
            "\u{feff} {\"ok\":true} \n",
        ] {
            let mut response = payload(content);
            normalize_response_with_wire(&mut response, &schema, None).unwrap();
            assert_eq!(
                response["choices"][0]["message"]["content"],
                "{\"ok\":true}"
            );
        }
    }

    #[test]
    fn malformed_wrapped_json_is_not_repaired_or_parsed_as_json5() {
        let schema = json!({"type":"object"});
        for content in [
            "```json\n{\"ok\":true\n```",
            "```json\n{ok:true,}\n```",
            "```json\n{\"pattern\":\"\\s+\"}\n```",
            "```json\n{\"ok\":true}\n",
            "{\"ok\":true}\n```",
        ] {
            let mut response = payload(content);
            let original = response.clone();
            let issue = normalize_response_with_wire(&mut response, &schema, None).unwrap_err();
            assert_eq!(issue.stage, "json_parse");
            assert_eq!(response, original);
        }
    }

    #[test]
    fn prose_multiple_documents_and_non_json_fences_are_never_extracted() {
        let schema = json!({"type":"object"});
        for content in [
            "Here is the output:\n```json\n{}\n```",
            "```json\n{}\n```\nDone.",
            "```json\n{}\n{}\n```",
            "```json\n{}\n```\n```json\n{}\n```",
            "```javascript\n{}\n```",
            "```json {} ```",
        ] {
            let issue =
                normalize_response_with_wire(&mut payload(content), &schema, None).unwrap_err();
            assert_eq!(issue.stage, "json_parse");
        }
    }

    #[test]
    fn wrapper_removal_preserves_shell_and_tool_argument_string_bytes() {
        let command = "printf '%s\\n' '```json' '\\s+\\.jar' '$HOME'\n\t# 保留原文\u{feff}";
        let arguments = json!({"text":"  ```json\n{literal}\\path\t\"quote\"\u{feff}  "});
        let context = json!({"tools":[{"id":"files.read","inputSchema":{
            "type":"object","properties":{"text":{"type":"string"}},
            "required":["text"],"additionalProperties":false
        }}]});
        let schema = contract("计划生成", &json!({"_opsarkContext":context.to_string()})).unwrap();
        let step = |action| {
            json!({"kind":"observe","title":"read","description":"read",
            "action":action,"expected":"read output","validation":"","risk":"low"})
        };
        let value = json!({"steps":[
            step(json!({"type":"shell","command":command})),
            step(json!({"type":"tool","toolId":"files.read","arguments":arguments}))
        ]});
        let raw = value.to_string();
        let wrapped = format!("\u{feff}\n```json\n{raw}\n```");
        assert_eq!(
            crate::json_contract::normalize_json_wrapper(&wrapped).as_bytes(),
            raw.as_bytes()
        );
        let mut response = payload(&wrapped);
        normalize_response_with_wire(&mut response, &schema, None).unwrap();
        let normalized: Value = serde_json::from_str(
            response["choices"][0]["message"]["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(normalized, value);
        assert_eq!(
            normalized["steps"][0]["action"]["command"]
                .as_str()
                .unwrap()
                .as_bytes(),
            command.as_bytes()
        );
        assert_eq!(
            normalized["steps"][1]["action"]["arguments"]["text"]
                .as_str()
                .unwrap()
                .as_bytes(),
            arguments["text"].as_str().unwrap().as_bytes()
        );
    }

    #[test]
    fn wrapper_removal_keeps_wire_business_and_metadata_validation() {
        let schema = object(
            json!({"command":{"type":"string"}}),
            json!({"limit":{"type":"integer","minimum":1}}),
        );
        let wire = crate::model_schema::compile(&schema).unwrap().schema;
        let mut response = payload("```json\n{\"command\":\"pwd\"}\n```");
        let issue = normalize_response_with_wire(&mut response, &schema, Some(&wire)).unwrap_err();
        assert_eq!(issue.stage, "wire_validation");
        let mut response = payload("```json\n{\"command\":\"pwd\",\"limit\":0}\n```");
        let issue = normalize_response_with_wire(&mut response, &schema, None).unwrap_err();
        assert_eq!(issue.stage, "business_validation");
        let schema = contract("阶段联合决策", &json!({})).unwrap();
        let value = json!({"decision":"adjust","reason":"r","summary":"s","steps":[],"planUpdate":"{invalid"});
        let mut response = payload(&format!("```json\n{value}\n```"));
        let issue = normalize_response_with_wire(&mut response, &schema, None).unwrap_err();
        assert_eq!(issue.stage, "metadata_decode");
    }

    #[test]
    fn valid_fenced_content_cannot_override_refusal_or_invalid_envelope() {
        let schema = json!({"type":"object"});
        let mut response = payload("```json\n{}\n```");
        response["choices"][0]["message"]["refusal"] = json!("refused");
        assert_eq!(
            normalize_response_with_wire(&mut response, &schema, None)
                .unwrap_err()
                .code,
            "MODEL_OUTPUT_REFUSED"
        );
        let mut response = payload("```json\n{}\n```");
        response["choices"][0]["message"]["tool_calls"] = json!([{"id":"unexpected"}]);
        assert_eq!(
            normalize_response_with_wire(&mut response, &schema, None)
                .unwrap_err()
                .stage,
            "response_envelope"
        );
        let mut response = json!({"content":"```json\n{}\n```"});
        assert_eq!(
            normalize_response_with_wire(&mut response, &schema, None)
                .unwrap_err()
                .stage,
            "response_envelope"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn configured(adapter: &str, format: &str, params: Value) -> Value {
        let context = json!({"_modelCapabilities":{"protocol":"chat_completions","version":"v1",
            "structuredOutput":format,"parameterAdapter":adapter,"tokenField":"max_completion_tokens",
            "defaultOutputTokens":5000,"maxOutputTokens":16000},"_requestParameters":params}).to_string();
        json!({"_opsarkContext":context,"messages":[{"role":"user","content":context}],"thinking":{"type":"disabled"}})
    }
    #[test]
    fn blank_budget_uses_connection_limit_but_direct_overrides_are_preserved() {
        let mut input = configured("portable", "json_object", json!({}));
        let (body, _) = prepare(&input, "计划生成", false).unwrap();
        assert_eq!(body["max_completion_tokens"], 16000);
        input["max_tokens"] = json!(777);
        let (body, _) = prepare(&input, "计划生成", false).unwrap();
        assert_eq!(body["max_completion_tokens"], 777);
    }

    #[test]
    fn official_budget_and_parameters_ignore_old_client_overrides() {
        let mut input = configured("gateway", "json_object", json!({"max_tokens":5000,"reasoning_effort":"invalid-stale-value","temperature":0.9}));
        input["max_tokens"] = json!(5000);
        let (body, _) = prepare(&input, "计划生成", true).unwrap();
        assert_eq!(body["max_completion_tokens"], 16000);
        assert!(body.get("reasoning_effort").is_none());
        assert!(body.get("temperature").is_none());
        assert!(!body["messages"].to_string().contains("invalid-stale-value"));
        for name in ["模型结构测试", "模型参数测试"] {
            let (body, _) = prepare(&input, name, true).unwrap();
            assert_eq!(body["max_completion_tokens"], 64);
        }
    }

    #[test]
    fn explicit_probe_budget_is_small_without_changing_business_budget() {
        let input = configured("portable", "json_object", json!({"max_tokens":8000}));
        for name in ["模型结构测试", "模型参数测试"] {
            let (body, _) = prepare(&input, name, false).unwrap();
            assert_eq!(body["max_completion_tokens"], 64);
        }
        let (body, _) = prepare(&input, "计划生成", false).unwrap();
        assert_eq!(body["max_completion_tokens"], 8000);
    }

    #[test]
    fn public_parameter_rules_are_validated_and_round_trip() {
        let input = configured("gateway", "json_object", json!({}));
        let context: Value =
            serde_json::from_str(input["_opsarkContext"].as_str().unwrap()).unwrap();
        let mut caps = context["_modelCapabilities"].clone();
        caps["parameterRules"] = json!({"reasoningEfforts":[], "thinkingEnabled":false,
            "frequencyPenalty":false, "temperatureExclusiveMax":2});
        let public = public_capabilities(&caps).unwrap();
        assert_eq!(public["parameterRules"]["thinkingEnabled"], false);
        caps["parameterRules"]["reasoningEfforts"] = json!(["invented"]);
        assert!(public_capabilities(&caps).is_none());
    }

    #[test]
    fn strict_schema_has_required_nullable_fields_and_maps_budget() {
        let (body, _) = prepare(
            &configured("openai", "json_schema", json!({"max_tokens":1200})),
            "阶段联合决策",
            false,
        )
        .unwrap();
        assert_eq!(body["max_completion_tokens"], 1200);
        assert!(body.get("max_tokens").is_none());
        assert!(!body.to_string().contains("_modelCapabilities"));
        let schema = &body["response_format"]["json_schema"]["schema"];
        assert_eq!(
            schema["required"].as_array().unwrap().len(),
            schema["properties"].as_object().unwrap().len()
        );
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(
            schema["properties"]["planUpdate"]["anyOf"][1]["type"],
            "null"
        );
    }
    #[test]
    fn explicit_parameters_are_not_silently_weakened() {
        assert!(prepare(
            &configured("openai", "json_schema", json!({"thinking":"enabled"})),
            "计划生成",
            false
        )
        .unwrap_err()
        .contains("MODEL_PARAMETER_UNSUPPORTED"));
        assert!(prepare(
            &configured(
                "deepseek",
                "json_object",
                json!({"reasoning_effort":"medium"})
            ),
            "计划生成",
            false
        )
        .is_err());
        let (body, _) = prepare(
            &configured("portable", "unknown", json!({"thinking":"enabled"})),
            "计划生成",
            false,
        )
        .unwrap();
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["response_format"]["type"], "json_object");
        assert!(prepare(
            &configured("gateway", "json_object", json!({})),
            "计划生成",
            false
        )
        .is_err());
        assert!(prepare(
            &configured("portable", "json_object", json!({"max_tokens":17000})),
            "计划生成",
            false
        )
        .unwrap_err()
        .contains("MODEL_OUTPUT_BUDGET_INVALID"));
    }
    #[test]
    fn classification_null_constraints_survive_wire_normalization() {
        for intent in ["answer", "terminal_context"] {
            let mut payload = json!({"choices":[{"message":{"content":json!({"intent":intent,"answer":"ok","relation":null,"constraints":null,"selectedSkillIds":[],"terminalContextLines":0}).to_string()}}]});
            normalize_response(&mut payload, &contract("需求理解", &json!({})).unwrap()).unwrap();
            let value: Value = serde_json::from_str(
                payload["choices"][0]["message"]["content"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            assert!(value.get("constraints").unwrap().is_null());
            assert!(serde_json::from_value::<crate::AiRequirementDecision>(value).is_ok());
        }
    }
    #[test]
    fn explicit_deepseek_effort_enables_thinking_without_changing_intensity() {
        let (body, _) = prepare(
            &configured(
                "deepseek",
                "json_object",
                json!({"reasoning_effort":"high"}),
            ),
            "计划生成",
            false,
        )
        .unwrap();
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(body["thinking"]["type"], "enabled");
        assert!(prepare(
            &configured(
                "deepseek",
                "json_object",
                json!({"reasoning_effort":"high","thinking":"disabled"})
            ),
            "计划生成",
            false
        )
        .is_err());
    }
    #[test]
    fn portable_has_explicit_budget_without_vendor_thinking() {
        let (body, _) = prepare(
            &json!({"thinking":{"type":"disabled"},"model":"custom","messages":[]}),
            "阶段联合决策",
            false,
        )
        .unwrap();
        assert_eq!(body["max_tokens"], 16384);
        assert!(body.get("thinking").is_none());
        assert_eq!(body["response_format"]["type"], "json_object");
    }
    #[test]
    fn validates_actual_tool_ranges_patterns_and_metadata_names() {
        let tools = json!([{"id":"check","inputSchema":{"type":"object","properties":{
            "port":{"type":"integer","minimum":1,"maximum":65535},
            "recovery":{"type":"string","pattern":"^safe$"}},
            "required":["port","recovery"],"additionalProperties":false}}]);
        let schema = action_schema(&tools);
        for args in [
            json!({"port":0,"recovery":"safe"}),
            json!({"port":22,"recovery":{}}),
            json!({"port":22,"recovery":"unsafe"}),
        ] {
            assert!(!validates(
                &json!({"type":"tool","toolId":"check","arguments":args}),
                &schema
            ));
        }
        assert!(validates(
            &json!({"type":"tool","toolId":"check","arguments":{"port":22.0,"recovery":"safe"}}),
            &schema
        ));
    }

    #[test]
    fn metadata_decoding_is_schema_scoped_and_rejects_non_objects() {
        let schema = contract("阶段联合决策", &json!({})).unwrap();
        for metadata in [json!({"reason":"r"}), json!("{\"reason\":\"r\"}")] {
            let mut response = json!({"choices":[{"message":{"content":json!({"decision":"adjust","reason":"r","summary":"s","steps":[],"planUpdate":metadata}).to_string()}}]});
            normalize_response(&mut response, &schema).unwrap();
            let decoded: Value = serde_json::from_str(
                response["choices"][0]["message"]["content"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            assert!(decoded["planUpdate"].is_object());
        }
        let mut response = json!({"choices":[{"message":{"content":json!({"decision":"adjust","reason":"r","summary":"s","steps":[],"planUpdate":"[]"}).to_string()}}]});
        assert!(normalize_response(&mut response, &schema).is_err());
        let schema = object(json!({"recovery":{"type":"string"}}), json!({}));
        let mut value = json!({"recovery":"this is plain tool data"});
        decode_metadata(&mut value, &schema).unwrap();
        assert_eq!(value["recovery"], "this is plain tool data");
    }

    #[test]
    fn contracts_are_operation_specific_and_preserve_advanced_metadata() {
        let schema = contract("阶段联合决策", &json!({})).unwrap();
        let mut response = json!({"choices":[{"message":{"content":json!({"decision":"adjust","reason":"r","summary":"s","steps":[],"planUpdate":"{\"basePlanFingerprint\":\"x\",\"replaceStepIds\":[],\"reason\":\"r\"}"}).to_string()}}]});
        normalize_response(&mut response, &schema).unwrap();
        let decoded: Value = serde_json::from_str(
            response["choices"][0]["message"]["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert!(decoded["planUpdate"].is_object());
        assert!(contract("结果复核", &json!({})).unwrap()["properties"]
            .get("steps")
            .is_none());
        response["choices"][0]["message"]["content"] = json!("{\"decision\":\"complete\"}");
        assert!(normalize_response(&mut response, &schema).is_err());
    }
}

#[cfg(test)]
mod structured_tool_contract_tests {
    use super::*;
    #[test]
    fn tool_identity_selects_its_own_argument_contract() {
        let schema = action_schema(&json!([
            {"id":"first","inputSchema":{"type":"object","required":["host"],"properties":{"host":{"type":"string"}},"additionalProperties":false}},
            {"id":"second","inputSchema":{"type":"object","required":["path"],"properties":{"path":{"type":"string"}},"additionalProperties":false}}
        ]));
        assert!(validates(
            &json!({"type":"tool","toolId":"first","arguments":{"host":"example"}}),
            &schema
        ));
        assert!(!validates(
            &json!({"type":"tool","toolId":"first","arguments":{"path":"/tmp"}}),
            &schema
        ));
        assert!(!validates(
            &json!({"type":"tool","toolId":"unknown","arguments":{"host":"example"}}),
            &schema
        ));
    }
    #[test]
    fn conditional_properties_are_checked_without_rewriting_required() {
        let schema = json!({"type":"object","properties":{"type":{"type":"string"},"options":{"type":"array"}},"required":["type"],"additionalProperties":false,
            "oneOf":[{"properties":{"type":{"enum":["select"]}},"required":["options"]},
                     {"properties":{"type":{"enum":["text"]}},"not":{"required":["options"]}}]});
        assert!(validates(&json!({"type":"text"}), &schema));
        assert!(validates(&json!({"type":"select","options":[]}), &schema));
        assert!(!validates(&json!({"type":"select"}), &schema));
        assert!(!validates(&json!({"type":"text","options":[]}), &schema));
        let mut response = json!({"type":"text","options":null});
        omit_optional_nulls(&mut response, &schema);
        assert_eq!(response, json!({"type":"text"}));
    }
    #[test]
    fn projected_connection_still_requires_real_credentials_after_decoding() {
        let schema = json!({"type":"object","additionalProperties":false,"required":["host"],
            "properties":{"host":{"type":"string"},"credentialRef":{"type":"string"},
                "username":{"type":"string"},"passwordSecretKey":{"type":"string"}},
            "anyOf":[{"required":["credentialRef"]},{"required":["username","passwordSecretKey"]}]});
        let compiled = crate::model_schema::compile(&schema).unwrap();
        let strict = compiled.schema;
        assert_eq!(compiled.report["outcome"], "projection");
        assert!(strict.get("anyOf").is_none());
        let mut value =
            json!({"host":"example","credentialRef":null,"username":null,"passwordSecretKey":null});
        assert!(
            validates(&value, &strict),
            "presence remains a mandatory local residual rule"
        );
        let mut payload = json!({"choices":[{"message":{"content":value.to_string()}}]});
        let diagnostic =
            normalize_response_with_wire(&mut payload, &schema, Some(&strict)).unwrap_err();
        assert_eq!(diagnostic.stage, "business_validation");
        value["username"] = json!("root");
        let mut payload = json!({"choices":[{"message":{"content":value.to_string()}}]});
        assert!(normalize_response_with_wire(&mut payload, &schema, Some(&strict)).is_err());
        value["passwordSecretKey"] = json!("SSH_PASSWORD");
        assert!(validates(&value, &strict));
        omit_optional_nulls(&mut value, &schema);
        assert!(validates(&value, &schema));
        value = json!({"host":"example","credentialRef":"managed-server:target","username":null,"passwordSecretKey":null});
        assert!(validates(&value, &strict));
        omit_optional_nulls(&mut value, &schema);
        assert_eq!(
            value,
            json!({"host":"example","credentialRef":"managed-server:target"})
        );
    }

    #[test]
    fn strict_select_forbids_credentials_but_accepts_null_sentinel() {
        let schema = json!({"type":"object","additionalProperties":false,"required":["type"],
            "properties":{"type":{"type":"string"},"options":{"type":"array","items":{"type":"string"}},"credential":{"type":"object","properties":{},"additionalProperties":false}},
            "oneOf":[{"properties":{"type":{"enum":["select"]}},"required":["options"],"not":{"required":["credential"]}},
                     {"properties":{"type":{"enum":["text","password"]}},"not":{"required":["options"]}}]});
        let strict = crate::model_schema::compile(&schema).unwrap().schema;
        for value in [
            json!({"type":"select","options":[],"credential":null}),
            json!({"type":"text","options":null,"credential":null}),
            json!({"type":"password","options":null,"credential":{}}),
        ] {
            assert!(validates(&value, &strict), "{value}");
            let mut decoded = value;
            omit_optional_nulls(&mut decoded, &schema);
            assert!(validates(&decoded, &schema));
        }
        let mut payload = json!({"choices":[{"message":{"content":json!({"type":"select","options":[],"credential":{}}).to_string()}}]});
        assert!(normalize_response_with_wire(&mut payload, &schema, Some(&strict)).is_err());
    }
}

#[cfg(test)]
mod j0_boundary_tests {
    use super::*;

    fn payload(value: Value) -> Value {
        json!({"choices":[{"message":{"content":value.to_string()},"finish_reason":"stop"}]})
    }

    #[test]
    fn both_api_protocols_report_the_same_precise_action_contract_error() {
        let schema = contract("计划生成", &json!({})).unwrap();
        let value = json!({"steps":[{"kind":"observe","title":"Read uptime","description":"Read system uptime",
            "action":{"type":"shell","command":"uptime","shell":"bash"},"expected":"Read uptime","validation":"","risk":"low"}]});
        for protocol in ["chat_completions", "responses"] {
            let response_for = |value: &Value| if protocol == "responses" {
                json!({"status":"completed","output":[{"type":"message","role":"assistant","status":"completed",
                    "content":[{"type":"output_text","text":value.to_string()}]}]})
            } else {
                payload(value.clone())
            };
            let mut response = response_for(&value);
            crate::model_protocol::normalize_response(&mut response, protocol).unwrap();
            let original = response.clone();
            let issue = normalize_response_with_wire(&mut response, &schema, None).unwrap_err();
            assert_eq!(issue.code, "MODEL_FORMAT_INVALID");
            assert_eq!(issue.stage, "business_validation");
            assert_eq!(issue.json_pointer.as_deref(), Some("/steps/0/action/shell"));
            assert_eq!(issue.schema_path.as_deref(), Some("/properties/steps/items/properties/action/anyOf/0/additionalProperties"));
            assert_eq!(issue.keyword.as_deref(), Some("additionalProperties"));
            assert_eq!(response, original, "invalid payload must never be cleaned into a valid action");
            let mut valid = value.clone();
            valid["steps"][0]["action"].as_object_mut().unwrap().remove("shell");
            let mut valid_response = response_for(&valid);
            crate::model_protocol::normalize_response(&mut valid_response, protocol).unwrap();
            normalize_response_with_wire(&mut valid_response, &schema, None).unwrap();
            assert_eq!(valid_response["choices"][0]["message"]["content"], valid.to_string());

            let wire = crate::model_schema::compile(&schema).unwrap().schema;
            let mut wire_value = value.clone();
            for field in ["executionScope", "validationScope", "runtimeClass", "sessionContextChange", "recovery", "retryBasis"] {
                wire_value["steps"][0][field] = Value::Null;
            }
            let mut wire_response = response_for(&wire_value);
            crate::model_protocol::normalize_response(&mut wire_response, protocol).unwrap();
            let original = wire_response.clone();
            let issue = normalize_response_with_wire(&mut wire_response, &schema, Some(&wire)).unwrap_err();
            assert_eq!(issue.stage, "wire_validation");
            assert_eq!(issue.json_pointer.as_deref(), Some("/steps/0/action/shell"));
            assert_eq!(issue.keyword.as_deref(), Some("additionalProperties"));
            assert_eq!(wire_response, original);
        }
    }

    #[test]
    fn strict_codec_does_not_leak_into_json_mode_or_drop_required_null() {
        let schema = object(
            json!({"requiredNull":nullable(json!({"type":"string"}))}),
            json!({"port":{"type":"integer","minimum":1}}),
        );
        let wire = crate::model_schema::compile(&schema).unwrap().schema;
        let raw = json!({"requiredNull":null,"port":null});
        assert!(normalize_response_with_wire(&mut payload(raw.clone()), &schema, None).is_err());
        let mut response = payload(raw);
        normalize_response_with_wire(&mut response, &schema, Some(&wire)).unwrap();
        let normalized: Value = serde_json::from_str(
            response["choices"][0]["message"]["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(normalized, json!({"requiredNull":null}));
    }

    #[test]
    fn nullable_array_and_optional_enum_decode_at_their_registered_paths() {
        let item = object(
            json!({"name":{"type":"string"}}),
            json!({"mode":{"type":"string","enum":["read"]}}),
        );
        let schema = object(
            json!({"nested":nullable(item.clone()),
            "rows":nullable(json!({"type":"array","items":item}))}),
            json!({}),
        );
        let wire = crate::model_schema::compile(&schema).unwrap().schema;
        let mut response = payload(
            json!({"nested":{"name":"one","mode":null},"rows":[{"name":"two","mode":null}]}),
        );
        normalize_response_with_wire(&mut response, &schema, Some(&wire)).unwrap();
        let normalized: Value = serde_json::from_str(
            response["choices"][0]["message"]["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            normalized,
            json!({"nested":{"name":"one"},"rows":[{"name":"two"}]})
        );
    }

    #[test]
    fn diagnostics_identify_fields_without_echoing_rejected_values() {
        let schema = contract("计划生成", &json!({})).unwrap();
        let missing = normalize_response(&mut payload(json!({})), &schema).unwrap_err();
        assert_eq!(missing.json_pointer.as_deref(), Some("/steps"));
        assert_eq!(missing.keyword.as_deref(), Some("required"));
        assert!(missing.message.contains("steps"));
        let invalid = normalize_response(
            &mut payload(json!({"steps":"private-password-value"})),
            &schema,
        )
        .unwrap_err();
        assert_eq!(invalid.json_pointer.as_deref(), Some("/steps"));
        assert!(invalid.message.contains("array"));
        assert!(!serde_json::to_string(&invalid)
            .unwrap()
            .contains("private-password-value"));
        let local = output_error(&invalid, Some(200));
        let local: Value =
            serde_json::from_str(local.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap())
                .unwrap();
        assert_eq!(local["modelError"]["httpStatus"], 200);
        assert_eq!(local["modelError"]["origin"], "core");
        let request = error("MODEL_PARAMETER_UNSUPPORTED", "invalid parameter");
        let request: Value = serde_json::from_str(
            request
                .strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX)
                .unwrap(),
        )
        .unwrap();
        assert!(request["modelError"].get("httpStatus").is_none());
    }

    #[test]
    fn malformed_metadata_reports_its_location_without_rewriting_the_payload() {
        let schema = contract("阶段联合决策", &json!({})).unwrap();
        let mut response = payload(
            json!({"decision":"adjust","reason":"r","summary":"s","steps":[],"planUpdate":"{private-value"}),
        );
        let before = response.clone();
        let diagnostic = normalize_response(&mut response, &schema).unwrap_err();
        assert_eq!(diagnostic.stage, "metadata_decode");
        assert_eq!(diagnostic.json_pointer.as_deref(), Some("/planUpdate"));
        assert!(diagnostic.line.is_some());
        assert!(!serde_json::to_string(&diagnostic)
            .unwrap()
            .contains("private-value"));
        assert_eq!(response, before);
    }

    #[test]
    fn compilation_report_and_operation_marker_stay_out_of_provider_json() {
        let caps = json!({"protocol":"chat_completions","version":"v1","structuredOutput":"json_schema",
            "parameterAdapter":"portable","tokenField":"max_tokens","defaultOutputTokens":5000,"maxOutputTokens":16000});
        let body = json!({"model":"test","_opsarkOperationContract":"plan.repair@1",
            "messages":[{"role":"system","content":"Return the requested JSON contract."}],
            "_opsarkContext":json!({"_modelCapabilities":caps}).to_string()});
        let (prepared, _) = prepare(&body, "计划生成", false).unwrap();
        assert_eq!(
            prepared["_opsarkSchemaCompilation"]["contractVersion"],
            "plan.repair@1"
        );
        assert_eq!(
            prepared["_opsarkSchemaCompilation"]["capabilityVersion"],
            "v1"
        );
        let (wire, log) = crate::prompt_layers::prepare_request(&prepared);
        for key in [
            "_opsarkSchemaCompilation",
            "_opsarkOperationContract",
            "_opsarkContext",
        ] {
            assert!(wire.get(key).is_none());
        }
        assert_eq!(
            log["schemaCompilation"],
            prepared["_opsarkSchemaCompilation"]
        );
    }
}

#[cfg(test)]
mod stage_scope_regressions {
    use super::*;

    #[test]
    fn both_apis_and_output_modes_reject_task_timeout_and_scope_failures_before_admission() {
        let schema = contract("阶段联合决策", &json!({})).unwrap();
        let wire = crate::model_schema::compile(&schema).unwrap().schema;
        for protocol in ["chat_completions", "responses"] {
            for strict in [false, true] {
                let mut value = json!({"decision":"continue","reason":"not deployed","summary":"clone",
                    "steps":[{"kind":"change","title":"clone","description":"clone repository",
                    "action":{"type":"shell","command":"git clone https://example.invalid/repo /opt/repo"},
                    "expected":"worktree exists","validation":"git -C /opt/repo rev-parse HEAD","risk":"low"}]});
                if strict {
                    for field in ["executionScope","validationScope","runtimeClass","sessionContextChange","recovery","retryBasis"] {
                        value["steps"][0][field] = Value::Null;
                    }
                    value["planUpdate"] = Value::Null;
                    value["reconciliation"] = Value::Null;
                    for field in ["requirementReview", "blocking", "issueResolutions"] { value[field] = Value::Null; }
                }
                let check = |value: &Value| {
                    let mut response = if protocol == "responses" {
                        json!({"status":"completed","output":[{"type":"message","role":"assistant","status":"completed",
                            "content":[{"type":"output_text","text":value.to_string()}]}]})
                    } else { json!({"choices":[{"message":{"content":value.to_string()},"finish_reason":"stop"}]}) };
                    crate::model_protocol::normalize_response(&mut response, protocol).unwrap();
                    normalize_response_with_wire(&mut response, &schema, strict.then_some(&wire))
                };
                check(&value).unwrap();
                let mut invalid = value.clone();
                invalid["steps"][0]["action"]["timeoutSeconds"] = json!(600);
                let error = check(&invalid).unwrap_err();
                assert_eq!(error.keyword.as_deref(), Some("additionalProperties"));
                assert_eq!(error.json_pointer.as_deref(), Some("/steps/0/action/timeoutSeconds"));
                for (field, allowed) in [
                    ("executionScope", crate::plan_contract::EXECUTION_SCOPES),
                    ("validationScope", crate::plan_contract::VALIDATION_SCOPES),
                    ("runtimeClass", crate::plan_contract::RUNTIME_CLASSES),
                ] {
                    let mut invalid = value.clone();
                    invalid["steps"][0][field] = json!("只读校验工作树和 HEAD");
                    let error = check(&invalid).unwrap_err();
                    assert_eq!(error.code, "MODEL_FORMAT_INVALID");
                    assert_eq!(error.json_pointer, Some(format!("/steps/0/{field}")));
                    for allowed_value in allowed {
                        invalid["steps"][0][field] = json!(allowed_value);
                        check(&invalid).unwrap();
                    }
                }
            }
        }
    }
}
