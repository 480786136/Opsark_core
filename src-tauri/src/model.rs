use reqwest::StatusCode;
use serde_json::{json, Value};

use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MODEL_RESPONSE_ATTEMPTS: usize = 3;

fn correlation_headers(
    api_key: &str,
    context: &Value,
    request_name: &str,
    request_id: &str,
) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    // Only the fixed, authenticated OpsArk gateway receives local task identifiers.
    // BYOK providers must not receive task/server/user context as telemetry.
    if !api_key.starts_with(crate::account::KEY_PREFIX) {
        return headers;
    }
    let valid_id = |value: &str| {
        !value.is_empty()
            && value.len() <= 128
            && value.as_bytes()[0].is_ascii_alphanumeric()
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    };
    if valid_id(request_id) {
        headers.insert("x-opsark-client-request-id", request_id.parse().unwrap());
    }
    let operation = match request_name {
        "计划生成" => "plan",
        "阶段联合决策" => "stage_decision",
        "需求理解" => "requirement",
        "模型参数测试" | "模型结构测试" | "模型业务测试" => "model_check",
        "模型总结" => "summary",
        "结果复核" => "review",
        _ => "other",
    };
    headers.insert("x-opsark-operation", operation.parse().unwrap());
    if context["taskId"].as_str().is_some_and(valid_id) {
        for (field, header) in [
            ("taskId", "x-opsark-task-id"),
            ("roundId", "x-opsark-round-id"),
            ("stepId", "x-opsark-step-id"),
        ] {
            if let Some(value) = context[field].as_str().filter(|value| valid_id(value)) {
                headers.insert(header, value.parse().unwrap());
            }
        }
        if let Some(index) = context["phaseIndex"]
            .as_u64()
            .filter(|index| *index <= 999999)
        {
            headers.insert("x-opsark-phase-index", index.to_string().parse().unwrap());
        }
    }
    headers
}

fn append_model_log(path: Option<&Path>, event: Value, context: &Value) {
    let Some(path) = path else { return };
    let result = crate::task_logs::append(
        path.parent().unwrap_or(Path::new(".")),
        "model-calls",
        event,
        context,
    );
    if let Err(error) = result {
        eprintln!("开发者模型日志写入失败：{error}");
    }
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn safe_model_url(url: &str) -> String {
    let Some((scheme, remainder)) = url.split_once("://") else {
        return url.split(['?', '#']).next().unwrap_or(url).to_string();
    };
    let authority_end = remainder.find('/').unwrap_or(remainder.len());
    let authority = &remainder[..authority_end];
    let host = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    let suffix = &remainder[authority_end..];
    let path = suffix.split(['?', '#']).next().unwrap_or(suffix);
    format!("{scheme}://{host}{path}")
}

fn build_model_client(timeout_seconds: u64, force_http1: bool) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(timeout_seconds))
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(0);
    if force_http1 {
        builder = builder.http1_only();
    }
    builder.build().map_err(|error| error.to_string())
}

async fn wait_before_model_retry(attempt: usize) {
    let delay_ms = match attempt {
        1 => 350,
        _ => 900,
    };
    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
}

pub(crate) struct ModelAvailability {
    pub available: bool,
    pub reason: String,
}

fn retryable_http_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

