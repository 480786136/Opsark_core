//! Account secrets never cross the webview boundary or the generic credential API.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{Method, Url};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub(crate) const KEY_PREFIX: &str = "opsark-account:";

#[derive(Default)]
struct Session {
    access: String,
    user_id: String,
    expires: Option<Instant>,
    // Logging out offline must not restore a stale disk credential in this process.
    logged_out: bool,
    oauth: Option<(String, String)>,
}

fn session() -> &'static Mutex<Session> {
    static SESSION: OnceLock<Mutex<Session>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(Session::default()))
}

fn validate_origin(value: &str, development: bool) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| "官方服务地址无效")?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if !(url.scheme() == "https" || development && loopback && url.scheme() == "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("官方服务须使用固定 HTTPS 源站（开发模式允许本机 HTTP）".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

pub(crate) fn origin() -> Result<String, String> {
    let value = option_env!("OPSARK_PLATFORM_URL")
        .or(if cfg!(debug_assertions) {
            Some("http://127.0.0.1:8001")
        } else {
            Some("https://zgspace.cn")
        })
        .ok_or("此安装包尚未配置官方服务，本地功能仍可使用")?;
    validate_origin(value, cfg!(debug_assertions))
}

fn entry(base: &str) -> Result<keyring::Entry, String> {
    let name = format!("refresh:{:x}", Sha256::digest(base.as_bytes()));
    keyring::Entry::new("com.opsark.desktop.account", &name)
        .map_err(|_| "无法访问账号钥匙串".into())
}

fn clear_credential(base: &str) -> Result<(), String> {
    match entry(base)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法清除账号凭据，请检查系统钥匙串权限后重试退出".into()),
    }
}

struct RequestError {
    status: u16,
    message: String,
}

