use reqwest::StatusCode;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::model_request_lifecycle::{RequestHandle, RequestState};

use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MODEL_RESPONSE_ATTEMPTS: usize = 3;
#[path = "model_format_repair.rs"]
mod format_repair;
#[path = "model_output_budget.rs"]
mod output_budget;

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

pub(crate) fn append_model_log(path: Option<&Path>, event: Value, context: &Value) {
    let Some(path) = path else { return };
    let result = crate::task_logs::append(
        path.parent().unwrap_or(Path::new(".")),
        "model-calls",
        event,
        &crate::prompt_layers::model_log_context(context),
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
    context: &Value,
) -> String {
    let operation_rule = match operation {
        "计划生成" if schema.pointer("/properties/repair").is_some() =>
            "只返回原契约的 repair，保留指定 stepIndex 和替换范围；不能扩展成整份计划。",
        "计划生成" => "只返回原计划契约；保留必要命令和验收，提供当前最小完整步骤，不用空 steps 掩盖错误。",
        "阶段联合决策" | "阶段格式修复（兼容模式）" =>
            "只返回原阶段决策契约，steps 必须为数组；continue 必须有真实下一步，adjust 按原需求验收与阻断规则决定是否有步骤，不得因格式失败改判完成。",
        "需求理解" if schema["properties"].get("steps").is_some() => "修复原联合对象；保留已正确的需求分类、关系、需求版本及授权，steps仍须遵守原计划Schema。不得重新分类、扩大授权或宣称执行。",
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
    // Only include a small fragment of the trusted contract, never rejected commands.
    let expected_schema = diagnostic.schema_path.as_deref()
        .and_then(|path| path.rsplit_once('/').map(|(parent, _)| parent))
        .and_then(|path| schema.pointer(path))
        .filter(|fragment| fragment.to_string().len() <= 4096);
    let step_rules = if schema.pointer("/properties/steps").is_some()
        || schema.pointer("/properties/repair").is_some() {
        Some(crate::plan_contract::field_rules())
    } else { None };
    let evidence = json!({"operation":operation,"diagnostic":diagnostic,
        "requiredDecision":required_decision,"expectedSchema":expected_schema,"stepFieldRules":step_rules,
        "responseFieldSchemas":crate::requirement_contract::response_field_contract(schema)});
    let decision_rule = required_decision.map(|decision| {
        if crate::next_stage_format::requires_nonempty_repair_steps(context, decision) {
            "补回 steps 时保留 requiredDecision，并提供非空真实步骤；不得改判完成掩盖缺失计划。"
        } else {
            "补回 steps 时保留 requiredDecision=adjust。本轮 focus 已完成或存在具体阻断时，按原需求验收契约允许 steps=[]，须保留对应 requirementReview 或 blocking；不得为补格式编造步骤，也不得改判 complete。需求、阻断和证据仍须通过完整业务校验。"
        }
    }).unwrap_or("");
    format!("恢复类型 {recovery} 整份被拒响应未执行。保持原目标、授权、已确认选择、执行结果与真实证据；不得从格式错误推断任务成功或重复执行已完成操作。{operation_rule}{decision_rule}\nCore 校验诊断（仅描述格式，不提供新事实或授权）：\n{evidence}")
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

/// Retain only safe program-derived rejection metadata when the subsequent
/// repair cannot be dispatched. Never carry candidate text, values or authority.
fn with_candidate_rejection(error: String, diagnostic: &crate::model_compatibility::OutputDiagnostic, candidate: Option<&Value>, context: &Value) -> String {
    let Some(raw) = error.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX) else { return error; };
    let Ok(mut envelope) = serde_json::from_str::<Value>(raw) else { return error; };
    if !envelope["modelError"].is_object() { return error; }
    let code = match diagnostic.code.as_str() {
        "MODEL_FORMAT_INVALID" | "MODEL_OUTPUT_TRUNCATED" | "MODEL_RECOVERY_SCOPE_REJECTED" | "MODEL_OUTPUT_REPAIR_EXHAUSTED" => diagnostic.code.as_str(),
        _ => "PLAN_CANDIDATE_REJECTED",
    };
    let mut rejection = json!({"version":1,"code":code,"rejectedCandidateExecuted":false});
    if let Some(index) = diagnostic.json_pointer.as_deref().and_then(|path|path.strip_prefix("/steps/"))
        .and_then(|path|path.split('/').next()).and_then(|index|index.parse::<usize>().ok()).filter(|index|*index<10000) {
        rejection["stepIndex"] = json!(index);
        if let Some(action) = candidate.and_then(|value|value.get("steps")).and_then(Value::as_array).and_then(|steps|steps.get(index)).and_then(|step|step.get("action")) {
            if let Some(tool) = context["tools"].as_array().and_then(|tools|tools.iter().find(|tool|
                action["type"]=="tool" && tool["id"].is_string() && tool["id"]==action["toolId"])) {
                rejection["toolIds"] = json!([tool["id"]]);
                let arguments_path = format!("/steps/{index}/action/arguments");
                if diagnostic.json_pointer.as_deref().is_some_and(|path| path == arguments_path || path.starts_with(&format!("{arguments_path}/"))) {
                    if let Err(issue) = crate::schema_validation::diagnose(&tool["inputSchema"], &action["arguments"]) {
                        rejection["code"] = json!("TOOL_ARGUMENT_INVALID");
                        rejection["keyword"] = json!(issue.keyword);
                    }
                }
            }
        }
    }
    if envelope["modelError"].get("candidateRejection").is_none() { envelope["modelError"]["candidateRejection"] = rejection; }
    format!("{}{envelope}",crate::MODEL_TRACE_ERROR_PREFIX)
}

fn set_field_repair_schema(body: &mut Value, schema: &Value) -> Result<(), String> {
    if body["response_format"]["type"] == "json_schema" {
        let compiled = crate::model_schema::compile(schema).map_err(|failure| {
            crate::model_compatibility::output_error(&crate::model_compatibility::OutputDiagnostic::new(
                "MODEL_SCHEMA_UNSUPPORTED", "schema_compile", &failure.message), None)
        })?;
        body["response_format"]["json_schema"]["schema"] = compiled.schema;
        body["response_format"]["json_schema"]["name"] = json!("opsark_field_repair");
        body["_opsarkSchemaCompilation"] = compiled.report;
    }
    body["_opsarkSchemaCompilation"]["contractVersion"] = json!("format.field-repair@1");
    body["_opsarkSchemaCompilation"]["normalizationVersion"] = json!(crate::model_compatibility::OUTPUT_NORMALIZATION_VERSION);
    Ok(())
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
    post_model_request_inner(url, api_key, body, request_name, timeout_seconds, developer_log_path, None).await
}

/// Private handoff of one received and rejected joint proposal. It is never an
/// executable plan or an IPC result; classification still needs its full gate.
pub(crate) struct RejectedRequirementCandidate {
    pub(crate) payload: Value,
    pub(crate) error: String,
}

pub(crate) async fn post_requirement_candidate(
    url: &str, api_key: &str, body: &Value, timeout_seconds: u64,
    developer_log_path: Option<&Path>, rejected: &mut Option<RejectedRequirementCandidate>,
) -> Result<Value, String> {
    post_model_request_inner(url, api_key, body, "需求理解", timeout_seconds, developer_log_path, Some(rejected)).await
}

fn retain_rejected_requirement_candidate(
    error: String, diagnostic: &crate::model_compatibility::OutputDiagnostic,
    body: &Value, payload: &Value, target: &mut Option<&mut Option<RejectedRequirementCandidate>>,
) -> String {
    let details = error.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok()).unwrap_or_default();
    let model_error = &details["modelError"];
    let budget = &model_error["recoveryBudget"];
    if body["_opsarkOperationContract"] == "requirement.plan@1"
        && diagnostic.code == "MODEL_FORMAT_INVALID"
        && matches!(diagnostic.stage.as_str(), "wire_validation" | "business_validation")
        && diagnostic.json_pointer.as_deref().is_some_and(|p| p == "/steps" || p.starts_with("/steps/"))
        && model_error["dispatchCertainty"] == "response_received"
        && model_error["httpStatus"].as_u64().is_some_and(|n| (200..300).contains(&n))
        && budget["generations"] == 1 && budget["unknownUsageAttempts"] == 0
        && budget["fieldRepairs"] == 0 && budget["candidateRegenerations"] == 0
        && budget["recoveryBlocked"] == false
    {
        if let Some(target) = target.as_mut() {
            **target = Some(RejectedRequirementCandidate { payload: payload.clone(), error: error.clone() });
        }
    }
    error
}

async fn post_model_request_inner(
    url: &str, api_key: &str, body: &Value, request_name: &str, timeout_seconds: u64,
    developer_log_path: Option<&Path>, mut rejected: Option<&mut Option<RejectedRequirementCandidate>>,
) -> Result<Value, String> {
    use crate::model_compatibility::{self as compatibility, OutputDiagnostic};
    use sha2::{Digest, Sha256};
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};
    static JSON_ONLY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let cache = JSON_ONLY.get_or_init(|| Mutex::new(HashSet::new()));
    let context: Value =
        serde_json::from_str(body["_opsarkContext"].as_str().unwrap_or("{}")).unwrap_or_default();
    let scoped_operation = matches!(request_name, "计划生成" | "阶段联合决策" | "阶段格式修复（兼容模式）")
        || request_name == "需求理解" && body["_opsarkOperationContract"] == "requirement.plan@1";
    let output_strategy = if scoped_operation {
        crate::model_budget::output_strategy(&context)?
    } else { None };
    use crate::model_budget::OutputRecoveryStrategy;
    if output_strategy == Some(OutputRecoveryStrategy::Regenerate)
        && (context["workflowPhase"] == "protocol_repair"
            || context.get("planGenerationRepair").is_some()
            || context["operationalRepair"]["rejectedProposal"]["responseMode"] == "metadata_fields"
            || body["_opsarkOperationContract"] == "plan.repair@1") {
        return Err(compatibility::output_error(&OutputDiagnostic::new(
            "MODEL_RECOVERY_SCOPE_REJECTED", "format_repair_scope",
            "局部修复请求不能扩大为候选重生成，必须回到持有原始任务上下文的入口",
        ), None));
    }
    let identity = format!("{:x}", Sha256::digest(api_key.as_bytes()));
    let original_body = body;
    let full_schema = compatibility::full_contract(request_name, body);
    let scoped_repair = full_schema.as_ref().and_then(|schema|
        crate::scoped_model_repair::ScopedRepair::new(request_name, body, schema));
    let scoped_body = scoped_repair.as_ref().map(|repair| repair.request(body));
    let body = scoped_body.as_ref().unwrap_or(body);
    let (mut body, schema) = compatibility::prepare(
        body,
        request_name,
        api_key.starts_with(crate::account::KEY_PREFIX) || api_key.starts_with("omk_"),
    )?;
    // This control is constructed from the original explicit parameter metadata,
    // never from model output or a caller-supplied body marker. Protocol wire()
    // removes it before serialization.
    body.as_object_mut().unwrap().remove("_opsarkBudgetOutputPolicy");
    if let Some(policy) = output_budget::policy(&context, original_body, &body, request_name) {
        body["_opsarkBudgetOutputPolicy"] = policy;
    }
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
    if let Some(strategy) = output_strategy {
        if strategy != OutputRecoveryStrategy::Initial { budget.check_repair_window(timeout_seconds)?; }
        budget.claim_output_strategy(strategy, &body)?;
    }
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
    let mut repair_diagnostics = HashSet::new();
    let mut missing_steps_decision: Option<String> = None;
    let mut repair_message_index: Option<usize> = None;
    let mut field_repair: Option<format_repair::FieldRepair> = None;
    let mut syntax_recovery_used = false;
    let mut read_only_recovery = false;
    // Preserve this operation's actual initial system contract across narrower
    // format-repair schemas. This is local Rust state, never caller metadata or
    // assistant output, and is populated only by the normal prompt projection.
    let mut initial_system_contract = None;
    loop {
        let attempt_output_recovery = if output_strategy.is_some() && field_repair.is_some() {
            json!({"strategy":"field_repair"})
        } else { context["_modelOutputRecovery"].clone() };
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
                "schemaDowngraded":downgraded, "cachedJsonOnly":cached_json_only, "compactRepair":!repair_diagnostics.is_empty(), "formatRepairCount":repair_diagnostics.len(),
                "outputRecovery":attempt_output_recovery, "recoveryBudget":budget.snapshot(),
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
            &mut initial_system_contract,
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
                if field_repair.is_none() { entries.insert(cache_key.clone()); }
                drop(entries);
                body["response_format"] = json!({"type":"json_object"});
                continue;
            }
            other => other?,
        };
        if transport["recoveredOriginal"] == true {
            // Route through the same application-owned context projection as
            // request_sent. The business context keeps IDs under _log; passing
            // it directly to task_logs would silently put this event in system.
            let (_, recovery_log_context) = crate::prompt_layers::prepare_request(
                &crate::model_parameters::prepare(&body)?);
            append_model_log(developer_log_path,json!({
                "event":"response_received","timestampMs":unix_millis(),"requestName":request_name,
                "requestId":transport["requestKey"],"callId":transport["callId"],"status":status,
                "state":"completed","recoveredOriginal":true,"source":transport["recoverySource"],
                "operationElapsedMs":budget.snapshot()["elapsedMs"],"durationMs":budget.snapshot()["elapsedMs"],
                "response":{"usage":payload.get("usage")},
                "contractValidation":"pending","budget":budget.snapshot(),
            }),&recovery_log_context);
        }
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
        let mut prior_value = payload
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .and_then(|content| serde_json::from_str::<Value>(crate::json_contract::normalize_json_wrapper(content)).ok());
        let wire = body
            .pointer("/response_format/json_schema/schema")
            .filter(|_| body["response_format"]["type"] == "json_schema");
        let repairing_field = field_repair.is_some();
        let active_schema = field_repair.as_ref().map(|repair| &repair.schema).or(schema.as_ref());
        let mut invalid = if truncated {
            Some(OutputDiagnostic::new(
                "MODEL_OUTPUT_TRUNCATED",
                "response_status",
                "模型输出达到预算上限，未得到完整结果",
            ))
        } else {
            active_schema.and_then(|schema| {
                compatibility::normalize_response_with_wire(&mut payload, schema, wire).err()
            })
        };
        if invalid.is_none() {
            if let Some(repair) = field_repair.take() {
                let corrected: Value = serde_json::from_str(payload["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
                read_only_recovery |= repair.opens_steps;
                match repair.merge(&corrected, &context) {
                    Ok(merged) => {
                        payload["choices"][0]["message"]["content"] = json!(merged.to_string());
                        prior_value = Some(merged);
                        invalid = schema.as_ref().and_then(|schema|
                            compatibility::normalize_response_with_wire(&mut payload, schema, None).err());
                    }
                    Err(diagnostic) => invalid = Some(diagnostic),
                }
            }
        }
        // A malformed repair envelope never falls back to whole-plan generation.
        let invalid_field_response = repairing_field && field_repair.is_some();
        if invalid.is_none() && read_only_recovery && scoped_operation {
            invalid = prior_value.as_ref().and_then(|value| format_repair::read_only_steps(value, &context).err());
        }
        let mut decision_violation = false;
        if !truncated && invalid.is_none() {
            if let Some(decision) = &missing_steps_decision {
                if prior_value.as_ref().is_none_or(|value| {
                    value["decision"] != decision.as_str()
                        || value["steps"].as_array().is_none_or(|steps| {
                            steps.is_empty()
                                && crate::next_stage_format::requires_nonempty_repair_steps(&context, decision)
                        })
                }) {
                    let mut diagnostic = OutputDiagnostic::new(
                        "MODEL_FORMAT_INVALID",
                        "business_validation",
                        "缺失 steps 的修复必须保留原决策并遵循该决策的步骤规则；continue 必须提供非空真实步骤",
                    );
                    diagnostic.json_pointer = Some("/steps".into());
                    diagnostic.keyword = Some("required".into());
                    decision_violation = true;
                    invalid = Some(diagnostic);
                }
            }
        }
        let Some(mut diagnostic) = invalid else {
            if let Some(repair) = &scoped_repair {
                let fields: Value = serde_json::from_str(payload["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
                let merged = repair.merge(&fields).map_err(|message| model_error_with_context(
                    compatibility::output_error(&OutputDiagnostic::new("MODEL_FORMAT_INVALID", "scoped_repair_merge", &message), Some(status)),
                    &budget, Some(&transport)))?;
                payload["choices"][0]["message"]["content"] = json!(merged.to_string());
                compatibility::normalize_response_with_wire(&mut payload, full_schema.as_ref().unwrap(), None)
                    .map_err(|diagnostic| model_error_with_context(
                        compatibility::output_error(&diagnostic, Some(status)), &budget, Some(&transport)))?;
            }
            return Ok(payload);
        };
        crate::model_protocol::attach_response_diagnostics(&payload, &protocol, &mut diagnostic);
        append_model_log(
            developer_log_path,
            json!({
                "event":"output_validation_failed", "timestampMs":unix_millis(), "requestName":request_name,
                "httpStatus":status, "diagnostic":&diagnostic, "formatRepairUsed":!repair_diagnostics.is_empty(), "formatRepairCount":repair_diagnostics.len(),
                "outputRecovery":attempt_output_recovery, "recoveryBudget":budget.snapshot(),
            }),
            &context,
        );
        // At most three targeted corrections under the same operation budget.
        // Locations, not model prose or parse columns, identify repeated failures.
        let repair_key = json!([diagnostic.code, diagnostic.stage, diagnostic.json_pointer,
            diagnostic.schema_path, diagnostic.keyword]).to_string();
        // The service-level coordinator owns escalation to a fresh candidate.
        // Syntax/truncation cannot establish a frozen field boundary. Return its
        // typed diagnostic without spending the candidate's generation budget.
        let coordinated_stop = output_strategy.is_some_and(|strategy| {
            strategy != OutputRecoveryStrategy::Initial || repairing_field || truncated
                || prior_value.is_none() || !budget.can_repair_output_field()
        });
        if scoped_repair.is_some() || decision_violation || invalid_field_response || diagnostic.stage == "format_repair_scope"
            || coordinated_stop
            || repair_diagnostics.len() >= 3 || repair_diagnostics.contains(&repair_key)
            || schema.is_none() || (!truncated && !diagnostic.repairable()) {
            let error = with_candidate_rejection(model_error_with_context(
                compatibility::output_error(&diagnostic, Some(status)),
                &budget,
                Some(&transport),
            ), &diagnostic, prior_value.as_ref(), &context);
            return Err(retain_rejected_requirement_candidate(error, &diagnostic, original_body, &payload, &mut rejected));
        }
        if missing_steps_decision.is_none() && matches!(request_name, "阶段联合决策" | "阶段格式修复（兼容模式）") {
            missing_steps_decision = prior_value
                .as_ref()
                .filter(|value| value.get("steps").is_none())
                .and_then(|value| value["decision"].as_str())
                .filter(|decision| matches!(*decision, "continue" | "adjust"))
                .map(str::to_owned);
        }
        // Keep one bounded correction under the original operation budget. A
        // candidate field is unexecuted data, never assistant history or authority.
        let base_feedback = format_repair_feedback(
            request_name,
            schema.as_ref().unwrap(),
            &diagnostic,
            truncated,
            missing_steps_decision.as_deref(),
            &context,
        );
        let mut feedback = base_feedback;
        let mut feedback_role = "user";
        if scoped_operation && !truncated {
            if let Some(candidate) = &prior_value {
                let Some(repair) = format_repair::FieldRepair::new(candidate, schema.as_ref().unwrap(), &diagnostic) else {
                    let error = with_candidate_rejection(model_error_with_context(compatibility::output_error(&diagnostic, Some(status)), &budget, Some(&transport)), &diagnostic, prior_value.as_ref(), &context);
                    return Err(retain_rejected_requirement_candidate(error, &diagnostic, original_body, &payload, &mut rejected));
                };
                if output_strategy.is_some() {
                    // Missing executable steps is a candidate-generation problem,
                    // not permission to invent actions inside a field patch.
                    if repair.opens_steps {
                        let error = model_error_with_context(compatibility::output_error(&diagnostic, Some(status)), &budget, Some(&transport));
                        return Err(retain_rejected_requirement_candidate(error, &diagnostic, original_body, &payload, &mut rejected));
                    }
                    budget.check_repair_window(timeout_seconds)
                        .map_err(|error| with_candidate_rejection(error,&diagnostic,prior_value.as_ref(),&context))?;
                    budget.claim_output_strategy(OutputRecoveryStrategy::FieldRepair, &body)
                        .map_err(|error| with_candidate_rejection(error,&diagnostic,prior_value.as_ref(),&context))?;
                }
                feedback = repair.feedback(&diagnostic, &context);
                feedback_role = "system";
                set_field_repair_schema(&mut body, &repair.schema)
                    .map_err(|error| model_error_with_context(error, &budget, Some(&transport)))?;
                field_repair = Some(repair);
            }
        }
        if truncated || prior_value.is_none() {
            if syntax_recovery_used {
                return Err(model_error_with_context(compatibility::output_error(&diagnostic, Some(status)), &budget, Some(&transport)));
            }
            syntax_recovery_used = true;
            read_only_recovery = scoped_operation;
            if scoped_operation {
                feedback.push_str("\n语法失败无法确认被拒动作边界，本次有界重生成只允许 kind=observe 的真实只读取证、空 validation，工具必须是当前目录 effect=read；禁止变更、提问、会话修改或用完成结论掩盖错误。后续仍做命令副作用、授权和证据校验。");
            }
        }
        let Some(messages) = body["messages"].as_array_mut() else {
            return Err(model_error_with_context(
                compatibility::output_error(&diagnostic, Some(status)),
                &budget,
                Some(&transport),
            ));
        };
        // Retain every original authority/evidence message. Only this operation's
        // previous format diagnostic is replaced, so corrections do not pile up
        // or compete with a newer field-level failure.
        let message = json!({"role":feedback_role, "content":feedback});
        if let Some(index) = repair_message_index {
            messages[index] = message;
        } else {
            repair_message_index = Some(messages.len());
            messages.push(message);
        }
        repair_diagnostics.insert(repair_key);
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

#[cfg(test)]
#[path = "model_original_wait_tests.rs"]
mod original_wait_tests;

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
        "adapterHttpStatus",
        "adapterReason",
    ] {
        if let Some(value) = diagnostic.get(field) {
            error[field] = value.clone();
        }
    }
    let payload = json!({"message":message,"modelError":error});
    format!("{}{payload}", crate::MODEL_TRACE_ERROR_PREFIX)
}

/// The local adapter protocol is opt-in Core configuration, never inferred from
/// provider errors. Every observation binds the original exact wire bytes.
async fn recover_local_adapter(lifecycle: &RequestHandle, authorization: &str, allowance_seconds:u64) -> Result<Option<(Value,u16)>,String> {
    recover_local_adapter_with_budget(lifecycle,authorization,Duration::from_secs(allowance_seconds.min(15)),None,false).await
}

/// Only a still-awaited native invocation may consume its original result.
/// Historical UI reconciliation uses the short wrapper above and never resumes
/// a workflow. Both task requests and synchronous configuration probes qualify.
async fn await_local_adapter(lifecycle: &RequestHandle, authorization: &str, budget: &crate::model_budget::OperationBudget) -> Result<Option<(Value,u16)>,String> {
    recover_local_adapter_with_budget(lifecycle,authorization,Duration::from_secs(15),Some(budget),false).await
}

async fn recover_local_adapter_with_budget(lifecycle: &RequestHandle, authorization: &str, initial_allowance:Duration,
    budget: Option<&crate::model_budget::OperationBudget>, accounting_only: bool) -> Result<Option<(Value,u16)>,String> {
    let original = lifecycle.read()?;
    let adapter = original.adapter.as_ref().ok_or_else(|| transport_error("MODEL_ADAPTER_UNAVAILABLE","request_lifecycle",
        "原请求没有受信任的结果查询适配器",&original.request_id,None,false,&json!({})))?;
    let operation_deadline = budget.map(|budget|budget.recovery_deadline()).transpose()?;
    let short_deadline = Instant::now() + initial_allowance;
    let mut deadline = operation_deadline.map_or(short_deadline,|limit|limit.min(short_deadline));
    let client = build_model_client(5, false)?;
    let mut cancel_sent = false;
    let mut cancellation_deadline = None;
    let mut interval = Duration::from_millis(350);
    while Instant::now() < deadline {
        let current = lifecycle.read()?;
        // A concurrent original response can finish while this lookup is open.
        // Historical cancellation does not make an already terminal call active.
        if matches!(current.state,RequestState::Completed|RequestState::Cancelled) {
            settle_persisted_model_usage(&current)?;
            return Ok(if current.state == RequestState::Completed {
                current.response.zip(current.http_status)
            } else { None });
        }
        // Check the same operation's blocked/deadline state without renewing it.
        if let Some(budget) = budget { deadline = deadline.min(budget.recovery_deadline()?); }
        if current.cancel_requested && !accounting_only {
            let end = *cancellation_deadline.get_or_insert_with(|| Instant::now() + Duration::from_secs(15));
            deadline = deadline.min(end);
        }
        if current.cancel_requested && !cancel_sent && !accounting_only {
            if deadline.saturating_duration_since(Instant::now()).is_zero() { break; }
            // An acknowledgement of receiving a cancellation is not proof of
            // cancellation. Only the bound state query can confirm that state.
            let _ = client.post(adapter.url(&original.request_id,true)?).bearer_auth(authorization)
                .json(&json!({"requestId":original.request_id,"requestDigest":original.request_digest}))
                .timeout(deadline.saturating_duration_since(Instant::now()).min(Duration::from_secs(5))).send().await;
            cancel_sent = true;
        }
        let timeout = deadline.saturating_duration_since(Instant::now());
        if timeout.is_zero() { break; }
        let response = client.get(adapter.url(&original.request_id,false)?).bearer_auth(authorization)
            .header("x-opsark-client-request-id",&original.request_id).header("x-opsark-request-digest",&original.request_digest)
            .timeout(timeout.min(Duration::from_secs(5))).send().await;
        if let Ok(mut response) = response {
            if response.status().as_u16() != 200 {
                lifecycle.observe(RequestState::Unknown,"adapter_status_unavailable",None,None,json!({"statusQueryHttpStatus":response.status().as_u16()}))?;
                break;
            }
            let mut bytes = Vec::new();
            let mut complete = false;
            while let Ok(chunk) = response.chunk().await {
                let Some(chunk) = chunk else { complete = true; break; };
                if bytes.len() + chunk.len() > 8*1024*1024 { break; }
                bytes.extend_from_slice(&chunk);
            }
            if !complete {
                lifecycle.observe(RequestState::Unknown,"adapter_status_incomplete",None,None,json!({}))?;
                break;
            }
            let Ok(payload) = serde_json::from_slice::<Value>(&bytes) else {
                lifecycle.observe(RequestState::Unknown,"adapter_status_invalid",None,None,json!({}))?;
                break;
            };
            if payload["protocol"] != "opsark-local-v1" || payload["requestId"] != original.request_id
                || payload["requestDigest"] != original.request_digest {
                lifecycle.observe(RequestState::Unknown,"adapter_identity_conflict",None,None,json!({"statusQueryHttpStatus":200}))?;
                break;
            }
            let state = match payload["state"].as_str() {
                Some("queued" | "running") => RequestState::Accepted,
                Some("completed") => RequestState::Completed,
                Some("cancelled") => RequestState::Cancelled,
                Some("not_accepted") => RequestState::NotDispatched,
                Some("unknown") => RequestState::Unknown,
                _ => {
                    lifecycle.observe(RequestState::Unknown,"adapter_state_invalid",None,None,json!({}))?;
                    break;
                },
            };
            let status = payload["httpStatus"].as_u64().filter(|s| (200..600).contains(s)).map(|s|s as u16);
            let reason = payload["reason"].as_str().filter(|reason| !reason.is_empty() && reason.len()<=96
                && reason.bytes().all(|byte|byte.is_ascii_alphanumeric() || byte==b'_'));
            let result = payload.get("response").filter(|p|p.is_object() && matches!(state,RequestState::Completed|RequestState::Cancelled)).cloned();
            if state == RequestState::Completed && (status.is_none() || result.is_none()) {
                lifecycle.observe(RequestState::Unknown,"adapter_result_incomplete",None,None,json!({}))?;
                break;
            }
            let record = lifecycle.observe(state,payload["state"].as_str().unwrap(),status,result.clone(),
                json!({"source":"bound_adapter_status","timing":payload.get("timing"),
                    "adapterReason":reason,
                    "reportedUsage":payload.get("usage"),
                    "usage":if matches!(state,RequestState::Completed|RequestState::Cancelled) {payload.get("usage")} else {None}}))?;
            if let Some(attempt_id) = record.attempt_ids.last().filter(|_| record.task_id.is_some()) {
                let mut attempt = crate::task_model_budget::TaskAttemptBudget::reopen(&record.request_id,attempt_id)?;
                if state == RequestState::NotDispatched { attempt.not_dispatched()?; }
                else if state == RequestState::Completed { if let Some(response) = &result { attempt.settle(response)?; } }
                else if state == RequestState::Cancelled { if let Some(usage) = payload.get("usage") { attempt.settle(&json!({"usage":usage}))?; } }
            }
            if state == RequestState::Completed { return Ok(Some((result.unwrap(),status.unwrap()))); }
            if matches!(state,RequestState::Cancelled | RequestState::NotDispatched | RequestState::Unknown) { return Ok(None); }
            if state == RequestState::Accepted && !record.cancel_requested {
                // Only a fresh authenticated, identity-bound queued/running
                // receipt extends a synchronous lookup to its ORIGINAL budget.
                if let Some(limit) = operation_deadline {
                    deadline = cancellation_deadline.map_or(limit,|cancel_limit|limit.min(cancel_limit));
                }
            }
        } else {
            // Losing reliable status is not permission to keep assuming running.
            lifecycle.observe(RequestState::Unknown,"adapter_status_transport_failed",None,None,json!({}))?;
            break;
        }
        let pause_until = (Instant::now() + interval).min(deadline);
        // Wake promptly on cancellation without changing the polling backoff or
        // permitting sleeps past the original operation deadline.
        while Instant::now() < pause_until {
            if let Some(budget) = budget { budget.recovery_deadline()?; }
            tokio::time::sleep(pause_until.saturating_duration_since(Instant::now()).min(Duration::from_millis(100))).await;
            if cancellation_deadline.is_none() && lifecycle.read()?.cancel_requested { break; }
        }
        interval = (interval * 2).min(Duration::from_secs(2));
    }
    Ok(None)
}

struct AdapterCancelWatch(Option<tokio::task::JoinHandle<()>>);
impl Drop for AdapterCancelWatch { fn drop(&mut self) { if let Some(handle) = &self.0 { handle.abort(); } } }
fn watch_adapter_cancellation(lifecycle: &RequestHandle, authorization: &str) -> Result<AdapterCancelWatch,String> {
    let original = lifecycle.read()?;
    let Some(adapter) = original.adapter else { return Ok(AdapterCancelWatch(None)); };
    let handle = lifecycle.clone();
    let authorization = authorization.to_owned();
    Ok(AdapterCancelWatch(Some(tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let Ok(record) = handle.read() else { return; };
            if matches!(record.state,RequestState::Completed|RequestState::Cancelled) { return; }
            if record.cancel_requested {
                if let (Ok(client),Ok(url)) = (build_model_client(5,false),adapter.url(&record.request_id,true)) {
                    // Keep the original generation socket alive for its usage and
                    // result. Only this request's adapter gets a cancel request.
                    let response = client.post(url).bearer_auth(&authorization)
                        .json(&json!({"requestId":record.request_id,"requestDigest":record.request_digest})).send().await;
                    if let Ok(current) = handle.read() {
                        let _ = handle.observe(current.state,&current.phase,None,None,json!({"source":"cancel_transport",
                            "cancelHttpStatus":response.ok().map(|response|response.status().as_u16()),"providerConfirmed":false}));
                    }
                }
                return;
            }
        }
    }))))
}