/// Preserve gateway failures as data across the existing String IPC boundary.
/// Do not forward arbitrary response fields (which may contain provider secrets).
fn http_model_error(
    status: StatusCode,
    payload: &Value,
    request_name: &str,
    gateway: bool,
) -> String {
    let message = payload
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("未知接口错误");
    let source_code = payload
        .pointer("/error/code")
        .and_then(Value::as_str)
        .filter(|code| {
            code.len() <= 96 && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
        .map(str::to_owned);
    let provider_code = if gateway {
        payload
            .pointer("/error/providerCode")
            .or_else(|| payload.pointer("/error/details/providerCode"))
            .and_then(Value::as_str)
            .filter(|code| {
                !code.is_empty()
                    && code.len() <= 96
                    && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            })
            .map(str::to_owned)
    } else {
        source_code.clone()
    };
    let mut details = serde_json::Map::new();
    if let Some(source) = payload.pointer("/error/details").and_then(Value::as_object) {
        if let Some(mode) = source
            .get("billing_mode")
            .and_then(Value::as_str)
            .filter(|mode| matches!(*mode, "direct" | "reserved"))
        {
            details.insert("billing_mode".into(), json!(mode));
        }
        for field in [
            "available_tokens",
            "required_tokens",
            "reserved_tokens",
            "estimated_input_tokens",
            "max_output_tokens",
        ] {
            if let Some(value) = source.get(field).and_then(Value::as_u64) {
                details.insert(field.into(), json!(value));
            }
        }
        if let Some(estimator) = source.get("estimator").and_then(Value::as_str) {
            details.insert(
                "estimator".into(),
                json!(estimator.chars().take(128).collect::<String>()),
            );
        }
        if let Some(exact) = source.get("exact").and_then(Value::as_bool) {
            details.insert("exact".into(), json!(exact));
        }
    }
    // Retry ownership stays in this transport/operation budget; UI callers must
    // not create a fresh generation from a generic HTTP failure.
    let retryable = false;
    let message = format!(
        "{request_name}接口返回 {status}：{}",
        message.chars().take(2048).collect::<String>()
    );
    let invalid_schema = matches!(status.as_u16(), 400 | 422)
        && (crate::next_stage_format::invalid_schema_message(&message)
            || matches!(
                source_code.as_deref().unwrap_or("").to_lowercase().as_str(),
                "invalid_json_schema" | "invalid_schema" | "upstream_schema_invalid"
            ));
    let known_code = source_code.as_deref().filter(|code| {
        matches!(
            *code,
            "INSUFFICIENT_CREDITS"
                | "CREDITS_RECONCILIATION_REQUIRED"
                | "IDEMPOTENCY_KEY_CONFLICT"
                | "REQUEST_ALREADY_ACCEPTED"
                | "REQUEST_STATE_CONFLICT"
                | "GATEWAY_BUSY"
                | "UPSTREAM_SCHEMA_INVALID"
                | "UPSTREAM_SCHEMA_UNSUPPORTED"
                | "UPSTREAM_HTTP_ERROR"
                | "UPSTREAM_CONNECT_FAILED"
                | "UPSTREAM_CONNECT_TIMEOUT"
                | "UPSTREAM_WRITE_FAILED"
                | "UPSTREAM_TIMEOUT"
                | "UPSTREAM_READ_FAILED"
                | "UPSTREAM_RESPONSE_INVALID"
                | "API_PROTOCOL_MISMATCH"
                | "INVALID_RESPONSES_REQUEST"
                | "RESPONSES_STREAM_NOT_SUPPORTED"
                | "PROVIDER_STORAGE_NOT_SUPPORTED"
                | "UPSTREAM_PROTOCOL_MISMATCH"
                | "OUTPUT_CAPABILITY_UNKNOWN"
                | "UNSUPPORTED_MESSAGE"
                | "OFFICIAL_CONTEXT_TOO_LARGE"
                | "INVALID_API_PROTOCOL"
                | "PROTOCOL_PARAMETER_UNSUPPORTED"
                | "PARAMETER_SEMANTICS_CONFLICT"
                | "PRESET_PROTOCOL_UNSUPPORTED"
                | "CAPABILITY_REVISION_MISMATCH"
                | "MODEL_PROTOCOL_UNSUPPORTED"
                | "MODEL_CAPABILITY_UNKNOWN"
                | "MODEL_CAPABILITY_INVALID"
                | "MODEL_PARAMETER_UNSUPPORTED"
                | "MODEL_OUTPUT_BUDGET_INVALID"
                | "PRESET_PARAMETER_UNSUPPORTED"
                | "PRESET_THINKING_INCOMPATIBLE"
                | "INVALID_MODEL_PARAMETERS"
                | "OUTPUT_LIMIT"
                | "PRESET_OUTPUT_LIMIT"
                | "PRESET_MODEL_MISMATCH"
                | "UNKNOWN_MODEL_PRESET"
                | "INVALID_RESPONSE_FORMAT"
        )
    });
    let code = if invalid_schema {
        "MODEL_SCHEMA_INVALID"
    } else {
        known_code.unwrap_or("MODEL_HTTP_ERROR")
    };
    let mut result = json!({
        "message": message,
        "modelError": {
            "httpStatus": status.as_u16(), "code": code, "message": message,
            "origin":"upstream",
            "stage": if invalid_schema { "request_schema" } else { "http_response" },
            "retryable": retryable, "details": details,
        },
    });
    if let Some(provider_code) = provider_code {
        result["modelError"]["providerCode"] = json!(provider_code);
    }
    crate::model_request_status::copy_diagnostics(
        &mut result["modelError"],
        &payload["error"]["details"],
    );
    crate::model_request_status::copy_diagnostics(&mut result["modelError"], &payload["error"]);
    if invalid_schema {
        result["modelError"]["code"] = json!("MODEL_SCHEMA_INVALID");
        result["modelError"]["stage"] = json!("request_schema");
    }
    format!("{}{result}", crate::MODEL_TRACE_ERROR_PREFIX)
}

/// Inspect transport outcomes before treating any assistant content as repairable JSON.
/// Refusals, missing envelopes and native tool calls are separate outcomes.
fn response_outcome(payload: &Value) -> Result<bool, crate::model_compatibility::OutputDiagnostic> {
    use crate::model_compatibility::OutputDiagnostic;
    if payload.get("error").is_some_and(|value| !value.is_null()) {
        return Err(OutputDiagnostic::new("MODEL_PROVIDER_FAILED", "response_status", "模型响应携带错误对象"));
    }
    let invalid_envelope = || {
        OutputDiagnostic::new(
            "MODEL_RESPONSE_INVALID",
            "response_envelope",
            "响应缺少有效的 Chat Completions 消息或结束状态",
        )
    };
    let choice = payload
        .pointer("/choices/0")
        .filter(|value| value.is_object())
        .ok_or_else(invalid_envelope)?;
    let message = choice
        .get("message")
        .filter(|value| value.is_object())
        .ok_or_else(invalid_envelope)?;
    if message
        .get("refusal")
        .is_some_and(|value| !value.is_null() && value.as_str() != Some(""))
    {
        return Err(OutputDiagnostic::new(
            "MODEL_OUTPUT_REFUSED",
            "response_status",
            "模型拒绝生成本次响应",
        ));
    }
    if message.get("tool_calls").is_some_and(|value| {
        !value.is_null() && value.as_array().is_none_or(|calls| !calls.is_empty())
    }) || message
        .get("function_call")
        .is_some_and(|value| !value.is_null())
    {
        return Err(OutputDiagnostic::new(
            "MODEL_TOOL_CALL_UNEXPECTED",
            "response_status",
            "当前操作需要业务输出，模型返回了未请求的原生工具调用",
        ));
    }
    match choice.get("finish_reason").and_then(Value::as_str) {
        Some("stop") if message.get("content").is_some_and(Value::is_string) => Ok(false),
        Some("stop") => Err(invalid_envelope()),
        Some("length") => Ok(true),
        Some("content_filter") => Err(OutputDiagnostic::new(
            "MODEL_CONTENT_FILTERED",
            "response_status",
            "模型响应被内容过滤，不能作为格式错误重试",
        )),
        Some("tool_calls" | "function_call") => Err(OutputDiagnostic::new(
            "MODEL_TOOL_CALL_UNEXPECTED",
            "response_status",
            "当前操作未请求原生工具调用",
        )),
        Some(_) => Err(OutputDiagnostic::new(
            "MODEL_FINISH_UNSUPPORTED",
            "response_status",
            "模型未正常结束，不能使用该响应",
        )),
        None => Err(invalid_envelope()),
    }
}

fn format_repair_feedback(
    operation: &str,
    schema: &Value,
    diagnostic: &crate::model_compatibility::OutputDiagnostic,
    truncated: bool,
    required_decision: Option<&str>,
) -> String {
    let operation_rule = match operation {
        "计划生成" if schema.pointer("/properties/repair").is_some() =>
            "只返回原契约的 repair，保留指定 stepIndex 和替换范围；不能扩展成整份计划。",
        "计划生成" => "只返回原计划契约；保留必要命令和验收，提供当前最小完整步骤，不用空 steps 掩盖错误。",
        "阶段联合决策" | "阶段格式修复（兼容模式）" =>
            "只返回原阶段决策契约；若需要继续或调整，保留真实完整 steps，不得因格式失败改判完成。",
        "需求理解" => "只修复需求理解的 intent、answer、selectedSkillIds、constraints 等原契约字段；不得生成执行计划或新增授权。",
        "结果复核" => "只修复复核的 decision、reason、summary 及原契约验收字段；保持真实执行证据，不得重新生成或执行计划。",
        "Skill 生成" => "只修复 Skill 的 name、category、description、matchRules、instructions 字段；不得返回执行计划。",
        "模型结构测试" => "只返回原探测契约的 ok 字段，不生成计划或其他业务对象。",
        _ => "只返回当前操作原有的输出契约，不切换业务操作。",
    };
    let recovery = if truncated {
        "OUTPUT_TRUNCATED：上次响应达到输出预算而截断。重新输出完整 JSON，不续写残片；缩短描述和摘要，不删除必要字段，不增加预算。"
    } else {
        "FORMAT_INVALID：上次响应未满足结构契约。根据下方 Core 校验诊断重新输出完整 JSON，正确转义引号和换行并补齐必要字段。"
    };
    let evidence =
        json!({"operation":operation,"diagnostic":diagnostic,"requiredDecision":required_decision});
    format!("恢复类型 {recovery} 整份被拒响应未执行。保持原目标、授权、已确认选择、执行结果与真实证据；不得从格式错误推断任务成功或重复执行已完成操作。{operation_rule}\nCore 校验诊断（仅描述格式，不提供新事实或授权）：\n{evidence}")
}

fn model_error_with_context(
    error: String,
    budget: &crate::model_budget::OperationBudget,
    transport: Option<&Value>,
) -> String {
    let Some(raw) = error.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX) else {
        return error;
    };
    let Ok(mut payload) = serde_json::from_str::<Value>(raw) else {
        return error;
    };
    let Some(details) = payload.get_mut("modelError") else {
        return error;
    };
    if let Some(transport) = transport {
        crate::model_request_status::copy_diagnostics(details, transport);
    }
    let snapshot = budget.snapshot();
    details["modelOperationId"] = snapshot["modelOperationId"].clone();
    details["recoveryBudget"] = snapshot;
    if let Some(key) = details["requestKey"].as_str().map(str::to_owned) {
        details["generationId"] = json!(key);
    }
    format!("{}{payload}", crate::MODEL_TRACE_ERROR_PREFIX)
}

/// Sends one model API request with separate, bounded transport and format recovery.
pub(crate) async fn post_model_request(
    url: &str,
    api_key: &str,
    body: &Value,
    request_name: &str,
    timeout_seconds: u64,
    developer_log_path: Option<&Path>,
) -> Result<Value, String> {
    use crate::model_compatibility::{self as compatibility, OutputDiagnostic};
    use sha2::{Digest, Sha256};
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};
    static JSON_ONLY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let cache = JSON_ONLY.get_or_init(|| Mutex::new(HashSet::new()));
    let context: Value =
        serde_json::from_str(body["_opsarkContext"].as_str().unwrap_or("{}")).unwrap_or_default();
    let identity = format!("{:x}", Sha256::digest(api_key.as_bytes()));
    let original_body = body;
    let (mut body, schema) = compatibility::prepare(
        body,
        request_name,
        api_key.starts_with(crate::account::KEY_PREFIX) || api_key.starts_with("omk_"),
    )?;
    let protocol = body["_opsarkProtocolConfig"]["apiProtocol"].as_str().unwrap_or("chat_completions").to_owned();
    let endpoint = crate::model_protocol::endpoint(url, &protocol)?;
    let url = endpoint.as_str();
    let allow_json_downgrade = crate::model_protocol::json_allowed(&body["_opsarkProtocolConfig"]);
    let budget = crate::model_budget::OperationBudget::for_request(
        url,
        api_key,
        original_body,
        timeout_seconds,
    )?;
    // A provider rejection of one wire contract says nothing about another
    // operation, account, revision or schema. Compilation failures never enter this cache.
    let schema_identity = format!(
        "{:x}",
        Sha256::digest(
            json!([schema, body["response_format"]])
                .to_string()
                .as_bytes()
        )
    );
    let cache_key = format!(
        "{url}|{}|{identity}|{}|{request_name}|{schema_identity}",
        body["model"], json!([context["_modelCapabilities"], context["_modelIntegration"]])
    );
    let cached_json_only = cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&cache_key)
        && body["response_format"]["type"] == "json_schema"
        && allow_json_downgrade;
    if cached_json_only {
        body["response_format"] = json!({"type":"json_object"});
    }
    let mut downgraded = false;
    let mut repaired = false;
    let mut missing_steps_decision: Option<String> = None;
    loop {
        append_model_log(
            developer_log_path,
            json!({
                "event":"compatibility_attempt", "timestampMs":unix_millis(), "requestName":request_name,
                "apiProtocol":protocol,
                "capabilityVersion":context["_modelIntegration"]["capabilitiesV2"].get("revision").unwrap_or(&context["_modelCapabilities"]["version"]),
                "outputPolicy":body["_opsarkProtocolConfig"]["outputPolicy"],
                "effectiveOutputMode":body["response_format"]["type"],
                "effectiveOutputTokens":body.get("max_completion_tokens").or_else(|| body.get("max_tokens")),
                "schemaCompilation":body.get("_opsarkSchemaCompilation"),
                "schemaDowngraded":downgraded, "cachedJsonOnly":cached_json_only, "compactRepair":repaired,
            }),
            &context,
        );
        let result = send_model_request(
            url,
            api_key,
            &body,
            request_name,
            timeout_seconds,
            developer_log_path,
            &budget,
        )
        .await
        .map_err(|error| {
            let error = model_error_with_context(error, &budget, None);
            let diagnostic = error
                .strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX)
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .and_then(|payload| payload.get("modelError").cloned());
            append_model_log(
                developer_log_path,
                json!({
                    "event":"model_attempt_terminated","timestampMs":unix_millis(),
                    "requestName":request_name,"diagnostic":diagnostic,"budget":budget.snapshot(),
                }),
                &context,
            );
            error
        });
        let (mut payload, status, transport) = match result {
            Err(error)
                if !downgraded
                    && allow_json_downgrade
                    && body["response_format"]["type"] == "json_schema"
                    && crate::next_stage_format::schema_unsupported(&error) =>
            {
                downgraded = true;
                let mut entries = cache.lock().unwrap_or_else(|e| e.into_inner());
                if entries.len() >= 256 {
                    entries.clear();
                }
                entries.insert(cache_key.clone());
                drop(entries);
                body["response_format"] = json!({"type":"json_object"});
                continue;
            }
            other => other?,
        };
        crate::model_protocol::normalize_response(&mut payload, &protocol).map_err(|mut diagnostic| {
            crate::model_protocol::attach_response_diagnostics(&payload, &protocol, &mut diagnostic);
            model_error_with_context(compatibility::output_error(&diagnostic, Some(status)), &budget, Some(&transport))
        })?;
        let truncated = response_outcome(&payload).map_err(|mut diagnostic| {
            crate::model_protocol::attach_response_diagnostics(&payload, &protocol, &mut diagnostic);
            model_error_with_context(
                compatibility::output_error(&diagnostic, Some(status)),
                &budget,
                Some(&transport),
            )
        })?;
        let prior_value = payload
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .and_then(|content| serde_json::from_str::<Value>(content).ok());
        let wire = body
            .pointer("/response_format/json_schema/schema")
            .filter(|_| body["response_format"]["type"] == "json_schema");
        let mut invalid = if truncated {
            Some(OutputDiagnostic::new(
                "MODEL_OUTPUT_TRUNCATED",
                "response_status",
                "模型输出达到预算上限，未得到完整结果",
            ))
        } else {
            schema.as_ref().and_then(|schema| {
                compatibility::normalize_response_with_wire(&mut payload, schema, wire).err()
            })
        };
        if !truncated && invalid.is_none() {
            if let Some(decision) = &missing_steps_decision {
                if prior_value.as_ref().is_none_or(|value| {
                    value["decision"] != decision.as_str()
                        || value["steps"].as_array().is_none_or(Vec::is_empty)
                }) {
                    let mut diagnostic = OutputDiagnostic::new(
                        "MODEL_FORMAT_INVALID",
                        "business_validation",
                        "缺失 steps 的修复必须保留原决策并提供非空真实步骤",
                    );
                    diagnostic.json_pointer = Some("/steps".into());
                    diagnostic.keyword = Some("required".into());
                    invalid = Some(diagnostic);
                }
            }
        }
        let Some(mut diagnostic) = invalid else {
            return Ok(payload);
        };
        crate::model_protocol::attach_response_diagnostics(&payload, &protocol, &mut diagnostic);
        append_model_log(
            developer_log_path,
            json!({
                "event":"output_validation_failed", "timestampMs":unix_millis(), "requestName":request_name,
                "httpStatus":status, "diagnostic":&diagnostic, "formatRepairUsed":repaired,
            }),
            &context,
        );
        if repaired || schema.is_none() || (!truncated && !diagnostic.repairable()) {
            return Err(model_error_with_context(
                compatibility::output_error(&diagnostic, Some(status)),
                &budget,
                Some(&transport),
            ));
        }
        if matches!(request_name, "阶段联合决策" | "阶段格式修复（兼容模式）") {
            missing_steps_decision = prior_value
                .as_ref()
                .filter(|value| value.get("steps").is_none())
                .and_then(|value| value["decision"].as_str())
                .filter(|decision| matches!(*decision, "continue" | "adjust"))
                .map(str::to_owned);
        }
        // One regeneration, under the original output budget. Never replay rejected
        // prose as assistant history, facts or commands; send only safe diagnostics.
        let feedback = format_repair_feedback(
            request_name,
            schema.as_ref().unwrap(),
            &diagnostic,
            truncated,
            missing_steps_decision.as_deref(),
        );
        let Some(messages) = body["messages"].as_array_mut() else {
            return Err(model_error_with_context(
                compatibility::output_error(&diagnostic, Some(status)),
                &budget,
                Some(&transport),
            ));
        };
        messages.push(json!({"role":"user", "content":feedback}));
        repaired = true;
    }
}

