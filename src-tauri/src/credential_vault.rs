//! Local encrypted credentials. System storage contains the master key only;
//! legacy per-account entries are removed only after durable authenticated readback.
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zeroize::Zeroizing;

pub(crate) const VAULT_MASTER_ACCOUNT: &str = "credential-vault:master:v1";
const VERSION: i64 = 1;
const APPLICATION_ID: i64 = 0x4f505356;
const MASTER_CHECK: &[u8] = b"opsark credential vault master check v1";
const STORAGE_ERROR: &str = "本地加密凭据库读写失败，请检查磁盘、文件权限或其他正在运行的实例";
const SYSTEM_ERROR: &str = "无法访问系统凭据库，请检查钥匙串或系统凭据权限后重试";
const MISSING_MASTER: &str =
    "本地加密凭据库的主密钥缺失，已停止读取；不会创建替代密钥或覆盖已有凭据";
const INVALID_MASTER: &str = "系统保存的凭据主密钥格式无效，已停止读取；不会创建替代密钥";
const AUTH_ERROR: &str = "本地凭据认证失败，可能是密钥不匹配或数据损坏；已有数据未被覆盖";
const FORMAT_ERROR: &str = "本地加密凭据库格式或版本无效，已有数据未被覆盖";

pub(crate) trait SystemStore: Send + Sync {
    /// Only Ok(None) means absent. Permission, encoding and platform errors are Err.
    fn read(&self, account: &str) -> Result<Option<String>, String>;
    fn write(&self, account: &str, value: &str) -> Result<(), String>;
    /// An already absent item is success; other platform errors remain errors.
    fn delete(&self, account: &str) -> Result<(), String>;
}

struct CachedMaster {
    vault_id: [u8; 16],
    key: Zeroizing<[u8; 32]>,
}

struct Header {
    vault_id: [u8; 16],
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

#[derive(Clone)]
struct Record {
    purpose: String,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    cleanup_pending: bool,
}

pub(crate) struct CredentialVault {
    path: PathBuf,
    system: Arc<dyn SystemStore>,
    // Queue this process's callers before opening SQLite. System authorization
    // can outlast SQLite's timeout; only other processes should contend there.
    operation: Mutex<()>,
    // This cache is private to this fixed path and authenticated vault identity.
    master: Mutex<Option<CachedMaster>>,
}

impl CredentialVault {
    pub(crate) fn new(path: PathBuf, system: Arc<dyn SystemStore>) -> Self {
        Self {
            path,
            system,
            operation: Mutex::new(()),
            master: Mutex::new(None),
        }
    }

    pub(crate) fn load(&self, account: &str) -> Result<Option<String>, String> {
        validate_account(account)?;
        let _operation = self
            .operation
            .lock()
            .map_err(|_| STORAGE_ERROR.to_string())?;
        let mut connection = self.connection()?;
        let transaction = begin(&mut connection)?;
        let (header, key) = self.open_vault(&transaction)?;
        if let Some(record) = read_record(&transaction, account)? {
            let value = decrypt_record(&header, &key, account, &record)?;
            transaction.commit().map_err(storage_error)?;
            self.cache(&header, &key)?;
            self.cleanup_legacy(
                &mut connection,
                &header,
                &key,
                account,
                &record,
                value.as_deref(),
            )?;
            return Ok(value);
        }
        // Read legacy only under the same write transaction that checked absence.
        // A concurrent save/delete therefore cannot be overwritten by migration.
        let legacy = self
            .system
            .read(account)
            .map_err(|_| SYSTEM_ERROR.to_string())?;
        let Some(legacy) = legacy else {
            transaction.commit().map_err(storage_error)?;
            self.cache(&header, &key)?;
            return Ok(None);
        };
        let legacy = Zeroizing::new(legacy);
        let record = encrypt_record(&header, &key, account, Some(&legacy))?;
        write_record(&transaction, account, &record)?;
        transaction.commit().map_err(storage_error)?;
        self.cache(&header, &key)?;
        self.cleanup_legacy(
            &mut connection,
            &header,
            &key,
            account,
            &record,
            Some(&legacy),
        )?;
        Ok(Some(legacy.to_string()))
    }

    pub(crate) fn save(&self, account: &str, value: &str) -> Result<(), String> {
        if value.is_empty() {
            return self.delete(account);
        }
        self.write(account, Some(value))
    }

    pub(crate) fn delete(&self, account: &str) -> Result<(), String> {
        // An authenticated persistent tombstone prevents any surviving legacy
        // entry from being imported again, including after restart.
        self.write(account, None)
    }