fn settle_persisted_model_usage(record: &crate::model_request_lifecycle::RequestRecord) -> Result<(),String> {
    if let Some(attempt_id) = record.attempt_ids.last().filter(|_| record.task_id.is_some()) {
        let mut attempt = crate::task_model_budget::TaskAttemptBudget::reopen(&record.request_id,attempt_id)?;
        if record.state == RequestState::NotDispatched { attempt.not_dispatched()?; }
        else if record.state == RequestState::Completed {
            if let Some(response) = &record.response { attempt.settle(response)?; }
        } else if record.state == RequestState::Cancelled {
            if let Some(usage) = &record.usage { attempt.settle(&json!({"usage":usage}))?; }
        }
    }
    Ok(())
}

/// Explicit recovery records evidence and usage only. The caller must not apply
/// a cancelled or obsolete completion to a newer task/round.
pub(crate) async fn recover_persisted_model_request(task_id:&str,request_id:&str,url:&str,api_key:&str) -> Result<Value,String> {
    lookup_persisted_model_request(task_id,request_id,url,api_key,false).await
}

pub(crate) async fn lookup_persisted_model_request(task_id:&str,request_id:&str,url:&str,api_key:&str,accounting_only:bool) -> Result<Value,String> {
    let authorization = crate::account::authorization(url,api_key).await.map_err(|_|transport_error(
        "MODEL_AUTH_UNAVAILABLE","request_lifecycle","原模型请求的账号授权不可用，未发出恢复查询",request_id,None,false,
        &json!({"dispatchCertainty":"not_dispatched"})))?;
    let handle = RequestHandle::reopen(task_id,request_id,url,&authorization)?;
    let before = handle.read()?;
    if before.adapter.is_none() {
        return Err(transport_error("MODEL_RECOVERY_UNSUPPORTED","request_recovery","当前接口不提供受信任的原结果领取能力；原记录保持不变",request_id,None,false,&json!({})));
    }
    if !matches!(before.state,RequestState::Completed|RequestState::Cancelled) {
        if accounting_only {
            // Accounting is GET-only, even after local cancellation. No stale
            // business result is returned to a model consumer or executor.
            recover_local_adapter_with_budget(&handle,&authorization,Duration::from_secs(5),None,true).await?;
        } else { recover_local_adapter(&handle,&authorization,15).await?; }
    }
    let record = handle.read()?;
    settle_persisted_model_usage(&record)?;
    Ok(json!(record))
}