#[cfg(test)]
#[path = "model_protocol_tests.rs"]
mod protocol_tests;

#[cfg(test)]
#[path = "model_compatibility_tests.rs"]
mod compatibility_tests;

#[cfg(test)]
#[path = "model_transport_tests.rs"]
mod transport_tests;

fn transport_error(
    code: &str,
    stage: &str,
    message: &str,
    request_id: &str,
    http_status: Option<u16>,
    official: bool,
    diagnostic: &Value,
) -> String {
    let mut error = json!({
        "code":code,"stage":stage,"origin":"core","message":message,
        "retryable":false,"requestKey":request_id,"dispatchCertainty":"may_have_dispatched",
    });
    if let Some(status) = http_status {
        error["httpStatus"] = json!(status);
        error[if official {
            "gatewayHttpStatus"
        } else {
            "providerHttpStatus"
        }] = json!(status);
    }
    crate::model_request_status::copy_diagnostics(&mut error, diagnostic);
    // The status endpoint may describe a persisted original call. Preserve the
    // actual HTTP response observed by this POST separately from that recovery.
    if let Some(status) = http_status {
        error[if official {
            "gatewayHttpStatus"
        } else {
            "providerHttpStatus"
        }] = json!(status);
    }
    // These identify Core's recovery decision, not the original gateway failure.
    error["origin"] = json!("core");
    error["stage"] = json!(stage);
    for field in [
        "statusQueryHttpStatus",
        "responseAvailable",
        "creditState",
        "billingMode",
        "reserved",
        "actual",
    ] {
        if let Some(value) = diagnostic.get(field) {
            error[field] = value.clone();
        }
    }
    let payload = json!({"message":message,"modelError":error});
    format!("{}{payload}", crate::MODEL_TRACE_ERROR_PREFIX)
}

