use reqwest::StatusCode;
use serde_json::{json, Value};

use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MODEL_RESPONSE_ATTEMPTS: usize = 3;

fn correlation_headers(api_key: &str, context: &Value, request_name: &str, request_id: &str) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    // Only the fixed, authenticated OpsArk gateway receives local task identifiers.
    // BYOK providers must not receive task/server/user context as telemetry.
    if !api_key.starts_with(crate::account::KEY_PREFIX) { return headers; }
    let valid_id = |value: &str| !value.is_empty() && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b));
    if valid_id(request_id) {
        headers.insert("x-opsark-client-request-id", request_id.parse().unwrap());
    }
    let operation = match request_name {
        "计划生成" => "plan", "阶段联合决策" => "stage_decision", "需求理解" => "requirement",
        "模型参数测试" => "model_check", "模型总结" => "summary", "结果复核" => "review", _ => "other",
    };
    headers.insert("x-opsark-operation", operation.parse().unwrap());
    if context["taskId"].as_str().is_some_and(valid_id) {
        for (field, header) in [("taskId", "x-opsark-task-id"), ("roundId", "x-opsark-round-id"), ("stepId", "x-opsark-step-id")] {
            if let Some(value) = context[field].as_str().filter(|value| valid_id(value)) {
                headers.insert(header, value.parse().unwrap());
            }
        }
        if let Some(index) = context["phaseIndex"].as_u64().filter(|index| *index <= 999999) {
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
fn http_model_error(status: StatusCode, payload: &Value, request_name: &str) -> String {
    let message = payload.pointer("/error/message").and_then(Value::as_str)
        .unwrap_or("未知接口错误");
    let code = payload.pointer("/error/code").and_then(Value::as_str)
        .filter(|code| code.len() <= 96 && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
        .map(str::to_owned).unwrap_or_else(|| format!("HTTP_{}", status.as_u16()));
    let mut details = serde_json::Map::new();
    if let Some(source) = payload.pointer("/error/details").and_then(Value::as_object) {
        if let Some(mode) = source.get("billing_mode").and_then(Value::as_str)
            .filter(|mode| matches!(*mode, "direct" | "reserved")) {
            details.insert("billing_mode".into(), json!(mode));
        }
        for field in ["available_tokens", "required_tokens", "reserved_tokens", "estimated_input_tokens", "max_output_tokens"] {
            if let Some(value) = source.get(field).and_then(Value::as_u64) {
                details.insert(field.into(), json!(value));
            }
        }
        if let Some(estimator) = source.get("estimator").and_then(Value::as_str) {
            details.insert("estimator".into(), json!(estimator.chars().take(128).collect::<String>()));
        }
        if let Some(exact) = source.get("exact").and_then(Value::as_bool) {
            details.insert("exact".into(), json!(exact));
        }
    }
    let retryable = retryable_http_status(status)
        && payload.pointer("/error/retryable").and_then(Value::as_bool) != Some(false)
        && payload.pointer("/error/details/retryable").and_then(Value::as_bool) != Some(false);
    let message = format!("{request_name}接口返回 {status}：{}", message.chars().take(2048).collect::<String>());
    let result = json!({
        "message": message,
        "modelError": {
            "httpStatus": status.as_u16(), "code": code, "message": message,
            "retryable": retryable, "details": details,
        },
    });
    format!("{}{result}", crate::MODEL_TRACE_ERROR_PREFIX)
}

/// Sends one model API request with bounded retries for transport and server failures.
pub(crate) async fn post_model_request(
    url: &str,
    api_key: &str,
    body: &Value,
    request_name: &str,
    timeout_seconds: u64,
    developer_log_path: Option<&Path>,
) -> Result<Value, String> {
    let authorization = crate::account::authorization(url, api_key).await?;
    let request_id = crate::task_logs::call_id();
    let configured_body = crate::model_parameters::prepare(body)?;
    let (prepared_body, mut log_context) = crate::prompt_layers::prepare_request(&configured_body);
    log_context["requestId"] = json!(&request_id);
    let body = &prepared_body;
    let mut last_retryable_error = String::new();

    for attempt in 1..=MODEL_RESPONSE_ATTEMPTS {
        let started_at = Instant::now();
        let call_id = crate::task_logs::call_id();
        append_model_log(
            developer_log_path,
            json!({
                "event": "request_sent",
                "callId": &call_id,
                "timestampMs": unix_millis(),
                "requestName": request_name,
                "attempt": attempt,
                "url": safe_model_url(url),
                "timeoutSeconds": timeout_seconds,
                "request": body,
                "contextMetrics": crate::prompt_layers::request_metrics(body),
            }),
            &log_context,
        );
        // 每轮使用新连接，避免重用被上游代理截断的 HTTP 连接。
        // 最后一轮回退到 HTTP/1.1 + identity，兼容有问题的 HTTP/2/压缩网关。
        let force_http1 = attempt == MODEL_RESPONSE_ATTEMPTS;
        let client = build_model_client(timeout_seconds, force_http1)
            .map_err(|error| format!("{request_name}客户端初始化失败：{error}"))?;
        let mut request = client
            .post(url)
            .bearer_auth(&authorization)
            // One logical request retains its identity across transport retries.
            .header("Idempotency-Key", &request_id)
            .header("X-Opsark-Version", env!("CARGO_PKG_VERSION"))
            .headers(correlation_headers(api_key, &log_context, request_name, &request_id))
            // Let the gateway finish and persist a failure before this client deadline.
            .header(
                "X-Opsark-Timeout-Seconds",
                timeout_seconds.saturating_sub(2).max(1).to_string(),
            )
            .header(reqwest::header::ACCEPT, "application/json")
            .json(body);
        if attempt > 1 {
            request = request.header(reqwest::header::ACCEPT_ENCODING, "identity");
        }
        if force_http1 {
            request = request.header(reqwest::header::CONNECTION, "close");
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                last_retryable_error = format!("{request_name}请求失败：{error}");
                append_model_log(
                    developer_log_path,
                    json!({
                        "event": "request_failed",
                        "callId": &call_id,
                        "timestampMs": unix_millis(),
                        "requestName": request_name,
                        "attempt": attempt,
                        "error": &last_retryable_error,
                    }),
                    &log_context,
                );
                if attempt < MODEL_RESPONSE_ATTEMPTS {
                    wait_before_model_retry(attempt).await;
                    continue;
                }
                break;
            }
        };
        let status = response.status();
        let upstream_request_id = response
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("未提供")
            .to_string();
        let content_encoding = response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("无")
            .to_string();
        let content_length = response.content_length();
        let response_bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                last_retryable_error = format!(
                    "{request_name}接口响应读取不完整（状态 {status}，Content-Encoding {content_encoding}，Content-Length {}）：{error}",
                    content_length.map_or_else(|| "未提供".to_string(), |value| value.to_string())
                );
                append_model_log(
                    developer_log_path,
                    json!({
                        "event": "response_failed",
                        "callId": &call_id,
                        "timestampMs": unix_millis(),
                        "requestName": request_name,
                        "attempt": attempt,
                        "status": status.as_u16(),
                        "contentType": &content_type,
                        "contentEncoding": &content_encoding,
                        "contentLength": content_length,
                        "upstreamRequestId": &upstream_request_id,
                        "error": &last_retryable_error,
                    }),
                    &log_context,
                );
                if !status.is_success() && !retryable_http_status(status) {
                    return Err(http_model_error(status, &json!({"error": {"message": last_retryable_error}}), request_name));
                }
                if attempt < MODEL_RESPONSE_ATTEMPTS {
                    wait_before_model_retry(attempt).await;
                    continue;
                }
                break;
            }
        };
        let payload: Value = match serde_json::from_slice(&response_bytes) {
            Ok(payload) => payload,
            Err(error) => {
                last_retryable_error = format!(
                    "{request_name}接口返回了无法解析的 HTTP 响应（状态 {status}，Content-Type {content_type}，{} 字节）：{error}",
                    response_bytes.len()
                );
                append_model_log(
                    developer_log_path,
                    json!({
                        "event": "response_failed",
                        "callId": &call_id,
                        "timestampMs": unix_millis(),
                        "requestName": request_name,
                        "attempt": attempt,
                        "status": status.as_u16(),
                        "contentType": &content_type,
                        "contentEncoding": &content_encoding,
                        "contentLength": content_length,
                        "upstreamRequestId": &upstream_request_id,
                        "responseText": String::from_utf8_lossy(&response_bytes),
                        "error": &last_retryable_error,
                    }),
                    &log_context,
                );
                // A terminal HTTP rejection is not repaired by parsing it again.
                if !status.is_success() && !retryable_http_status(status) {
                    return Err(http_model_error(status, &json!({"error": {"message": last_retryable_error}}), request_name));
                }
                if attempt < MODEL_RESPONSE_ATTEMPTS {
                    wait_before_model_retry(attempt).await;
                    continue;
                }
                break;
            }
        };

        append_model_log(
            developer_log_path,
            json!({
                "event": "response_received",
                "durationMs": started_at.elapsed().as_millis() as u64,
                "callId": &call_id,
                "timestampMs": unix_millis(),
                "requestName": request_name,
                "attempt": attempt,
                "status": status.as_u16(),
                "contentType": &content_type,
                "contentEncoding": &content_encoding,
                "contentLength": content_length,
                "upstreamRequestId": &upstream_request_id,
                "response": &payload,
            }),
            &log_context,
        );

        if status.is_success() {
            return Ok(payload);
        }
        let error = http_model_error(status, &payload, request_name);
        if retryable_http_status(status)
            && payload.pointer("/error/retryable").and_then(Value::as_bool) != Some(false)
            && payload.pointer("/error/details/retryable").and_then(Value::as_bool) != Some(false)
            && attempt < MODEL_RESPONSE_ATTEMPTS
        {
            last_retryable_error = error;
            wait_before_model_retry(attempt).await;
            continue;
        }
        return Err(error);
    }

    Err(format!(
        "{last_retryable_error}（已自动重试 {} 次）",
        MODEL_RESPONSE_ATTEMPTS - 1
    ))
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
        let available = model_ids.iter().take(5).copied().collect::<Vec<_>>().join("、");
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
    let url = format!("{}/models", endpoint.trim_end_matches('/'));
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
        let encoded = http_model_error(StatusCode::PAYMENT_REQUIRED, &json!({"error": {
            "code": "INSUFFICIENT_CREDITS", "message": "本次预留额度不足", "retryable": true,
            "details": {"billing_mode": "direct", "available_tokens": 53152, "required_tokens": 93074, "reserved_tokens": 0,
                "estimated_input_tokens": 88978, "max_output_tokens": 4096,
                "estimator": "unicode_heuristic_v1", "exact": false, "api_key": "must-not-forward"}
        }}), "计划生成");
        let value: Value = serde_json::from_str(encoded.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap()).unwrap();
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
            (StatusCode::CONFLICT, json!({"error":{"code":"CREDITS_RECONCILIATION_REQUIRED"}}), false),
            (StatusCode::SERVICE_UNAVAILABLE, json!({"error":{"message":"busy"}}), true),
            (StatusCode::SERVICE_UNAVAILABLE, json!({"error":{"retryable":false}}), false),
            (StatusCode::TOO_MANY_REQUESTS, json!({"error":{"details":{"retryable":false}}}), false),
        ] {
            let encoded = http_model_error(status, &payload, "计划生成");
            let value: Value = serde_json::from_str(encoded.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap()).unwrap();
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
            let url = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0_u8; 2048];
                loop {
                    let count = socket.read(&mut chunk).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(end) = bytes.windows(4).position(|x| x == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                        let content_len = headers.lines().find_map(|line| line.strip_prefix("content-length:"))
                            .map(|value| value.trim().parse::<usize>().unwrap()).unwrap_or(0);
                        if bytes.len() >= end + 4 + content_len { break; }
                    }
                }
                write!(socket, "HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            });
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            let error = runtime.block_on(post_model_request(
                &url, "synthetic-byok", &json!({"model":"test", "messages":[{"role":"user","content":"hello"}]}),
                "计划生成", 3, None,
            )).unwrap_err();
            server.join().unwrap();
            let payload: Value = serde_json::from_str(error.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap()).unwrap();
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
        assert!(correlation_headers("synthetic-byok", &context, "结果复核", "request-1").is_empty());
        let invalid = correlation_headers("opsark-account:user", &json!({"taskId":"bad\nheader", "stepId":"step-1"}), "unknown", "request-1");
        assert!(!invalid.contains_key("x-opsark-task-id"));
        assert!(!invalid.contains_key("x-opsark-step-id"));
        assert_eq!(invalid["x-opsark-operation"], "other");
    }
}