    fn write(&self, account: &str, value: Option<&str>) -> Result<(), String> {
        validate_account(account)?;
        let _operation = self
            .operation
            .lock()
            .map_err(|_| STORAGE_ERROR.to_string())?;
        let mut connection = self.connection()?;
        let transaction = begin(&mut connection)?;
        let (header, key) = self.open_vault(&transaction)?;
        if let Some(existing) = read_record(&transaction, account)? {
            // Do not silently overwrite a corrupted record, even on an explicit save.
            let _existing = decrypt_record(&header, &key, account, &existing)?.map(Zeroizing::new);
        }
        let record = encrypt_record(&header, &key, account, value)?;
        write_record(&transaction, account, &record)?;
        transaction.commit().map_err(storage_error)?;
        self.cache(&header, &key)?;
        self.cleanup_legacy(&mut connection, &header, &key, account, &record, value)?;
        Ok(())
    }

    fn connection(&self) -> Result<Connection, String> {
        if let Some(parent) = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).map_err(|_| STORAGE_ERROR.to_string())?;
        }
        create_private_file(&self.path)?;
        let connection = Connection::open(&self.path).map_err(storage_error)?;
        connection
            .busy_timeout(Duration::from_secs(10))
            .map_err(storage_error)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(storage_error)?;
        connection
            .pragma_update(None, "fullfsync", "ON")
            .map_err(storage_error)?;
        Ok(connection)
    }

    fn open_vault(
        &self,
        transaction: &Transaction<'_>,
    ) -> Result<(Header, Zeroizing<[u8; 32]>), String> {
        let application_id: i64 = transaction
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .map_err(storage_error)?;
        let version: i64 = transaction
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(storage_error)?;
        let table_count: i64 = transaction.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |row| row.get(0)
        ).map_err(storage_error)?;
        if application_id == 0 && version == 0 && table_count == 0 {
            // BEGIN IMMEDIATE is already held, including throughout the system-key
            // read/create/readback. Independent processes cannot initialize two keys.
            let key = match self.read_master()? {
                Some(key) => key,
                None => {
                    let mut key = Zeroizing::new([0_u8; 32]);
                    getrandom::fill(&mut *key).map_err(|_| SYSTEM_ERROR.to_string())?;
                    let encoded = Zeroizing::new(format!("v1:{}", STANDARD.encode(&*key)));
                    self.system
                        .write(VAULT_MASTER_ACCOUNT, &encoded)
                        .map_err(|_| SYSTEM_ERROR.to_string())?;
                    let confirmed = self
                        .read_master()?
                        .ok_or_else(|| MISSING_MASTER.to_string())?;
                    if *confirmed != *key {
                        return Err(INVALID_MASTER.into());
                    }
                    key
                }
            };
            let mut vault_id = [0_u8; 16];
            getrandom::fill(&mut vault_id).map_err(|_| SYSTEM_ERROR.to_string())?;
            let (nonce, ciphertext) = encrypt(
                &key,
                &aad(&vault_id, VAULT_MASTER_ACCOUNT, "master-check"),
                MASTER_CHECK,
            )?;
            transaction.execute_batch(
                "CREATE TABLE vault_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, vault_id BLOB NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL);
                 CREATE TABLE vault_records (account TEXT PRIMARY KEY NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('credential','tombstone')), nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, cleanup_pending INTEGER NOT NULL CHECK(cleanup_pending IN (0,1)));"
            ).map_err(storage_error)?;
            transaction
                .pragma_update(None, "application_id", APPLICATION_ID)
                .map_err(storage_error)?;
            transaction
                .pragma_update(None, "user_version", VERSION)
                .map_err(storage_error)?;
            transaction.execute("INSERT INTO vault_meta(singleton,version,vault_id,nonce,ciphertext) VALUES(1,?1,?2,?3,?4)",
                params![VERSION, vault_id.as_slice(), nonce, ciphertext]).map_err(storage_error)?;
            let header = read_header(transaction)?;
            authenticate_header(&header, &key)?;
            return Ok((header, key));
        }
        if application_id != APPLICATION_ID || version != VERSION || table_count != 2 {
            return Err(FORMAT_ERROR.into());
        }
        let header = read_header(transaction)?;
        let cached = self.master.lock().map_err(|_| STORAGE_ERROR.to_string())?;
        let key = if let Some(cached) = cached
            .as_ref()
            .filter(|cached| cached.vault_id == header.vault_id)
        {
            Zeroizing::new(*cached.key)
        } else {
            self.read_master()?
                .ok_or_else(|| MISSING_MASTER.to_string())?
        };
        authenticate_header(&header, &key)?;
        Ok((header, key))
    }

    fn read_master(&self) -> Result<Option<Zeroizing<[u8; 32]>>, String> {
        let value = self
            .system
            .read(VAULT_MASTER_ACCOUNT)
            .map_err(|_| SYSTEM_ERROR.to_string())?;
        value
            .map(|value| {
                let value = Zeroizing::new(value);
                let encoded = value
                    .strip_prefix("v1:")
                    .ok_or_else(|| INVALID_MASTER.to_string())?;
                let decoded = Zeroizing::new(
                    STANDARD
                        .decode(encoded)
                        .map_err(|_| INVALID_MASTER.to_string())?,
                );
                if decoded.len() != 32 {
                    return Err(INVALID_MASTER.into());
                }
                let mut key = Zeroizing::new([0_u8; 32]);
                key.copy_from_slice(&decoded);
                Ok(key)
            })
            .transpose()
    }

    fn cache(&self, header: &Header, key: &[u8; 32]) -> Result<(), String> {
        *self.master.lock().map_err(|_| STORAGE_ERROR.to_string())? = Some(CachedMaster {
            vault_id: header.vault_id,
            key: Zeroizing::new(*key),
        });
        Ok(())
    }

    fn cleanup_legacy(
        &self,
        connection: &mut Connection,
        header: &Header,
        key: &[u8; 32],
        account: &str,
        expected: &Record,
        expected_value: Option<&str>,
    ) -> Result<(), String> {
        // Primary data is already FULL-synchronous committed. Fresh readback and
        // authentication errors remain failures, preserving the legacy entry.
        // Only OS deletion / cleanup-flag failures are deferred after verification.
        if !expected.cleanup_pending {
            return Ok(());
        }
        let transaction = begin(connection)?;
        let actual_header = read_header(&transaction)?;
        if actual_header.vault_id != header.vault_id {
            return Err(AUTH_ERROR.into());
        }
        authenticate_header(&actual_header, key)?;
        let actual = read_record(&transaction, account)?.ok_or_else(|| AUTH_ERROR.to_string())?;
        let verified = decrypt_record(&actual_header, key, account, &actual)?.map(Zeroizing::new);
        if actual.purpose != expected.purpose
            || actual.nonce != expected.nonce
            || actual.ciphertext != expected.ciphertext
        {
            // Another serialized writer won after our commit. It owns cleanup;
            // never delete on behalf of a superseded candidate.
            return Ok(());
        }
        if verified.as_deref().map(String::as_str) != expected_value {
            return Err(AUTH_ERROR.into());
        }
        if !actual.cleanup_pending {
            return Ok(());
        }
        if self.system.delete(account).is_err() {
            return Ok(());
        }
        if transaction
            .execute(
                "UPDATE vault_records SET cleanup_pending=0 WHERE account=?1",
                [account],
            )
            .is_ok()
        {
            let _ = transaction.commit();
        }
        Ok(())
    }
}