async fn recover_uncertain_request(
    url: &str,
    authorization: &str,
    request_id: &str,
    official: bool,
    gateway: bool,
    http_status: Option<u16>,
    original_diagnostic: &Value,
    budget: &crate::model_budget::OperationBudget,
    attempt: &mut crate::model_budget::AttemptBudget,
) -> String {
    let mut diagnostic = json!({});
    crate::model_request_status::copy_diagnostics(&mut diagnostic, original_diagnostic);
    if official {
        let recovered =
            crate::model_request_status::recover(url, authorization, request_id, budget).await;
        if recovered.not_dispatched {
            attempt.not_dispatched();
        } else if let Some(actual) = recovered.diagnostic["actual"].as_u64() {
            attempt.settle_total(actual);
        }
        if let Some(fields) = recovered.diagnostic.as_object() {
            for (key, value) in fields {
                diagnostic[key] = value.clone();
            }
        }
        budget.block_recovery();
        transport_error(
            recovered.code,
            "request_recovery",
            recovered.message,
            request_id,
            http_status,
            gateway,
            &diagnostic,
        )
    } else {
        budget.block_recovery();
        transport_error("MODEL_DISPATCH_UNKNOWN", "request_recovery",
            "模型请求可能已被处理，但未收到可确认的结果；当前接口没有受信任的状态恢复协议，已停止自动重发",
            request_id, http_status, gateway, &diagnostic)
    }
}

