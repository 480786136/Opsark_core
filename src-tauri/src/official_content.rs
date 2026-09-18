//! Downloads only from the fixed Admin origin; immutable, origin-scoped local cache.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

fn pending() -> &'static Mutex<HashMap<String, Value>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn valid_kind(kind: &str) -> bool {
    matches!(kind, "skills" | "tools")
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn verify(value: &Value, kind: &str, id: &str) -> Result<(), String> {
    let content = value["content"].as_str().ok_or("缺少官方内容")?;
    if !valid_kind(kind)
        || !valid_id(id)
        || value["kind"] != kind
        || value["id"] != id
        || content.len() > 1024 * 1024
        || value["sha256"] != format!("{:x}", Sha256::digest(content.as_bytes()))
    {
        return Err("官方内容完整性校验失败，继续使用本地版本".into());
    }
    let bundle: Value = serde_json::from_str(content).map_err(|_| "官方内容格式无效")?;
    if !(bundle["schema_version"] == 1 || (kind == "tools" && bundle["schema_version"] == 2))
        || bundle["kind"] != kind
        || bundle["version"] != value["version"]
        || bundle["min_core_version"] != value["min_core_version"]
        || !matches!(bundle["version"].as_u64(), Some(1..=2147483647))
    {
        return Err("官方内容版本校验失败".into());
    }
    Ok(())
}

fn read_cache(directory: &Path) -> Result<Vec<Value>, String> {
    if !directory.exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    for entry in fs::read_dir(directory).map_err(|_| "无法读取官方内容缓存")? {
        let entry = entry.map_err(|_| "无法读取官方内容缓存")?;
        if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if entry.metadata().map_err(|_| "无法读取官方内容缓存")?.len() > 2 * 1024 * 1024 {
            continue;
        }
        let value: Value = match fs::read(entry.path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
        {
            Some(value) => value,
            None => continue,
        };
        let kind = value["kind"].as_str().unwrap_or("");
        let id = value["id"].as_str().unwrap_or("");
        if verify(&value, kind, id).is_ok() {
            result.push(value);
        }
    }
    result.sort_by_key(|v| std::cmp::Reverse(v["version"].as_u64().unwrap_or(0)));
    Ok(result)
}

fn save_cache(directory: &Path, value: &Value) -> Result<(), String> {
    let kind = value["kind"].as_str().ok_or("缺少内容类型")?;
    let id = value["id"].as_str().ok_or("缺少发布标识")?;
    verify(value, kind, id)?;
    fs::create_dir_all(directory).map_err(|_| "无法创建官方内容缓存")?;
    let path = directory.join(format!("{kind}-{id}.json"));
    if path.exists() {
        let saved: Value =
            serde_json::from_slice(&fs::read(&path).map_err(|_| "无法读取官方内容缓存")?)
                .map_err(|_| "官方内容缓存损坏")?;
        return if saved == *value {
            Ok(())
        } else {
            Err("同一发布不可覆盖".into())
        };
    }
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec(value).map_err(|_| "无法保存官方内容")?;
    use std::io::Write;
    let mut file = fs::File::create(&temporary).map_err(|_| "无法写入官方内容缓存")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "无法写入官方内容缓存")?;
    drop(file);
    fs::rename(temporary, path).map_err(|_| "无法激活官方内容缓存")?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn official_content_request(
    app: tauri::AppHandle,
    operation: String,
    kind: Option<String>,
    release_id: Option<String>,
) -> Result<Value, String> {
    let origin = crate::account::origin()?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法读取应用目录")?
        .join("official-content")
        .join(format!("{:x}", Sha256::digest(origin.as_bytes())));
    if operation == "cache" {
        return Ok(json!(read_cache(&directory)?));
    }
    let kind = kind.as_deref().ok_or("缺少内容类型")?;
    let id = release_id.as_deref().ok_or("缺少发布标识")?;
    if !valid_kind(kind) || !valid_id(id) {
        return Err("无效官方发布标识".into());
    }
    let key = format!("{origin}/{kind}/{id}");
    if operation == "download" {
        let value =
            crate::account::public_api(&format!("/api/core/v1/official-content/{kind}/{id}"))
                .await?;
        verify(&value, kind, id)?;
        let mut staged = pending().lock().map_err(|_| "官方内容正在更新")?;
        // At most one pending publication per kind and origin.
        staged.retain(|k, _| !k.starts_with(&format!("{origin}/{kind}/")));
        staged.insert(key, value.clone());
        return Ok(value);
    }
    if operation == "activate" {
        let mut staged = pending().lock().map_err(|_| "官方内容正在更新")?;
        let value = staged.get(&key).ok_or("请先下载并校验官方内容")?;
        save_cache(&directory, value)?;
        staged.remove(&key);
        return Ok(json!({"ok": true}));
    }
    Err("不支持的官方内容操作".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        let content = r#"{"schema_version":1,"kind":"tools","version":1,"min_core_version":"0.3.0","items":[]}"#;
        json!({"id":"fixture", "kind":"tools", "version":1,"min_core_version":"0.3.0",
            "content":content,"sha256":format!("{:x}", Sha256::digest(content.as_bytes()))})
    }
    #[test]
    fn verifies_hash_identity_and_payload_version() {
        let mut value = fixture();
        assert!(verify(&value, "tools", "fixture").is_ok());
        assert!(verify(&value, "skills", "fixture").is_err());
        assert!(verify(&value, "tools", "../fixture").is_err());
        value["version"] = json!(2);
        assert!(verify(&value, "tools", "fixture").is_err());
        value = fixture();
        value["content"] = json!("tampered");
        assert!(verify(&value, "tools", "fixture").is_err());
    }
    #[test]
    fn accepts_parameter_configurations_only_for_supported_tool_protocols() {
        for (kind, protocol, expected) in [
            ("tools", 1, true),
            ("tools", 2, true),
            ("tools", 3, false),
            ("skills", 1, true),
            ("skills", 2, false),
        ] {
            let mut value = fixture();
            let mut bundle: Value =
                serde_json::from_str(value["content"].as_str().unwrap()).unwrap();
            bundle["kind"] = json!(kind);
            bundle["schema_version"] = json!(protocol);
            let content = serde_json::to_string(&bundle).unwrap();
            value["kind"] = json!(kind);
            value["sha256"] = json!(format!("{:x}", Sha256::digest(content.as_bytes())));
            value["content"] = json!(content);
            assert_eq!(verify(&value, kind, "fixture").is_ok(), expected);
        }
    }
    #[test]
    fn immutable_cache_survives_partial_write() {
        let dir = std::env::temp_dir().join(format!(
            "opsark-official-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let value = fixture();
        save_cache(&dir, &value).unwrap();
        save_cache(&dir, &value).unwrap();
        fs::write(dir.join("interrupted.tmp"), "partial").unwrap();
        fs::write(dir.join("broken.json"), "partial").unwrap();
        assert_eq!(read_cache(&dir).unwrap(), vec![value]);
        fs::remove_dir_all(dir).unwrap();
    }
}
