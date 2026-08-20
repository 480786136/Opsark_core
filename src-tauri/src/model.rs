use reqwest::StatusCode;
use serde_json::Value;
use std::time::Duration;

const MODEL_RESPONSE_ATTEMPTS: usize = 3;

fn build_model_client(timeout_seconds: u64, force_http1: bool) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(timeout_seconds))
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

/// Sends one model API request with bounded retries for transport and server failures.
pub(crate) async fn post_model_request(
    url: &str,
    api_key: &str,
    body: &Value,
    request_name: &str,
    timeout_seconds: u64,
) -> Result<Value, String> {
    let mut last_retryable_error = String::new();

    for attempt in 1..=MODEL_RESPONSE_ATTEMPTS {
        // 每轮使用新连接，避免重用被上游代理截断的 HTTP 连接。
        // 最后一轮回退到 HTTP/1.1 + identity，兼容有问题的 HTTP/2/压缩网关。
        let force_http1 = attempt == MODEL_RESPONSE_ATTEMPTS;
        let client = build_model_client(timeout_seconds, force_http1)
            .map_err(|error| format!("{request_name}客户端初始化失败：{error}"))?;
        let mut request = client
            .post(url)
            .bearer_auth(api_key)
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
                if attempt < MODEL_RESPONSE_ATTEMPTS {
                    wait_before_model_retry(attempt).await;
                    continue;
                }
                break;
            }
        };
        let status = response.status();
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
                if attempt < MODEL_RESPONSE_ATTEMPTS {
                    wait_before_model_retry(attempt).await;
                    continue;
                }
                break;
            }
        };

        if status.is_success() {
            return Ok(payload);
        }
        let message = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("未知接口错误");
        let error = format!("{request_name}接口返回 {status}：{message}");
        if (status.as_u16() == 429 || status.is_server_error()) && attempt < MODEL_RESPONSE_ATTEMPTS
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
        ModelAvailability {
            available: false,
            reason: if model_ids.is_empty() {
                "接口未返回可用模型".into()
            } else {
                format!("接口可访问，但模型 {model} 不在可用列表中")
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
    let mut decoded = None;
    let mut last_error = String::new();
    for attempt in 1..=MODEL_RESPONSE_ATTEMPTS {
        let force_http1 = attempt == MODEL_RESPONSE_ATTEMPTS;
        let client = build_model_client(15, force_http1)
            .map_err(|error| format!("模型列表客户端初始化失败：{error}"))?;
        let mut request = client
            .get(&url)
            .bearer_auth(api_key)
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
        assert!(!missing.available);
        assert!(missing.reason.contains("model-b"));
    }

    #[test]
    fn preserves_model_api_error_messages() {
        let payload = json!({"error": {"message": "invalid key"}});
        let result = evaluate_model_list(StatusCode::UNAUTHORIZED, &payload, "model-a");
        assert!(!result.available);
        assert!(result.reason.contains("invalid key"));
    }

    #[test]
    fn builds_standard_and_http1_fallback_clients() {
        assert!(build_model_client(30, false).is_ok());
        assert!(build_model_client(30, true).is_ok());
    }
}
