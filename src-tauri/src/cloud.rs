use reqwest::{Method, Url};
use serde_json::{json, Value};

fn client_info_path() -> String {
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    format!(
        "/api/core/v1/client-info?platform={platform}&arch={arch}&content_protocol=3&version={}",
        env!("CARGO_PKG_VERSION")
    )
}

pub(crate) fn open_safe_url(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "无效链接")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || value.chars().any(|c| c.is_control())
    {
        return Err("只允许打开无凭据的 HTTPS 链接".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("/usr/bin/open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = std::process::Command::new("xdg-open");
    command
        .arg(value)
        .spawn()
        .map_err(|_| "无法打开系统浏览器")?;
    Ok(())
}

fn identifier(value: &Value) -> Result<&str, String> {
    let id = value["id"].as_str().ok_or("缺少资源标识")?;
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("资源标识无效".into());
    }
    Ok(id)
}

#[tauri::command]
pub(crate) async fn cloud_request(
    operation: String,
    payload: Option<Value>,
    user_id: Option<String>,
) -> Result<Value, String> {
    let payload = payload.unwrap_or(json!({}));
    if operation == "feedback_create" && user_id.is_none() {
        return crate::account::submit_public_feedback(payload).await;
    }
    if operation == "official_models" {
        return crate::account::public_api("/api/core/v1/official-models").await;
    }
    if operation == "client_info" {
        let mut info = crate::account::public_api(&client_info_path()).await?;
        info["current_version"] = json!(env!("CARGO_PKG_VERSION"));
        return Ok(info);
    }
    if operation == "github_config" {
        return crate::account::public_api("/api/core/v1/auth/github/config").await;
    }
    if operation == "open_download" || operation == "open_support" {
        let info = crate::account::public_api(&client_info_path()).await?;
        let url = if operation == "open_support" {
            info["support_url"].as_str().ok_or("尚未配置联系网址")?
        } else {
            if payload["id"] != info["latest"]["id"] || info["latest"].is_null() {
                return Err("该版本已撤回或更换，请重新检查更新".into());
            }
            info["latest"]["download_url"]
                .as_str()
                .ok_or("没有可用的下载链接")?
        };
        open_safe_url(url)?;
        return Ok(json!({"ok": true}));
    }
    let (path, method, body) = match operation.as_str() {
        "skills_list" => {
            let cursor = payload["cursor"].as_str().unwrap_or("");
            if !cursor
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                || cursor.len() > 128
            {
                return Err("无效游标".into());
            }
            (
                format!("/api/core/v1/skills?after={cursor}"),
                Method::GET,
                None,
            )
        }
        "skills_save" => (
            format!("/api/core/v1/skills/{}", identifier(&payload)?),
            Method::PUT,
            Some(payload["body"].clone()),
        ),
        "feedback_create" => ("/api/core/v1/feedback".into(), Method::POST, Some(payload)),
        "feedback_list" => ("/api/core/v1/feedback".into(), Method::GET, None),
        "feedback_read" => (
            format!("/api/core/v1/feedback/{}", identifier(&payload)?),
            Method::GET,
            None,
        ),
        "feedback_delete" => (
            format!("/api/core/v1/feedback/{}", identifier(&payload)?),
            Method::DELETE,
            None,
        ),
        _ => return Err("不支持的云操作".into()),
    };
    crate::account::authenticated_api(
        user_id.as_deref().ok_or("请先登录 OpsArk")?,
        &path,
        method,
        body,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_path_injection_and_non_https_links_without_opening_them() {
        assert!(identifier(&json!({"id": "../users"})).is_err());
        assert!(identifier(&json!({"id": "a?owner=b"})).is_err());
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:pass@example.test",
        ] {
            assert!(open_safe_url(url).is_err());
        }
    }
}