/// Configuration probes have their own persistent scope, without a task budget.
/// Recovery only records the original result; it never validates or executes it.
pub(crate) async fn recover_persisted_model_probe(probe_id:&str,request_id:&str,url:&str,api_key:&str) -> Result<Value,String> {
    let authorization = crate::account::authorization(url,api_key).await.map_err(|_|transport_error(
        "MODEL_AUTH_UNAVAILABLE","request_lifecycle","原模型测试账号授权不可用，未发出恢复查询",request_id,None,false,
        &json!({"dispatchCertainty":"not_dispatched"})))?;
    let handle=RequestHandle::reopen_probe(probe_id,request_id,url,&authorization)?;
    let before=handle.read()?;
    if !matches!(before.state,RequestState::Completed|RequestState::Cancelled) {
        if before.adapter.is_none() {
            return Err(transport_error("MODEL_RECOVERY_UNSUPPORTED","request_recovery","当前接口不提供原结果查询；取消只隔离本地结果，不能证明服务方停止",request_id,None,false,&json!({})));
        }
        recover_local_adapter(&handle,&authorization,15).await?;
    }
    Ok(json!(handle.read()?))
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
    task_attempt: &mut Option<crate::task_model_budget::TaskAttemptBudget>,
    lifecycle: &RequestHandle,
) -> Result<(Value, u16, Value), String> {
    lifecycle.observe(RequestState::Unknown, "transport_uncertain", http_status, None, original_diagnostic.clone())?;
    if lifecycle.read()?.adapter.is_some() {
        let recovered = await_local_adapter(lifecycle, authorization,budget).await;
        let record = lifecycle.read()?;
        // A persisted receipt does not hide a failed durable usage settlement.
        if let Err(error)=&recovered {
            if !matches!(record.state,RequestState::Completed|RequestState::Cancelled|RequestState::NotDispatched) { budget.block_recovery(); }
            return Err(error.clone());
        }
        if let Some(payload) = &record.response {
            if record.state == RequestState::Completed { attempt.settle(payload); }
        }
        if record.state == RequestState::NotDispatched { attempt.not_dispatched(); }
        // The adapter recovery settles the original persistent task attempt,
        // including after restarts. Never reserve or settle a new attempt here.
        lifecycle.assert_deliverable()?;
        if record.state == RequestState::Cancelled { return Err(crate::model_request_lifecycle::cancel_error(request_id)); }
        if record.state == RequestState::NotDispatched {
            let reason = record.events.iter().rev().find(|event|event["detail"]["source"]=="bound_adapter_status")
                .and_then(|event|event["detail"]["adapterReason"].as_str());
            let busy = http_status==Some(429) || record.http_status==Some(429) || reason==Some("QUEUE_FULL");
            return Err(transport_error(if busy {"MODEL_ADAPTER_BUSY"} else {"MODEL_REQUEST_NOT_ACCEPTED"},"request_recovery",
                if busy {"适配器队列繁忙，已确认原请求未受理；可显式重试，未自动重新派发"} else {"适配器确认原请求未受理，未自动重新派发"},
                request_id,http_status.or(record.http_status),gateway,
                &json!({"dispatchCertainty":"not_dispatched","statusQueryHttpStatus":200,"adapterHttpStatus":record.http_status,
                    "providerCode":reason,"adapterReason":reason})));
        }
        match recovered {
            Ok(Some((payload, status))) if (200..300).contains(&status) =>
                { budget.recovery_deadline()?; return Ok((payload,status,json!({"requestKey":request_id,
                    "callId":record.attempt_ids.last(),"dispatchCertainty":"response_received",
                    "recoveredOriginal":true,"recoverySource":"bound_adapter_status"}))); },
            Ok(Some((payload,status))) => return Err(model_error_with_context(
                http_model_error(StatusCode::from_u16(status).map_err(|e|e.to_string())?,&payload,"原模型请求",false),
                budget,Some(&json!({"requestKey":request_id,"dispatchCertainty":"response_received"})))),
            Ok(None) => {},
            Err(error) => return Err(error),
        }
        budget.block_recovery();
        return Err(transport_error("MODEL_DISPATCH_UNKNOWN","request_recovery","原适配请求仍未完成或不可领取，已保留身份并停止重发",request_id,http_status,gateway,&json!({})));
    }
    let mut diagnostic = json!({});
    crate::model_request_status::copy_diagnostics(&mut diagnostic, original_diagnostic);
    if official {
        let recovered =
            crate::model_request_status::recover(url, authorization, request_id, budget).await;
        if recovered.not_dispatched {
            attempt.not_dispatched();
            if let Some(task_attempt) = task_attempt.as_mut() { task_attempt.not_dispatched()?; }
        } else if let Some(actual) = recovered.diagnostic["actual"].as_u64() {
            attempt.settle_total(actual);
            if let Some(task_attempt) = task_attempt.as_mut() { task_attempt.settle_total(actual)?; }
        }
        if let Some(fields) = recovered.diagnostic.as_object() {
            for (key, value) in fields {
                diagnostic[key] = value.clone();
            }
        }
        budget.block_recovery();
        let state = if recovered.not_dispatched { RequestState::NotDispatched }
            else if recovered.code == "MODEL_RESULT_UNAVAILABLE" || recovered.code == "MODEL_REQUEST_FAILED" { RequestState::Completed }
            else { RequestState::Unknown };
        lifecycle.observe(state,"official_status",http_status,None,diagnostic.clone())?;
        lifecycle.assert_deliverable()?;
        Err(transport_error(
            recovered.code,
            "request_recovery",
            recovered.message,
            request_id,
            http_status,
            gateway,
            &diagnostic,
        ))
    } else {
        budget.block_recovery();
        lifecycle.assert_deliverable()?;
        Err(transport_error("MODEL_DISPATCH_UNKNOWN", "request_recovery",
            "模型请求可能已被处理，但未收到可确认的结果；当前接口没有受信任的状态恢复协议，已停止自动重发",
            request_id, http_status, gateway, &diagnostic))
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
    initial_system_contract: &mut Option<Vec<(usize, Value)>>,
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
    send_model_request_authorized_with_system_contract(
        url,
        api_key,
        &authorization,
        api_key.starts_with(crate::account::KEY_PREFIX),
        body,
        request_name,
        timeout_seconds,
        developer_log_path,
        budget,
        initial_system_contract,
    )
    .await
}

// Existing isolated transport tests send one request, without the operation's
// output-repair loop. Keep their entry point and the same initial projection.
#[cfg(test)]
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
    let mut initial_system_contract = None;
    send_model_request_authorized_with_system_contract(
        url, api_key, authorization, official, body, request_name, timeout_seconds,
        developer_log_path, budget, &mut initial_system_contract,
    ).await
}

