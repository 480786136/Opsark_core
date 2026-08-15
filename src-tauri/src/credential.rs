const KEYCHAIN_SERVICE: &str = "com.opsark.desktop";

pub(crate) fn credential_account(kind: &str, id: &str) -> Result<String, String> {
    if !matches!(kind, "server" | "model" | "secret") {
        return Err("不支持的凭据类型".into());
    }
    if id.trim().is_empty() || id.len() > 160 {
        return Err("凭据标识无效".into());
    }
    Ok(format!("{kind}:{}", id.trim()))
}

fn credential_entry(kind: &str, id: &str) -> Result<keyring::Entry, String> {
    let account = credential_account(kind, id)?;
    keyring::Entry::new(KEYCHAIN_SERVICE, &account)
        .map_err(|error| format!("无法访问系统钥匙串：{error}"))
}

#[tauri::command(async)]
pub(crate) fn save_credential(kind: String, id: String, value: String) -> Result<(), String> {
    if value.is_empty() {
        return delete_credential(kind, id);
    }
    credential_entry(&kind, &id)?
        .set_password(&value)
        .map_err(|error| format!("保存系统凭据失败：{error}"))
}

#[tauri::command(async)]
pub(crate) fn load_credential(kind: String, id: String) -> Result<Option<String>, String> {
    match credential_entry(&kind, &id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取系统凭据失败：{error}")),
    }
}

#[tauri::command(async)]
pub(crate) fn delete_credential(kind: String, id: String) -> Result<(), String> {
    match credential_entry(&kind, &id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除系统凭据失败：{error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::credential_account;

    #[test]
    fn namespaces_and_validates_accounts() {
        assert_eq!(
            credential_account("server", "srv-1").unwrap(),
            "server:srv-1"
        );
        assert_eq!(
            credential_account("model", "model-1").unwrap(),
            "model:model-1"
        );
        assert_eq!(
            credential_account("secret", "TOKEN").unwrap(),
            "secret:TOKEN"
        );
        assert!(credential_account("other", "id").is_err());
        assert!(credential_account("server", " ").is_err());
    }
}
