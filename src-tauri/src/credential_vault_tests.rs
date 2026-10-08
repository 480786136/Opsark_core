use super::*;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::{Barrier, Condvar};

struct TestDirectory(PathBuf);
impl TestDirectory {
    fn new() -> Self {
        let mut random = [0_u8; 12];
        getrandom::fill(&mut random).unwrap();
        let path = std::env::temp_dir().join(format!(
            "opsark-vault-test-{}-{}",
            std::process::id(),
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn database(&self) -> PathBuf {
        self.0.join("credential-vault.sqlite")
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct ReadGate {
    state: Mutex<(bool, bool)>,
    changed: Condvar,
}
impl ReadGate {
    fn block(&self) {
        let mut state = self.state.lock().unwrap();
        state.0 = true;
        self.changed.notify_all();
        while !state.1 {
            state = self.changed.wait(state).unwrap();
        }
    }
    fn entered(&self) {
        let state = self.state.lock().unwrap();
        let (state, timeout) = self
            .changed
            .wait_timeout_while(state, Duration::from_secs(5), |state| !state.0)
            .unwrap();
        assert!(
            state.0 && !timeout.timed_out(),
            "mock authorization was not reached"
        );
    }
    fn release(&self) {
        self.state.lock().unwrap().1 = true;
        self.changed.notify_all();
    }
}

#[derive(Default)]
struct MockState {
    values: HashMap<String, String>,
    reads: HashMap<String, usize>,
    writes: HashMap<String, usize>,
    deletes: HashMap<String, usize>,
    deny_read: HashSet<String>,
    deny_write: HashSet<String>,
    deny_delete: HashSet<String>,
    fail_master_readback: bool,
    gate: Option<(String, Arc<ReadGate>)>,
    // Verify through a different SQLite connection at the instant of OS deletion.
    durable_probe: Option<(PathBuf, String, Option<String>)>,
    probe_count: usize,
}
#[derive(Default)]
struct MockStore(Mutex<MockState>);
impl MockStore {
    fn put(&self, account: &str, value: &str) {
        self.0
            .lock()
            .unwrap()
            .values
            .insert(account.into(), value.into());
    }
    fn contains(&self, account: &str) -> bool {
        self.0.lock().unwrap().values.contains_key(account)
    }
    fn write_count(&self, account: &str) -> usize {
        *self.0.lock().unwrap().writes.get(account).unwrap_or(&0)
    }
    fn read_count(&self, account: &str) -> usize {
        *self.0.lock().unwrap().reads.get(account).unwrap_or(&0)
    }
    fn delete_count(&self, account: &str) -> usize {
        *self.0.lock().unwrap().deletes.get(account).unwrap_or(&0)
    }
}
impl SystemStore for MockStore {
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        let (value, gate) = {
            let mut state = self.0.lock().unwrap();
            *state.reads.entry(account.into()).or_default() += 1;
            if state.deny_read.contains(account)
                || (account == VAULT_MASTER_ACCOUNT
                    && state.fail_master_readback
                    && state.values.contains_key(account))
            {
                return Err("synthetic permission error (must not leak)".into());
            }
            (
                state.values.get(account).cloned(),
                state
                    .gate
                    .as_ref()
                    .filter(|(target, _)| target == account)
                    .map(|(_, gate)| gate.clone()),
            )
        };
        if let Some(gate) = gate {
            gate.block();
        }
        Ok(value)
    }
    fn write(&self, account: &str, value: &str) -> Result<(), String> {
        let mut state = self.0.lock().unwrap();
        *state.writes.entry(account.into()).or_default() += 1;
        if state.deny_write.contains(account) {
            return Err("synthetic write error".into());
        }
        state.values.insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        let mut state = self.0.lock().unwrap();
        *state.deletes.entry(account.into()).or_default() += 1;
        if state.deny_delete.contains(account) {
            return Err("synthetic delete error".into());
        }
        if let Some((path, target, expected)) = state
            .durable_probe
            .clone()
            .filter(|(_, target, _)| target == account)
        {
            let encoded = state.values.get(VAULT_MASTER_ACCOUNT).unwrap();
            let key: [u8; 32] = STANDARD
                .decode(encoded.strip_prefix("v1:").unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            let mut connection = Connection::open(path).unwrap();
            let transaction = connection.transaction().unwrap();
            let header = read_header(&transaction).unwrap();
            authenticate_header(&header, &key).unwrap();
            let record = read_record(&transaction, &target).unwrap().unwrap();
            assert_eq!(
                decrypt_record(&header, &key, &target, &record).unwrap(),
                expected
            );
            assert!(record.cleanup_pending);
            state.probe_count += 1;
        }
        state.values.remove(account);
        Ok(())
    }
}

fn setup() -> (TestDirectory, Arc<MockStore>, CredentialVault) {
    let directory = TestDirectory::new();
    let store = Arc::new(MockStore::default());
    let vault = CredentialVault::new(directory.database(), store.clone());
    (directory, store, vault)
}
fn pending(path: &Path, account: &str) -> bool {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT cleanup_pending FROM vault_records WHERE account=?1",
            [account],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
        == 1
}
fn snapshot(path: &Path, account: &str) -> Record {
    let mut connection = Connection::open(path).unwrap();
    let transaction = connection.transaction().unwrap();
    read_record(&transaction, account).unwrap().unwrap()
}
fn assert_no_records(path: &Path) {
    let connection = Connection::open(path).unwrap();
    let has_table: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='vault_records')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    if has_table {
        let count: i64 = connection
            .query_row("SELECT count(*) FROM vault_records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}

#[test]
fn encrypts_all_supported_kinds_and_caches_only_verified_master() {
    let (directory, store, vault) = setup();
    let value = "fixture-secret-not-present-in-sqlite-明文";
    for account in ["server:one", "model:one", "secret:one", "knowledge:one"] {
        vault.save(account, value).unwrap();
        assert_eq!(vault.load(account).unwrap().as_deref(), Some(value));
    }
    assert_eq!(store.write_count(VAULT_MASTER_ACCOUNT), 1);
    assert_eq!(store.read_count(VAULT_MASTER_ACCOUNT), 2);
    let bytes = std::fs::read(directory.database()).unwrap();
    assert!(!bytes
        .windows(value.len())
        .any(|window| window == value.as_bytes()));
    let first = snapshot(&directory.database(), "server:one");
    vault.save("server:one", value).unwrap();
    let second = snapshot(&directory.database(), "server:one");
    assert_ne!(first.nonce, second.nonce);
    assert_ne!(first.ciphertext, second.ciphertext);
    let restarted = CredentialVault::new(directory.database(), store.clone());
    assert_eq!(
        restarted.load("server:one").unwrap().as_deref(),
        Some(value)
    );
    assert_eq!(store.read_count(VAULT_MASTER_ACCOUNT), 3);
    let connection = vault.connection().unwrap();
    let sync: i64 = connection
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .unwrap();
    assert_eq!(sync, 2); // SQLITE_SYNC_FULL
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(directory.database())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn migration_deletes_legacy_only_after_committed_authenticated_readback() {
    let (directory, store, vault) = setup();
    store.put("server:legacy", "legacy-fixture");
    store.0.lock().unwrap().durable_probe = Some((
        directory.database(),
        "server:legacy".into(),
        Some("legacy-fixture".into()),
    ));
    assert_eq!(
        vault.load("server:legacy").unwrap().as_deref(),
        Some("legacy-fixture")
    );
    assert!(!store.contains("server:legacy"));
    assert_eq!(store.0.lock().unwrap().probe_count, 1);
    assert!(!pending(&directory.database(), "server:legacy"));
    let restarted = CredentialVault::new(directory.database(), store);
    assert_eq!(
        restarted.load("server:legacy").unwrap().as_deref(),
        Some("legacy-fixture")
    );
}

#[test]
fn deferred_cleanup_preserves_new_value_and_retries_without_legacy_fallback() {
    let (directory, store, vault) = setup();
    store.put("model:legacy", "old-fixture");
    store
        .0
        .lock()
        .unwrap()
        .deny_delete
        .insert("model:legacy".into());
    vault.save("model:legacy", "new-fixture").unwrap();
    assert!(pending(&directory.database(), "model:legacy"));
    store
        .0
        .lock()
        .unwrap()
        .deny_read
        .insert("model:legacy".into());
    let restarted = CredentialVault::new(directory.database(), store.clone());
    assert_eq!(
        restarted.load("model:legacy").unwrap().as_deref(),
        Some("new-fixture")
    );
    assert_eq!(store.read_count("model:legacy"), 0);
    store.0.lock().unwrap().deny_delete.clear();
    assert_eq!(
        restarted.load("model:legacy").unwrap().as_deref(),
        Some("new-fixture")
    );
    assert!(!store.contains("model:legacy"));
    assert!(!pending(&directory.database(), "model:legacy"));
}

#[test]
fn tombstone_prevents_legacy_resurrection_after_restart_and_cleanup_failure() {
    let (directory, store, vault) = setup();
    store.put("secret:old", "old-fixture");
    store
        .0
        .lock()
        .unwrap()
        .deny_delete
        .insert("secret:old".into());
    vault.delete("secret:old").unwrap();
    assert!(store.contains("secret:old"));
    assert_eq!(
        snapshot(&directory.database(), "secret:old").purpose,
        "tombstone"
    );
    let restarted = CredentialVault::new(directory.database(), store.clone());
    assert_eq!(restarted.load("secret:old").unwrap(), None);
    assert_eq!(store.read_count("secret:old"), 0);
    store.0.lock().unwrap().deny_delete.clear();
    assert_eq!(restarted.load("secret:old").unwrap(), None);
    assert!(!store.contains("secret:old"));
    vault.save("secret:old", "replacement-fixture").unwrap();
    assert_eq!(
        vault.load("secret:old").unwrap().as_deref(),
        Some("replacement-fixture")
    );
    vault.save("secret:old", "").unwrap();
    assert_eq!(vault.load("secret:old").unwrap(), None);
}

#[test]
fn missing_legacy_is_distinct_from_system_read_and_write_errors() {
    for fail_at in ["master-read", "master-write", "legacy-read"] {
        let (directory, store, vault) = setup();
        {
            let mut state = store.0.lock().unwrap();
            match fail_at {
                "master-read" => {
                    state.deny_read.insert(VAULT_MASTER_ACCOUNT.into());
                }
                "master-write" => {
                    state.deny_write.insert(VAULT_MASTER_ACCOUNT.into());
                }
                _ => {
                    state.deny_read.insert("server:missing".into());
                }
            }
        }
        assert_eq!(vault.load("server:missing").unwrap_err(), SYSTEM_ERROR);
        assert_no_records(&directory.database());
        assert_eq!(store.delete_count("server:missing"), 0);
    }
    let (directory, _, vault) = setup();
    assert_eq!(vault.load("server:missing").unwrap(), None);
    assert_no_records(&directory.database());
}

#[test]
fn failed_master_readback_keeps_legacy_and_reuses_stored_key_on_retry() {
    let (directory, store, vault) = setup();
    store.put("server:old", "legacy-fixture");
    store.0.lock().unwrap().fail_master_readback = true;
    assert_eq!(vault.load("server:old").unwrap_err(), SYSTEM_ERROR);
    assert_no_records(&directory.database());
    assert!(store.contains("server:old"));
    assert_eq!(store.delete_count("server:old"), 0);
    store.0.lock().unwrap().fail_master_readback = false;
    assert_eq!(
        vault.load("server:old").unwrap().as_deref(),
        Some("legacy-fixture")
    );
    assert_eq!(store.write_count(VAULT_MASTER_ACCOUNT), 1);
}

#[test]
fn existing_vault_missing_malformed_or_wrong_master_never_regenerates_or_falls_back() {
    for bad_master in [
        None,
        Some("v2:invalid".to_string()),
        Some("v1:%%%".to_string()),
        Some(format!("v1:{}", STANDARD.encode([0_u8; 31]))),
        Some(format!("v1:{}", STANDARD.encode([0_u8; 32]))),
    ] {
        let (directory, store, vault) = setup();
        vault.save("server:one", "vault-fixture").unwrap();
        let before = snapshot(&directory.database(), "server:one");
        {
            let mut state = store.0.lock().unwrap();
            state.values.remove(VAULT_MASTER_ACCOUNT);
            if let Some(value) = bad_master {
                state.values.insert(VAULT_MASTER_ACCOUNT.into(), value);
            }
        }
        store.put("server:one", "stale-legacy-fixture");
        let restarted = CredentialVault::new(directory.database(), store.clone());
        assert!(restarted.load("server:one").is_err());
        assert!(restarted.save("server:one", "overwrite-fixture").is_err());
        assert!(restarted.delete("server:one").is_err());
        assert_eq!(store.write_count(VAULT_MASTER_ACCOUNT), 1);
        assert_eq!(store.read_count("server:one"), 0);
        assert_eq!(
            snapshot(&directory.database(), "server:one").ciphertext,
            before.ciphertext
        );
    }
}

#[test]
fn cached_master_still_authenticates_canary_on_every_operation() {
    let (directory, store, vault) = setup();
    vault.save("server:one", "vault-fixture").unwrap();
    Connection::open(directory.database())
        .unwrap()
        .execute(
            "UPDATE vault_meta SET ciphertext=zeroblob(length(ciphertext))",
            [],
        )
        .unwrap();
    assert_eq!(vault.load("server:one").unwrap_err(), AUTH_ERROR);
    assert_eq!(
        vault.save("server:one", "replacement").unwrap_err(),
        AUTH_ERROR
    );
    assert_eq!(store.read_count(VAULT_MASTER_ACCOUNT), 2);
}

#[test]
fn row_account_purpose_nonce_and_ciphertext_tampering_fail_without_legacy_fallback() {
    for statement in [
        "UPDATE vault_records SET account='server:other' WHERE account='server:one'",
        "UPDATE vault_records SET purpose='tombstone' WHERE account='server:one'",
        "UPDATE vault_records SET nonce=x'00' WHERE account='server:one'",
        "UPDATE vault_records SET ciphertext=zeroblob(length(ciphertext)) WHERE account='server:one'",
    ] {
        let (directory, store, vault) = setup();
        vault.save("server:one", "vault-fixture").unwrap();
        Connection::open(directory.database()).unwrap().execute(statement, []).unwrap();
        let account = if statement.contains("account='server:other'") { "server:other" } else { "server:one" };
        store.put(account, "stale-legacy-fixture");
        assert_eq!(vault.load(account).unwrap_err(), AUTH_ERROR);
        assert_eq!(vault.save(account, "replacement").unwrap_err(), AUTH_ERROR);
        assert_eq!(vault.delete(account).unwrap_err(), AUTH_ERROR);
        assert_eq!(store.read_count(account), 0);
        assert!(store.contains(account));
    }
}

#[test]
fn rows_cannot_be_transplanted_between_vaults_sharing_master() {
    let (directory, store, first) = setup();
    let other_path = directory.0.join("other.sqlite");
    let second = CredentialVault::new(other_path.clone(), store.clone());
    first.save("server:one", "first-fixture").unwrap();
    second.save("server:one", "second-fixture").unwrap();
    let record = snapshot(&directory.database(), "server:one");
    let mut connection = Connection::open(&other_path).unwrap();
    let transaction = begin(&mut connection).unwrap();
    write_record(&transaction, "server:one", &record).unwrap();
    transaction.commit().unwrap();
    assert_eq!(second.load("server:one").unwrap_err(), AUTH_ERROR);
    assert_eq!(store.write_count(VAULT_MASTER_ACCOUNT), 1);
}

#[test]
fn authenticated_tombstone_with_nonempty_plaintext_is_rejected() {
    let (_directory, _, vault) = setup();
    vault.load("server:one").unwrap();
    let mut connection = vault.connection().unwrap();
    let transaction = begin(&mut connection).unwrap();
    let (header, key) = vault.open_vault(&transaction).unwrap();
    let (nonce, ciphertext) = encrypt(
        &key,
        &aad(&header.vault_id, "server:one", "tombstone"),
        b"not-empty",
    )
    .unwrap();
    write_record(
        &transaction,
        "server:one",
        &Record {
            purpose: "tombstone".into(),
            nonce,
            ciphertext,
            cleanup_pending: true,
        },
    )
    .unwrap();
    transaction.commit().unwrap();
    assert_eq!(vault.load("server:one").unwrap_err(), AUTH_ERROR);
}

#[test]
fn postcommit_readback_corruption_returns_error_and_does_not_delete_legacy() {
    for migrate in [true, false] {
        let (directory, store, vault) = setup();
        vault.load("server:initialize").unwrap();
        store.put("server:one", "legacy-fixture");
        let connection = Connection::open(directory.database()).unwrap();
        connection.execute_batch("CREATE TRIGGER corrupt_insert AFTER INSERT ON vault_records BEGIN UPDATE vault_records SET ciphertext=zeroblob(length(ciphertext)) WHERE account=NEW.account; END;").unwrap();
        let result = if migrate {
            vault.load("server:one").map(|_| ())
        } else {
            vault.save("server:one", "new-fixture")
        };
        assert_eq!(result.unwrap_err(), AUTH_ERROR);
        assert_eq!(store.delete_count("server:one"), 0);
        assert!(store.contains("server:one"));
        assert!(pending(&directory.database(), "server:one"));
    }
}

#[test]
fn cleanup_flag_write_failure_is_deferred_without_reverting_committed_value() {
    let (directory, store, vault) = setup();
    vault.load("server:initialize").unwrap();
    store.put("server:one", "legacy-fixture");
    let connection = Connection::open(directory.database()).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_cleanup BEFORE UPDATE OF cleanup_pending ON vault_records WHEN NEW.cleanup_pending=0 BEGIN SELECT RAISE(ABORT, 'fixture'); END;").unwrap();
    vault.save("server:one", "new-fixture").unwrap();
    assert!(pending(&directory.database(), "server:one"));
    assert!(!store.contains("server:one"));
    connection
        .execute_batch("DROP TRIGGER reject_cleanup;")
        .unwrap();
    assert_eq!(
        vault.load("server:one").unwrap().as_deref(),
        Some("new-fixture")
    );
    assert!(!pending(&directory.database(), "server:one"));
}

#[test]
fn superseded_committed_candidate_does_not_delete_legacy_on_behalf_of_new_writer() {
    let (directory, store, vault) = setup();
    store
        .0
        .lock()
        .unwrap()
        .deny_delete
        .insert("server:one".into());
    vault.save("server:one", "first-fixture").unwrap();
    let expected = snapshot(&directory.database(), "server:one");
    let mut connection = vault.connection().unwrap();
    let transaction = begin(&mut connection).unwrap();
    let (header, key) = vault.open_vault(&transaction).unwrap();
    transaction.commit().unwrap();
    let other = CredentialVault::new(directory.database(), store.clone());
    other.save("server:one", "later-fixture").unwrap();
    store.put("server:one", "legacy-fixture");
    store.0.lock().unwrap().deny_delete.clear();
    let count = store.delete_count("server:one");
    vault
        .cleanup_legacy(
            &mut connection,
            &header,
            &key,
            "server:one",
            &expected,
            Some("first-fixture"),
        )
        .unwrap();
    assert_eq!(store.delete_count("server:one"), count);
    assert!(store.contains("server:one"));
    assert_eq!(
        vault.load("server:one").unwrap().as_deref(),
        Some("later-fixture")
    );
    assert!(!store.contains("server:one"));
}

#[test]
fn malformed_database_version_or_path_never_accesses_or_replaces_system_master() {
    for invalid in ["foreign", "version", "file", "parent"] {
        let directory = TestDirectory::new();
        let store = Arc::new(MockStore::default());
        let path = if invalid == "parent" {
            let parent = directory.0.join("not-a-directory");
            std::fs::write(&parent, "fixture").unwrap();
            parent.join("vault.sqlite")
        } else {
            directory.database()
        };
        match invalid {
            "foreign" => {
                Connection::open(&path)
                    .unwrap()
                    .execute_batch("CREATE TABLE unrelated(id INTEGER);")
                    .unwrap();
            }
            "version" => {
                Connection::open(&path)
                    .unwrap()
                    .pragma_update(None, "user_version", 99)
                    .unwrap();
            }
            "file" => {
                std::fs::write(&path, "not a sqlite file").unwrap();
            }
            _ => {}
        }
        let vault = CredentialVault::new(path, store.clone());
        assert!(vault.load("server:one").is_err());
        assert_eq!(store.read_count(VAULT_MASTER_ACCOUNT), 0);
        assert_eq!(store.write_count(VAULT_MASTER_ACCOUNT), 0);
    }
}

#[test]
fn generic_api_cannot_access_master_or_official_refresh_namespace() {
    let (_directory, store, vault) = setup();
    for account in [
        VAULT_MASTER_ACCOUNT,
        "account:refresh-token",
        "server:",
        "secret:bad\nidentifier",
        "other:value",
    ] {
        assert!(vault.load(account).is_err());
        assert!(vault.save(account, "fixture").is_err());
        assert!(vault.delete(account).is_err());
    }
    assert_eq!(store.read_count(VAULT_MASTER_ACCOUNT), 0);
}

#[test]
fn independent_instances_initialize_one_master_and_keep_all_concurrent_writes() {
    let (directory, store, _) = setup();
    let barrier = Arc::new(Barrier::new(8));
    let threads: Vec<_> = (0..8)
        .map(|index| {
            let vault = CredentialVault::new(directory.database(), store.clone());
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                vault
                    .save(&format!("server:{index}"), &format!("fixture-{index}"))
                    .unwrap();
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(store.write_count(VAULT_MASTER_ACCOUNT), 1);
    let restarted = CredentialVault::new(directory.database(), store);
    for index in 0..8 {
        assert_eq!(
            restarted.load(&format!("server:{index}")).unwrap(),
            Some(format!("fixture-{index}"))
        );
    }
}

#[test]
fn same_instance_queues_calls_while_system_authorization_is_pending() {
    let (directory, store, vault) = setup();
    let vault = Arc::new(vault);
    let gate = Arc::new(ReadGate::default());
    store.0.lock().unwrap().gate = Some(("server:one".into(), gate.clone()));
    let first_vault = vault.clone();
    let first = std::thread::spawn(move || first_vault.load("server:one"));
    gate.entered();
    assert!(vault.operation.try_lock().is_err());
    let second_vault = vault.clone();
    let second = std::thread::spawn(move || second_vault.save("server:two", "fixture"));
    gate.release();
    assert_eq!(first.join().unwrap().unwrap(), None);
    second.join().unwrap().unwrap();
    assert_eq!(
        vault.load("server:two").unwrap().as_deref(),
        Some("fixture")
    );
    assert_eq!(store.write_count(VAULT_MASTER_ACCOUNT), 1);
    assert!(directory.database().exists());
}

#[test]
fn migration_racing_new_save_or_delete_cannot_resurrect_old_value() {
    for deleting in [false, true] {
        let (directory, store, vault) = setup();
        store.put("server:one", "legacy-fixture");
        let gate = Arc::new(ReadGate::default());
        store.0.lock().unwrap().gate = Some(("server:one".into(), gate.clone()));
        let migrating = std::thread::spawn(move || vault.load("server:one"));
        gate.entered();
        let other = CredentialVault::new(directory.database(), store.clone());
        let newer = std::thread::spawn(move || {
            if deleting {
                other.delete("server:one")
            } else {
                other.save("server:one", "new-fixture")
            }
        });
        gate.release();
        assert_eq!(
            migrating.join().unwrap().unwrap().as_deref(),
            Some("legacy-fixture")
        );
        newer.join().unwrap().unwrap();
        let restarted = CredentialVault::new(directory.database(), store.clone());
        assert_eq!(
            restarted.load("server:one").unwrap().as_deref(),
            if deleting { None } else { Some("new-fixture") }
        );
        assert_eq!(store.write_count(VAULT_MASTER_ACCOUNT), 1);
    }
}

// Files below stand in for the OS credential API in child processes. They only
// contain synthetic test keys and are removed with the test directory.
struct FileMockStore(PathBuf);
impl FileMockStore {
    fn item(&self, account: &str) -> PathBuf {
        self.0
            .join(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(account))
    }
}
impl SystemStore for FileMockStore {
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        match std::fs::read_to_string(self.item(account)) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("mock file read".into()),
        }
    }
    fn write(&self, account: &str, value: &str) -> Result<(), String> {
        std::fs::write(self.item(account), value).map_err(|_| "mock file write".to_string())?;
        if account == VAULT_MASTER_ACCOUNT {
            let mut count = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.0.join("master-write-count"))
                .map_err(|_| "mock count".to_string())?;
            writeln!(count, "write").map_err(|_| "mock count".to_string())?;
        }
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        match std::fs::remove_file(self.item(account)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("mock file delete".into()),
        }
    }
}

#[test]
fn child_process_writer() {
    let Some(directory) = std::env::var_os("OPSARK_VAULT_TEST_CHILD_DIRECTORY") else {
        return;
    };
    let directory = PathBuf::from(directory);
    let account = std::env::var("OPSARK_VAULT_TEST_CHILD_ACCOUNT").unwrap();
    let store = Arc::new(FileMockStore(directory.join("fake-system")));
    let vault = CredentialVault::new(directory.join("credential-vault.sqlite"), store);
    vault.save(&account, "child-fixture").unwrap();
}

#[test]
fn independent_processes_serialize_master_initialization_and_database_writes() {
    let directory = TestDirectory::new();
    std::fs::create_dir(directory.0.join("fake-system")).unwrap();
    let children: Vec<_> = (0..3)
        .map(|index| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "credential_vault::tests::child_process_writer",
                    "--test-threads=1",
                ])
                .env("OPSARK_VAULT_TEST_CHILD_DIRECTORY", &directory.0)
                .env(
                    "OPSARK_VAULT_TEST_CHILD_ACCOUNT",
                    format!("server:child-{index}"),
                )
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    for child in children {
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "child test failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert_eq!(
        std::fs::read_to_string(directory.0.join("fake-system/master-write-count"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    let vault = CredentialVault::new(
        directory.database(),
        Arc::new(FileMockStore(directory.0.join("fake-system"))),
    );
    for index in 0..3 {
        assert_eq!(
            vault
                .load(&format!("server:child-{index}"))
                .unwrap()
                .as_deref(),
            Some("child-fixture")
        );
    }
}