fn retain_initial_system_contract(
    body: &mut Value,
    initial: &mut Option<Vec<(usize, Value)>>,
) -> Result<(), String> {
    let scope_error = || crate::model_compatibility::output_error(
        &crate::model_compatibility::OutputDiagnostic::new(
            "MODEL_RECOVERY_SCOPE_REJECTED", "format_repair_scope",
            "格式恢复不能删除原系统合同或改变其消息角色",
        ), None,
    );
    let Some(messages) = body["messages"].as_array_mut() else {
        return if initial.as_ref().is_some_and(|messages| !messages.is_empty()) {
            Err(scope_error())
        } else { Ok(()) };
    };
    if let Some(initial) = initial {
        for (index, contract) in initial {
            let message = messages.get_mut(*index).ok_or_else(scope_error)?;
            if message["role"] != "system" { return Err(scope_error()); }
            *message = contract.clone();
        }
    } else {
        *initial = Some(messages.iter().enumerate()
            .filter(|(_, message)| message["role"] == "system")
            .map(|(index, message)| (index, message.clone())).collect());
    }
    Ok(())
}

async fn send_model_request_authorized_with_system_contract(
    url: &str,
    api_key: &str,
    authorization: &str,
    official: bool,
    body: &Value,
    request_name: &str,
    timeout_seconds: u64,
    developer_log_path: Option<&Path>,
    budget: &crate::model_budget::OperationBudget,
    initial_system_contract: &mut Option<Vec<(usize, Value)>>,
) -> Result<(Value, u16, Value), String> {
    // Account credentials and explicit OpsArk model keys identify a gateway
    // before inspecting its response. Only accounts have the status-query API.
    let gateway = official || api_key.starts_with("omk_");
    let configured_body = crate::model_parameters::prepare(body)?;
    let (mut prepared_body, mut log_context) = crate::prompt_layers::prepare_request(&configured_body);
    retain_initial_system_contract(&mut prepared_body, initial_system_contract)
        .map_err(|error| model_error_with_context(error, budget, None))?;
    let capability_revision = configured_body["_opsarkProtocolConfig"]["capabilitiesV2"]["revision"].as_str().map(str::to_owned);
    let mut prepared_body = crate::model_protocol::wire(&prepared_body)?;
    let mut context: Value = serde_json::from_str(configured_body["_opsarkContext"].as_str().unwrap_or("{}")).unwrap_or_default();
    let task_budget = crate::task_model_budget::TaskBudget::for_context(&context)?;
    let output_budget_adjustment = match (task_budget.as_ref(), output_budget::minimum(&configured_body["_opsarkBudgetOutputPolicy"], &prepared_body)) {
        (Some(task_budget), Some(minimum)) => task_budget.fit_output_cap(&mut prepared_body, minimum)?,
        _ => None,
    };
    let generation = budget.start_generation(&prepared_body)?;
    let (operation_id, started_at_ms) = budget.lifecycle_identity();
    // Use the budget's already validated private identity. prepare() correctly
    // removed _modelRecovery from the provider context; reconstructing it from
    // that projection previously fabricated zero start times in real requests.
    context.as_object_mut().ok_or_else(|| transport_error("MODEL_REQUEST_INVALID","request_lifecycle",
        "模型请求上下文不是合法对象",&generation.request_id,None,gateway,&json!({"dispatchCertainty":"not_dispatched"})))?
        .insert("_modelRecovery".into(),json!({"operationId":operation_id,"startedAtMs":started_at_ms}));
    let operation_id = operation_id.as_str();
    let lifecycle = RequestHandle::prepare(developer_log_path,&context,url,authorization,&prepared_body,
        operation_id,generation.generation_index)?;
    let request_id = &lifecycle.id;
    let original = lifecycle.read()?;
    let _cancel_watch = watch_adapter_cancellation(&lifecycle,authorization)?;
    if original.state != RequestState::NotDispatched {
        lifecycle.assert_deliverable()?;
        settle_persisted_model_usage(&original)?;
        if original.state == RequestState::Completed {
            if let (Some(payload),Some(status)) = (original.response,original.http_status) {
                if (200..300).contains(&status) { return Ok((payload,status,json!({"requestKey":request_id,"callId":original.attempt_ids.last(),
                    "recoveredOriginal":true,"recoverySource":"persisted_original"}))); }
            }
        }
        if original.adapter.is_some() {
            if let Some((payload,status)) = await_local_adapter(&lifecycle,authorization,budget).await? {
                lifecycle.assert_deliverable()?;
                budget.recovery_deadline()?;
                if (200..300).contains(&status) { return Ok((payload,status,json!({"requestKey":request_id,"callId":lifecycle.read()?.attempt_ids.last(),
                    "recoveredOriginal":true,"recoverySource":"bound_adapter_status"}))); }
            }
        }
        return Err(transport_error("MODEL_DISPATCH_UNKNOWN","request_recovery","原模型请求已登记且可能派发，禁止重复发送",request_id,None,gateway,&json!({})));
    }
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
        let mut task_attempt = match task_budget.as_ref().map(|budget| budget.reserve(request_id,&call_id,operation_id,&prepared_body)).transpose() {
            Ok(attempt) => attempt,
            Err(error) => {
                attempt_budget.not_dispatched();
                let diagnostic = error.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX)
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                    .and_then(|payload| payload.get("modelError").cloned());
                append_model_log(developer_log_path, json!({
                    "event":"task_budget_rejected","timestampMs":unix_millis(),
                    "requestId":request_id,"callId":call_id,"requestName":request_name,
                    "dispatchCertainty":"not_dispatched","diagnostic":diagnostic,
                    "contextMetrics":crate::prompt_layers::request_metrics(body),
                    "contextProjection":log_context.get("contextProjection"),
                    "toolDirectoryProjection":log_context.get("toolDirectoryProjection"),
                    "outputBudgetAdjustment":output_budget_adjustment,
                    "wireDigest":format!("{:x}",Sha256::digest(body.to_string().as_bytes())),
                    "budget":budget.snapshot(),
                }), &log_context);
                return Err(error);
            }
        };
        if let Err(error) = lifecycle.dispatch(&call_id) {
            attempt_budget.not_dispatched();
            if let Some(attempt) = task_attempt.as_mut() { attempt.not_dispatched()?; }
            return Err(error);
        }
        append_model_log(
            developer_log_path,
            json!({
                "event":"request_sent", "callId":call_id,"timestampMs":unix_millis(),
                "requestName":request_name,"attempt":attempt_index,"url":safe_model_url(url),
                "timeoutSeconds":effective_timeout,"request":body,
                "contextMetrics":crate::prompt_layers::request_metrics(body),
                "contextProjection":log_context.get("contextProjection"),"budget":budget.snapshot(),
                "toolDirectoryProjection":log_context.get("toolDirectoryProjection"),
                "outputBudgetAdjustment":output_budget_adjustment,
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
            .header(reqwest::header::CONTENT_TYPE,"application/json")
            .body(body.to_string());
        if original.adapter.is_some() {
            request = request.header("x-opsark-client-request-id",request_id)
                .header("x-opsark-request-digest",&original.request_digest);
        }
        if gateway {
            if let Some(revision) = &capability_revision { request = request.header("X-Opsark-Expected-Capability-Revision", revision); }
        }
        if attempt_index > 1 {
            request = request.header(reqwest::header::ACCEPT_ENCODING, "identity");
        }
        if let Err(error)=lifecycle.assert_deliverable() {
            attempt_budget.not_dispatched();
            if let Some(attempt)=task_attempt.as_mut() { attempt.not_dispatched()?; }
            lifecycle.observe(RequestState::NotDispatched,"cancelled_before_send",None,None,json!({}))?;
            return Err(error);
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
                    if let Some(attempt) = task_attempt.as_mut() { attempt.not_dispatched()?; }
                    lifecycle.observe(RequestState::NotDispatched,"connect_failed",None,None,json!({"attemptId":call_id}))?;
                    lifecycle.assert_deliverable()?;
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
                return recover_uncertain_request(
                    url,
                    authorization,
                    request_id,
                    official,
                    gateway,
                    None,
                    &json!({}),
                    budget,
                    &mut attempt_budget,
                    &mut task_attempt,
                    &lifecycle,
                )
                .await;
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
                return recover_uncertain_request(
                    url,
                    authorization,
                    request_id,
                    official,
                    gateway,
                    Some(status.as_u16()),
                    &transport,
                    budget,
                    &mut attempt_budget,
                    &mut task_attempt,
                    &lifecycle,
                )
                .await
            }
        };
        let mut payload: Value = match serde_json::from_slice(&response_bytes) {
            Ok(payload) => payload,
            Err(error) => {
                // A complete, malformed envelope is not a repairable assistant JSON
                // response. Never regenerate from this boundary failure.
                if official || original.adapter.is_some() {
                    return recover_uncertain_request(
                        url,
                        authorization,
                        request_id,
                        official,
                        gateway,
                        Some(status.as_u16()),
                        &transport,
                        budget,
                        &mut attempt_budget,
                        &mut task_attempt,
                        &lifecycle,
                    )
                    .await;
                }
                if status.is_success() {
                    budget.block_recovery();
                    lifecycle.observe(RequestState::Unknown,"invalid_response",Some(status.as_u16()),None,json!({"bodyBytes":response_bytes.len()}))?;
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
        let standard_completion = payload["choices"].is_array()
            || payload["object"] == "response" && payload["output"].is_array();
        if original.adapter.is_some() && (!status.is_success() || status == StatusCode::ACCEPTED
            || payload["protocol"] == "opsark-local-v1" || !standard_completion) {
            let accepted = payload["protocol"] == "opsark-local-v1" && payload["requestId"] == original.request_id
                && payload["requestDigest"] == original.request_digest && matches!(payload["state"].as_str(),Some("queued"|"running"));
            lifecycle.observe(if accepted {RequestState::Accepted} else {RequestState::Unknown},"adapter_post_ack",Some(status.as_u16()),None,
                json!({"identityVerified":accepted,"phase":payload.get("state")}))?;
            // Queue receipts and adapter HTTP errors are not assistant
            // completions. Only its bound original ledger can decide whether
            // this was rejected, cancelled, unknown, or actually completed.
            return recover_uncertain_request(url,authorization,request_id,official,gateway,Some(status.as_u16()),&transport,
                budget,&mut attempt_budget,&mut task_attempt,&lifecycle).await;
        }
        // Store the complete original envelope before cost settlement, so even a
        // budget-storage failure cannot discard a late result or its real usage.
        lifecycle.observe(RequestState::Unknown,"http_response_received",Some(status.as_u16()),Some(payload.clone()),json!({"upstreamRequestId":upstream_request_id}))?;
        attempt_budget.settle(&payload);
        if let Some(attempt) = task_attempt.as_mut() { attempt.settle(&payload)?; }
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
            lifecycle.observe(RequestState::Completed,"response_received",Some(status.as_u16()),Some(payload.clone()),json!({"upstreamRequestId":upstream_request_id}))?;
            lifecycle.assert_deliverable()?;
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
            if let Some(attempt) = task_attempt.as_mut() { attempt.not_dispatched()?; }
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
        if (official || original.adapter.is_some()) && uncertain {
            return recover_uncertain_request(
                url,
                authorization,
                request_id,
                official,
                gateway,
                Some(status.as_u16()),
                &diagnostic,
                budget,
                &mut attempt_budget,
                &mut task_attempt,
                &lifecycle,
            )
            .await;
        }
        // Direct endpoints and omk keys do not establish idempotent replay. A 5xx
        // response with no dispatch evidence cannot authorize another POST.
        if !official && retryable_http_status(status) && (!gateway || uncertain) {
            return recover_uncertain_request(
                url,
                authorization,
                request_id,
                false,
                gateway,
                Some(status.as_u16()),
                &diagnostic,
                budget,
                &mut attempt_budget,
                &mut task_attempt,
                &lifecycle,
            )
            .await;
        }
        lifecycle.observe(if gateway && diagnostic["dispatchCertainty"] == "not_dispatched" { RequestState::NotDispatched } else { RequestState::Completed },
            "http_error",Some(status.as_u16()),Some(payload.clone()),diagnostic.clone())?;
        lifecycle.assert_deliverable()?;
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