async fn send_model_request(
    url: &str,
    api_key: &str,
    body: &Value,
    request_name: &str,
    timeout_seconds: u64,
    developer_log_path: Option<&Path>,
    budget: &crate::model_budget::OperationBudget,
) -> Result<(Value, u16, Value), String> {
    // Capture authorization once. Recovery uses this exact account credential;
    // it never falls through to the newly selected account or a redirected origin.
    let authorization = crate::account::authorization(url, api_key)
        .await
        .map_err(|_| {
            // Account errors can describe credential storage or configured addresses.
            // Return only a stable, safe diagnostic and never a success fallback.
            let message = "模型账号授权不可用或已切换，请重新登录并选择模型后重试";
            let error = json!({"message":message,"modelError":{
                "code":"MODEL_AUTH_UNAVAILABLE","origin":"core","stage":"request_auth",
                "message":message,"retryable":false,"dispatchCertainty":"not_dispatched"
            }});
            model_error_with_context(
                format!("{}{error}", crate::MODEL_TRACE_ERROR_PREFIX),
                budget,
                None,
            )
        })?;
    send_model_request_authorized(
        url,
        api_key,
        &authorization,
        api_key.starts_with(crate::account::KEY_PREFIX),
        body,
        request_name,
        timeout_seconds,
        developer_log_path,
        budget,
    )
    .await
}

