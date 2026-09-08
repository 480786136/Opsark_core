use reqwest::{redirect::Policy, Url};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

fn endpoint_url(endpoint: &str) -> Result<Url, String> {
    let url = Url::parse(endpoint).map_err(|_| "知识接口地址无效")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || url.scheme() == "http" && loopback)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path().trim_end_matches('/') != "/api/v1"
    {
        return Err(
            "知识地址须为 HTTPS /api/v1；仅本机调试允许 HTTP，不允许用户名、查询参数或片段".into(),
        );
    }
    Ok(url)
}

fn operation_path(operation: &str, record_id: Option<&str>) -> Result<String, String> {
    match operation {
        "bases" => Ok("knowledge/bases".into()),
        "upload" => Ok("records".into()),
        "status" => {
            let id = record_id.ok_or("缺少记录标识")?;
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            {
                return Err("记录标识无效".into());
            }
            Ok(format!("records/{id}"))
        }
        _ => Err("不支持的知识接口操作".into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeResponse {
    status: u16,
    data: Value,
    retry_after_seconds: Option<u64>,
}

#[tauri::command]
pub(crate) async fn knowledge_request(
    endpoint: String,
    credential_id: String,
    operation: String,
    record_id: Option<String>,
    body: Option<String>,
    idempotency_key: Option<String>,
) -> Result<KnowledgeResponse, String> {
    let base = endpoint_url(&endpoint)?;
    let path = operation_path(&operation, record_id.as_deref())?;
    let key = crate::credential::load_credential("knowledge".into(), credential_id)?
        .filter(|v| !v.is_empty())
        .ok_or("知识 API Key 尚未保存到系统钥匙串")?;
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| "无法创建知识连接")?;
    let url = format!("{}/{path}", base.as_str().trim_end_matches('/'));
    let mut request = if operation == "upload" {
        let body = body.ok_or("缺少上传正文")?;
        if body.len() > 256 * 1024 {
            return Err("上传正文超过 256 KiB".into());
        }
        serde_json::from_str::<Value>(&body).map_err(|_| "上传正文不是有效 JSON")?;
        let idem = idempotency_key.ok_or("缺少幂等标识")?;
        if idem.is_empty() || idem.len() > 128 || !idem.bytes().all(|c| (33..=126).contains(&c)) {
            return Err("幂等标识无效".into());
        }
        client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Idempotency-Key", idem)
            .body(body)
    } else {
        client.get(&url)
    };
    request = request
        .bearer_auth(key)
        .header("Accept", "application/json");
    // Do not reuse the model request logger: knowledge payloads and credentials stay out of logs.
    let mut response = request
        .send()
        .await
        .map_err(|_| "知识服务连接失败或超时，请检查地址后手动重试")?;
    let status = response.status().as_u16();
    let retry_after_seconds = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    let mut bytes = Vec::new();
    while let Some(part) = response
        .chunk()
        .await
        .map_err(|_| "知识响应读取失败，请手动重试")?
    {
        if bytes.len() + part.len() > 2 * 1024 * 1024 {
            return Err("知识响应过大".into());
        }
        bytes.extend_from_slice(&part);
    }
    let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let data = if (200..300).contains(&status) {
        if parsed.is_null() {
            return Err("知识服务未返回有效 JSON".into());
        }
        parsed
    } else {
        let code = parsed
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("HTTP_ERROR");
        let safe_code: String = code
            .chars()
            .filter(|c| c.is_ascii_uppercase() || *c == '_')
            .take(64)
            .collect();
        json!({"error": {"code": safe_code}})
    };
    Ok(KnowledgeResponse {
        status,
        data,
        retry_after_seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_destination_and_paths() {
        assert!(endpoint_url("http://127.0.0.1:8002/api/v1").is_ok());
        assert!(endpoint_url("https://knowledge.example/api/v1/").is_ok());
        for invalid in [
            "http://remote.example/api/v1",
            "https://user:key@host/api/v1",
            "https://host/internal/v1",
            "https://host/api/v1?key=x",
            "file:///api/v1",
        ] {
            assert!(endpoint_url(invalid).is_err());
        }
        assert!(operation_path("status", Some("../internal/v1")).is_err());
        assert!(operation_path("keys", None).is_err());
        assert_eq!(
            operation_path("status", Some("rec-1")).unwrap(),
            "records/rec-1"
        );
    }
}
