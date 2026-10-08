//! Durable execution facts. This repository never dispatches or replays I/O.
//! A successful `begin` commit is a prerequisite for dispatch, not proof that
//! dispatch occurred. Recovery preserves that uncertainty across process death.
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const VERSION: u32 = 1;
fn error(code: &str, message: impl std::fmt::Display) -> String {
    format!("EXECUTION_LEDGER_{code}: {message}")
}
fn storage(e: impl std::fmt::Display) -> String {
    error("STORAGE", e)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn boot_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(crate::task_logs::call_id)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreparedOperation {
    pub version: u32,
    pub operation_id: String,
    pub task_id: String,
    pub step_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub round_id: Option<String>,
    pub workflow_epoch: u64,
    pub plan_revision: u64,
    pub step_revision: u64,
    pub intent_digest: String,
    pub intent: Value,
    pub phase: Phase,
    pub effect: Effect,
    pub resource_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    Command,
    Validation,
    Tool,
    Framework,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Effect {
    Read,
    Change,
    Interaction,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Status {
    Prepared,
    Dispatching,
    Succeeded,
    Failed,
    Unknown,
    NotDispatched,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Outcome {
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    pub evidence_refs: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AttemptReviewInput {
    pub version: u32,
    pub operation_id: String,
    pub attempt_id: String,
    pub intent_digest: String,
    pub outcome: String,
    pub disposition: String,
    pub evidence_refs: Vec<String>,
    pub review_fingerprint: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttemptReviewReceipt {
    #[serde(flatten)]
    pub review: AttemptReviewInput,
    pub recorded_at: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Attempt {
    pub version: u32,
    pub id: String,
    pub operation_id: String,
    pub execution_id: String,
    pub status: Status,
    pub boot_id: String,
    pub cancel_requested: bool,
    pub late: bool,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
    // UI receipt/review acknowledgement, not proof of current remote state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projection_applied_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_completed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reviews: Vec<AttemptReviewReceipt>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Operation {
    #[serde(flatten)]
    pub record: PreparedOperation,
    pub state: Status,
    pub attempts: Vec<Attempt>,
    pub cancel_requested: bool,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconciliation: Option<Value>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ReconciliationProof {
    #[serde(rename_all = "camelCase")]
    FileTransfer {
        version: u32,
        source_read_operation_id: String,
        target_read_operation_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Service {
        version: u32,
        read_operation_id: String,
    },
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 1024 || id.chars().any(char::is_control) {
        return Err(error("INVALID_RECORD", "invalid identifier"));
    }
    Ok(())
}
// Matches the frontend's explicit credential fields; never searches arbitrary
// IDs, paths, command text or public account names for password substrings.
fn credential_field(value: &Value, path: &str) -> Option<String> {
    match value {
        Value::Object(map) => map.iter().find_map(|(key, value)| {
            let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
            let sensitive = matches!(normalized.as_str(),
                "password" | "passwd" | "passphrase" | "apikey" | "accesstoken"
                | "refreshtoken" | "authorization" | "privatekey" | "clientsecret" | "secret");
            let location = format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"));
            if sensitive && !value.is_null() && value.as_str() != Some("") && value.as_str() != Some("[REDACTED]") {
                Some(location)
            } else { credential_field(value, &location) }
        }),
        Value::Array(values) => values.iter().enumerate()
            .find_map(|(index, value)| credential_field(value, &format!("{path}/{index}"))),
        _ => None,
    }
}
fn contains_raw_secret(value: &Value) -> bool {
    credential_field(value, "").is_some()
}
fn validate_record(record: &PreparedOperation) -> Result<(), String> {
    if record.version != VERSION
        || record.intent["version"] != "execution-intent@1"
        || record.intent["algorithm"] != "sha256"
    {
        return Err(error(
            "UNSUPPORTED_VERSION",
            "unsupported execution record or intent version",
        ));
    }
    for id in [
        &record.operation_id,
        &record.task_id,
        &record.step_id,
        &record.intent_digest,
    ] {
        validate_id(id)?;
    }
    if record.intent["digest"].as_str() != Some(&record.intent_digest) {
        return Err(error(
            "INVALID_RECORD",
            "intent digest does not match snapshot",
        ));
    }
    let semantic = &record.intent["semantic"];
    if semantic["taskId"] != record.task_id
        || semantic["stepId"] != record.step_id
        || semantic["effect"] != serde_json::to_value(&record.effect).map_err(storage)?
    {
        return Err(error(
            "INVALID_RECORD",
            "intent task, step, or effect differs from execution record",
        ));
    }
    if record.intent_digest != intent_digest(semantic)? {
        return Err(error(
            "INVALID_RECORD",
            "execution intent checksum mismatch",
        ));
    }
    let action = &semantic["action"];
    if !matches!(action["type"].as_str(), Some("shell" | "tool")) || !semantic["targets"].is_array()
    {
        return Err(error(
            "INVALID_RECORD",
            "unsupported action or target contract",
        ));
    }
    if record.effect == Effect::Change && record.resource_keys.is_empty() {
        return Err(error(
            "INVALID_RECORD",
            "change operations must declare resources",
        ));
    }
    for key in &record.resource_keys {
        validate_id(key)?;
    }
    let mut expected_resources = std::collections::BTreeSet::new();
    for target in semantic["targets"].as_array().unwrap() {
        if !target.is_object()
            || !matches!(
                target["role"].as_str(),
                Some("execution" | "source" | "target" | "lookup" | "connection" | "interaction")
            )
        {
            return Err(error(
                "INVALID_RECORD",
                "unsupported execution target contract",
            ));
        }
        let host = target["host"]
            .as_str()
            .ok_or_else(|| error("INVALID_RECORD", "target host must be a string"))?;
        if host.is_empty() || target["role"] == "interaction" {
            continue;
        }
        let port = target["port"]
            .as_u64()
            .filter(|port| *port > 0 && *port <= 65535)
            .ok_or_else(|| error("INVALID_RECORD", "invalid execution target port"))?;
        if !target["username"].is_null() && !target["username"].is_string() {
            return Err(error("INVALID_RECORD", "target username must be a string"));
        }
        // Accounts can share paths and services: account identity remains in
        // the snapshot, while writes serialize across the whole endpoint.
        expected_resources.insert(format!("endpoint:{}:{port}", host.to_lowercase()));
    }
    if expected_resources.is_empty() {
        expected_resources.insert(format!("task:{}", record.task_id));
    }
    let declared_resources: std::collections::BTreeSet<_> =
        record.resource_keys.iter().cloned().collect();
    if declared_resources != expected_resources
        || declared_resources.len() != record.resource_keys.len()
    {
        return Err(error(
            "INVALID_RECORD",
            "resource keys do not match frozen execution targets",
        ));
    }
    if let Some(field) = credential_field(&record.intent, "") {
        return Err(error(
            "SECRET_VALUE",
            &format!("credential field {field}: store credential references, never raw credentials"),
        ));
    }
    if serde_json::to_vec(record).map_err(storage)?.len() > 1_048_576 {
        return Err(error(
            "INVALID_RECORD",
            "execution intent exceeds storage limit",
        ));
    }
    Ok(())
}

// Match J1 canonicalExecutionJson exactly, including JavaScript's numeric
// property enumeration and UTF-16 string ordering. Plain serde_json sorting
// differs for integer property names, supplementary Unicode, and floats.
fn canonical_json(value: &Value) -> Result<String, String> {
    fn array_index(key: &str) -> Option<u32> {
        key.parse::<u32>()
            .ok()
            .filter(|index| *index != u32::MAX && index.to_string() == key)
    }
    fn write(value: &Value, output: &mut String) -> Result<(), String> {
        match value {
            Value::Null => output.push_str("null"),
            Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
            Value::String(value) => {
                output.push_str(&serde_json::to_string(value).map_err(storage)?)
            }
            Value::Number(number) => {
                let number = number
                    .as_f64()
                    .filter(|number| number.is_finite())
                    .ok_or_else(|| error("INVALID_RECORD", "nonfinite intent number"))?;
                output.push_str(ryu_js::Buffer::new().format(number));
            }
            Value::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    write(value, output)?;
                }
                output.push(']');
            }
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort_by(
                    |left, right| match (array_index(left), array_index(right)) {
                        (Some(a), Some(b)) => a.cmp(&b),
                        (Some(_), None) => std::cmp::Ordering::Less,
                        (None, Some(_)) => std::cmp::Ordering::Greater,
                        (None, None) => left.encode_utf16().cmp(right.encode_utf16()),
                    },
                );
                output.push('{');
                for (index, key) in keys.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    output.push_str(&serde_json::to_string(key).map_err(storage)?);
                    output.push(':');
                    write(&map[*key], output)?;
                }
                output.push('}');
            }
        }
        Ok(())
    }
    let mut output = String::new();
    write(value, &mut output)?;
    Ok(output)
}
fn intent_digest(semantic: &Value) -> Result<String, String> {
    let canonical =
        canonical_json(&serde_json::json!({"version":"execution-intent@1","semantic":semantic}))?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical.as_bytes())))
}

pub(crate) struct Ledger {
    connection: Connection,
    boot: String,
}
impl Ledger {
    pub(crate) fn open(root: &Path, boot: &str) -> Result<Self, String> {
        std::fs::create_dir_all(root).map_err(storage)?;
        let connection =
            Connection::open(root.join("execution-ledger.sqlite3")).map_err(storage)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(storage)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(storage)?;
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(storage)?;
        if version > VERSION {
            return Err(error(
                "UNSUPPORTED_VERSION",
                format!("database version {version}"),
            ));
        }
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(storage)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(storage)?;
        let mut ledger = Self {
            connection,
            boot: boot.into(),
        };
        let tx = ledger
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS operations (
            id TEXT PRIMARY KEY, task_id TEXT NOT NULL, record TEXT NOT NULL,
            state TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, reconciliation TEXT);
            CREATE INDEX IF NOT EXISTS operations_task ON operations(task_id);
            CREATE TABLE IF NOT EXISTS attempts (
            id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id),
            record TEXT NOT NULL, status TEXT NOT NULL, boot_id TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS attempts_operation ON attempts(operation_id);
            CREATE UNIQUE INDEX IF NOT EXISTS attempts_active ON attempts(operation_id) WHERE status IN ('dispatching','unknown');
            CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id),
            attempt_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS resource_locks (
            resource_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id));
            PRAGMA user_version = 1;").map_err(storage)?;
        // A future/corrupt row may own effects which this version cannot
        // interpret. Validate the whole repository before granting any new
        // dispatch permit, rather than only validating the requested task.
        let operation_ids: Vec<String> = {
            let mut query = tx.prepare("SELECT id FROM operations").map_err(storage)?;
            let ids = query
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(storage)?;
            ids.collect::<Result<_, _>>().map_err(storage)?
        };
        for id in operation_ids {
            read_operation(&tx, &id)?;
        }
        let mut abandoned = Vec::new();
        {
            let mut query = tx
                .prepare(
                    "SELECT record FROM attempts WHERE status = 'dispatching' AND boot_id != ?1",
                )
                .map_err(storage)?;
            let rows = query
                .query_map([&ledger.boot], |row| row.get::<_, String>(0))
                .map_err(storage)?;
            for row in rows {
                abandoned.push(parse::<Attempt>(&row.map_err(storage)?)?);
            }
        }
        for mut attempt in abandoned {
            if attempt.version != VERSION {
                return Err(error("UNSUPPORTED_VERSION", "unsupported attempt version"));
            }
            // Validate the persisted parent before making any migration writes.
            read_operation(&tx, &attempt.operation_id)?
                .ok_or_else(|| error("INVALID_RECORD", "missing attempt owner"))?;
            attempt.status = Status::Unknown;
            write_attempt(&tx, &attempt)?;
            tx.execute(
                "UPDATE operations SET state='unknown', updated_at=?2 WHERE id=?1",
                params![attempt.operation_id, now()],
            )
            .map_err(storage)?;
            tx.execute("INSERT OR IGNORE INTO events(id, operation_id, attempt_id, kind, payload, created_at) VALUES (?1,?2,?3,'recovered_unknown',?4,?5)",
                params![format!("recovery:{}", attempt.id), attempt.operation_id, attempt.id, json(&attempt)?, now()]).map_err(storage)?;
        }
        tx.commit().map_err(storage)?;
        Ok(ledger)
    }

    pub(crate) fn prepare(&mut self, record: PreparedOperation) -> Result<Operation, String> {
        validate_record(&record)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if let Some(existing) = read_operation(&tx, &record.operation_id)? {
            // Physical dispatch identifiers belong to attempts. Re-preparing
            // an unchanged logical read for its bounded retry may supply a new
            // execution ID without changing the approved operation identity.
            let mut comparable = record.clone();
            comparable.execution_id = existing.record.execution_id.clone();
            if existing.record != comparable {
                return Err(error(
                    "INTENT_CONFLICT",
                    "operation id already belongs to a different intent",
                ));
            }
            return Ok(existing);
        }
        let timestamp = now();
        tx.execute("INSERT INTO operations(id,task_id,record,state,created_at,updated_at) VALUES (?1,?2,?3,'prepared',?4,?4)",
            params![record.operation_id, record.task_id, json(&record)?, timestamp]).map_err(storage)?;
        tx.execute("INSERT INTO events(id,operation_id,kind,payload,created_at) VALUES (?1,?2,'prepared',?3,?4)",
            params![format!("prepared:{}", record.operation_id), record.operation_id, json(&record)?, timestamp]).map_err(storage)?;
        tx.commit().map_err(storage)?;
        self.get(&record.operation_id)
    }

    pub(crate) fn begin(
        &mut self,
        operation_id: &str,
        attempt_id: &str,
        execution_id: &str,
    ) -> Result<Attempt, String> {
        validate_id(attempt_id)?;
        validate_id(execution_id)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let operation = read_operation(&tx, operation_id)?
            .ok_or_else(|| error("NOT_FOUND", "operation is not prepared"))?;
        if operation
            .attempts
            .iter()
            .any(|attempt| attempt.id == attempt_id)
        {
            // An IPC reply may have been lost after commit. Returning the same permit
            // would let an unsafe caller dispatch twice; query the record instead.
            return Err(error(
                "ATTEMPT_EXISTS",
                "attempt already registered; never redispatch the same attempt",
            ));
        }
        if operation.cancel_requested {
            return Err(error(
                "CANCEL_REQUESTED",
                "operation cancellation requested",
            ));
        }
        if operation
            .attempts
            .iter()
            .any(|attempt| matches!(attempt.status, Status::Dispatching | Status::Unknown))
        {
            return Err(error(
                "ACTIVE_ATTEMPT",
                "an active or uncertain attempt already exists",
            ));
        }
        if operation.record.effect != Effect::Read
            && operation
                .attempts
                .iter()
                .any(|attempt| attempt.status != Status::NotDispatched)
        {
            return Err(error(
                "REPLAY_BLOCKED",
                "a change or interaction operation cannot be replayed",
            ));
        }
        if operation.record.effect == Effect::Change {
            for resource in &operation.record.resource_keys {
                let owner: Option<String> = tx
                    .query_row(
                        "SELECT operation_id FROM resource_locks WHERE resource_key=?1",
                        [resource],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(storage)?;
                if owner.as_deref().is_some_and(|owner| owner != operation_id) {
                    return Err(error(
                        "RESOURCE_CONFLICT",
                        format!("resource has an active or uncertain change: {resource}"),
                    ));
                }
                tx.execute("INSERT OR IGNORE INTO resource_locks(resource_key,operation_id) VALUES (?1,?2)", params![resource, operation_id]).map_err(storage)?;
            }
        }
        let attempt = Attempt {
            version: VERSION,
            id: attempt_id.into(),
            operation_id: operation_id.into(),
            execution_id: execution_id.into(),
            status: Status::Dispatching,
            boot_id: self.boot.clone(),
            cancel_requested: false,
            late: false,
            started_at: now(),
            completed_at: None,
            outcome: None,
            projection_applied_at: None,
            review_completed_at: None,
            reviews: Vec::new(),
        };
        tx.execute("INSERT INTO attempts(id,operation_id,record,status,boot_id) VALUES (?1,?2,?3,'dispatching',?4)", params![attempt.id, operation_id, json(&attempt)?, self.boot]).map_err(storage)?;
        tx.execute(
            "UPDATE operations SET state='dispatching',updated_at=?2 WHERE id=?1",
            params![operation_id, attempt.started_at],
        )
        .map_err(storage)?;
        tx.execute("INSERT INTO events(id,operation_id,attempt_id,kind,payload,created_at) VALUES (?1,?2,?3,'dispatching',?4,?5)", params![format!("begin:{}", attempt.id), operation_id, attempt.id, json(&attempt)?, attempt.started_at]).map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(attempt)
    }

    pub(crate) fn complete(
        &mut self,
        root: &Path,
        operation_id: &str,
        attempt_id: &str,
        event_id: &str,
        outcome: Outcome,
        late: bool,
    ) -> Result<Attempt, String> {
        validate_id(event_id)?;
        if matches!(outcome.status, Status::Prepared | Status::Dispatching) {
            return Err(error("INVALID_RESULT", "not a completion outcome"));
        }
        if contains_raw_secret(&serde_json::to_value(&outcome).map_err(storage)?) {
            return Err(error(
                "SECRET_VALUE",
                "result contains raw credential fields",
            ));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let operation = read_operation(&tx, operation_id)?
            .ok_or_else(|| error("NOT_FOUND", "operation not found"))?;
        let current_attempt_id = operation.attempts.last().map(|attempt| attempt.id.clone());
        let mut attempt = operation
            .attempts
            .into_iter()
            .find(|attempt| attempt.id == attempt_id)
            .ok_or_else(|| error("ATTEMPT_MISMATCH", "attempt does not belong to operation"))?;
        if outcome.evidence_refs.is_empty() {
            return Err(error(
                "INVALID_EVIDENCE",
                "completion requires archived evidence",
            ));
        }
        for id in &outcome.evidence_refs {
            let evidence = crate::evidence_store::read(root, &operation.record.task_id, id, 0, 1)
                .map_err(|e| error("INVALID_EVIDENCE", e))?;
            if evidence["metadata"]["operationId"] != operation_id
                || evidence["metadata"]["attemptId"] != attempt_id
                || evidence["metadata"]["executionId"] != attempt.execution_id
                || evidence["metadata"]["status"] != status_text(&outcome.status)
            {
                return Err(error(
                    "INVALID_EVIDENCE",
                    "archived evidence does not belong to this execution outcome",
                ));
            }
        }
        let payload = json(&outcome)?;
        if payload.len() > 262_144 {
            return Err(error(
                "INVALID_RESULT",
                "use evidence references for large results",
            ));
        }
        let existing_event: Option<(String, Option<String>, String)> = tx
            .query_row(
                "SELECT operation_id,attempt_id,payload FROM events WHERE id=?1",
                [event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(storage)?;
        if let Some((owner, target, previous)) = existing_event {
            if owner != operation_id || target.as_deref() != Some(attempt_id) || previous != payload
            {
                return Err(error(
                    "EVENT_CONFLICT",
                    "event id belongs to different result",
                ));
            }
            return Ok(attempt);
        }
        if !matches!(attempt.status, Status::Dispatching | Status::Unknown) {
            if attempt.outcome.as_ref() != Some(&outcome) {
                return Err(error("RESULT_CONFLICT", "terminal result is immutable"));
            }
        } else {
            // Unknown can be refined by a real late result; cancellation is never
            // promoted into a remote cancellation fact.
            attempt.status = outcome.status.clone();
            attempt.late |= late || attempt.cancel_requested || attempt.boot_id != self.boot;
            attempt.completed_at = Some(now());
            attempt.outcome = Some(outcome.clone());
            write_attempt(&tx, &attempt)?;
        }
        tx.execute("INSERT INTO events(id,operation_id,attempt_id,kind,payload,created_at) VALUES (?1,?2,?3,'result',?4,?5)", params![event_id, operation_id, attempt_id, payload, now()]).map_err(storage)?;
        if current_attempt_id.as_deref() == Some(attempt_id) {
            tx.execute(
                "UPDATE operations SET state=?2,updated_at=?3 WHERE id=?1",
                params![operation_id, status_text(&attempt.status), now()],
            )
            .map_err(storage)?;
            if attempt.status != Status::Unknown {
                tx.execute(
                    "DELETE FROM resource_locks WHERE operation_id=?1",
                    [operation_id],
                )
                .map_err(storage)?;
            }
        }
        tx.commit().map_err(storage)?;
        Ok(attempt)
    }

    /// Acknowledgement never changes outcomes, reconciliation or resource locks.
    pub(crate) fn acknowledge(&mut self, operation_id: &str, attempt_id: &str, reviewed: bool) -> Result<Attempt, String> {
        self.acknowledge_with_review(operation_id, attempt_id, reviewed, None)
    }

    pub(crate) fn acknowledge_with_review(&mut self, operation_id: &str, attempt_id: &str, reviewed: bool,
        review: Option<AttemptReviewInput>) -> Result<Attempt, String> {
        let tx = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
        let operation = read_operation(&tx, operation_id)?.ok_or_else(|| error("NOT_FOUND", "operation not found"))?;
        let mut attempt = operation.attempts.iter().find(|a| a.id == attempt_id).cloned()
            .ok_or_else(|| error("ATTEMPT_MISMATCH", "attempt does not belong to operation"))?;
        if !matches!(attempt.status, Status::Succeeded | Status::Failed | Status::NotDispatched)
            || attempt.outcome.is_none() || attempt.late
            || reviewed && attempt.status != Status::Succeeded {
            return Err(error("ACKNOWLEDGEMENT_INVALID", "only an owned terminal receipt may be acknowledged"));
        }
        if let Some(review) = &review {
            let refs = &attempt.outcome.as_ref().expect("checked terminal receipt").evidence_refs;
            let fingerprint = review.review_fingerprint.strip_prefix("sha256:").unwrap_or("");
            let disposition_valid = match review.disposition.as_str() {
                "accepted" => review.outcome == "proven",
                "task_followup" => matches!(review.outcome.as_str(), "not_met" | "unknown"),
                _ => false,
            };
            if review.version != 1 || review.operation_id != operation_id || review.attempt_id != attempt_id
                || review.intent_digest != operation.record.intent_digest
                || !matches!(attempt.status, Status::Succeeded | Status::Failed)
                || operation.cancel_requested || attempt.cancel_requested || !disposition_valid
                || fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || refs.is_empty() || review.evidence_refs.len() != refs.len()
                || review.evidence_refs.iter().collect::<std::collections::HashSet<_>>().len() != refs.len()
                || review.evidence_refs.iter().any(|id| !refs.contains(id)) {
                return Err(error("REVIEW_INVALID", "review must reference the exact owned terminal attempt, intent and evidence"));
            }
            if let Some(previous) = attempt.reviews.iter().find(|item| item.review.review_fingerprint == review.review_fingerprint) {
                if previous.review != *review { return Err(error("REVIEW_CONFLICT", "a review fingerprint cannot replace a recorded decision")); }
            } else {
                attempt.reviews.push(AttemptReviewReceipt { review: review.clone(), recorded_at: now() });
            }
        }
        attempt.projection_applied_at.get_or_insert_with(now);
        if reviewed { attempt.review_completed_at.get_or_insert_with(now); }
        write_attempt(&tx, &attempt)?;
        tx.execute("INSERT OR IGNORE INTO events(id,operation_id,attempt_id,kind,payload,created_at) VALUES (?1,?2,?3,'receipt_acknowledged',?4,?5)",
            params![format!("ack:{attempt_id}:{reviewed}"), operation_id, attempt_id, json(&attempt)?, now()]).map_err(storage)?;
        if let Some(review) = &review {
            tx.execute("INSERT OR IGNORE INTO events(id,operation_id,attempt_id,kind,payload,created_at) VALUES (?1,?2,?3,'step_review_completed',?4,?5)",
                params![format!("review:{attempt_id}:{}", review.review_fingerprint), operation_id, attempt_id, json(review)?, now()]).map_err(storage)?;
        }
        tx.commit().map_err(storage)?;
        Ok(attempt)
    }

    pub(crate) fn cancel(
        &mut self,
        operation_id: &str,
        attempt_id: Option<&str>,
    ) -> Result<Operation, String> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let mut operation = read_operation(&tx, operation_id)?
            .ok_or_else(|| error("NOT_FOUND", "operation not found"))?;
        if let Some(id) = attempt_id {
            if !operation.attempts.iter().any(|attempt| attempt.id == id) {
                return Err(error(
                    "ATTEMPT_MISMATCH",
                    "attempt does not belong to operation",
                ));
            }
        }
        for attempt in &mut operation.attempts {
            if attempt_id.is_none_or(|id| attempt.id == id)
                && matches!(attempt.status, Status::Dispatching | Status::Unknown)
            {
                attempt.cancel_requested = true;
                write_attempt(&tx, attempt)?;
            }
        }
        tx.execute(
            "UPDATE operations SET cancel_requested=1,updated_at=?2 WHERE id=?1",
            params![operation_id, now()],
        )
        .map_err(storage)?;
        tx.execute("INSERT OR IGNORE INTO events(id,operation_id,attempt_id,kind,payload,created_at) VALUES (?1,?2,?3,'cancel_requested','{}',?4)", params![format!("cancel:{operation_id}:{}", attempt_id.unwrap_or("*")), operation_id, attempt_id, now()]).map_err(storage)?;
        tx.commit().map_err(storage)?;
        self.get(operation_id)
    }

    fn get(&self, id: &str) -> Result<Operation, String> {
        let tx = self.connection.unchecked_transaction().map_err(storage)?;
        read_operation(&tx, id)?.ok_or_else(|| error("NOT_FOUND", "operation not found"))
    }
    pub(crate) fn list(&self, task_id: Option<&str>) -> Result<Vec<Operation>, String> {
        let tx = self.connection.unchecked_transaction().map_err(storage)?;
        let mut statement = tx
            .prepare(
                "SELECT id FROM operations WHERE (?1 IS NULL OR task_id=?1) ORDER BY created_at,id",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map([task_id], |row| row.get::<_, String>(0))
            .map_err(storage)?;
        rows.map(|row| {
            read_operation(&tx, &row.map_err(storage)?)?
                .ok_or_else(|| error("INVALID_RECORD", "missing listed operation"))
        })
        .collect()
    }

    pub(crate) fn resolve(
        &mut self,
        root: &Path,
        operation_id: &str,
        attempt_id: &str,
        proof: ReconciliationProof,
    ) -> Result<Operation, String> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let operation = read_operation(&tx, operation_id)?
            .ok_or_else(|| error("NOT_FOUND", "operation not found"))?;
        let attempt = operation
            .attempts
            .last()
            .filter(|attempt| attempt.id == attempt_id)
            .ok_or_else(|| {
                error(
                    "ATTEMPT_MISMATCH",
                    "only the current attempt can be reconciled",
                )
            })?;
        if !matches!(
            attempt.status,
            Status::Unknown | Status::Failed | Status::Succeeded
        ) {
            return Err(error(
                "RECONCILIATION_REJECTED",
                "wait for the active attempt before reconciling",
            ));
        }
        if operation.reconciliation.is_some() {
            return Ok(operation);
        }
        let semantic = &operation.record.intent["semantic"];
        let (kind, read_ids) = match &proof {
            ReconciliationProof::FileTransfer {
                version,
                source_read_operation_id,
                target_read_operation_id,
            } => {
                if *version != VERSION {
                    return Err(error(
                        "UNSUPPORTED_VERSION",
                        "unsupported reconciliation version",
                    ));
                }
                if semantic["action"]["type"] != "tool"
                    || semantic["action"]["toolId"] != "files.transfer_between_servers"
                    || source_read_operation_id == target_read_operation_id
                {
                    return Err(error(
                        "RECONCILIATION_REJECTED",
                        "not a distinct two-endpoint file transfer observation",
                    ));
                }
                let source = intent_target(semantic, "source")?;
                let target = intent_target(semantic, "target")?;
                let source_read = read_operation(&tx, source_read_operation_id)?
                    .ok_or_else(|| error("NOT_FOUND", "source read not found"))?;
                let target_read = read_operation(&tx, target_read_operation_id)?
                    .ok_or_else(|| error("NOT_FOUND", "target read not found"))?;
                let source_output = verified_read(
                    &tx,
                    root,
                    &operation,
                    attempt,
                    &source_read,
                    source,
                    &file_probe_command(source)?,
                )?;
                let target_output = verified_read(
                    &tx,
                    root,
                    &operation,
                    attempt,
                    &target_read,
                    target,
                    &file_probe_command(target)?,
                )?;
                if file_fingerprint(&source_output, source)?
                    != file_fingerprint(&target_output, target)?
                {
                    return Err(error(
                        "RECONCILIATION_REJECTED",
                        "source and target do not have the same stable file fingerprint",
                    ));
                }
                (
                    "file_transfer",
                    vec![
                        source_read_operation_id.clone(),
                        target_read_operation_id.clone(),
                    ],
                )
            }
            ReconciliationProof::Service {
                version,
                read_operation_id,
            } => {
                if *version != VERSION {
                    return Err(error(
                        "UNSUPPORTED_VERSION",
                        "unsupported reconciliation version",
                    ));
                }
                if semantic["action"]["type"] != "shell"
                    || semantic["runtimeClass"] != "persistent_service"
                {
                    return Err(error(
                        "RECONCILIATION_REJECTED",
                        "not a persistent service operation",
                    ));
                }
                let command = semantic["validator"]["command"]
                    .as_str()
                    .or_else(|| semantic["validation"].as_str())
                    .ok_or_else(|| {
                        error(
                            "RECONCILIATION_REJECTED",
                            "missing frozen service validator",
                        )
                    })?;
                if !is_read_only_service_validator(command) {
                    return Err(error(
                        "RECONCILIATION_REJECTED",
                        "service validator is outside the read-only allowlist",
                    ));
                }
                let target = intent_target(semantic, "execution")?;
                let read = read_operation(&tx, read_operation_id)?
                    .ok_or_else(|| error("NOT_FOUND", "service read not found"))?;
                verified_read(&tx, root, &operation, attempt, &read, target, command)?;
                ("service", vec![read_operation_id.clone()])
            }
        };
        let mut evidence_refs = Vec::new();
        for id in &read_ids {
            let read = read_operation(&tx, id)?.unwrap();
            evidence_refs.extend(
                read.attempts
                    .last()
                    .and_then(|attempt| attempt.outcome.as_ref())
                    .unwrap()
                    .evidence_refs
                    .clone(),
            );
        }
        let reconciliation = serde_json::json!({"version":1,"status":"completed","reason":"current_state_verified","attemptId":attempt_id,"readOperationId":read_ids[0],"readOperationIds":read_ids,"evidenceRefs":evidence_refs,"kind":kind,"resolvedAt":now()});
        tx.execute(
            "UPDATE operations SET reconciliation=?2,updated_at=?3 WHERE id=?1",
            params![operation_id, json(&reconciliation)?, now()],
        )
        .map_err(storage)?;
        tx.execute(
            "DELETE FROM resource_locks WHERE operation_id=?1",
            [operation_id],
        )
        .map_err(storage)?;
        tx.execute("INSERT INTO events(id,operation_id,attempt_id,kind,payload,created_at) VALUES (?1,?2,?3,'reconciled_current_state',?4,?5)", params![format!("reconcile:{attempt_id}"),operation_id,attempt_id,json(&reconciliation)?,now()]).map_err(storage)?;
        tx.commit().map_err(storage)?;
        self.get(operation_id)
    }
}
fn intent_target<'a>(semantic: &'a Value, role: &str) -> Result<&'a Value, String> {
    let matches: Vec<&Value> = semantic["targets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|target| target["role"] == role)
        .collect();
    if matches.len() != 1 {
        return Err(error(
            "RECONCILIATION_REJECTED",
            "ambiguous or missing frozen target",
        ));
    }
    Ok(matches[0])
}
fn same_endpoint(left: &Value, right: &Value) -> bool {
    let Some(host) = left["host"].as_str() else {
        return false;
    };
    !host.is_empty()
        && right["host"]
            .as_str()
            .is_some_and(|other| host.eq_ignore_ascii_case(other))
        && left["serverId"].as_str().is_some_and(|id| !id.is_empty())
        && left["serverId"] == right["serverId"]
        && left["port"]
            .as_u64()
            .is_some_and(|port| port > 0 && port <= 65535)
        && left["port"] == right["port"]
        && left["username"]
            .as_str()
            .is_some_and(|username| !username.is_empty())
        && left["username"] == right["username"]
}
fn file_probe_command(target: &Value) -> Result<String, String> {
    let path = target["path"]
        .as_str()
        .filter(|path| {
            path.starts_with('/') && !path.chars().any(|ch| matches!(ch, '\r' | '\n' | '\0'))
        })
        .ok_or_else(|| {
            error(
                "RECONCILIATION_REJECTED",
                "file fingerprint requires an absolute frozen path",
            )
        })?;
    let quoted = format!("'{}'", path.replace('\'', "'\"'\"'"));
    Ok(format!("test -f {quoted} && LC_ALL=C stat -Lc '%s' -- {quoted} && sha256sum -- {quoted} && LC_ALL=C stat -Lc '%s' -- {quoted}"))
}
fn file_fingerprint(output: &str, target: &Value) -> Result<(u64, String), String> {
    let lines: Vec<&str> = output.trim().lines().collect();
    if lines.len() != 3
        || lines[0] != lines[2]
        || lines[1].len() < 67
        || !lines[1].is_char_boundary(64)
        || !lines[1].is_char_boundary(66)
    {
        return Err(error(
            "RECONCILIATION_REJECTED",
            "file changed during fingerprint observation or output is incomplete",
        ));
    }
    let size: u64 = lines[0]
        .parse()
        .map_err(|_| error("RECONCILIATION_REJECTED", "invalid file size"))?;
    let hash = &lines[1][..64];
    if !hash
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !matches!(&lines[1][64..66], "  " | " *")
        || Some(&lines[1][66..]) != target["path"].as_str()
    {
        return Err(error(
            "RECONCILIATION_REJECTED",
            "invalid file digest or observed path",
        ));
    }
    Ok((size, hash.into()))
}
fn is_read_only_service_validator(command: &str) -> bool {
    let mut tokens: Vec<&str> = command.split(' ').collect();
    if tokens.first() == Some(&"sudo") {
        if tokens.get(1) != Some(&"-n") {
            return false;
        }
        tokens.drain(..2);
    }
    if tokens.first() == Some(&"systemctl") {
        tokens.remove(0);
        if tokens.first() == Some(&"--user") {
            tokens.remove(0);
        }
        if tokens.first() != Some(&"is-active") {
            return false;
        }
        tokens.remove(0);
        if tokens.first() == Some(&"--quiet") {
            tokens.remove(0);
        }
        return tokens.len() == 1
            && !tokens[0].is_empty()
            && !tokens[0].starts_with('-')
            && tokens[0]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_@.:-".contains(&byte));
    }
    if tokens.first() != Some(&"curl") || command.starts_with("sudo ") {
        return false;
    }
    tokens.remove(0);
    let mut flags = String::new();
    while tokens
        .first()
        .is_some_and(|token| token.starts_with('-') && !token.starts_with("--"))
    {
        let token = tokens.remove(0);
        if token.len() < 2 || !token[1..].bytes().all(|byte| b"fsSI".contains(&byte)) {
            return false;
        }
        flags.push_str(token);
    }
    if !flags.contains('f') {
        return false;
    }
    if tokens.first() == Some(&"--max-time") {
        if tokens
            .get(1)
            .and_then(|value| value.parse::<u32>().ok())
            .is_none_or(|timeout| timeout == 0)
        {
            return false;
        }
        tokens.drain(..2);
    }
    if tokens.len() != 1 {
        return false;
    }
    let url = tokens[0]
        .strip_prefix('\'')
        .and_then(|url| url.strip_suffix('\''))
        .unwrap_or(tokens[0]);
    (url.starts_with("https://") || url.starts_with("http://"))
        && url
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~:/?#[]@!%+,=-".contains(&byte))
}
fn verified_read(
    connection: &Connection,
    root: &Path,
    original: &Operation,
    original_attempt: &Attempt,
    read: &Operation,
    target: &Value,
    command: &str,
) -> Result<String, String> {
    if read.record.effect != Effect::Read
        || read.record.task_id != original.record.task_id
        || read.record.intent["semantic"]["action"]["type"] != "shell"
        || read.record.intent["semantic"]["action"]["command"] != command
    {
        return Err(error(
            "RECONCILIATION_REJECTED",
            "observation must be the matching read-only command in the original task",
        ));
    }
    let read_target = intent_target(&read.record.intent["semantic"], "execution")?;
    if !same_endpoint(target, read_target) {
        return Err(error(
            "RECONCILIATION_REJECTED",
            "observation target differs from frozen execution target",
        ));
    }
    let attempt = read
        .attempts
        .last()
        .ok_or_else(|| error("RECONCILIATION_REJECTED", "read has no attempt"))?;
    let original_sequence: u64 = connection
        .query_row(
            "SELECT rowid FROM attempts WHERE id=?1",
            [&original_attempt.id],
            |row| row.get(0),
        )
        .map_err(storage)?;
    let read_sequence: u64 = connection
        .query_row(
            "SELECT rowid FROM attempts WHERE id=?1",
            [&attempt.id],
            |row| row.get(0),
        )
        .map_err(storage)?;
    if attempt.status != Status::Succeeded
        || read_sequence <= original_sequence
        || attempt.started_at < original_attempt.started_at
        || attempt.cancel_requested
        || attempt.late
    {
        return Err(error(
            "RECONCILIATION_REJECTED",
            "observation must be a later successful current read",
        ));
    }
    let outcome = attempt
        .outcome
        .as_ref()
        .ok_or_else(|| error("RECONCILIATION_REJECTED", "missing read outcome"))?;
    let result = outcome
        .result
        .as_ref()
        .ok_or_else(|| error("RECONCILIATION_REJECTED", "missing read result"))?;
    if result["exitCode"] != 0 {
        return Err(error(
            "RECONCILIATION_REJECTED",
            "read command did not succeed",
        ));
    }
    let output = result["output"]
        .as_str()
        .ok_or_else(|| error("RECONCILIATION_REJECTED", "missing captured read output"))?;
    // Recheck content-addressed evidence at resolution time (files may have
    // disappeared or been corrupted after the completion commit).
    if outcome.evidence_refs.is_empty() {
        return Err(error("INVALID_EVIDENCE", "read has no archived evidence"));
    }
    let mut captured_result_matches = false;
    for id in &outcome.evidence_refs {
        let evidence = crate::evidence_store::read(root, &read.record.task_id, id, 0, 12000)
            .map_err(|e| error("INVALID_EVIDENCE", e))?;
        if evidence["metadata"]["operationId"] != read.record.operation_id
            || evidence["metadata"]["attemptId"] != attempt.id
            || evidence["metadata"]["executionId"] != attempt.execution_id
            || evidence["metadata"]["status"] != "succeeded"
        {
            return Err(error(
                "INVALID_EVIDENCE",
                "observation evidence ownership mismatch",
            ));
        }
        if evidence["nextOffset"].is_null() {
            if let Some(captured) = evidence["text"]
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
            {
                captured_result_matches |=
                    captured["exitCode"] == 0 && captured["output"].as_str() == Some(output);
            }
        }
    }
    if !captured_result_matches {
        return Err(error(
            "INVALID_EVIDENCE",
            "result differs from archived observation or evidence is incomplete",
        ));
    }
    Ok(output.into())
}
fn json(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(storage)
}
fn parse<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|e| error("INVALID_RECORD", e))
}
fn status_text(status: &Status) -> &'static str {
    match status {
        Status::Prepared => "prepared",
        Status::Dispatching => "dispatching",
        Status::Succeeded => "succeeded",
        Status::Failed => "failed",
        Status::Unknown => "unknown",
        Status::NotDispatched => "not_dispatched",
    }
}
fn write_attempt(tx: &Transaction<'_>, attempt: &Attempt) -> Result<(), String> {
    tx.execute(
        "UPDATE attempts SET record=?2,status=?3 WHERE id=?1",
        params![attempt.id, json(attempt)?, status_text(&attempt.status)],
    )
    .map_err(storage)?;
    Ok(())
}
fn read_operation(connection: &Connection, id: &str) -> Result<Option<Operation>, String> {
    let row: Option<(String,String,bool,u64,u64,Option<String>,String)> = connection.query_row("SELECT record,state,cancel_requested,created_at,updated_at,reconciliation,task_id FROM operations WHERE id=?1", [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))).optional().map_err(storage)?;
    let Some((record, state, cancel_requested, created_at, updated_at, reconciliation, task_id)) =
        row
    else {
        return Ok(None);
    };
    let record: PreparedOperation = parse(&record)?;
    validate_record(&record)?;
    if record.operation_id != id || record.task_id != task_id {
        return Err(error("INVALID_RECORD", "operation ownership mismatch"));
    }
    let incompatible_events: u64 = connection
        .query_row(
            "SELECT count(*) FROM events WHERE operation_id=?1 AND version != 1",
            [id],
            |row| row.get(0),
        )
        .map_err(storage)?;
    if incompatible_events != 0 {
        return Err(error(
            "UNSUPPORTED_VERSION",
            "unsupported execution event version",
        ));
    }
    let mut query = connection
        .prepare(
            "SELECT record,id,status,boot_id FROM attempts WHERE operation_id=?1 ORDER BY rowid",
        )
        .map_err(storage)?;
    let rows = query
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(storage)?;
    let mut attempts = Vec::new();
    for row in rows {
        let (raw, attempt_id, status, boot) = row.map_err(storage)?;
        let attempt: Attempt = parse(&raw)?;
        if attempt.version != VERSION {
            return Err(error("UNSUPPORTED_VERSION", "unsupported attempt version"));
        }
        if attempt.operation_id != id
            || attempt.id != attempt_id
            || status_text(&attempt.status) != status
            || attempt.boot_id != boot
            || matches!(attempt.status, Status::Prepared)
            || attempt.projection_applied_at.is_some() && (attempt.outcome.is_none() || attempt.late
                || !matches!(attempt.status, Status::Succeeded | Status::Failed | Status::NotDispatched))
            || attempt.review_completed_at.is_some() && (attempt.projection_applied_at.is_none() || attempt.status != Status::Succeeded)
            || attempt
                .outcome
                .as_ref()
                .is_some_and(|outcome| outcome.status != attempt.status)
        {
            return Err(error(
                "INVALID_RECORD",
                "attempt identity or state mismatch",
            ));
        }
        attempts.push(attempt);
    }
    let state: Status = parse(&format!("\"{state}\""))?;
    if attempts
        .last()
        .map_or(state != Status::Prepared, |attempt| attempt.status != state)
    {
        return Err(error(
            "INVALID_RECORD",
            "operation and latest attempt state disagree",
        ));
    }
    let reconciliation: Option<Value> = reconciliation.as_deref().map(parse).transpose()?;
    if let Some(resolved) = &reconciliation {
        if resolved["version"] != VERSION
            || resolved["status"] != "completed"
            || resolved["attemptId"].as_str() != attempts.last().map(|attempt| attempt.id.as_str())
        {
            return Err(error(
                "UNSUPPORTED_VERSION",
                "invalid or unsupported reconciliation record",
            ));
        }
    }
    let mut lock_query = connection
        .prepare("SELECT resource_key FROM resource_locks WHERE operation_id=?1")
        .map_err(storage)?;
    let resources = lock_query
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage)?;
    let needs_locks = record.effect == Effect::Change
        && matches!(state, Status::Dispatching | Status::Unknown)
        && reconciliation.is_none();
    if (needs_locks
        && (record
            .resource_keys
            .iter()
            .any(|key| !resources.contains(key))
            || resources
                .iter()
                .any(|key| !record.resource_keys.contains(key))))
        || (!needs_locks && !resources.is_empty())
    {
        return Err(error(
            "INVALID_RECORD",
            "execution resources and durable ownership disagree",
        ));
    }
    Ok(Some(Operation {
        record,
        state,
        attempts,
        cancel_requested,
        created_at,
        updated_at,
        reconciliation,
    }))
}

