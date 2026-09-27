//! Read-only recovery for one accepted official-account request. This never starts
//! another generation and never refreshes or switches the captured credential.
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::time::Duration;

const STATUS_ATTEMPTS: usize = 3;
const STATUS_RESPONSE_LIMIT: usize = 32 * 1024;

pub(crate) struct RecoveryResult {
    pub code: &'static str,
    pub message: &'static str,
    pub diagnostic: Value,
    pub not_dispatched: bool,
}

fn unknown() -> RecoveryResult {
    RecoveryResult {
        code: "MODEL_DISPATCH_UNKNOWN",
        message: "无法确认原模型请求的派发或结算结果，已停止自动重发；请核对原请求记录",
        diagnostic: json!({"dispatchCertainty":"may_have_dispatched"}),
        not_dispatched: false,
    }
}

pub(crate) fn status_url(original_url: &str, request_id: &str) -> Option<Url> {
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return None;
    }
    let mut url = Url::parse(original_url).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "/v1/chat/completions" | "/v1/responses")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    url.set_path(&format!("/api/core/v1/model-requests/{request_id}"));
    Some(url)
}

/// Only documented machine diagnostics cross into Core. No response body,
/// authorization, arbitrary provider details or status URL is copied.
pub(crate) fn copy_diagnostics(target: &mut Value, source: &Value) {
    for field in [
        "origin",
        "stage",
        "dispatchCertainty",
        "callId",
        "requestKey",
        "providerCode",
    ] {
        if let Some(value) = source[field].as_str().filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        }) {
            let valid = match field {
                "origin" => matches!(value, "core" | "gateway" | "upstream"),
                "dispatchCertainty" => matches!(
                    value,
                    "not_dispatched" | "may_have_dispatched" | "response_received"
                ),
                _ => true,
            };
            if valid {
                target[field] = json!(value);
            }
        }
    }
    for field in ["gatewayHttpStatus", "providerHttpStatus"] {
        if let Some(value) = source[field]
            .as_u64()
            .filter(|value| (100..=599).contains(value))
        {
            target[field] = json!(value);
        }
    }
}

fn evaluate_status(payload: &Value, request_id: &str) -> Option<RecoveryResult> {
    let mut result = unknown();
    if payload
        .get("requestKey")
        .is_some_and(|value| value.as_str() != Some(request_id))
    {
        return Some(result);
    }
    copy_diagnostics(&mut result.diagnostic, payload);
    if result.diagnostic["callId"].is_null() {
        copy_diagnostics(
            &mut result.diagnostic,
            &json!({"callId":payload["call_id"]}),
        );
    }
    result.diagnostic["requestKey"] = json!(request_id);
    for (source, target) in [
        ("credit_state", "creditState"),
        ("billing_mode", "billingMode"),
    ] {
        if let Some(value) = payload[source].as_str().filter(|value| {
            matches!(
                *value,
                "reserved"
                    | "settled"
                    | "released"
                    | "reconciliation_required"
                    | "needs_reconciliation"
                    | "pending_usage"
                    | "direct"
                    | "pending"
            )
        }) {
            result.diagnostic[target] = json!(value);
        }
    }
    for field in ["reserved", "actual"] {
        if let Some(value) = payload[field].as_u64() {
            result.diagnostic[field] = json!(value);
        }
    }
    match payload["status"].as_str() {
        Some("running") => return None,
        Some("succeeded") => {
            // The status endpoint intentionally does not store/replay completions.
            result.code = "MODEL_RESULT_UNAVAILABLE";
            result.message =
                "原模型请求已完成，但状态接口不提供原始响应正文；已停止重新生成以避免重复计费";
            result.diagnostic["dispatchCertainty"] = json!("response_received");
            result.diagnostic["responseAvailable"] = json!(false);
        }
        Some("failed" | "cancelled") => {
            let certainty = result.diagnostic["dispatchCertainty"]
                .as_str()
                .unwrap_or("");
            if matches!(certainty, "not_dispatched" | "response_received") {
                result.code = "MODEL_REQUEST_FAILED";
                result.message = "原模型请求已终止，已保留其派发和结算状态；不会使用新请求自动重试";
                result.not_dispatched = certainty == "not_dispatched";
            }
        }
        _ => {}
    }
    Some(result)
}