async fn request(
    base: &str,
    path: &str,
    method: Method,
    access: &str,
    body: Option<Value>,
) -> Result<Value, RequestError> {
    let network_error = || RequestError {
        status: 0,
        message: "无法连接官方服务，请稍后重试；本地功能不受影响".into(),
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(if path.starts_with("/api/core/v1/feedback") { 120 } else { 20 }))
        .build()
        .map_err(|_| network_error())?;
    let mut builder = client
        .request(method, format!("{base}{path}"))
        .header("X-Opsark-Version", env!("CARGO_PKG_VERSION"));
    if !access.is_empty() {
        builder = builder.bearer_auth(access);
    }
    if let Some(body) = body {
        builder = builder.json(&body);
    }
    let mut response = builder.send().await.map_err(|_| network_error())?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| network_error())? {
        let response_limit = if path.starts_with("/api/core/v1/feedback/") { 96 * 1024 * 1024 } else { 2 * 1024 * 1024 };
        if bytes.len() + chunk.len() > response_limit {
            return Err(RequestError {
                status: status.as_u16(),
                message: "官方服务响应过大".into(),
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| network_error())?;
    if !status.is_success() {
        // Do not return validation bodies: they may echo a submitted password/token.
        let message = data
            .pointer("/error/message")
            .and_then(Value::as_str)
            .filter(|s| s.chars().count() <= 300)
            .unwrap_or("请求未完成，请检查输入或稍后重试");
        return Err(RequestError {
            status: status.as_u16(),
            message: message.to_owned(),
        });
    }
    Ok(data)
}

async fn install(base: &str, state: &mut Session, data: Value) -> Result<(), String> {
    let access = data["access_token"]
        .as_str()
        .filter(|s| s.starts_with("ouc_"))
        .ok_or("官方服务会话格式不正确")?;
    let refresh = data["refresh_token"]
        .as_str()
        .filter(|s| s.starts_with("our_"))
        .ok_or("官方服务会话格式不正确")?;
    let user_id = data
        .pointer("/user/id")
        .and_then(Value::as_str)
        .ok_or("缺少用户信息")?;
    if entry(base)?.set_password(refresh).is_err() {
        let _ = request(base, "/api/core/v1/session", Method::DELETE, access, None).await;
        return Err("保存登录凭据失败，登录未完成；请检查系统钥匙串权限".into());
    }
    state.access = access.to_owned();
    state.user_id = user_id.to_owned();
    state.expires = Some(Instant::now() + Duration::from_secs(840));
    state.logged_out = false;
    Ok(())
}

async fn ensure_session(base: &str, state: &mut Session) -> Result<(), String> {
    if state.logged_out {
        return Err("请先登录 OpsArk 账号".into());
    }
    if !state.access.is_empty()
        && state
            .expires
            .is_some_and(|deadline| deadline > Instant::now())
    {
        return Ok(());
    }
    let refresh = match entry(base)?.get_password() {
        Ok(refresh) => refresh,
        Err(keyring::Error::NoEntry) => return Err("请先登录 OpsArk 账号".into()),
        Err(_) => return Err("无法读取账号凭据，请检查系统钥匙串权限".into()),
    };
    match request(
        base,
        "/api/core/v1/session/refresh",
        Method::POST,
        "",
        Some(json!({"refresh_token": refresh})),
    )
    .await
    {
        Ok(data) => install(base, state, data).await,
        Err(error) => {
            if error.status == 401 {
                *state = Session {
                    logged_out: true,
                    ..Session::default()
                };
                clear_credential(base)?;
            }
            Err(error.message)
        }
    }
}

fn public_snapshot(base: &str, me: &Value, models: &Value) -> Result<Value, String> {
    let id = me
        .pointer("/user/id")
        .and_then(Value::as_str)
        .ok_or("缺少用户标识")?;
    let email = me
        .pointer("/user/email")
        .and_then(Value::as_str)
        .ok_or("缺少用户邮箱")?;
    let count = |key: &str| me["balance"][key].as_u64().ok_or("额度响应格式不正确");
    let models = models["data"]
        .as_array()
        .ok_or("模型列表格式不正确")?
        .iter()
        .filter_map(|m| {
            m["id"]
                .as_str()
                .map(|id| json!({"id": id, "name": m["name"].as_str().unwrap_or(id)}))
        })
        .collect::<Vec<_>>();
    Ok(json!({"user": {"id": id, "email": email},
        "billingMode": if me["billing_mode"].as_str() == Some("direct") { "direct" } else { "reserved" },
        "githubLinked": me["github_linked"].as_bool().unwrap_or(false),
        "balance": {"available": count("available")?, "reserved": count("reserved")?, "revision": count("revision")?, "unit": "tokens"},
        "models": models, "endpoint": format!("{base}/v1")}))
}

async fn snapshot(base: &str, state: &mut Session) -> Result<Value, String> {
    ensure_session(base, state).await?;
    let me = match request(base, "/api/core/v1/me", Method::GET, &state.access, None).await {
        Ok(value) => value,
        Err(error) => {
            if error.status == 401 {
                *state = Session { logged_out: true, ..Session::default() };
                clear_credential(base)?;
            }
            return Err(error.message);
        }
    };
    let (models, warning) =
        match request(base, "/v1/models", Method::GET, &state.access, None).await {
            Ok(models) => (models, None),
            // Compatibility restrictions must not prevent account access or support requests.
            Err(error) => (json!({"data": []}), Some(error.message)),
        };
    // Whitelist fields, including nested objects. Never forward session responses.
    let mut result = public_snapshot(base, &me, &models)?;
    if let Some(message) = warning {
        result["model_warning"] = json!(message);
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn account_request(
    operation: String,
    email: Option<String>,
    password: Option<String>,
) -> Result<Value, String> {
    if operation == "config" {
        return Ok(match origin() {
            Ok(base) => json!({"configured": true, "origin": base}),
            Err(error) => json!({"configured": false, "message": error}),
        });
    }
    let base = origin()?;
    if operation == "policy" {
        return request(
            &base,
            "/api/core/v1/registration-policy",
            Method::GET,
            "",
            None,
        )
        .await
        .map_err(|e| e.message);
    }
    let mut state = session().lock().await;
    match operation.as_str() {
        "github_login" | "github_link" => {
            let linking = operation == "github_link";
            if linking {
                ensure_session(&base, &mut state).await?;
            } else if !state.access.is_empty() {
                return Err("请先退出当前账号，或选择绑定 GitHub".into());
            }
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).map_err(|_| "无法生成授权校验码")?;
            let verifier = URL_SAFE_NO_PAD.encode(bytes);
            let proof = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
            let data = request(
                &base,
                "/api/core/v1/auth/github/start",
                Method::POST,
                if linking { &state.access } else { "" },
                Some(json!({"challenge": proof, "mode": if linking { "link" } else { "login" }})),
            )
            .await
            .map_err(|e| e.message)?;
            let flow_id = data["flow_id"]
                .as_str()
                .ok_or("GitHub 授权响应无效")?
                .to_owned();
            let url = data["authorize_url"]
                .as_str()
                .ok_or("缺少 GitHub 授权地址")?;
            let parsed = Url::parse(url).map_err(|_| "GitHub 授权地址无效")?;
            if parsed.host_str() != Some("github.com") || parsed.path() != "/login/oauth/authorize"
            {
                return Err("拒绝非 GitHub 授权地址".into());
            }
            state.oauth = Some((flow_id, verifier));
            crate::cloud::open_safe_url(url)?;
            Ok(json!({"status": "pending"}))
        }
        "github_complete" => {
            let (flow_id, verifier) = state.oauth.as_ref().ok_or("请先发起 GitHub 授权")?;
            let data = request(
                &base,
                "/api/core/v1/auth/github/complete",
                Method::POST,
                &state.access,
                Some(json!({"flow_id": flow_id, "verifier": verifier})),
            )
            .await
            .map_err(|e| e.message)?;
            if data["status"] == "pending" {
                return Ok(json!({"status": "pending"}));
            }
            state.oauth = None;
            if data["status"] == "authenticated" {
                install(&base, &mut state, data).await?;
            }
            snapshot(&base, &mut state).await
        }
        "login" | "register" => {
            // Require an explicit logout before switching; do not strand another account's refresh token.
            if !state.access.is_empty() {
                return Err("请先退出当前账号再登录其他账号".into());
            }
            let data = request(&base, &format!("/api/core/v1/{operation}"), Method::POST, "",
                Some(json!({"email": email.unwrap_or_default(), "password": password.unwrap_or_default()}))).await.map_err(|e| e.message)?;
            // A completed password login invalidates any older pending GitHub login on this device.
            state.oauth = None;
            install(&base, &mut state, data).await?;
            snapshot(&base, &mut state).await
        }
        "restore" | "me" => snapshot(&base, &mut state).await,
        "logout" => {
            // Resolve a refresh-only restored session when possible, but never require network to log out.
            let _ = ensure_session(&base, &mut state).await;
            let access = std::mem::take(&mut state.access);
            *state = Session {
                logged_out: true,
                ..Session::default()
            };
            let cleanup = clear_credential(&base);
            let revoked = if access.is_empty() {
                false
            } else {
                request(&base, "/api/core/v1/session", Method::DELETE, &access, None)
                    .await
                    .is_ok()
            };
            cleanup?;
            Ok(json!({"ok": true, "revoked": revoked}))
        }
        _ => Err("不支持的账号操作".into()),
    }
}

pub(crate) async fn public_api(path: &str) -> Result<Value, String> {
    request(&origin()?, path, Method::GET, "", None)
        .await
        .map_err(|e| e.message)
}

pub(crate) async fn submit_public_feedback(body: Value) -> Result<Value, String> {
    request(&origin()?, "/api/core/v1/feedback", Method::POST, "", Some(body))
        .await
        .map_err(|e| e.message)
}

pub(crate) async fn authenticated_api(
    expected_user: &str,
    path: &str,
    method: Method,
    body: Option<Value>,
) -> Result<Value, String> {
    let base = origin()?;
    let mut state = session().lock().await;
    ensure_session(&base, &mut state).await?;
    if expected_user != state.user_id {
        return Err("账号已切换，请刷新后重试".into());
    }
    request(&base, path, method, &state.access, body)
        .await
        .map_err(|e| e.message)
}

pub(crate) async fn authorization(url: &str, key: &str) -> Result<String, String> {
    let Some(expected_user) = key.strip_prefix(KEY_PREFIX) else {
        return Ok(key.to_owned());
    };
    let base = origin()?;
    if url != format!("{base}/v1/chat/completions") && url != format!("{base}/v1/models") {
        return Err("官方账号凭据不能用于自定义模型接口".into());
    }
    let mut state = session().lock().await;
    ensure_session(&base, &mut state).await?;
    if expected_user != state.user_id {
        return Err("模型所属账号已切换，请重新选择模型".into());
    }
    Ok(state.access.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_exposes_only_the_known_billing_policy() {
        for (mode, expected) in [("direct", "direct"), ("reserved", "reserved"), ("unknown", "reserved")] {
            let result = public_snapshot("https://platform.example.test", &json!({
                "user":{"id":"user","email":"u@example.test"},
                "balance":{"available":10,"reserved":0,"revision":1}, "billing_mode":mode,
            }), &json!({"data":[]})).unwrap();
            assert_eq!(result["billingMode"], expected);
        }
    }

    #[test]
    fn only_fixed_secure_origins() {
        assert_eq!(
            validate_origin("https://platform.example.test/", false).unwrap(),
            "https://platform.example.test"
        );
        assert!(validate_origin("http://127.0.0.1:8001", true).is_ok());
        for url in [
            "http://example.test",
            "https://user:pass@example.test",
            "https://example.test/v1",
            "https://example.test?key=secret",
            "https://example.test/#x",
        ] {
            assert!(validate_origin(url, false).is_err());
        }
        assert!(validate_origin("http://127.0.0.1:8001", false).is_err());
    }

    #[test]
    fn webview_projection_never_forwards_tokens_or_new_server_fields() {
        let result = public_snapshot(
            "https://platform.example.test",
            &json!({
                "access_token": "ouc_synthetic", "refresh_token": "our_synthetic",
                "user": {"id": "user", "email": "u@example.test", "password_hash": "hidden"},
                "balance": {"available": 10, "reserved": 2, "revision": 3, "private": "hidden"}
            }),
            &json!({"data": [{"id": "trial", "api_key": "hidden"}]}),
        )
        .unwrap();
        assert_eq!(result["balance"]["available"], 10);
        for private in ["synthetic", "hidden", "password_hash", "api_key"] {
            assert!(!result.to_string().contains(private));
        }
    }

    #[test]
    fn official_marker_is_rejected_for_external_destinations_before_keychain_access() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let error = runtime.block_on(authorization(
            "https://external.example.test/v1/chat/completions",
            "opsark-account:some-user",
        ));
        assert!(error.is_err());
        assert_eq!(
            runtime
                .block_on(authorization(
                    "https://own.example.test/v1/chat/completions",
                    "synthetic-byok"
                ))
                .unwrap(),
            "synthetic-byok"
        );
    }
}