async fn send_model_request_authorized(
    url: &str,
    api_key: &str,
    authorization: &str,
    official: bool,
    body: &Value,
    request_name: &str,
    timeout_seconds: u64,
    developer_log_path: Option<&Path>,
    budget: &crate::model_budget::OperationBudget,
) -> Result<(Value, u16, Value), String> {
    // Account credentials and explicit OpsArk model keys identify a gateway
    // before inspecting its response. Only accounts have the status-query API.
    let gateway = official || api_key.starts_with("omk_");
    let configured_body = crate::model_parameters::prepare(body)?;
    let (prepared_body, mut log_context) = crate::prompt_layers::prepare_request(&configured_body);
    let capability_revision = configured_body["_opsarkProtocolConfig"]["capabilitiesV2"]["revision"].as_str().map(str::to_owned);
    let prepared_body = crate::model_protocol::wire(&prepared_body)?;
    let generation = budget.start_generation(&prepared_body)?;
    let request_id = &generation.request_id;
    log_context["requestId"] = json!(request_id);
    let body = &prepared_body;
    for attempt_index in 1..=MODEL_RESPONSE_ATTEMPTS {
        let effective_timeout = budget.remaining_timeout_seconds(timeout_seconds)?;
        let started_at = Instant::now();
        let call_id = crate::task_logs::call_id();
        // Local HTTP client construction cannot dispatch a request. Validate it
        // before reserving any transport/token budget for the POST.
        let client =
            build_model_client(effective_timeout, attempt_index == MODEL_RESPONSE_ATTEMPTS)
                .map_err(|_| {
                    model_error_with_context(
                        transport_error(
                            "MODEL_CONNECT_FAILED",
                            "transport_connect",
                            "模型 HTTP 客户端初始化失败，请求未派发",
                            request_id,
                            None,
                            gateway,
                            &json!({"dispatchCertainty":"not_dispatched"}),
                        ),
                        budget,
                        None,
                    )
                })?;
        // No token or dispatch charge until immediately before sending this POST.
        let mut attempt_budget = generation.start_attempt()?;
        append_model_log(
            developer_log_path,
            json!({
                "event":"request_sent", "callId":call_id,"timestampMs":unix_millis(),
                "requestName":request_name,"attempt":attempt_index,"url":safe_model_url(url),
                "timeoutSeconds":effective_timeout,"request":body,
                "contextMetrics":crate::prompt_layers::request_metrics(body),"budget":budget.snapshot(),
            }),
            &log_context,
        );
        let mut request = client
            .post(url)
            .bearer_auth(authorization)
            .header("Idempotency-Key", request_id)
            .header("X-Opsark-Version", env!("CARGO_PKG_VERSION"))
            .headers(correlation_headers(
                api_key,
                &log_context,
                request_name,
                request_id,
            ))
            .header(
                "X-Opsark-Timeout-Seconds",
                effective_timeout.saturating_sub(2).max(1).to_string(),
            )
            .header(reqwest::header::ACCEPT, "application/json")
            .json(body);
        if gateway {
            if let Some(revision) = &capability_revision { request = request.header("X-Opsark-Expected-Capability-Revision", revision); }
        }
        if attempt_index > 1 {
            request = request.header(reqwest::header::ACCEPT_ENCODING, "identity");
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                let definitely_not_dispatched = error.is_connect();
                append_model_log(
                    developer_log_path,
                    json!({
                        "event":"request_failed","callId":call_id,"timestampMs":unix_millis(),
                        "requestName":request_name,"attempt":attempt_index,
                        "dispatchCertainty":if definitely_not_dispatched {"not_dispatched"} else {"may_have_dispatched"},
                        "error":error.to_string(),"budget":budget.snapshot(),
                    }),
                    &log_context,
                );
                if definitely_not_dispatched {
                    attempt_budget.not_dispatched();
                    if attempt_index < MODEL_RESPONSE_ATTEMPTS {
                        wait_before_model_retry(attempt_index).await;
                        continue;
                    }
                    return Err(transport_error(
                        "MODEL_CONNECT_FAILED",
                        "transport_connect",
                        "模型接口连接未建立，请求未派发；有限连接重试已结束",
                        request_id,
                        None,
                        gateway,
                        &json!({"dispatchCertainty":"not_dispatched"}),
                    ));
                }
                return Err(recover_uncertain_request(
                    url,
                    authorization,
                    request_id,
                    official,
                    gateway,
                    None,
                    &json!({}),
                    budget,
                    &mut attempt_budget,
                )
                .await);
            }
        };
        let status = response.status();
        let mut transport =
            json!({"requestKey":request_id,"dispatchCertainty":"response_received"});
        transport[if gateway {
            "gatewayHttpStatus"
        } else {
            "providerHttpStatus"
        }] = json!(status.as_u16());
        if gateway {
            let mut reported = json!({});
            reported["providerHttpStatus"] = response
                .headers()
                .get("x-opsark-provider-http-status")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u16>().ok())
                .map_or(Value::Null, |value| json!(value));
            reported["callId"] = response
                .headers()
                .get("x-opsark-call-id")
                .and_then(|value| value.to_str().ok())
                .map_or(Value::Null, |value| json!(value));
            crate::model_request_status::copy_diagnostics(&mut transport, &reported);
        }
        let upstream_request_id = response
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let response_bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(_) => {
                return Err(recover_uncertain_request(
                    url,
                    authorization,
                    request_id,
                    official,
                    gateway,
                    Some(status.as_u16()),
                    &transport,
                    budget,
                    &mut attempt_budget,
                )
                .await)
            }
        };
        let mut payload: Value = match serde_json::from_slice(&response_bytes) {
            Ok(payload) => payload,
            Err(error) => {
                // A complete, malformed envelope is not a repairable assistant JSON
                // response. Never regenerate from this boundary failure.
                if official {
                    return Err(recover_uncertain_request(
                        url,
                        authorization,
                        request_id,
                        true,
                        gateway,
                        Some(status.as_u16()),
                        &transport,
                        budget,
                        &mut attempt_budget,
                    )
                    .await);
                }
                if status.is_success() {
                    budget.block_recovery();
                    let mut diagnostic = crate::model_compatibility::OutputDiagnostic::new(
                        "MODEL_RESPONSE_INVALID",
                        "response_envelope",
                        "模型接口成功响应不是合法 JSON 信封",
                    );
                    diagnostic.line = Some(error.line());
                    diagnostic.column = Some(error.column());
                    return Err(model_error_with_context(
                        crate::model_compatibility::output_error(
                            &diagnostic,
                            Some(status.as_u16()),
                        ),
                        budget,
                        Some(&transport),
                    ));
                }
                payload_error_value(status, request_name)
            }
        };
        attempt_budget.settle(&payload);
        append_model_log(
            developer_log_path,
            json!({
                "event":"response_received","durationMs":started_at.elapsed().as_millis() as u64,
                "callId":call_id,"timestampMs":unix_millis(),"requestName":request_name,
                "attempt":attempt_index,"status":status.as_u16(),"upstreamRequestId":upstream_request_id,
                "response":payload,"budget":budget.snapshot(),
            }),
            &log_context,
        );
        if status.is_success() {
            return Ok((payload, status.as_u16(), transport));
        }
        if !gateway {
            if let Some(error) = payload.get_mut("error").and_then(Value::as_object_mut) {
                for name in [
                    "origin",
                    "stage",
                    "dispatchCertainty",
                    "gatewayHttpStatus",
                    "callId",
                    "requestKey",
                ] {
                    error.remove(name);
                    if let Some(details) = error.get_mut("details").and_then(Value::as_object_mut) {
                        details.remove(name);
                    }
                }
            }
        }
        let mut diagnostic = json!({});
        crate::model_request_status::copy_diagnostics(
            &mut diagnostic,
            &payload["error"]["details"],
        );
        crate::model_request_status::copy_diagnostics(&mut diagnostic, &payload["error"]);
        if gateway && diagnostic["dispatchCertainty"] == "not_dispatched" {
            attempt_budget.not_dispatched();
        }
        let code = payload
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("");
        let uncertain = code != "IDEMPOTENCY_KEY_CONFLICT"
            && diagnostic["dispatchCertainty"] != "not_dispatched"
            && (diagnostic["dispatchCertainty"] == "may_have_dispatched"
                || status == StatusCode::CONFLICT
                || retryable_http_status(status) && diagnostic["dispatchCertainty"].is_null());
        if official && uncertain {
            return Err(recover_uncertain_request(
                url,
                authorization,
                request_id,
                true,
                gateway,
                Some(status.as_u16()),
                &diagnostic,
                budget,
                &mut attempt_budget,
            )
            .await);
        }
        // Direct endpoints and omk keys do not establish idempotent replay. A 5xx
        // response with no dispatch evidence cannot authorize another POST.
        if !official && retryable_http_status(status) && (!gateway || uncertain) {
            return Err(recover_uncertain_request(
                url,
                authorization,
                request_id,
                false,
                gateway,
                Some(status.as_u16()),
                &diagnostic,
                budget,
                &mut attempt_budget,
            )
            .await);
        }
        if let Some(error) = payload.get_mut("error").and_then(Value::as_object_mut) {
            error.insert(
                if gateway {
                    "gatewayHttpStatus"
                } else {
                    "providerHttpStatus"
                }
                .into(),
                json!(status.as_u16()),
            );
        }
        let mut error = http_model_error(status, &payload, request_name, gateway);
        // Attach the original request identity without overwriting gateway diagnostics.
        let identity = json!({"requestKey":request_id});
        error = model_error_with_context(error, budget, Some(&identity));
        return Err(error);
    }
    unreachable!("each attempt either returns or advances within the fixed limit")
}

/// Frozen offline/paid probe input shared by preview and explicit validation.
pub(crate) fn probe_body(model:&str, mode:&str, parameters:Option<Value>, capabilities:Option<Value>, integration:Option<Value>) -> Result<(Value, &'static str),String> {
    let (content,operation,budget)=match mode {
        "parameters"=>("Reply OK.","模型参数测试",64),
        "structured"=>("Return only this JSON object: {\"ok\":true}","模型结构测试",64),
        "business"=>("Return one JSON object with steps containing exactly one read-only observe shell step: command 'pwd', title 'Read directory', description 'Read current directory', expected 'A directory path', validation an empty string, risk 'low'. Do not execute anything.","模型业务测试",1200),
        _=>return Err(crate::model_compatibility::error("MODEL_PARAMETER_UNSUPPORTED","模型测试模式无效")),
    };
    Ok((json!({"model":model,"messages":[{"role":"user","content":content}],"max_tokens":budget,
        "_opsarkContext":json!({"_modelCapabilities":capabilities,"_modelIntegration":integration,"_requestParameters":parameters}).to_string()}),operation))
}