fn app_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(storage)
}
struct FrontendSession {
    current: String,
    retired: std::collections::HashSet<String>,
}
fn frontend_sessions(
) -> &'static Mutex<std::collections::HashMap<std::path::PathBuf, FrontendSession>> {
    static SESSIONS: OnceLock<
        Mutex<std::collections::HashMap<std::path::PathBuf, FrontendSession>>,
    > = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}
fn session_boot_id(frontend_session_id: &str) -> String {
    format!("{}:{frontend_session_id}", boot_id())
}
fn register_frontend_session(root: &Path, frontend_session_id: &str) -> Result<(), String> {
    validate_id(frontend_session_id)?;
    let mut sessions = frontend_sessions().lock().map_err(storage)?;
    if let Some(previous) = sessions.get(root) {
        if previous.current == frontend_session_id {
            return Ok(());
        }
        if previous.retired.contains(frontend_session_id) {
            return Err(error(
                "SESSION_REPLACED",
                "an old page cannot reclaim execution ownership",
            ));
        }
    }
    // Replaced page attempts become unknown, retaining effects and locks.
    Ledger::open(root, &session_boot_id(frontend_session_id))?;
    let previous = sessions
        .entry(root.to_path_buf())
        .or_insert_with(|| FrontendSession {
            current: frontend_session_id.into(),
            retired: Default::default(),
        });
    if previous.current != frontend_session_id {
        previous.retired.insert(std::mem::replace(
            &mut previous.current,
            frontend_session_id.into(),
        ));
    }
    Ok(())
}
fn with_frontend_session<T>(
    root: &Path,
    frontend_session_id: &str,
    allow_late: bool,
    operation: impl FnOnce(&mut Ledger, bool) -> Result<T, String>,
) -> Result<T, String> {
    // The shared runtime gate orders replacement and queued old requests.
    let sessions = frontend_sessions().lock().map_err(storage)?;
    let session = sessions.get(root).ok_or_else(|| {
        error(
            "SESSION_REQUIRED",
            "register the current page before accessing execution records",
        )
    })?;
    let stale = session.current != frontend_session_id;
    if stale && !(allow_late && session.retired.contains(frontend_session_id)) {
        return Err(error(
            "SESSION_REPLACED",
            "execution request belongs to a replaced page",
        ));
    }
    let mut ledger = Ledger::open(root, &session_boot_id(&session.current))?;
    operation(&mut ledger, stale)
}
fn complete_for_frontend(
    root: &Path,
    frontend_session_id: &str,
    operation_id: &str,
    attempt_id: &str,
    event_id: &str,
    outcome: Outcome,
    late: bool,
) -> Result<Attempt, String> {
    with_frontend_session(root, frontend_session_id, true, |ledger, stale| {
        if stale
            && !ledger.get(operation_id)?.attempts.iter().any(|attempt| {
                attempt.id == attempt_id && attempt.boot_id == session_boot_id(frontend_session_id)
            })
        {
            return Err(error(
                "SESSION_REPLACED",
                "old page may only append results for its own attempt",
            ));
        }
        ledger.complete(
            root,
            operation_id,
            attempt_id,
            event_id,
            outcome,
            late || stale,
        )
    })
}
fn cancel_for_frontend(
    root: &Path,
    frontend_session_id: &str,
    operation_id: &str,
    attempt_id: Option<&str>,
) -> Result<Operation, String> {
    with_frontend_session(root, frontend_session_id, true, |ledger, stale| {
        if stale
            && !ledger
                .get(operation_id)?
                .attempts
                .last()
                .is_some_and(|attempt| {
                    attempt_id.is_none_or(|id| id == attempt.id)
                        && attempt.boot_id == session_boot_id(frontend_session_id)
                })
        {
            return Err(error(
                "SESSION_REPLACED",
                "old page may only cancel its own current attempt",
            ));
        }
        ledger.cancel(operation_id, attempt_id)
    })
}
#[tauri::command]
pub(crate) async fn register_execution_ledger_session(
    app: tauri::AppHandle,
    frontend_session_id: String,
) -> Result<(), String> {
    let root = app_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        register_frontend_session(&root, &frontend_session_id)
    })
    .await
    .map_err(storage)?
}
#[tauri::command]
pub(crate) async fn prepare_execution_operation(
    app: tauri::AppHandle,
    frontend_session_id: String,
    record: PreparedOperation,
) -> Result<Operation, String> {
    let root = app_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_frontend_session(&root, &frontend_session_id, false, |ledger, _| {
            ledger.prepare(record)
        })
    })
    .await
    .map_err(storage)?
}
#[tauri::command]
pub(crate) async fn begin_execution_attempt(
    app: tauri::AppHandle,
    frontend_session_id: String,
    operation_id: String,
    attempt_id: String,
    execution_id: String,
) -> Result<Attempt, String> {
    let root = app_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_frontend_session(&root, &frontend_session_id, false, |ledger, _| {
            ledger.begin(&operation_id, &attempt_id, &execution_id)
        })
    })
    .await
    .map_err(storage)?
}
#[tauri::command]
pub(crate) async fn complete_execution_attempt(
    app: tauri::AppHandle,
    frontend_session_id: String,
    operation_id: String,
    attempt_id: String,
    event_id: String,
    outcome: Outcome,
    late: Option<bool>,
) -> Result<Attempt, String> {
    let root = app_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        complete_for_frontend(
            &root,
            &frontend_session_id,
            &operation_id,
            &attempt_id,
            &event_id,
            outcome,
            late.unwrap_or(false),
        )
    })
    .await
    .map_err(storage)?
}
#[tauri::command]
pub(crate) async fn request_execution_cancel(
    app: tauri::AppHandle,
    frontend_session_id: String,
    operation_id: String,
    attempt_id: Option<String>,
) -> Result<Operation, String> {
    let root = app_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        cancel_for_frontend(
            &root,
            &frontend_session_id,
            &operation_id,
            attempt_id.as_deref(),
        )
    })
    .await
    .map_err(storage)?
}
#[tauri::command]
pub(crate) async fn list_execution_operations(
    app: tauri::AppHandle,
    frontend_session_id: String,
    task_id: Option<String>,
) -> Result<Vec<Operation>, String> {
    let root = app_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_frontend_session(&root, &frontend_session_id, false, |ledger, _| {
            ledger.list(task_id.as_deref())
        })
    })
    .await
    .map_err(storage)?
}
#[tauri::command]
pub(crate) async fn acknowledge_execution_attempt(
    app: tauri::AppHandle, frontend_session_id: String, operation_id: String, attempt_id: String, reviewed: bool,
    review: Option<AttemptReviewInput>,
) -> Result<Attempt, String> {
    let root = app_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_frontend_session(&root, &frontend_session_id, false, |ledger, _| ledger.acknowledge_with_review(&operation_id, &attempt_id, reviewed, review))
    }).await.map_err(storage)?
}
#[tauri::command]
pub(crate) async fn resolve_execution_operation(
    app: tauri::AppHandle,
    frontend_session_id: String,
    operation_id: String,
    attempt_id: String,
    proof: ReconciliationProof,
) -> Result<Operation, String> {
    let root = app_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_frontend_session(&root, &frontend_session_id, false, |ledger, _| {
            ledger.resolve(&root, &operation_id, &attempt_id, proof)
        })
    })
    .await
    .map_err(storage)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    struct TestRoot(std::path::PathBuf);
    impl TestRoot {
        fn new() -> Self {
            Self(
                std::env::temp_dir().join(format!("opsark-ledger-{}", crate::task_logs::call_id())),
            )
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn target(role: &str, host: &str, path: Option<&str>) -> Value {
        let mut value = json!({"role":role,"serverId":format!("server-{host}"),"host":host,"port":22,"username":"ops","connectionGeneration":1});
        if let Some(path) = path {
            value["path"] = json!(path);
        }
        value
    }
    fn record(id: &str, effect: Effect) -> PreparedOperation {
        seal(PreparedOperation {
            version: 1,
            operation_id: id.into(),
            task_id: "task-1".into(),
            step_id: format!("step-{id}"),
            round_id: Some("round-1".into()),
            workflow_epoch: 1,
            plan_revision: 1,
            step_revision: 1,
            intent_digest: String::new(),
            intent: json!({"version":"execution-intent@1","algorithm":"sha256","digest":"","semantic":{"taskId":"task-1","stepId":format!("step-{id}"),"effect":effect,"action":{"type":"shell","command":"printf ok"},"targets":[target("execution","server.test",None)]}}),
            phase: Phase::Command,
            effect,
            resource_keys: vec!["endpoint:server.test:22".into()],
            execution_id: None,
        })
    }
    fn seal(mut record: PreparedOperation) -> PreparedOperation {
        record.intent_digest = intent_digest(&record.intent["semantic"]).unwrap();
        record.intent["digest"] = json!(record.intent_digest);
        record.resource_keys = record.intent["semantic"]["targets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|target| {
                target["host"].as_str().is_some_and(|host| !host.is_empty())
                    && target["role"] != "interaction"
            })
            .map(|target| {
                format!(
                    "endpoint:{}:{}",
                    target["host"].as_str().unwrap().to_lowercase(),
                    target["port"].as_u64().unwrap()
                )
            })
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        if record.resource_keys.is_empty() {
            record
                .resource_keys
                .push(format!("task:{}", record.task_id));
        }
        record
    }
    fn archived_outcome(
        root: &Path,
        operation: &str,
        attempt: &str,
        status: Status,
        result: Value,
    ) -> Outcome {
        let execution_id = format!("exec-{attempt}");
        let id = crate::evidence_store::save(root,"task-1",&json!({"version":1,"operationId":operation,"attemptId":attempt,"executionId":execution_id,"status":status_text(&status),"text":json(&result).unwrap()})).unwrap();
        Outcome {
            status,
            result: Some(result),
            evidence_refs: vec![id],
        }
    }
    fn begin(ledger: &mut Ledger, operation: &str, attempt: &str) -> Attempt {
        ledger
            .begin(operation, attempt, &format!("exec-{attempt}"))
            .unwrap()
    }

    #[test]
    fn receipt_acknowledgement_survives_restart_without_changing_remote_facts() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot").unwrap();
        ledger.prepare(record("op-ack", Effect::Change)).unwrap();
        begin(&mut ledger, "op-ack", "attempt-ack");
        assert!(ledger.acknowledge("op-ack", "attempt-ack", true).is_err());
        let outcome = archived_outcome(&root.0, "op-ack", "attempt-ack", Status::Succeeded, json!({"output":"ok"}));
        ledger.complete(&root.0, "op-ack", "attempt-ack", "result-ack", outcome.clone(), false).unwrap();
        let ack = ledger.acknowledge("op-ack", "attempt-ack", true).unwrap();
        assert_eq!(ledger.acknowledge("op-ack", "attempt-ack", true).unwrap(), ack);
        drop(ledger);
        let ledger = Ledger::open(&root.0, "next-boot").unwrap();
        let stored = ledger.get("op-ack").unwrap();
        assert_eq!(stored.attempts[0], ack);
        assert_eq!(stored.attempts[0].outcome, Some(outcome));
        assert!(stored.reconciliation.is_none());
        assert!(ack.projection_applied_at.is_some() && ack.review_completed_at.is_some());
    }

    #[test]
    fn negative_review_survives_restart_without_claiming_acceptance_or_reconciliation() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot").unwrap();
        let prepared = record("op-review", Effect::Change);
        ledger.prepare(prepared.clone()).unwrap();
        begin(&mut ledger, "op-review", "attempt-review");
        let outcome = archived_outcome(&root.0, "op-review", "attempt-review", Status::Succeeded, json!({"output":"listening on unexpected port"}));
        ledger.complete(&root.0, "op-review", "attempt-review", "result-review", outcome.clone(), false).unwrap();
        let review = AttemptReviewInput { version: 1, operation_id: "op-review".into(), attempt_id: "attempt-review".into(),
            intent_digest: prepared.intent_digest, outcome: "not_met".into(), disposition: "task_followup".into(),
            evidence_refs: outcome.evidence_refs.clone(), review_fingerprint: format!("sha256:{}", "a".repeat(64)) };
        let saved = ledger.acknowledge_with_review("op-review", "attempt-review", false, Some(review.clone())).unwrap();
        assert_eq!(ledger.acknowledge_with_review("op-review", "attempt-review", false, Some(review.clone())).unwrap(), saved);
        let mut changed = review.clone(); changed.outcome = "unknown".into();
        assert!(ledger.acknowledge_with_review("op-review", "attempt-review", false, Some(changed)).unwrap_err().contains("REVIEW_CONFLICT"));
        drop(ledger);
        let mut ledger = Ledger::open(&root.0, "next-boot").unwrap();
        let operation = ledger.get("op-review").unwrap();
        assert_eq!(operation.attempts[0], saved);
        assert_eq!(operation.attempts[0].outcome, Some(outcome));
        assert_eq!(operation.attempts[0].reviews[0].review.outcome, "not_met");
        assert!(operation.attempts[0].review_completed_at.is_none());
        assert!(operation.reconciliation.is_none());
        ledger.cancel("op-review", Some("attempt-review")).unwrap();
        assert!(ledger.acknowledge_with_review("op-review", "attempt-review", false, Some(review)).unwrap_err().contains("REVIEW_INVALID"));
    }

    #[test]
    fn structured_reviews_reject_other_attempts_evidence_and_unknown_dispatch() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot").unwrap();
        let prepared = record("op-review", Effect::Change);
        ledger.prepare(prepared.clone()).unwrap();
        begin(&mut ledger, "op-review", "attempt-review");
        let outcome = archived_outcome(&root.0, "op-review", "attempt-review", Status::Succeeded, json!({"output":"ok"}));
        let review = AttemptReviewInput { version: 1, operation_id: "op-review".into(), attempt_id: "attempt-review".into(),
            intent_digest: prepared.intent_digest, outcome: "unknown".into(), disposition: "task_followup".into(),
            evidence_refs: outcome.evidence_refs.clone(), review_fingerprint: format!("sha256:{}", "b".repeat(64)) };
        drop(ledger);
        let mut ledger = Ledger::open(&root.0, "next-boot").unwrap();
        assert!(ledger.acknowledge_with_review("op-review", "attempt-review", false, Some(review.clone())).is_err());
        ledger.complete(&root.0, "op-review", "attempt-review", "result-review", outcome, false).unwrap();
        // The pre-restart receipt is late by design. Use a fresh owned attempt
        // to exercise identity checks independently from that earlier guard.
        let prepared = record("op-current-review", Effect::Change);
        ledger.prepare(prepared.clone()).unwrap();
        begin(&mut ledger, "op-current-review", "attempt-current-review");
        let outcome = archived_outcome(&root.0, "op-current-review", "attempt-current-review", Status::Succeeded, json!({"output":"ok"}));
        ledger.complete(&root.0, "op-current-review", "attempt-current-review", "result-current-review", outcome.clone(), false).unwrap();
        let review = AttemptReviewInput { operation_id: "op-current-review".into(), attempt_id: "attempt-current-review".into(),
            intent_digest: prepared.intent_digest, evidence_refs: outcome.evidence_refs, ..review };
        let mut wrong_attempt = review.clone(); wrong_attempt.attempt_id = "other-attempt".into();
        let mut wrong_evidence = review.clone(); wrong_evidence.evidence_refs = vec!["foreign-proof".into()];
        let mut false_acceptance = review.clone(); false_acceptance.disposition = "accepted".into();
        for invalid in [wrong_attempt, wrong_evidence, false_acceptance] {
            assert!(ledger.acknowledge_with_review("op-current-review", "attempt-current-review", false, Some(invalid)).unwrap_err().contains("REVIEW_INVALID"));
        }
        assert!(ledger.get("op-current-review").unwrap().attempts[0].reviews.is_empty());
    }

    #[test]
    fn acknowledgement_cannot_accept_unknown_or_late_results() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot").unwrap();
        ledger.prepare(record("op-late", Effect::Change)).unwrap();
        begin(&mut ledger, "op-late", "attempt-late");
        drop(ledger);
        let mut ledger = Ledger::open(&root.0, "next-boot").unwrap();
        assert!(ledger.acknowledge("op-late", "attempt-late", false).is_err());
        assert_eq!(ledger.get("op-late").unwrap().state, Status::Unknown);
        let outcome = archived_outcome(&root.0, "op-late", "attempt-late", Status::Succeeded, json!({"output":"late"}));
        ledger.complete(&root.0, "op-late", "attempt-late", "result-late", outcome, true).unwrap();
        assert!(ledger.acknowledge("op-late", "attempt-late", true).is_err());
        assert!(ledger.get("op-late").unwrap().attempts[0].review_completed_at.is_none());
    }

    #[test]
    fn canonical_intent_hash_matches_javascript_numbers_and_property_enumeration() {
        // Fixture generated by Node using the shipped canonicalExecutionJson
        // algorithm and node:crypto; covers cases serde_json alone gets wrong.
        let semantic = json!({"10":"ten","2":"two","01":"one","😀":"emoji","\u{e000}":"private","v":[1.0,1e20,1e21,1e-7,-0.0,1e-6,0.0000123],"s":"你好\n\\\""});
        assert_eq!(
            intent_digest(&semantic).unwrap(),
            "sha256:2af3d97db8d7b37913e0bb0cad36e034b473841192de3dcce9bd5b237db7e360"
        );
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot").unwrap();
        let mut tampered = record("tampered", Effect::Change);
        tampered.intent["semantic"]["action"]["command"] = json!("unexpected");
        assert!(ledger
            .prepare(tampered)
            .unwrap_err()
            .contains("checksum mismatch"));
        let mut wrong_owner = record("owner", Effect::Change);
        wrong_owner.task_id = "other-task".into();
        assert!(ledger
            .prepare(wrong_owner)
            .unwrap_err()
            .contains("task, step, or effect"));
        let mut wrong_effect = record("effect", Effect::Change);
        wrong_effect.effect = Effect::Read;
        assert!(ledger
            .prepare(wrong_effect)
            .unwrap_err()
            .contains("task, step, or effect"));
        let mut wrong_resource = record("resource", Effect::Change);
        wrong_resource.resource_keys = vec!["endpoint:unrelated:22:ops".into()];
        assert!(ledger
            .prepare(wrong_resource)
            .unwrap_err()
            .contains("resource keys do not match"));
    }

    #[test]
    fn prepare_idempotence_rejects_changed_intent_and_raw_credentials() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot").unwrap();
        let original = record("operation", Effect::Change);
        assert_eq!(
            ledger.prepare(original.clone()).unwrap().state,
            Status::Prepared
        );
        assert_eq!(ledger.prepare(original.clone()).unwrap().attempts.len(), 0);
        let mut changed = original.clone();
        changed.intent["semantic"]["action"]["command"] = json!("rm file");
        assert!(ledger
            .prepare(seal(changed))
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_INTENT_CONFLICT"));
        let mut secret = record("secret", Effect::Change);
        secret.intent["semantic"]["action"]["password"] = json!("never-save");
        assert!(ledger
            .prepare(seal(secret))
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_SECRET_VALUE"));
        assert_eq!(ledger.list(None).unwrap().len(), 1);
    }

    #[test]
    fn credential_fields_are_explicit_and_rejection_does_not_lock_following_operations() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot").unwrap();
        for field in ["password", "passwd", "passphrase", "apiKey", "api-key", "access_token",
            "refreshToken", "authorization", "private_key", "clientSecret", "secret"] {
            let mut rejected = record(&format!("rejected-{field}"), Effect::Change);
            rejected.intent["semantic"]["action"] = json!({"type":"tool","toolId":"fixture",
                "arguments":{"nested":[{field:"never-persist-this-credential"}]}});
            let error = ledger.prepare(seal(rejected)).unwrap_err();
            assert!(error.starts_with("EXECUTION_LEDGER_SECRET_VALUE"));
            assert!(error.contains(&format!("/semantic/action/arguments/nested/0/{field}")));
            assert!(!error.contains("never-persist-this-credential"));
        }
        assert!(ledger.list(None).unwrap().is_empty());
        let mut valid = record("next-operation-1", Effect::Change);
        valid.intent["semantic"]["action"] = json!({"type":"tool","toolId":"core.sftp.delete",
            "arguments":{"path":"/opt/core-case","kind":"directory"}});
        valid.intent["semantic"]["targets"][0]["username"] = json!("root");
        valid.intent["semantic"]["targets"][0]["credentialRef"] = json!("keychain:server-1");
        let sealed = seal(valid);
        let saved = ledger.prepare(sealed.clone()).unwrap();
        assert_eq!(saved.record.intent, sealed.intent);
        assert_eq!(ledger.list(None).unwrap().len(), 1);
        assert!(!contains_raw_secret(&json!({"password":null,"privateKey":"", "apiKey":"[REDACTED]"})));
        assert!(contains_raw_secret(&json!({"output":{"refreshToken":"must redact"}})));
    }

    #[test]
    fn prepare_and_dispatch_are_separate_durable_commits() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot-a").unwrap();
        ledger.prepare(record("prepared", Effect::Change)).unwrap();
        ledger
            .prepare(record("dispatched", Effect::Change))
            .unwrap();
        begin(&mut ledger, "dispatched", "attempt");
        drop(ledger);
        let mut recovered = Ledger::open(&root.0, "boot-b").unwrap();
        assert_eq!(recovered.get("prepared").unwrap().state, Status::Prepared);
        let uncertain = recovered.get("dispatched").unwrap();
        assert_eq!(uncertain.state, Status::Unknown);
        assert_eq!(uncertain.attempts[0].status, Status::Unknown);
        assert!(recovered
            .begin("dispatched", "retry", "retry-execution")
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_ACTIVE_ATTEMPT"));
        let event_count: u64 = recovered
            .connection
            .query_row(
                "SELECT count(*) FROM events WHERE kind='recovered_unknown'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 1);
        drop(recovered);
        let recovered = Ledger::open(&root.0, "boot-c").unwrap();
        let event_count: u64 = recovered
            .connection
            .query_row(
                "SELECT count(*) FROM events WHERE kind='recovered_unknown'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 1);
    }

    #[test]
    fn duplicate_begin_never_returns_a_second_dispatch_permit() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot").unwrap();
        ledger.prepare(record("operation", Effect::Change)).unwrap();
        begin(&mut ledger, "operation", "attempt");
        assert!(ledger
            .begin("operation", "attempt", "exec-attempt")
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_ATTEMPT_EXISTS"));
        assert!(ledger
            .begin("operation", "other", "exec-other")
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_ACTIVE_ATTEMPT"));
    }

    #[test]
    fn cancellation_keeps_late_success_and_result_event_is_idempotent() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot").unwrap();
        ledger.prepare(record("operation", Effect::Change)).unwrap();
        begin(&mut ledger, "operation", "attempt");
        let canceled = ledger.cancel("operation", Some("attempt")).unwrap();
        assert_eq!(canceled.state, Status::Dispatching);
        assert!(canceled.cancel_requested);
        let outcome = archived_outcome(
            &root.0,
            "operation",
            "attempt",
            Status::Succeeded,
            json!({"exitCode":0,"output":"changed"}),
        );
        let result = ledger
            .complete(
                &root.0,
                "operation",
                "attempt",
                "event",
                outcome.clone(),
                false,
            )
            .unwrap();
        assert_eq!(result.status, Status::Succeeded);
        assert!(result.late);
        assert!(result.cancel_requested);
        assert_eq!(
            ledger
                .complete(
                    &root.0,
                    "operation",
                    "attempt",
                    "event",
                    outcome.clone(),
                    false
                )
                .unwrap(),
            result
        );
        let changed = archived_outcome(
            &root.0,
            "operation",
            "attempt",
            Status::Failed,
            json!({"exitCode":1}),
        );
        assert!(ledger
            .complete(
                &root.0,
                "operation",
                "attempt",
                "event",
                changed.clone(),
                false
            )
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_EVENT_CONFLICT"));
        assert!(ledger
            .complete(
                &root.0,
                "operation",
                "attempt",
                "other-event",
                changed,
                false
            )
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_RESULT_CONFLICT"));
        assert!(ledger.begin("operation", "retry", "retry").is_err());
        let events: u64 = ledger
            .connection
            .query_row(
                "SELECT count(*) FROM events WHERE kind='result'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(events, 1);
    }

    #[test]
    fn uncertain_change_blocks_conflicting_change_but_independent_reads_continue() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot-a").unwrap();
        ledger.prepare(record("old", Effect::Change)).unwrap();
        begin(&mut ledger, "old", "old-attempt");
        drop(ledger);
        let mut ledger = Ledger::open(&root.0, "boot-b").unwrap();
        ledger.prepare(record("new", Effect::Change)).unwrap();
        assert!(ledger
            .begin("new", "new-attempt", "exec-new")
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_RESOURCE_CONFLICT"));
        ledger.prepare(record("read", Effect::Read)).unwrap();
        begin(&mut ledger, "read", "read-attempt");
        let outcome = archived_outcome(
            &root.0,
            "old",
            "old-attempt",
            Status::Succeeded,
            json!({"exitCode":0}),
        );
        let late = ledger
            .complete(&root.0, "old", "old-attempt", "late-event", outcome, false)
            .unwrap();
        assert!(late.late);
        begin(&mut ledger, "new", "new-attempt");
    }

    #[test]
    fn terminal_change_cannot_replay_but_read_can_have_new_attempt() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot").unwrap();
        for (id, effect) in [("change", Effect::Change), ("read", Effect::Read)] {
            ledger.prepare(record(id, effect)).unwrap();
            begin(&mut ledger, id, &format!("{id}-attempt"));
            let outcome = archived_outcome(
                &root.0,
                id,
                &format!("{id}-attempt"),
                Status::Failed,
                json!({"exitCode":1}),
            );
            ledger
                .complete(
                    &root.0,
                    id,
                    &format!("{id}-attempt"),
                    &format!("{id}-event"),
                    outcome,
                    false,
                )
                .unwrap();
        }
        assert!(ledger
            .begin("change", "retry-change", "retry-change")
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_REPLAY_BLOCKED"));
        let mut same_read = record("read", Effect::Read);
        same_read.execution_id = Some("exec-retry-read".into());
        ledger.prepare(same_read).unwrap();
        begin(&mut ledger, "read", "retry-read");
        let first = archived_outcome(
            &root.0,
            "read",
            "read-attempt",
            Status::Failed,
            json!({"exitCode":1}),
        );
        ledger
            .complete(
                &root.0,
                "read",
                "read-attempt",
                "old-duplicate-new-event",
                first,
                false,
            )
            .unwrap();
        assert_eq!(ledger.get("read").unwrap().state, Status::Dispatching);
    }

    #[test]
    fn completion_requires_intact_evidence_scoped_to_attempt() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot").unwrap();
        ledger.prepare(record("operation", Effect::Change)).unwrap();
        begin(&mut ledger, "operation", "attempt");
        let wrong = archived_outcome(
            &root.0,
            "operation",
            "other-attempt",
            Status::Succeeded,
            json!({"exitCode":0}),
        );
        assert!(ledger
            .complete(&root.0, "operation", "attempt", "event", wrong, false)
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_INVALID_EVIDENCE"));
        let missing = Outcome {
            status: Status::Succeeded,
            result: None,
            evidence_refs: vec!["0".repeat(64)],
        };
        assert!(ledger
            .complete(&root.0, "operation", "attempt", "event", missing, false)
            .is_err());
        assert_eq!(ledger.get("operation").unwrap().state, Status::Dispatching);
    }

    #[test]
    fn storage_failure_before_dispatch_and_after_result_keeps_durable_truth() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot").unwrap();
        ledger.prepare(record("operation", Effect::Change)).unwrap();
        ledger
            .connection
            .pragma_update(None, "query_only", true)
            .unwrap();
        assert!(ledger
            .begin("operation", "attempt", "exec-attempt")
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_STORAGE"));
        assert_eq!(ledger.get("operation").unwrap().state, Status::Prepared);
        ledger
            .connection
            .pragma_update(None, "query_only", false)
            .unwrap();
        begin(&mut ledger, "operation", "attempt");
        let outcome = archived_outcome(
            &root.0,
            "operation",
            "attempt",
            Status::Succeeded,
            json!({"exitCode":0}),
        );
        ledger
            .connection
            .pragma_update(None, "query_only", true)
            .unwrap();
        assert!(ledger
            .complete(&root.0, "operation", "attempt", "event", outcome, false)
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_STORAGE"));
        assert_eq!(ledger.get("operation").unwrap().state, Status::Dispatching);
        drop(ledger);
        let recovered = Ledger::open(&root.0, "new-boot").unwrap();
        assert_eq!(recovered.get("operation").unwrap().state, Status::Unknown);
        let file_root = root.0.join("not-a-directory");
        std::fs::write(&file_root, "file").unwrap();
        assert!(Ledger::open(&file_root, "boot").is_err());
    }

    #[test]
    fn unknown_record_and_database_versions_are_not_migrated_or_executed() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot").unwrap();
        let mut unsupported = record("future", Effect::Change);
        unsupported.version = 9;
        assert!(ledger
            .prepare(unsupported)
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_UNSUPPORTED_VERSION"));
        ledger.prepare(record("operation", Effect::Change)).unwrap();
        begin(&mut ledger, "operation", "attempt");
        let mut future = ledger.get("operation").unwrap().attempts[0].clone();
        future.version = 9;
        ledger
            .connection
            .execute(
                "UPDATE attempts SET record=?1 WHERE id='attempt'",
                [json(&future).unwrap()],
            )
            .unwrap();
        assert!(ledger
            .list(None)
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_UNSUPPORTED_VERSION"));
        drop(ledger);
        assert!(
            matches!(Ledger::open(&root.0,"new-boot"),Err(error) if error.starts_with("EXECUTION_LEDGER_UNSUPPORTED_VERSION"))
        );
        let connection = Connection::open(root.0.join("execution-ledger.sqlite3")).unwrap();
        let state: String = connection
            .query_row(
                "SELECT status FROM attempts WHERE id='attempt'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "dispatching");
        connection.pragma_update(None, "user_version", 9).unwrap();
        drop(connection);
        assert!(
            matches!(Ledger::open(&root.0,"new-boot"),Err(error) if error.starts_with("EXECUTION_LEDGER_UNSUPPORTED_VERSION"))
        );
    }

    #[test]
    fn any_unknown_or_corrupt_record_blocks_a_new_repository_dispatch_session() {
        for corruption in [
            "future-operation",
            "future-event",
            "missing-resource-lock",
            "snapshot-tamper",
        ] {
            let root = TestRoot::new();
            let mut ledger = Ledger::open(&root.0, "boot").unwrap();
            ledger.prepare(record("old", Effect::Change)).unwrap();
            match corruption {
                "future-operation" => {
                    let mut future = record("old", Effect::Change);
                    future.version = 2;
                    ledger
                        .connection
                        .execute(
                            "UPDATE operations SET record=?1 WHERE id='old'",
                            [json(&future).unwrap()],
                        )
                        .unwrap();
                }
                "future-event" => {
                    ledger
                        .connection
                        .execute("UPDATE events SET version=2", [])
                        .unwrap();
                }
                "missing-resource-lock" => {
                    begin(&mut ledger, "old", "old-attempt");
                    ledger
                        .connection
                        .execute("DELETE FROM resource_locks", [])
                        .unwrap();
                }
                "snapshot-tamper" => {
                    let mut changed = record("old", Effect::Change);
                    changed.intent["semantic"]["action"]["command"] = json!("different command");
                    ledger
                        .connection
                        .execute(
                            "UPDATE operations SET record=?1 WHERE id='old'",
                            [json(&changed).unwrap()],
                        )
                        .unwrap();
                }
                _ => unreachable!(),
            }
            drop(ledger);
            assert!(
                Ledger::open(&root.0, "same-or-new-boot").is_err(),
                "{corruption} must block new dispatches even on unrelated resources"
            );
            let connection = Connection::open(root.0.join("execution-ledger.sqlite3")).unwrap();
            let count: u64 = connection
                .query_row("SELECT count(*) FROM operations", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 1);
        }
    }

    #[test]
    fn concurrent_dispatches_claim_only_one_resource_owner() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot").unwrap();
        ledger.prepare(record("a", Effect::Change)).unwrap();
        ledger.prepare(record("b", Effect::Change)).unwrap();
        drop(ledger);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = ["a", "b"]
            .into_iter()
            .map(|id| {
                let root = root.0.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut ledger = Ledger::open(&root, "boot").unwrap();
                    barrier.wait();
                    ledger.begin(id, &format!("attempt-{id}"), &format!("exec-{id}"))
                })
            })
            .collect();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(results
            .into_iter()
            .find_map(Result::err)
            .unwrap()
            .starts_with("EXECUTION_LEDGER_RESOURCE_CONFLICT"));
    }

    #[test]
    fn webview_reload_fences_old_requests_but_preserves_owned_late_facts() {
        let root = TestRoot::new();
        register_frontend_session(&root.0, "page-a").unwrap();
        with_frontend_session(&root.0, "page-a", false, |ledger, _| {
            ledger.prepare(record("old", Effect::Change))?;
            ledger.begin("old", "old-attempt", "exec-old-attempt")
        })
        .unwrap();
        register_frontend_session(&root.0, "page-a").unwrap();
        assert_eq!(
            with_frontend_session(&root.0, "page-a", false, |ledger, _| ledger.get("old"))
                .unwrap()
                .state,
            Status::Dispatching
        );
        register_frontend_session(&root.0, "page-b").unwrap();
        assert!(register_frontend_session(&root.0, "page-a")
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_SESSION_REPLACED"));
        assert!(
            with_frontend_session(&root.0, "page-a", false, |ledger, _| ledger.begin(
                "old",
                "queued-old",
                "queued-exec"
            ))
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_SESSION_REPLACED")
        );
        assert_eq!(
            with_frontend_session(&root.0, "page-b", false, |ledger, _| ledger.get("old"))
                .unwrap()
                .state,
            Status::Unknown
        );
        // A different SSH account on the same endpoint still conflicts.
        let mut different_account = record("new", Effect::Change);
        different_account.intent["semantic"]["targets"][0]["username"] = json!("root");
        with_frontend_session(&root.0, "page-b", false, |ledger, _| {
            ledger.prepare(seal(different_account))
        })
        .unwrap();
        assert!(
            with_frontend_session(&root.0, "page-b", false, |ledger, _| ledger.begin(
                "new",
                "new-attempt",
                "exec-new-attempt"
            ))
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_RESOURCE_CONFLICT")
        );
        let outcome = archived_outcome(
            &root.0,
            "old",
            "old-attempt",
            Status::Succeeded,
            json!({"exitCode":0}),
        );
        let late = complete_for_frontend(
            &root.0,
            "page-a",
            "old",
            "old-attempt",
            "late-event",
            outcome,
            false,
        )
        .unwrap();
        assert!(late.late);
        assert_eq!(late.status, Status::Succeeded);
        with_frontend_session(&root.0, "page-b", false, |ledger, _| {
            ledger.begin("new", "new-attempt", "exec-new-attempt")
        })
        .unwrap();
        let foreign_outcome = archived_outcome(
            &root.0,
            "new",
            "new-attempt",
            Status::Succeeded,
            json!({"exitCode":0}),
        );
        assert!(complete_for_frontend(
            &root.0,
            "page-a",
            "new",
            "new-attempt",
            "foreign-event",
            foreign_outcome,
            false
        )
        .unwrap_err()
        .starts_with("EXECUTION_LEDGER_SESSION_REPLACED"));
        assert!(cancel_for_frontend(&root.0, "page-a", "new", None)
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_SESSION_REPLACED"));
        cancel_for_frontend(&root.0, "page-a", "old", Some("old-attempt")).unwrap();
        assert!(
            !with_frontend_session(&root.0, "page-b", false, |ledger, _| ledger.get("new"))
                .unwrap()
                .cancel_requested
        );
    }

    #[test]
    #[ignore = "child entry point invoked by process_crash_windows_are_recovered_without_replay"]
    fn crash_child() {
        let root =
            std::path::PathBuf::from(std::env::var("OPSARK_LEDGER_CRASH_TEST_ROOT").unwrap());
        let stage = std::env::var("OPSARK_LEDGER_CRASH_TEST_STAGE").unwrap();
        let mut ledger = Ledger::open(&root, "child-boot").unwrap();
        ledger.prepare(record("operation", Effect::Change)).unwrap();
        if stage != "prepared" {
            begin(&mut ledger, "operation", "attempt");
        }
        if stage == "completed" {
            let outcome = archived_outcome(
                &root,
                "operation",
                "attempt",
                Status::Succeeded,
                json!({"exitCode":0,"output":"effect happened"}),
            );
            ledger
                .complete(&root, "operation", "attempt", "event", outcome, false)
                .unwrap();
        }
        // Abrupt termination skips all Rust destructors, including SQLite close.
        std::process::exit(71);
    }

    #[test]
    fn process_crash_windows_are_recovered_without_replay() {
        for (stage, expected) in [
            ("prepared", Status::Prepared),
            ("dispatching", Status::Unknown),
            ("completed", Status::Succeeded),
        ] {
            let root = TestRoot::new();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "execution_ledger::tests::crash_child",
                    "--ignored",
                ])
                .env("OPSARK_LEDGER_CRASH_TEST_ROOT", &root.0)
                .env("OPSARK_LEDGER_CRASH_TEST_STAGE", stage)
                .output()
                .unwrap();
            assert_eq!(
                output.status.code(),
                Some(71),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let mut recovered = Ledger::open(&root.0, "recovery-boot").unwrap();
            let operation = recovered.get("operation").unwrap();
            assert_eq!(operation.state, expected);
            if stage != "prepared" {
                assert!(recovered
                    .begin("operation", "retry", "retry-execution")
                    .is_err());
            }
        }
    }

    fn successful_read(
        root: &Path,
        ledger: &mut Ledger,
        id: &str,
        target: Value,
        command: &str,
        output: &str,
    ) {
        let mut read = record(id, Effect::Read);
        read.intent["semantic"]["targets"] = json!([target]);
        read.intent["semantic"]["action"]["command"] = json!(command);
        ledger.prepare(seal(read)).unwrap();
        let attempt = format!("attempt-{id}");
        begin(ledger, id, &attempt);
        let outcome = archived_outcome(
            root,
            id,
            &attempt,
            Status::Succeeded,
            json!({"exitCode":0,"output":output}),
        );
        ledger
            .complete(root, id, &attempt, &format!("event-{id}"), outcome, false)
            .unwrap();
    }
    #[test]
    fn service_reconciliation_preserves_unknown_fact_and_releases_only_verified_resource() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot-a").unwrap();
        let mut original = record("service", Effect::Change);
        original.intent["semantic"]["runtimeClass"] = json!("persistent_service");
        original.intent["semantic"]["validator"] =
            json!({"command":"systemctl is-active app.service"});
        ledger.prepare(seal(original)).unwrap();
        begin(&mut ledger, "service", "attempt");
        drop(ledger);
        let mut ledger = Ledger::open(&root.0, "boot-b").unwrap();
        successful_read(
            &root.0,
            &mut ledger,
            "wrong-host",
            target("execution", "other.test", None),
            "systemctl is-active app.service",
            "active\n",
        );
        assert!(ledger
            .resolve(
                &root.0,
                "service",
                "attempt",
                ReconciliationProof::Service {
                    version: 1,
                    read_operation_id: "wrong-host".into()
                }
            )
            .is_err());
        successful_read(
            &root.0,
            &mut ledger,
            "read",
            target("execution", "server.test", None),
            "systemctl is-active app.service",
            "active\n",
        );
        let resolved = ledger
            .resolve(
                &root.0,
                "service",
                "attempt",
                ReconciliationProof::Service {
                    version: 1,
                    read_operation_id: "read".into(),
                },
            )
            .unwrap();
        assert_eq!(resolved.state, Status::Unknown);
        assert_eq!(resolved.attempts[0].status, Status::Unknown);
        assert_eq!(
            resolved.reconciliation.unwrap()["reason"],
            "current_state_verified"
        );
        assert!(ledger.begin("service", "retry", "retry").is_err());
        ledger
            .prepare(record("next-change", Effect::Change))
            .unwrap();
        begin(&mut ledger, "next-change", "next-attempt");
    }

    #[test]
    fn service_reconciliation_rejects_arbitrary_prose_commands_or_fake_archive_values() {
        assert!(!is_read_only_service_validator("true"));
        assert!(!is_read_only_service_validator("systemctl restart app"));
        assert!(!is_read_only_service_validator(
            "systemctl is-active app; reboot"
        ));
        assert!(!is_read_only_service_validator("curl -SI http://localhost"));
        assert!(is_read_only_service_validator(
            "curl -fsSI --max-time 5 'http://localhost:8080/health'"
        ));
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot-a").unwrap();
        let mut original = record("service", Effect::Change);
        original.intent["semantic"]["runtimeClass"] = json!("persistent_service");
        original.intent["semantic"]["validator"] =
            json!({"command":"systemctl is-active app.service"});
        ledger.prepare(seal(original)).unwrap();
        begin(&mut ledger, "service", "attempt");
        drop(ledger);
        let mut ledger = Ledger::open(&root.0, "boot-b").unwrap();
        let mut read = record("read", Effect::Read);
        read.intent["semantic"]["action"]["command"] = json!("systemctl is-active app.service");
        ledger.prepare(seal(read)).unwrap();
        begin(&mut ledger, "read", "read-attempt");
        let mut outcome = archived_outcome(
            &root.0,
            "read",
            "read-attempt",
            Status::Succeeded,
            json!({"exitCode":1,"output":"inactive"}),
        );
        outcome.result = Some(json!({"exitCode":0,"output":"model claims active"}));
        ledger
            .complete(&root.0, "read", "read-attempt", "event", outcome, false)
            .unwrap();
        assert!(ledger
            .resolve(
                &root.0,
                "service",
                "attempt",
                ReconciliationProof::Service {
                    version: 1,
                    read_operation_id: "read".into()
                }
            )
            .unwrap_err()
            .starts_with("EXECUTION_LEDGER_INVALID_EVIDENCE"));
    }

    #[test]
    fn file_transfer_reconciliation_requires_both_stable_matching_fingerprints() {
        let root = TestRoot::new();
        let mut ledger = Ledger::open(&root.0, "boot-a").unwrap();
        let source = target("source", "source.test", Some("/source/file"));
        let dest = target("target", "target.test", Some("/dest/file"));
        let mut original = record("transfer", Effect::Change);
        original.intent["semantic"]["action"] =
            json!({"type":"tool","toolId":"files.transfer_between_servers","arguments":{}});
        original.intent["semantic"]["targets"] = json!([source.clone(), dest.clone()]);
        ledger.prepare(seal(original)).unwrap();
        begin(&mut ledger, "transfer", "attempt");
        drop(ledger);
        let mut ledger = Ledger::open(&root.0, "boot-b").unwrap();
        let mut source_read_target = source.clone();
        source_read_target["role"] = json!("execution");
        let mut dest_read_target = dest.clone();
        dest_read_target["role"] = json!("execution");
        let hash = "b".repeat(64);
        successful_read(
            &root.0,
            &mut ledger,
            "source-read",
            source_read_target,
            &file_probe_command(&source).unwrap(),
            &format!("15\n{hash}  /source/file\n15\n"),
        );
        successful_read(
            &root.0,
            &mut ledger,
            "bad-target",
            dest_read_target.clone(),
            &file_probe_command(&dest).unwrap(),
            &format!("16\n{hash}  /dest/file\n16\n"),
        );
        let proof = |dest: &str| ReconciliationProof::FileTransfer {
            version: 1,
            source_read_operation_id: "source-read".into(),
            target_read_operation_id: dest.into(),
        };
        assert!(ledger
            .resolve(&root.0, "transfer", "attempt", proof("bad-target"))
            .is_err());
        successful_read(
            &root.0,
            &mut ledger,
            "target-read",
            dest_read_target,
            &file_probe_command(&dest).unwrap(),
            &format!("15\n{hash}  /dest/file\n15\n"),
        );
        let operation = ledger
            .resolve(&root.0, "transfer", "attempt", proof("target-read"))
            .unwrap();
        assert_eq!(operation.attempts[0].status, Status::Unknown);
        assert_eq!(operation.reconciliation.unwrap()["kind"], "file_transfer");
        assert!(file_fingerprint(&format!("15\n{hash}  /dest/file\n16\n"), &dest).is_err());
    }
}
