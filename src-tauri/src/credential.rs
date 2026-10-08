use crate::credential_vault::{CredentialVault, SystemStore};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

const KEYCHAIN_SERVICE: &str = "com.opsark.desktop";
pub(crate) const VAULT_FILENAME: &str = "credential-vault.sqlite";

// keyring's v1 compatibility layer initializes its native store on the first
// Entry::new call. Serialize that initialization across vault and account use.
static SYSTEM_ENTRY_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn system_entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    let _guard = SYSTEM_ENTRY_LOCK
        .lock()
        .map_err(|_| "系统凭据库初始化失败，请重启应用")?;
    keyring::Entry::new(service, account)
        .map_err(|_| "无法访问系统凭据库，请检查系统权限并重启应用后重试".into())
}

struct NativeSystemStore;

impl SystemStore for NativeSystemStore {
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        match system_entry(KEYCHAIN_SERVICE, account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("读取系统凭据失败，请检查钥匙串或 Windows 凭据管理器权限".into()),
        }
    }

    fn write(&self, account: &str, value: &str) -> Result<(), String> {
        system_entry(KEYCHAIN_SERVICE, account)?
            .set_password(value)
            .map_err(|_| "保存系统凭据失败，请检查系统凭据库权限".into())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match system_entry(KEYCHAIN_SERVICE, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("清理旧系统凭据失败，请检查系统凭据库权限".into()),
        }
    }
}

pub(crate) struct CredentialVaultState(Arc<CredentialVault>);

impl CredentialVaultState {
    // Construction only binds the private app path. Opening the database or
    // prompting the system credential store happens on a blocking worker.
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self(Arc::new(CredentialVault::new(
            directory.join(VAULT_FILENAME),
            Arc::new(NativeSystemStore),
        )))
    }
}

fn vault(app: &AppHandle) -> Arc<CredentialVault> {
    app.state::<CredentialVaultState>().inner().0.clone()
}

pub(crate) fn credential_account(kind: &str, id: &str) -> Result<String, String> {
    if !matches!(kind, "server" | "model" | "secret" | "knowledge") {
        return Err("不支持的凭据类型".into());
    }
    if id.trim().is_empty() || id.len() > 160 {
        return Err("凭据标识无效".into());
    }
    Ok(format!("{kind}:{}", id.trim()))
}

#[tauri::command]
pub(crate) async fn save_credential(
    app: AppHandle,
    kind: String,
    id: String,
    value: String,
) -> Result<(), String> {
    let account = credential_account(&kind, &id)?;
    let vault = vault(&app);
    let value = Zeroizing::new(value);
    tauri::async_runtime::spawn_blocking(move || vault.save(&account, &value))
        .await
        .map_err(|_| "本地加密凭据保存任务未完成".to_string())?
}

#[tauri::command]
pub(crate) async fn load_credential(
    app: AppHandle,
    kind: String,
    id: String,
) -> Result<Option<String>, String> {
    let account = credential_account(&kind, &id)?;
    let vault = vault(&app);
    tauri::async_runtime::spawn_blocking(move || vault.load(&account))
        .await
        .map_err(|_| "本地加密凭据读取任务未完成".to_string())?
}

#[tauri::command]
pub(crate) async fn delete_credential(
    app: AppHandle,
    kind: String,
    id: String,
) -> Result<(), String> {
    let account = credential_account(&kind, &id)?;
    let vault = vault(&app);
    tauri::async_runtime::spawn_blocking(move || vault.delete(&account))
        .await
        .map_err(|_| "本地加密凭据删除任务未完成".to_string())?
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
        assert!(credential_account("credential-vault", "master:v1").is_err());
        assert_eq!(
            credential_account("knowledge", "primary").unwrap(),
            "knowledge:primary"
        );
        assert!(credential_account("server", " ").is_err());
    }
}