fn storage_error(_: rusqlite::Error) -> String {
    STORAGE_ERROR.into()
}
fn begin(connection: &mut Connection) -> Result<Transaction<'_>, String> {
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)
}
fn validate_account(account: &str) -> Result<(), String> {
    let (kind, id) = account.split_once(':').ok_or("凭据标识无效")?;
    if !matches!(kind, "server" | "model" | "secret" | "knowledge")
        || id.is_empty()
        || id.len() > 160
        || id.trim() != id
        || id.chars().any(char::is_control)
    {
        return Err("凭据标识无效".into());
    }
    Ok(())
}
fn create_private_file(path: &Path) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err(STORAGE_ERROR.into()),
    }
}
fn read_header(transaction: &Transaction<'_>) -> Result<Header, String> {
    let row: Option<(i64, Vec<u8>, Vec<u8>, Vec<u8>)> = transaction
        .query_row(
            "SELECT version,vault_id,nonce,ciphertext FROM vault_meta WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(storage_error)?;
    let (version, vault_id, nonce, ciphertext) = row.ok_or_else(|| FORMAT_ERROR.to_string())?;
    if version != VERSION || vault_id.len() != 16 {
        return Err(FORMAT_ERROR.into());
    }
    Ok(Header {
        vault_id: vault_id.try_into().unwrap(),
        nonce,
        ciphertext,
    })
}
fn authenticate_header(header: &Header, key: &[u8; 32]) -> Result<(), String> {
    let plaintext = decrypt(
        key,
        &aad(&header.vault_id, VAULT_MASTER_ACCOUNT, "master-check"),
        &header.nonce,
        &header.ciphertext,
    )?;
    if plaintext.as_slice() != MASTER_CHECK {
        return Err(AUTH_ERROR.into());
    }
    Ok(())
}
fn aad(vault_id: &[u8; 16], account: &str, purpose: &str) -> Vec<u8> {
    let mut data = b"opsark-credential-vault\0".to_vec();
    data.extend_from_slice(&VERSION.to_be_bytes());
    data.extend_from_slice(vault_id);
    for field in [account.as_bytes(), purpose.as_bytes()] {
        data.extend_from_slice(&(field.len() as u32).to_be_bytes());
        data.extend_from_slice(field);
    }
    data
}
fn encrypt(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let key =
        LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).map_err(|_| AUTH_ERROR.to_string())?);
    let mut nonce = [0_u8; 12];
    getrandom::fill(&mut nonce).map_err(|_| SYSTEM_ERROR.to_string())?;
    let mut buffer = Zeroizing::new(plaintext.to_vec());
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(aad),
        &mut *buffer,
    )
    .map_err(|_| AUTH_ERROR.to_string())?;
    Ok((nonce.to_vec(), buffer.to_vec()))
}
fn decrypt(
    key: &[u8; 32],
    aad: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Zeroizing<Vec<u8>>, String> {
    let nonce: [u8; 12] = nonce.try_into().map_err(|_| AUTH_ERROR.to_string())?;
    let key =
        LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).map_err(|_| AUTH_ERROR.to_string())?);
    let mut buffer = Zeroizing::new(ciphertext.to_vec());
    let plaintext_len = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(aad),
            &mut buffer,
        )
        .map_err(|_| AUTH_ERROR.to_string())?
        .len();
    buffer.truncate(plaintext_len);
    Ok(buffer)
}
fn encrypt_record(
    header: &Header,
    key: &[u8; 32],
    account: &str,
    value: Option<&str>,
) -> Result<Record, String> {
    let purpose = if value.is_some() {
        "credential"
    } else {
        "tombstone"
    };
    let (nonce, ciphertext) = encrypt(
        key,
        &aad(&header.vault_id, account, purpose),
        value.unwrap_or("").as_bytes(),
    )?;
    Ok(Record {
        purpose: purpose.into(),
        nonce,
        ciphertext,
        cleanup_pending: true,
    })
}
fn decrypt_record(
    header: &Header,
    key: &[u8; 32],
    account: &str,
    record: &Record,
) -> Result<Option<String>, String> {
    if !matches!(record.purpose.as_str(), "credential" | "tombstone") {
        return Err(FORMAT_ERROR.into());
    }
    let value = decrypt(
        key,
        &aad(&header.vault_id, account, &record.purpose),
        &record.nonce,
        &record.ciphertext,
    )?;
    if record.purpose == "tombstone" {
        if !value.is_empty() {
            return Err(AUTH_ERROR.into());
        }
        return Ok(None);
    }
    let value = std::str::from_utf8(&value).map_err(|_| AUTH_ERROR.to_string())?;
    Ok(Some(value.to_string()))
}
fn read_record(transaction: &Transaction<'_>, account: &str) -> Result<Option<Record>, String> {
    transaction
        .query_row(
            "SELECT purpose,nonce,ciphertext,cleanup_pending FROM vault_records WHERE account=?1",
            [account],
            |row| {
                Ok(Record {
                    purpose: row.get(0)?,
                    nonce: row.get(1)?,
                    ciphertext: row.get(2)?,
                    cleanup_pending: row.get::<_, i64>(3)? == 1,
                })
            },
        )
        .optional()
        .map_err(storage_error)
}
fn write_record(
    transaction: &Transaction<'_>,
    account: &str,
    record: &Record,
) -> Result<(), String> {
    transaction.execute("INSERT INTO vault_records(account,purpose,nonce,ciphertext,cleanup_pending) VALUES(?1,?2,?3,?4,1)
        ON CONFLICT(account) DO UPDATE SET purpose=excluded.purpose,nonce=excluded.nonce,ciphertext=excluded.ciphertext,cleanup_pending=1",
        params![account, record.purpose, record.nonce, record.ciphertext]).map_err(storage_error)?;
    Ok(())
}

#[cfg(test)]
#[path = "credential_vault_tests.rs"]
mod tests;