pub(crate) async fn recover(
    original_url: &str,
    authorization: &str,
    request_id: &str,
    budget: &crate::model_budget::OperationBudget,
) -> RecoveryResult {
    let Some(url) = status_url(original_url, request_id) else {
        return unknown();
    };
    let mut last = unknown();
    last.diagnostic["requestKey"] = json!(request_id);
    for attempt in 0..STATUS_ATTEMPTS {
        let timeout = match budget.remaining_timeout_seconds(5) {
            Ok(timeout) => timeout,
            Err(_) => return last,
        };
        let Ok(client) = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(timeout.min(5)))
            .timeout(Duration::from_secs(timeout))
            .build()
        else {
            return last;
        };
        let response = client
            .get(url.clone())
            .bearer_auth(authorization)
            .header("X-Opsark-Version", env!("CARGO_PKG_VERSION"))
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await;
        if let Ok(mut response) = response {
            let status = response.status().as_u16();
            last.diagnostic["statusQueryHttpStatus"] = json!(status);
            // Authentication, missing records, redirects and all failures are not
            // evidence that the original POST was never accepted.
            if status != 200 {
                return last;
            }
            let mut bytes = Vec::new();
            let mut complete = true;
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) if bytes.len() + chunk.len() <= STATUS_RESPONSE_LIMIT => {
                        bytes.extend_from_slice(&chunk)
                    }
                    Ok(None) => break,
                    _ => {
                        complete = false;
                        break;
                    }
                }
            }
            if complete {
                if let Ok(payload) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(mut result) = evaluate_status(&payload, request_id) {
                        result.diagnostic["statusQueryHttpStatus"] = json!(status);
                        return result;
                    }
                    copy_diagnostics(&mut last.diagnostic, &payload);
                    last.diagnostic["dispatchCertainty"] = json!("may_have_dispatched");
                }
            }
        }
        if attempt + 1 < STATUS_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(if cfg!(test) { 5 } else { 350 })).await;
        }
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_uses_only_the_original_origin_and_exact_request_identity() {
        assert_eq!(
            status_url(
                "https://gateway.example:443/v1/chat/completions",
                "request_123456789"
            )
            .unwrap()
            .as_str(),
            "https://gateway.example/api/core/v1/model-requests/request_123456789"
        );
        assert_eq!(status_url("https://gateway.example/v1/responses", "request_123456789").unwrap().as_str(),
            "https://gateway.example/api/core/v1/model-requests/request_123456789");
        for url in [
            "https://u:p@gateway.example/v1/chat/completions",
            "https://gateway.example/other",
            "https://gateway.example/v1/chat/completions?token=x",
        ] {
            assert!(status_url(url, "request_123456789").is_none());
        }
        assert!(status_url("https://gateway.example/v1/chat/completions", "../other").is_none());
    }
    #[test]
    fn completed_requests_never_synthesize_the_missing_completion() {
        let result = evaluate_status(&json!({"status":"succeeded","requestKey":"req","call_id":"call-1","actual":17,"credit_state":"settled"}), "req").unwrap();
        assert_eq!(result.code, "MODEL_RESULT_UNAVAILABLE");
        assert_eq!(result.diagnostic["actual"], 17);
        assert_eq!(result.diagnostic["callId"], "call-1");
        assert!(!result.not_dispatched);
        assert_eq!(
            evaluate_status(&json!({"status":"failed"}), "req")
                .unwrap()
                .code,
            "MODEL_DISPATCH_UNKNOWN"
        );
        assert!(evaluate_status(&json!({"status":"running"}), "req").is_none());
        assert_eq!(
            evaluate_status(&json!({"status":"succeeded","requestKey":"other"}), "req")
                .unwrap()
                .code,
            "MODEL_DISPATCH_UNKNOWN"
        );
    }
}