/// Same compiler, prompt preparation and wire serializer as a real call; no credentials or I/O.
pub(crate) fn preview_model_request(endpoint: &str, body: &Value, request_name: &str, gateway: bool) -> Result<Value, String> {
    let (prepared, _) = crate::model_compatibility::prepare(body, request_name, gateway)?;
    let config = &prepared["_opsarkProtocolConfig"];
    let protocol = config["apiProtocol"].as_str().unwrap_or("chat_completions");
    let endpoint = crate::model_protocol::endpoint(endpoint, protocol)?;
    let (layered, _) = crate::prompt_layers::prepare_request(&prepared);
    let request = crate::model_protocol::wire(&layered)?;
    Ok(json!({"apiProtocol":protocol,"endpoint":endpoint,"model":request["model"],
        "effectiveOutputMode":prepared["response_format"]["type"].as_str().unwrap_or("text"),
        "capabilityRevision":config["capabilitiesV2"]["revision"],"request":request,
        "schemaCompilation":prepared["_opsarkSchemaCompilation"],"diagnostics":[]}))
}

fn payload_error_value(status: StatusCode, request_name: &str) -> Value {
    json!({"error":{"message":format!("{request_name}接口拒绝了请求，HTTP {}，错误响应不是 JSON",status.as_u16())}})
}

/// Extracts the first assistant message while preserving a caller-specific error.
pub(crate) fn message_content<'a>(
    payload: &'a Value,
    missing_error: &str,
) -> Result<&'a str, String> {
    payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| missing_error.to_string())
}

fn evaluate_model_list(status: StatusCode, payload: &Value, model: &str) -> ModelAvailability {
    if !status.is_success() {
        if matches!(status.as_u16(), 404 | 405) {
            return ModelAvailability {
                available: true,
                reason: "自定义接口未提供 /models，已保留配置；最终以真实生成请求为准".into(),
            };
        }
        let message = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("鉴权或接口检查失败");
        return ModelAvailability {
            available: false,
            reason: format!("接口返回 {status}：{message}"),
        };
    }
    let model_ids: Vec<&str> = payload
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .collect();
    if model_ids.contains(&model) {
        ModelAvailability {
            available: true,
            reason: "接口、鉴权和模型名称均可用".into(),
        }
    } else {
        let available = model_ids
            .iter()
            .take(5)
            .copied()
            .collect::<Vec<_>>()
            .join("、");
        ModelAvailability {
            // A custom OpenAI-compatible gateway may hide models, expose aliases,
            // or route an arbitrary caller-provided model ID. A list mismatch is
            // therefore advisory and must not disable an otherwise valid profile.
            available: true,
            reason: if model_ids.is_empty() {
                "接口可访问，但未公布模型列表；最终以真实生成请求为准".into()
            } else {
                format!("接口可访问；/models 未列出自定义模型 ID {model}，仍允许使用。接口公布：{available}")
            },
        }
    }
}

/// Checks model-list availability using the same retry and response rules as generation.
pub(crate) async fn check_model_availability(
    api_key: &str,
    endpoint: &str,
    model: &str,
) -> Result<ModelAvailability, String> {
    if api_key.trim().is_empty() || endpoint.trim().is_empty() || model.trim().is_empty() {
        return Ok(ModelAvailability {
            available: false,
            reason: "模型配置不完整".into(),
        });
    }
    let normalized = crate::model_protocol::endpoint(endpoint, "chat_completions")?;
    let root = normalized.strip_suffix("/chat/completions").expect("normalized endpoint suffix");
    let url = format!("{root}/models");
    let authorization = crate::account::authorization(&url, api_key).await?;
    let mut decoded = None;
    let mut last_error = String::new();
    for attempt in 1..=MODEL_RESPONSE_ATTEMPTS {
        let force_http1 = attempt == MODEL_RESPONSE_ATTEMPTS;
        let client = build_model_client(15, force_http1)
            .map_err(|error| format!("模型列表客户端初始化失败：{error}"))?;
        let mut request = client
            .get(&url)
            .header("X-Opsark-Version", env!("CARGO_PKG_VERSION"))
            .bearer_auth(&authorization)
            .header(reqwest::header::ACCEPT, "application/json");
        if attempt > 1 {
            request = request.header(reqwest::header::ACCEPT_ENCODING, "identity");
        }
        if force_http1 {
            request = request.header(reqwest::header::CONNECTION, "close");
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                last_error = format!("无法连接模型服务：{error}");
                if attempt < MODEL_RESPONSE_ATTEMPTS {
                    wait_before_model_retry(attempt).await;
                    continue;
                }
                break;
            }
        };
        let status = response.status();
        let content_encoding = response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("无")
            .to_string();
        let content_length = response.content_length();
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                last_error = format!(
                    "模型列表接口响应读取不完整（状态 {status}，Content-Encoding {content_encoding}，Content-Length {}）：{error}",
                    content_length.map_or_else(|| "未提供".to_string(), |value| value.to_string())
                );
                if attempt < MODEL_RESPONSE_ATTEMPTS {
                    wait_before_model_retry(attempt).await;
                    continue;
                }
                break;
            }
        };
        if matches!(status.as_u16(), 404 | 405) {
            return Ok(ModelAvailability {
                available: true,
                reason: "自定义接口未提供 /models，已保留配置；最终以真实生成请求为准".into(),
            });
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(payload) => {
                if (status.as_u16() == 429 || status.is_server_error())
                    && attempt < MODEL_RESPONSE_ATTEMPTS
                {
                    let message = payload
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("未知接口错误");
                    last_error = format!("模型列表接口返回 {status}：{message}");
                    wait_before_model_retry(attempt).await;
                    continue;
                }
                decoded = Some((status, payload));
                break;
            }
            Err(error) => {
                last_error = format!(
                    "模型列表接口返回了无法解析的 HTTP 响应（状态 {status}，{} 字节）：{error}",
                    bytes.len()
                );
                if attempt < MODEL_RESPONSE_ATTEMPTS {
                    wait_before_model_retry(attempt).await;
                    continue;
                }
            }
        }
    }
    let (status, payload) = decoded.ok_or_else(|| {
        format!(
            "{last_error}（已自动重试 {} 次）",
            MODEL_RESPONSE_ATTEMPTS - 1
        )
    })?;
    Ok(evaluate_model_list(status, &payload, model))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_assistant_message_content() {
        let payload = json!({"choices": [{"message": {"content": "done"}}]});
        assert_eq!(message_content(&payload, "missing").unwrap(), "done");
        assert_eq!(
            message_content(&json!({}), "missing").unwrap_err(),
            "missing"
        );
    }

    #[test]
    fn evaluates_available_and_missing_models() {
        let payload = json!({"data": [{"id": "model-a"}]});
        assert!(evaluate_model_list(StatusCode::OK, &payload, "model-a").available);
        let missing = evaluate_model_list(StatusCode::OK, &payload, "model-b");
        assert!(missing.available);
        assert!(missing.reason.contains("model-b"));
    }

    #[test]
    fn accepts_custom_endpoint_without_model_listing() {
        let missing = evaluate_model_list(StatusCode::NOT_FOUND, &json!({}), "custom-model");
        assert!(missing.available);
        assert!(missing.reason.contains("真实生成请求"));
    }

    #[test]
    fn preserves_model_api_error_messages() {
        let payload = json!({"error": {"message": "invalid key"}});
        let result = evaluate_model_list(StatusCode::UNAUTHORIZED, &payload, "model-a");
        assert!(!result.available);
        assert!(result.reason.contains("invalid key"));
    }

    #[test]
    fn preserves_credit_failure_without_retry_or_unrelated_details() {
        let encoded = http_model_error(
            StatusCode::PAYMENT_REQUIRED,
            &json!({"error": {
                "code": "INSUFFICIENT_CREDITS", "message": "本次预留额度不足", "retryable": true,
                "details": {"billing_mode": "direct", "available_tokens": 53152, "required_tokens": 93074, "reserved_tokens": 0,
                    "estimated_input_tokens": 88978, "max_output_tokens": 4096,
                    "estimator": "unicode_heuristic_v1", "exact": false, "api_key": "must-not-forward"}
            }}),
            "计划生成",
            true,
        );
        let value: Value = serde_json::from_str(
            encoded
                .strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value["modelError"]["httpStatus"], 402);
        assert_eq!(value["modelError"]["code"], "INSUFFICIENT_CREDITS");
        assert_eq!(value["modelError"]["retryable"], false);
        assert_eq!(value["modelError"]["details"]["available_tokens"], 53152);
        assert_eq!(value["modelError"]["details"]["required_tokens"], 93074);
        assert_eq!(value["modelError"]["details"]["exact"], false);
        assert_eq!(value["modelError"]["details"]["billing_mode"], "direct");
        assert!(!encoded.contains("must-not-forward"));
    }

    #[test]
    fn respects_terminal_reconciliation_and_retryable_server_errors() {
        for (status, payload, expected) in [
            (
                StatusCode::CONFLICT,
                json!({"error":{"code":"CREDITS_RECONCILIATION_REQUIRED"}}),
                false,
            ),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error":{"message":"busy"}}),
                false,
            ),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error":{"retryable":false}}),
                false,
            ),
            (
                StatusCode::TOO_MANY_REQUESTS,
                json!({"error":{"details":{"retryable":false}}}),
                false,
            ),
        ] {
            let encoded = http_model_error(status, &payload, "计划生成", true);
            let value: Value = serde_json::from_str(
                encoded
                    .strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(value["modelError"]["retryable"], expected);
        }
    }

    #[test]
    fn payment_rejections_cross_the_http_boundary_without_transport_retries() {
        use std::io::{Read, Write};
        for body in [
            r#"{"error":{"code":"INSUFFICIENT_CREDITS","message":"insufficient reservation","details":{"available_tokens":53152,"required_tokens":93074}}}"#,
            "gateway rejected this request",
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!(
                "http://{}/v1/chat/completions",
                listener.local_addr().unwrap()
            );
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0_u8; 2048];
                loop {
                    let count = socket.read(&mut chunk).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(end) = bytes.windows(4).position(|x| x == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                        let content_len = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .map(|value| value.trim().parse::<usize>().unwrap())
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + content_len {
                            break;
                        }
                    }
                }
                write!(socket, "HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            });
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let error = runtime
                .block_on(post_model_request(
                    &url,
                    "synthetic-byok",
                    &json!({"model":"test", "messages":[{"role":"user","content":"hello"}]}),
                    "计划生成",
                    3,
                    None,
                ))
                .unwrap_err();
            server.join().unwrap();
            let payload: Value =
                serde_json::from_str(error.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap())
                    .unwrap();
            assert_eq!(payload["modelError"]["httpStatus"], 402);
            assert_eq!(payload["modelError"]["retryable"], false);
            if body.starts_with('{') {
                assert_eq!(payload["modelError"]["code"], "INSUFFICIENT_CREDITS");
                assert_eq!(payload["modelError"]["details"]["available_tokens"], 53152);
            }
        }
    }

    #[test]
    fn builds_standard_and_http1_fallback_clients() {
        assert!(build_model_client(30, false).is_ok());
        assert!(build_model_client(30, true).is_ok());
    }

    #[test]
    fn official_correlation_is_bounded_and_never_sent_to_byok() {
        let context = json!({"taskId":"task-abc", "roundId":"round-1", "stepId":"step-1", "phaseIndex":2,
            "serverId":"private-host", "userId":"forged-user", "title":"private requirement"});
        let headers = correlation_headers("opsark-account:user", &context, "结果复核", "request-1");
        assert_eq!(headers["x-opsark-task-id"], "task-abc");
        assert_eq!(headers["x-opsark-operation"], "review");
        assert_eq!(headers["x-opsark-phase-index"], "2");
        assert_eq!(headers.len(), 6);
        assert!(
            correlation_headers("synthetic-byok", &context, "结果复核", "request-1").is_empty()
        );
        let invalid = correlation_headers(
            "opsark-account:user",
            &json!({"taskId":"bad\nheader", "stepId":"step-1"}),
            "unknown",
            "request-1",
        );
        assert!(!invalid.contains_key("x-opsark-task-id"));
        assert!(!invalid.contains_key("x-opsark-step-id"));
        assert_eq!(invalid["x-opsark-operation"], "other");
    }
}
