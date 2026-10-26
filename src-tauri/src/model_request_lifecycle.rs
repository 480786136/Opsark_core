//! Durable identities and observations for model requests. Local cancellation is
//! a delivery barrier, never evidence that a provider stopped or charged nothing.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static ROOT: OnceLock<PathBuf> = OnceLock::new();
static BOOT: OnceLock<String> = OnceLock::new();
fn boot() -> &'static str {
    BOOT.get_or_init(crate::task_logs::call_id)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn fail(code: &str, message: &str) -> String {
    format!(
        "{}{}",
        crate::MODEL_TRACE_ERROR_PREFIX,
        json!({"message":message,"modelError":{
        "code":code,"message":message,"origin":"core","stage":"request_lifecycle","retryable":false}})
    )
}
fn request_failure(code: &str, message: &str, request_id: &str) -> String {
    format!(
        "{}{}",
        crate::MODEL_TRACE_ERROR_PREFIX,
        json!({"message":message,"modelError":{
        "code":code,"message":message,"origin":"core","stage":"request_lifecycle","retryable":false,"requestKey":request_id}})
    )
}
fn db_error(_: impl std::fmt::Display) -> String {
    fail(
        "MODEL_REQUEST_LEDGER_UNAVAILABLE",
        "模型请求账本不可用，已停止派发",
    )
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn request_scope(context: &Value) -> Result<(Option<String>, Option<String>), String> {
    let mut task: Option<String> = None;
    let mut round: Option<String> = None;
    for pointer in [
        "",
        "/_modelRequestLifecycle",
        "/_taskModelBudget",
        "/_log",
        "/baseSnapshot/_log",
        "/task/_log",
    ] {
        let Some(meta) = context.pointer(pointer) else {
            continue;
        };
        for (key, target) in [("taskId", &mut task), ("roundId", &mut round)] {
            if let Some(raw) = meta.get(key) {
                let id = raw
                    .as_str()
                    .filter(|id| valid_id(id))
                    .ok_or_else(|| fail("MODEL_REQUEST_INVALID", "模型请求作用域标识无效"))?;
                if target.as_deref().is_some_and(|old| old != id) {
                    return Err(fail(
                        "MODEL_REQUEST_IDENTITY_CONFLICT",
                        "模型请求和预算的任务或轮次身份不一致",
                    ));
                }
                *target = Some(id.to_owned());
            }
        }
    }
    if round.is_some() && task.is_none() {
        return Err(fail("MODEL_REQUEST_INVALID", "轮次缺少原任务身份"));
    }
    Ok((task, round))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Adapter {
    pub protocol: String,
    pub base_url: String,
}
impl Adapter {
    pub(crate) fn from_context(context: &Value, endpoint: &str) -> Result<Option<Self>, String> {
        let Some(raw) = context.pointer("/_modelRequestLifecycle/adapter") else {
            return Ok(None);
        };
        let adapter: Self = serde_json::from_value(raw.clone())
            .map_err(|_| fail("MODEL_ADAPTER_INVALID", "模型适配恢复配置无效"))?;
        let base = reqwest::Url::parse(&adapter.base_url).map_err(db_error)?;
        let original = reqwest::Url::parse(endpoint).map_err(db_error)?;
        let loopback = base.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if adapter.protocol != "opsark-local-v1"
            || !loopback
            || !matches!(base.scheme(), "http" | "https")
            || base.origin() != original.origin()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || base.path() != "/"
        {
            return Err(fail(
                "MODEL_ADAPTER_INVALID",
                "适配查询必须使用显式配置的同源本地接口",
            ));
        }
        Ok(Some(adapter))
    }
    pub(crate) fn url(&self, request_id: &str, cancel: bool) -> Result<reqwest::Url, String> {
        if !valid_id(request_id) {
            return Err(fail("MODEL_REQUEST_INVALID", "原请求标识无效"));
        }
        let mut url = reqwest::Url::parse(&self.base_url).map_err(db_error)?;
        url.set_path(&format!(
            "/opsark/requests/{request_id}{}",
            if cancel { "/cancel" } else { "" }
        ));
        Ok(url)
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RequestState {
    NotDispatched,
    Dispatching,
    Accepted,
    Unknown,
    Completed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestRecord {
    pub version: u32,
    pub request_id: String,
    pub operation_id: String,
    pub operation_started_at_ms: u64,
    pub task_id: Option<String>,
    pub round_id: Option<String>,
    /// Model configuration probes are independent of OpsTask budgets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe_id: Option<String>,
    pub endpoint: String,
    pub credential_digest: String,
    pub request_digest: String,
    pub adapter: Option<Adapter>,
    pub state: RequestState,
    pub phase: String,
    pub cancel_requested: bool,
    pub late: bool,
    pub attempt_ids: Vec<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub http_status: Option<u16>,
    pub response: Option<Value>,
    pub usage: Option<Value>,
    pub events: Vec<Value>,
}

fn assert_probe_identity(record:&RequestRecord, probe_id:&str,url:&str,authorization:&str) -> Result<(),String> {
    if record.probe_id.as_deref()!=Some(probe_id) || record.task_id.is_some() || record.round_id.is_some()
        || record.endpoint!=url || record.credential_digest!=digest(authorization.as_bytes()) {
        return Err(fail("MODEL_REQUEST_IDENTITY_CONFLICT","查询必须绑定原模型测试、接口和账号"));
    }
    Ok(())
}

pub(crate) struct Store {
    connection: Connection,
    boot_id: String,
}
impl Store {
    pub(crate) fn open(path: &Path, current_boot: &str) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(db_error)?;
        }
        let mut connection = Connection::open(path).map_err(db_error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(db_error)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS model_requests(id TEXT PRIMARY KEY, task_id TEXT, record TEXT NOT NULL, boot_id TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS model_requests_task ON model_requests(task_id);
          CREATE TABLE IF NOT EXISTS model_request_cancellations(task_id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS model_request_cancel_before(task_id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS model_request_delivery_cancellations(request_id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);").map_err(db_error)?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS model_probe_requests(request_id TEXT PRIMARY KEY, probe_id TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS model_probe_scope ON model_probe_requests(probe_id);
          CREATE TABLE IF NOT EXISTS model_probe_cancel_before(probe_id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);").map_err(db_error)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let originals: Vec<(String, String)> = {
            let mut query = tx
                .prepare("SELECT id,record FROM model_requests WHERE boot_id<>?1")
                .map_err(db_error)?;
            let rows = query
                .query_map([current_boot], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(db_error)?;
            rows.collect::<Result<_, _>>().map_err(db_error)?
        };
        for (id, raw) in originals {
            let mut record: RequestRecord = serde_json::from_str(&raw).map_err(db_error)?;
            if matches!(
                record.state,
                RequestState::Dispatching | RequestState::Accepted
            ) {
                record.state = RequestState::Unknown;
                record
                    .events
                    .push(json!({"event":"runtime_restarted","atMs":now(),"state":"unknown"}));
                record.updated_at_ms = now();
            }
            tx.execute(
                "UPDATE model_requests SET record=?2,boot_id=?3 WHERE id=?1",
                params![
                    id,
                    serde_json::to_string(&record).map_err(db_error)?,
                    current_boot
                ],
            )
            .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(Self {
            connection,
            boot_id: current_boot.into(),
        })
    }
    fn get_from(connection: &Connection, id: &str) -> Result<Option<RequestRecord>, String> {
        let raw: Option<String> = connection
            .query_row("SELECT record FROM model_requests WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(db_error)?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(db_error))
            .transpose()
    }
    pub(crate) fn get(&self, id: &str) -> Result<RequestRecord, String> {
        Self::get_from(&self.connection, id)?
            .ok_or_else(|| fail("MODEL_REQUEST_NOT_FOUND", "原模型请求不存在"))
    }
    fn assert_deliverable(&mut self, id: &str) -> Result<(), String> {
        // A completed receipt is immutable history, but stopping its task/probe
        // still fences a result that has not reached the caller. Read both the
        // receipt and its persistent cancellation scope in one snapshot.
        let tx = self.connection.transaction().map_err(db_error)?;
        let record = Self::get_from(&tx, id)?
            .ok_or_else(|| fail("MODEL_REQUEST_NOT_FOUND", "原模型请求不存在"))?;
        let exact_cancelled: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM model_request_delivery_cancellations WHERE request_id=?1)",
            [id], |r| r.get(0),
        ).map_err(db_error)?;
        let mut blocked = record.cancel_requested || exact_cancelled;
        if let Some(task) = &record.task_id {
            let cancelled: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM model_request_cancellations WHERE task_id=?1)",
                [task], |r| r.get(0),
            ).map_err(db_error)?;
            let cutoff: Option<u64> = tx.query_row(
                "SELECT at_ms FROM model_request_cancel_before WHERE task_id=?1",
                [task], |r| r.get(0),
            ).optional().map_err(db_error)?;
            blocked |= cancelled || cutoff.is_some_and(|at| record.operation_started_at_ms <= at);
        }
        if let Some(probe) = &record.probe_id {
            let cutoff: Option<u64> = tx.query_row(
                "SELECT at_ms FROM model_probe_cancel_before WHERE probe_id=?1",
                [probe], |r| r.get(0),
            ).optional().map_err(db_error)?;
            blocked |= cutoff.is_some_and(|at| record.operation_started_at_ms <= at);
        }
        tx.commit().map_err(db_error)?;
        if blocked { Err(cancel_error(id)) } else { Ok(()) }
    }
    pub(crate) fn prepare(&mut self, record: RequestRecord) -> Result<RequestRecord, String> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        if let Some(old) = Self::get_from(&tx, &record.request_id)? {
            if old.operation_id != record.operation_id
                || old.operation_started_at_ms != record.operation_started_at_ms
                || old.task_id != record.task_id
                || old.round_id != record.round_id
                || old.probe_id != record.probe_id
                || old.endpoint != record.endpoint
                || old.credential_digest != record.credential_digest
                || old.request_digest != record.request_digest
                || old.adapter != record.adapter
            {
                return Err(fail(
                    "MODEL_REQUEST_IDENTITY_CONFLICT",
                    "原模型请求身份或内容不一致，禁止复用",
                ));
            }
            return Ok(old);
        }
        if let Some(probe) = &record.probe_id {
            if record.task_id.is_some() || record.round_id.is_some() || !valid_id(probe) {
                return Err(fail("MODEL_REQUEST_INVALID", "模型配置测试不能借用任务预算作用域"));
            }
            let cutoff: Option<u64> = tx.query_row("SELECT at_ms FROM model_probe_cancel_before WHERE probe_id=?1", [probe], |r| r.get(0)).optional().map_err(db_error)?;
            if cutoff.is_some_and(|cutoff| record.operation_started_at_ms <= cutoff) { return Err(cancel_error(&record.request_id)); }
            Self::assert_probe_clear(&tx, probe, &record.request_id)?;
        }
        if let Some(task) = &record.task_id {
            let cancelled: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM model_request_cancellations WHERE task_id=?1)",
                    [task],
                    |r| r.get(0),
                )
                .map_err(db_error)?;
            if cancelled {
                return Err(cancel_error(&record.request_id));
            }
            let cutoff: Option<u64> = tx
                .query_row(
                    "SELECT at_ms FROM model_request_cancel_before WHERE task_id=?1",
                    [task],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db_error)?;
            if cutoff.is_some_and(|cutoff| record.operation_started_at_ms <= cutoff) {
                return Err(cancel_error(&record.request_id));
            }
            let mut query = tx
                .prepare("SELECT record FROM model_requests WHERE task_id=?1")
                .map_err(db_error)?;
            let rows = query
                .query_map([task], |r| r.get::<_, String>(0))
                .map_err(db_error)?;
            for raw in rows {
                let old: RequestRecord =
                    serde_json::from_str(&raw.map_err(db_error)?).map_err(db_error)?;
                if matches!(
                    old.state,
                    RequestState::Dispatching | RequestState::Accepted | RequestState::Unknown
                ) {
                    return Err(request_failure(
                        "MODEL_REQUEST_UNRESOLVED",
                        "本任务已有未决模型请求，请先查询原请求，不能重新生成",
                        &old.request_id,
                    ));
                }
            }
        }
        tx.execute(
            "INSERT INTO model_requests(id,task_id,record,boot_id) VALUES(?1,?2,?3,?4)",
            params![
                record.request_id,
                record.task_id,
                serde_json::to_string(&record).map_err(db_error)?,
                self.boot_id
            ],
        )
        .map_err(db_error)?;
        if let Some(probe) = &record.probe_id {
            tx.execute("INSERT INTO model_probe_requests(request_id,probe_id) VALUES(?1,?2)", params![record.request_id,probe]).map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(record)
    }
    fn assert_probe_clear(connection: &Connection, probe: &str, except: &str) -> Result<(), String> {
        let mut query = connection.prepare("SELECT r.record FROM model_requests r JOIN model_probe_requests p ON p.request_id=r.id WHERE p.probe_id=?1 AND r.id<>?2").map_err(db_error)?;
        let rows = query.query_map(params![probe,except], |r| r.get::<_,String>(0)).map_err(db_error)?;
        for raw in rows {
            let old: RequestRecord = serde_json::from_str(&raw.map_err(db_error)?).map_err(db_error)?;
            if matches!(old.state, RequestState::Dispatching|RequestState::Accepted|RequestState::Unknown) {
                return Err(request_failure("MODEL_REQUEST_UNRESOLVED", "此模型连接已有未决测试，请先查询原请求，不能重新生成", &old.request_id));
            }
        }
        Ok(())
    }
    fn update(
        &mut self,
        id: &str,
        change: impl FnOnce(&mut RequestRecord, &Connection) -> Result<(), String>,
    ) -> Result<RequestRecord, String> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let mut record = Self::get_from(&tx, id)?
            .ok_or_else(|| fail("MODEL_REQUEST_NOT_FOUND", "原模型请求不存在"))?;
        change(&mut record, &tx)?;
        record.updated_at_ms = now();
        tx.execute(
            "UPDATE model_requests SET record=?2 WHERE id=?1",
            params![id, serde_json::to_string(&record).map_err(db_error)?],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(record)
    }
    pub(crate) fn dispatch(&mut self, id: &str, attempt: &str) -> Result<RequestRecord, String> {
        self.update(id, |record, tx| {
            if record.cancel_requested {
                return Err(cancel_error(id));
            }
            if record.state != RequestState::NotDispatched
                || record.attempt_ids.iter().any(|old| old == attempt)
            {
                return Err(request_failure(
                    "MODEL_REQUEST_REPLAY_BLOCKED",
                    "原请求可能已派发，禁止再次发送",
                    &record.request_id,
                ));
            }
            if let Some(task) = &record.task_id {
                let mut query = tx
                    .prepare("SELECT record FROM model_requests WHERE task_id=?1 AND id<>?2")
                    .map_err(db_error)?;
                let rows = query
                    .query_map(params![task, id], |r| r.get::<_, String>(0))
                    .map_err(db_error)?;
                for raw in rows {
                    let other: RequestRecord =
                        serde_json::from_str(&raw.map_err(db_error)?).map_err(db_error)?;
                    if matches!(
                        other.state,
                        RequestState::Dispatching | RequestState::Accepted | RequestState::Unknown
                    ) {
                        return Err(request_failure(
                            "MODEL_REQUEST_UNRESOLVED",
                            "本任务已有未决模型请求，禁止并发派发新的生成",
                            &other.request_id,
                        ));
                    }
                }
            }
            if let Some(probe) = &record.probe_id {
                Self::assert_probe_clear(tx, probe, &record.request_id)?;
            }
            record.attempt_ids.push(attempt.into());
            record.state = RequestState::Dispatching;
            record.phase = "dispatching".into();
            record
                .events
                .push(json!({"event":"dispatch_committed","attemptId":attempt,"atMs":now()}));
            Ok(())
        })
    }
    pub(crate) fn observe(
        &mut self,
        id: &str,
        state: RequestState,
        phase: &str,
        status: Option<u16>,
        response: Option<Value>,
        detail: Value,
    ) -> Result<RequestRecord, String> {
        self.update(id, |record,_| {
            if matches!(record.state, RequestState::Completed | RequestState::Cancelled) && state != record.state {
                return Err(fail("MODEL_REQUEST_STATE_CONFLICT", "不能覆盖原模型请求终态"));
            }
            if matches!(record.state, RequestState::Completed | RequestState::Cancelled)
                && response.as_ref().zip(record.response.as_ref()).is_some_and(|(new,old)|new != old) {
                return Err(fail("MODEL_REQUEST_STATE_CONFLICT", "原模型请求完成正文不一致"));
            }
            record.state = state;
            record.phase = phase.into();
            record.http_status = status.or(record.http_status);
            record.late |= record.cancel_requested && response.is_some();
            if let Some(payload) = &response {
                if let Some(usage) = payload.get("usage") { record.usage = Some(usage.clone()); }
                record.response = Some(payload.clone());
            }
            if record.usage.is_none() {
                if let Some(usage) = detail.get("usage").filter(|v| !v.is_null()) { record.usage = Some(usage.clone()); }
                else if let Some(actual) = detail.get("actual").and_then(Value::as_u64) { record.usage = Some(json!({"total_tokens":actual,"source":"authenticated_status"})); }
            }
            record.events.push(json!({"event":"observation","atMs":now(),"state":state,"phase":phase,"httpStatus":status,"response":response,"detail":detail}));
            Ok(())
        })
    }
    pub(crate) fn cancel(&mut self, task: &str, request: Option<&str>) -> Result<Value, String> {
        self.cancel_scope(task, request, None)
    }
    #[cfg(test)]
    pub(crate) fn cancel_before_for_test(&mut self, task: &str, cutoff: u64) -> Result<Value,String> {
        self.cancel_scope(task,None,Some(cutoff))
    }
    fn cancel_scope(
        &mut self,
        task: &str,
        request: Option<&str>,
        cutoff: Option<u64>,
    ) -> Result<Value, String> {
        if !valid_id(task) {
            return Err(fail("MODEL_REQUEST_INVALID", "任务标识无效"));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        if let Some(id) = request {
            let record = Self::get_from(&tx, id)?
                .ok_or_else(|| fail("MODEL_REQUEST_NOT_FOUND", "原模型请求不存在"))?;
            if record.task_id.as_deref() != Some(task) {
                return Err(fail(
                    "MODEL_REQUEST_IDENTITY_CONFLICT",
                    "不能取消其他任务的请求",
                ));
            }
            // Exact-request cancellation also fences a completed but undelivered
            // result. This local barrier must not claim a terminal provider
            // request is still waiting to stop or rewrite its receipt history.
            tx.execute(
                "INSERT OR IGNORE INTO model_request_delivery_cancellations(request_id,at_ms) VALUES(?1,?2)",
                params![id, now()],
            ).map_err(db_error)?;
        } else if let Some(at) = cutoff {
            tx.execute("INSERT INTO model_request_cancel_before(task_id,at_ms) VALUES(?1,?2) ON CONFLICT(task_id) DO UPDATE SET at_ms=MAX(at_ms,excluded.at_ms)", params![task,at]).map_err(db_error)?;
        } else {
            tx.execute(
                "INSERT OR IGNORE INTO model_request_cancellations(task_id,at_ms) VALUES(?1,?2)",
                params![task, now()],
            )
            .map_err(db_error)?;
        }
        let mut records: Vec<RequestRecord> = {
            let mut query = tx
                .prepare("SELECT record FROM model_requests WHERE task_id=?1")
                .map_err(db_error)?;
            let rows = query
                .query_map([task], |r| r.get::<_, String>(0))
                .map_err(db_error)?;
            rows.map(|r| serde_json::from_str(&r.map_err(db_error)?).map_err(db_error))
                .collect::<Result<_, _>>()?
        };
        records.retain(|record| request.is_none_or(|id| id == record.request_id));
        for record in &mut records {
            if !record.cancel_requested
                && !matches!(record.state, RequestState::Completed | RequestState::Cancelled)
                && cutoff.is_none_or(|at| record.operation_started_at_ms <= at)
            {
                record.cancel_requested = true;
                record.updated_at_ms = now();
                record.events.push(
                    json!({"event":"cancel_requested","atMs":now(),"providerConfirmed":false}),
                );
                tx.execute(
                    "UPDATE model_requests SET record=?2 WHERE id=?1",
                    params![
                        record.request_id,
                        serde_json::to_string(record).map_err(db_error)?
                    ],
                )
                .map_err(db_error)?;
            }
        }
        tx.commit().map_err(db_error)?;
        Ok(json!(records))
    }
    pub(crate) fn list(&self, task: &str) -> Result<Value, String> {
        let mut query = self
            .connection
            .prepare("SELECT record FROM model_requests WHERE task_id=?1 ORDER BY rowid")
            .map_err(db_error)?;
        let rows = query
            .query_map([task], |r| r.get::<_, String>(0))
            .map_err(db_error)?;
        let values = rows
            .map(|r| serde_json::from_str::<Value>(&r.map_err(db_error)?).map_err(db_error))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!(values))
    }
    pub(crate) fn list_probe(&self, probe: &str) -> Result<Value, String> {
        let mut query = self.connection.prepare("SELECT r.record FROM model_requests r JOIN model_probe_requests p ON p.request_id=r.id WHERE p.probe_id=?1 ORDER BY r.rowid").map_err(db_error)?;
        let rows = query.query_map([probe], |r| r.get::<_,String>(0)).map_err(db_error)?;
        let values = rows.map(|r| serde_json::from_str::<Value>(&r.map_err(db_error)?).map_err(db_error)).collect::<Result<Vec<_>,_>>()?;
        Ok(json!(values))
    }
    pub(crate) fn cancel_probe(&mut self, probe: &str, cutoff: u64) -> Result<Value,String> {
        let tx = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
        tx.execute("INSERT INTO model_probe_cancel_before(probe_id,at_ms) VALUES(?1,?2) ON CONFLICT(probe_id) DO UPDATE SET at_ms=MAX(at_ms,excluded.at_ms)",params![probe,cutoff]).map_err(db_error)?;
        let mut records:Vec<RequestRecord> = {
            let mut query = tx.prepare("SELECT r.record FROM model_requests r JOIN model_probe_requests p ON p.request_id=r.id WHERE p.probe_id=?1").map_err(db_error)?;
            let rows = query.query_map([probe],|r|r.get::<_,String>(0)).map_err(db_error)?;
            rows.map(|r|serde_json::from_str(&r.map_err(db_error)?).map_err(db_error)).collect::<Result<_,_>>()?
        };
        for record in &mut records {
            if !record.cancel_requested && record.operation_started_at_ms <= cutoff && !matches!(record.state,RequestState::Completed|RequestState::Cancelled) {
                record.cancel_requested=true;
                record.updated_at_ms=now();
                record.events.push(json!({"event":"cancel_requested","atMs":now(),"providerConfirmed":false}));
                tx.execute("UPDATE model_requests SET record=?2 WHERE id=?1",params![record.request_id,serde_json::to_string(record).map_err(db_error)?]).map_err(db_error)?;
            }
        }
        tx.commit().map_err(db_error)?;
        Ok(json!(records))
    }
}

pub(crate) fn initialize(root: &Path) -> Result<(), String> {
    let path = root.join("model-requests.sqlite3");
    Store::open(&path, boot())?;
    match ROOT.set(path.clone()) {
        Ok(()) => Ok(()),
        Err(_) if ROOT.get() == Some(&path) => Ok(()),
        Err(_) => Err(fail(
            "MODEL_REQUEST_LEDGER_UNAVAILABLE",
            "模型请求账本不能在运行中更换位置",
        )),
    }
}
fn configured_path() -> Result<PathBuf, String> {
    ROOT.get()
        .cloned()
        .ok_or_else(|| fail("MODEL_REQUEST_LEDGER_UNAVAILABLE", "模型请求账本尚未初始化"))
}
pub(crate) fn list_requests(task_id: &str) -> Result<Value, String> {
    Store::open(&configured_path()?, boot())?.list(task_id)
}
pub(crate) fn request_cancel(task_id: &str, request_id: Option<&str>) -> Result<Value, String> {
    Store::open(&configured_path()?, boot())?.cancel(task_id, request_id)
}
pub(crate) fn cancel_current_task_requests(task_id: &str) -> Result<Value, String> {
    Store::open(&configured_path()?, boot())?.cancel_scope(task_id, None, Some(now()))
}
pub(crate) fn list_probe_requests(probe_id: &str) -> Result<Value,String> {
    Store::open(&configured_path()?,boot())?.list_probe(probe_id)
}
pub(crate) fn cancel_probe_requests(probe_id: &str) -> Result<Value,String> {
    Store::open(&configured_path()?,boot())?.cancel_probe(probe_id,now())
}
pub(crate) fn cancel_error(request_id: &str) -> String {
    let mut payload: Value = serde_json::from_str(
        fail(
            "MODEL_REQUEST_CANCELLED",
            "原模型请求已请求取消，结果仅记账，不继续任务",
        )
        .strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX)
        .unwrap(),
    )
    .unwrap();
    payload["modelError"]["requestKey"] = json!(request_id);
    format!("{}{payload}", crate::MODEL_TRACE_ERROR_PREFIX)
}

#[derive(Clone)]
pub(crate) struct RequestHandle {
    path: PathBuf,
    pub id: String,
}
impl RequestHandle {
    #[cfg(test)]
    pub(crate) fn from_test_path(path: PathBuf, id: String) -> Self {
        Self { path, id }
    }
    #[cfg(test)]
    pub(crate) fn cancel_for_test(&self, task: &str) -> Result<Value, String> {
        Store::open(&self.path, boot())?.cancel(task, Some(&self.id))
    }
    pub(crate) fn prepare(
        log_path: Option<&Path>,
        context: &Value,
        url: &str,
        authorization: &str,
        wire: &Value,
        operation: &str,
        generation: u64,
    ) -> Result<Self, String> {
        let path = if let Some(root) = ROOT.get() {
            root.clone()
        } else if let Some(log) = log_path {
            log.parent()
                .unwrap_or(Path::new("."))
                .join("model-requests.sqlite3")
        } else if cfg!(test) {
            std::env::temp_dir()
                .join("opsark-model-request-tests")
                .join(format!("{}.sqlite3", digest(operation.as_bytes())))
        } else {
            configured_path()?
        };
        let (task_id, round_id) = request_scope(context)?;
        let probe_id = context.pointer("/_modelRequestLifecycle/probeId").map(|value| value.as_str().filter(|id|valid_id(id)).map(str::to_owned)
            .ok_or_else(||fail("MODEL_REQUEST_INVALID","模型配置测试作用域无效"))).transpose()?;
        if !valid_id(operation)
            || task_id.as_deref().is_some_and(|s| !valid_id(s))
            || round_id.as_deref().is_some_and(|s| !valid_id(s))
        {
            return Err(fail("MODEL_REQUEST_INVALID", "模型请求作用域标识无效"));
        }
        let endpoint = reqwest::Url::parse(url).map_err(db_error)?;
        if !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(fail("MODEL_REQUEST_INVALID", "模型接口不能把凭据放入地址"));
        }
        let id = digest(json!([operation, generation]).to_string().as_bytes());
        let operation_started_at_ms = context
            .pointer("/_modelRecovery/startedAtMs")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let record = RequestRecord {
            version: 1,
            request_id: id.clone(),
            operation_id: operation.into(),
            operation_started_at_ms,
            task_id,
            round_id,
            probe_id,
            endpoint: url.into(),
            credential_digest: digest(authorization.as_bytes()),
            request_digest: digest(wire.to_string().as_bytes()),
            adapter: Adapter::from_context(context, url)?,
            state: RequestState::NotDispatched,
            phase: "prepared".into(),
            cancel_requested: false,
            late: false,
            attempt_ids: vec![],
            created_at_ms: now(),
            updated_at_ms: now(),
            http_status: None,
            response: None,
            usage: None,
            events: vec![json!({"event":"prepared","atMs":now()})],
        };
        Store::open(&path, boot())?.prepare(record)?;
        Ok(Self { path, id })
    }
    pub(crate) fn reopen(
        task_id: &str,
        id: &str,
        url: &str,
        authorization: &str,
    ) -> Result<Self, String> {
        let handle = Self {
            path: configured_path()?,
            id: id.into(),
        };
        let record = handle.read()?;
        if record.task_id.as_deref() != Some(task_id)
            || record.endpoint != url
            || record.credential_digest != digest(authorization.as_bytes())
        {
            return Err(fail(
                "MODEL_REQUEST_IDENTITY_CONFLICT",
                "查询必须绑定原任务、接口和账号",
            ));
        }
        Ok(handle)
    }
    pub(crate) fn read(&self) -> Result<RequestRecord, String> {
        Store::open(&self.path, boot())?.get(&self.id)
    }
    pub(crate) fn reopen_probe(probe_id:&str,id:&str,url:&str,authorization:&str) -> Result<Self,String> {
        let handle=Self { path:configured_path()?, id:id.into() };
        let record=handle.read()?;
        assert_probe_identity(&record,probe_id,url,authorization)?;
        Ok(handle)
    }
    pub(crate) fn dispatch(&self, attempt: &str) -> Result<RequestRecord, String> {
        Store::open(&self.path, boot())?.dispatch(&self.id, attempt)
    }
    pub(crate) fn observe(
        &self,
        state: RequestState,
        phase: &str,
        status: Option<u16>,
        response: Option<Value>,
        detail: Value,
    ) -> Result<RequestRecord, String> {
        Store::open(&self.path, boot())?.observe(&self.id, state, phase, status, response, detail)
    }
    pub(crate) fn assert_deliverable(&self) -> Result<(), String> {
        Store::open(&self.path, boot())?.assert_deliverable(&self.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn path() -> PathBuf {
        std::env::temp_dir()
            .join("opsark-lifecycle-unit")
            .join(format!("{}.sqlite3", crate::task_logs::call_id()))
    }
    fn record(id: &str, task: &str) -> RequestRecord {
        RequestRecord {
            version: 1,
            request_id: id.into(),
            operation_id: format!("op-{id}"),
            operation_started_at_ms: 100,
            task_id: Some(task.into()),
            round_id: Some("round-1".into()),
            probe_id: None,
            endpoint: "https://provider.test/v1/chat/completions".into(),
            credential_digest: digest(b"synthetic-secret"),
            request_digest: digest(b"wire"),
            adapter: None,
            state: RequestState::NotDispatched,
            phase: "prepared".into(),
            cancel_requested: false,
            late: false,
            attempt_ids: vec![],
            created_at_ms: 100,
            updated_at_ms: 100,
            http_status: None,
            response: None,
            usage: None,
            events: vec![],
        }
    }
    #[test]
    fn restart_retains_identity_and_converts_dispatch_to_unknown_without_replay() {
        let path = path();
        let mut store = Store::open(&path, "boot-a").unwrap();
        let original = record("request-a", "task-a");
        store.prepare(original.clone()).unwrap();
        store.dispatch("request-a", "attempt-a").unwrap();
        drop(store);
        let mut recovered = Store::open(&path, "boot-b").unwrap();
        let old = recovered.prepare(original).unwrap();
        assert_eq!(old.state, RequestState::Unknown);
        assert_eq!(old.attempt_ids, vec!["attempt-a"]);
        assert!(old.events.iter().any(|e| e["event"] == "runtime_restarted"));
        let error = recovered.dispatch("request-a", "attempt-b").unwrap_err();
        assert!(error.contains("MODEL_REQUEST_REPLAY_BLOCKED"));
        let detail: Value =
            serde_json::from_str(error.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap())
                .unwrap();
        assert_eq!(detail["modelError"]["requestKey"], "request-a");
    }
    #[test]
    fn identity_reuse_cannot_change_body_account_task_or_endpoint() {
        let mut store = Store::open(&path(), "boot").unwrap();
        let original = record("request", "task");
        store.prepare(original.clone()).unwrap();
        for field in [
            "requestDigest",
            "credentialDigest",
            "taskId",
            "roundId",
            "endpoint",
            "operationId",
            "operationStartedAtMs",
        ] {
            let mut changed = json!(original);
            changed[field] = if field == "operationStartedAtMs" {
                json!(101)
            } else {
                json!("changed")
            };
            assert!(store
                .prepare(serde_json::from_value(changed).unwrap())
                .unwrap_err()
                .contains("MODEL_REQUEST_IDENTITY_CONFLICT"));
        }
        assert!(!store
            .list("task")
            .unwrap()
            .to_string()
            .contains("synthetic-secret"));
    }
    #[test]
    fn unknown_blocks_new_generations_only_in_original_task() {
        let mut store = Store::open(&path(), "boot").unwrap();
        store.prepare(record("first", "task-a")).unwrap();
        store.dispatch("first", "attempt").unwrap();
        store
            .observe(
                "first",
                RequestState::Unknown,
                "timeout",
                None,
                None,
                json!({}),
            )
            .unwrap();
        let mut another = record("next", "task-a");
        another.round_id = Some("round-2".into());
        let error = store.prepare(another).unwrap_err();
        assert!(error.contains("MODEL_REQUEST_UNRESOLVED"));
        let detail: Value =
            serde_json::from_str(error.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap())
                .unwrap();
        assert_eq!(detail["modelError"]["requestKey"], "first");
        store.prepare(record("independent", "task-b")).unwrap();
        assert_eq!(store.get("first").unwrap().state, RequestState::Unknown);
    }
    #[test]
    fn simultaneous_preparations_cannot_bypass_the_atomic_task_dispatch_gate() {
        let path = path();
        let mut a = Store::open(&path, "boot").unwrap();
        let mut b = Store::open(&path, "boot").unwrap();
        a.prepare(record("one", "task")).unwrap();
        b.prepare(record("two", "task")).unwrap();
        a.dispatch("one", "attempt-one").unwrap();
        let error = b.dispatch("two", "attempt-two").unwrap_err();
        assert!(error.contains("MODEL_REQUEST_UNRESOLVED"));
        let detail: Value =
            serde_json::from_str(error.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap())
                .unwrap();
        assert_eq!(detail["modelError"]["requestKey"], "one");
        assert!(b.get("two").unwrap().attempt_ids.is_empty());
    }
    #[test]
    fn only_proven_not_dispatched_allows_another_transport_attempt() {
        let mut store = Store::open(&path(), "boot").unwrap();
        store.prepare(record("request", "task")).unwrap();
        store.dispatch("request", "one").unwrap();
        assert!(store.dispatch("request", "two").is_err());
        store
            .observe(
                "request",
                RequestState::NotDispatched,
                "connect_failed",
                None,
                None,
                json!({}),
            )
            .unwrap();
        assert!(store.dispatch("request", "one").is_err());
        store.dispatch("request", "two").unwrap();
        assert_eq!(
            store.get("request").unwrap().attempt_ids,
            vec!["one", "two"]
        );
    }
    #[test]
    fn cancellation_is_isolated_and_late_completion_preserves_original_usage() {
        let mut store = Store::open(&path(), "boot").unwrap();
        for (id, task) in [("one", "a"), ("two", "b")] {
            store.prepare(record(id, task)).unwrap();
            store.dispatch(id, id).unwrap();
        }
        assert!(store.cancel("b", Some("one")).is_err());
        store.cancel("a", Some("one")).unwrap();
        assert_eq!(store.get("one").unwrap().state, RequestState::Dispatching);
        let result = json!({"choices":[{"message":{"content":"late"}}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}});
        let late = store
            .observe(
                "one",
                RequestState::Completed,
                "response_received",
                Some(200),
                Some(result.clone()),
                json!({}),
            )
            .unwrap();
        assert!(late.late && late.cancel_requested);
        assert_eq!(late.response, Some(result));
        assert_eq!(late.usage.unwrap()["total_tokens"], 10);
        assert!(!store.get("two").unwrap().cancel_requested);
        assert_eq!(store.get("two").unwrap().state, RequestState::Dispatching);
    }
    #[test]
    fn cancellation_does_not_rewrite_completed_or_cancelled_receipts() {
        for state in [RequestState::Completed, RequestState::Cancelled] {
            let mut store = Store::open(&path(), "boot").unwrap();
            store.prepare(record("original", "task")).unwrap();
            store.dispatch("original", "attempt").unwrap();
            let original = store.observe("original", state, "terminal", Some(200),
                Some(json!({"response":"original","usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}})), json!({})).unwrap();
            store.cancel("task", Some("original")).unwrap();
            assert_eq!(store.get("original").unwrap(), original);
            store.cancel_scope("task", None, Some(150)).unwrap();
            assert_eq!(store.get("original").unwrap(), original);
            store.cancel("task", None).unwrap();
            assert_eq!(store.get("original").unwrap(), original);
            assert!(!original.cancel_requested && !original.late);
        }
    }
    #[test]
    fn task_cutoff_fences_completed_undelivered_result_without_changing_history() {
        let path = path();
        let mut store = Store::open(&path, boot()).unwrap();
        store.prepare(record("original", "task")).unwrap();
        store.dispatch("original", "attempt").unwrap();
        let original = store.observe("original", RequestState::Completed, "response_received", Some(200),
            Some(json!({"choices":[],"usage":{"total_tokens":19}})), json!({})).unwrap();
        let handle = RequestHandle::from_test_path(path, "original".into());
        handle.assert_deliverable().unwrap();
        store.cancel_scope("task", None, Some(150)).unwrap();
        drop(store);
        assert!(handle.assert_deliverable().unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
        assert_eq!(handle.read().unwrap(), original);
        assert_eq!(original.usage.unwrap()["total_tokens"], 19);
    }
    #[test]
    fn exact_request_stop_fences_completed_result_without_affecting_other_requests() {
        let path = path();
        let mut store = Store::open(&path, boot()).unwrap();
        for id in ["original", "other"] {
            store.prepare(record(id, "task")).unwrap();
            store.dispatch(id, &format!("attempt-{id}")).unwrap();
            store.observe(id, RequestState::Completed, "response_received", Some(200),
                Some(json!({"answer":id,"usage":{"total_tokens":19}})), json!({})).unwrap();
        }
        let original = store.get("original").unwrap();
        let other = store.get("other").unwrap();
        assert!(store.cancel("wrong-task", Some("original")).unwrap_err().contains("MODEL_REQUEST_IDENTITY_CONFLICT"));
        store.assert_deliverable("original").unwrap();
        store.cancel("task", Some("original")).unwrap();
        store.cancel("task", Some("original")).unwrap();
        assert_eq!(store.get("original").unwrap(), original);
        assert_eq!(store.get("other").unwrap(), other);
        assert!(!original.cancel_requested && !original.late);
        store.prepare(record("new-request", "task")).unwrap();
        drop(store);
        let original_handle = RequestHandle::from_test_path(path.clone(), "original".into());
        assert!(original_handle.assert_deliverable().unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
        assert_eq!(original_handle.read().unwrap(), original);
        RequestHandle::from_test_path(path.clone(), "other".into()).assert_deliverable().unwrap();
        RequestHandle::from_test_path(path, "new-request".into()).assert_deliverable().unwrap();
    }
    #[test]
    fn permanent_task_stop_fences_completed_result_without_a_new_cancel_flag() {
        let path = path();
        let mut store = Store::open(&path, boot()).unwrap();
        store.prepare(record("original", "task")).unwrap();
        store.dispatch("original", "attempt").unwrap();
        let original = store.observe("original", RequestState::Completed, "response_received", Some(200),
            Some(json!({"choices":[],"usage":{"total_tokens":23}})), json!({})).unwrap();
        store.cancel("task", None).unwrap();
        let mut future = record("future", "task"); future.operation_started_at_ms = u64::MAX / 2;
        assert!(store.prepare(future).unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
        drop(store);
        let handle = RequestHandle::from_test_path(path, "original".into());
        assert!(handle.assert_deliverable().unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
        assert_eq!(handle.read().unwrap(), original);
    }
    #[test]
    fn task_cutoff_does_not_cancel_an_existing_newer_operation_or_other_task() {
        let mut store = Store::open(&path(), "boot").unwrap();
        store.prepare(record("old", "task")).unwrap();
        let mut newer = record("new", "task"); newer.operation_started_at_ms = 200;
        store.prepare(newer).unwrap();
        store.prepare(record("other", "other-task")).unwrap();
        store.cancel_scope("task", None, Some(150)).unwrap();
        assert!(store.get("old").unwrap().cancel_requested);
        assert!(!store.get("new").unwrap().cancel_requested);
        assert!(!store.get("other").unwrap().cancel_requested);
        assert!(store.assert_deliverable("old").unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
        store.assert_deliverable("new").unwrap();
        store.assert_deliverable("other").unwrap();
        assert!(store.prepare(record("late-old", "task")).unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
        assert!(store.dispatch("old", "old-attempt").unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
        store.dispatch("new", "new-attempt").unwrap();
    }
    #[test]
    fn task_stop_still_cancels_prepared_and_connect_failed_requests() {
        let mut store = Store::open(&path(), "boot").unwrap();
        store.prepare(record("prepared", "task")).unwrap();
        store.prepare(record("connect-failed", "task")).unwrap();
        store.dispatch("connect-failed", "attempt").unwrap();
        store.observe("connect-failed", RequestState::NotDispatched, "connect_failed", None, None, json!({})).unwrap();
        store.cancel_scope("task", None, Some(150)).unwrap();
        for id in ["prepared", "connect-failed"] {
            let current = store.get(id).unwrap();
            assert_eq!(current.state, RequestState::NotDispatched);
            assert!(current.cancel_requested);
            assert!(store.assert_deliverable(id).unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
            assert!(store.dispatch(id, &format!("retry-{id}")).unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
        }
    }
    #[test]
    fn repeated_completion_after_task_stop_is_not_reclassified_as_late() {
        let mut store = Store::open(&path(), "boot").unwrap();
        store.prepare(record("original", "task")).unwrap();
        store.dispatch("original", "attempt").unwrap();
        let response = json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}});
        let original = store.observe("original", RequestState::Completed, "response_received", Some(200), Some(response.clone()), json!({})).unwrap();
        store.cancel_scope("task", None, Some(150)).unwrap();
        for _ in 0..2 {
            let repeated = store.observe("original", RequestState::Completed, "response_received", Some(200), Some(response.clone()), json!({})).unwrap();
            assert!(!repeated.cancel_requested && !repeated.late);
            assert_eq!(repeated.response, original.response);
            assert_eq!(repeated.usage, original.usage);
            assert!(!repeated.events.iter().any(|event| event["event"] == "cancel_requested"));
        }
        assert!(store.assert_deliverable("original").unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
    }
    #[test]
    fn task_stop_before_completion_preserves_late_result_and_usage_on_repeated_stop() {
        let path = path();
        let mut store = Store::open(&path, boot()).unwrap();
        store.prepare(record("original", "task")).unwrap();
        store.dispatch("original", "attempt").unwrap();
        store.cancel_scope("task", None, Some(150)).unwrap();
        let response = json!({"choices":[],"usage":{"total_tokens":31}});
        let original = store.observe("original", RequestState::Completed, "response_received", Some(200), Some(response.clone()), json!({})).unwrap();
        assert!(original.cancel_requested && original.late);
        store.cancel_scope("task", None, Some(200)).unwrap();
        assert_eq!(store.get("original").unwrap(), original);
        let repeated = store.observe("original", RequestState::Completed, "response_received", Some(200), Some(response), json!({})).unwrap();
        assert!(repeated.cancel_requested && repeated.late);
        assert_eq!(repeated.usage, original.usage);
        assert_eq!(repeated.response, original.response);
        drop(store);
        let handle = RequestHandle::from_test_path(path, "original".into());
        assert!(handle.assert_deliverable().unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
    }
    #[test]
    fn cancel_cutoff_rejects_late_prepare_but_permits_a_new_user_operation() {
        let path = path();
        let mut store = Store::open(&path, "boot").unwrap();
        store.cancel_scope("task", None, Some(150)).unwrap();
        drop(store);
        let mut store = Store::open(&path, "restart").unwrap();
        assert!(store
            .prepare(record("old", "task"))
            .unwrap_err()
            .contains("MODEL_REQUEST_CANCELLED"));
        let mut new = record("new", "task");
        new.operation_started_at_ms = 151;
        store.prepare(new).unwrap();
        store.cancel("task", None).unwrap();
        let mut future = record("future", "task");
        future.operation_started_at_ms = 500;
        assert!(store
            .prepare(future)
            .unwrap_err()
            .contains("MODEL_REQUEST_CANCELLED"));
    }
    #[test]
    fn original_completed_payload_cannot_be_replaced_or_downgraded() {
        let mut store = Store::open(&path(), "boot").unwrap();
        store.prepare(record("request", "task")).unwrap();
        store.dispatch("request", "attempt").unwrap();
        store
            .observe(
                "request",
                RequestState::Completed,
                "completed",
                Some(200),
                Some(json!({"response":"original"})),
                json!({}),
            )
            .unwrap();
        assert!(store
            .observe(
                "request",
                RequestState::Unknown,
                "timeout",
                None,
                None,
                json!({})
            )
            .is_err());
        assert!(store
            .observe(
                "request",
                RequestState::Completed,
                "completed",
                Some(200),
                Some(json!({"response":"new"})),
                json!({})
            )
            .is_err());
    }
    #[test]
    fn adapter_requires_explicit_loopback_same_origin_config() {
        assert_eq!(
            Adapter::from_context(
                &json!({"providerError":{"adapter":{"protocol":"opsark-local-v1"}}}),
                "https://api.example/v1/chat/completions"
            )
            .unwrap(),
            None
        );
        for base in [
            "https://api.example/",
            "http://127.0.0.1:9999/",
            "http://user:secret@127.0.0.1:18765/",
            "http://127.0.0.1:18765/other",
            "http://127.0.0.1:18765/?token=x",
        ] {
            assert!(Adapter::from_context(&json!({"_modelRequestLifecycle":{"adapter":{"protocol":"opsark-local-v1","baseUrl":base}}}),"http://127.0.0.1:18765/v1/chat/completions").is_err());
        }
        let adapter=Adapter::from_context(&json!({"_modelRequestLifecycle":{"adapter":{"protocol":"opsark-local-v1","baseUrl":"http://127.0.0.1:18765"}}}),"http://127.0.0.1:18765/v1/chat/completions").unwrap().unwrap();
        assert!(adapter.url("../escape", false).is_err());
    }
    #[test]
    fn lifecycle_and_budget_scopes_cannot_name_different_tasks_or_rounds() {
        assert_eq!(
            request_scope(&json!({"_taskModelBudget":{"taskId":"a","roundId":"r"}})).unwrap(),
            (Some("a".into()), Some("r".into()))
        );
        for context in [
            json!({"_log":{"taskId":"a"},"_modelRequestLifecycle":{"taskId":"b"}}),
            json!({"_taskModelBudget":{"taskId":"a","roundId":"r1"},"task":{"_log":{"taskId":"a","roundId":"r2"}}}),
            json!({"_log":{"taskId":false}}),
            json!({"_modelRequestLifecycle":{"roundId":"orphan"}}),
        ] {
            assert!(request_scope(&context).is_err());
        }
    }
    #[test]
    fn request_handle_keeps_stable_generation_identity_and_exact_wire_binding() {
        let root = path().with_extension("directory");
        let log = root.join("model-calls.jsonl");
        let operation = crate::task_logs::call_id();
        let wire = json!({"model":"synthetic","messages":[],"max_tokens":10});
        let first = RequestHandle::prepare(
            Some(&log),
            &json!({}),
            "https://provider.test/v1/chat/completions",
            "synthetic",
            &wire,
            &operation,
            1,
        )
        .unwrap();
        first.dispatch("attempt-one").unwrap();
        let restored = RequestHandle::prepare(
            Some(&log),
            &json!({}),
            "https://provider.test/v1/chat/completions",
            "synthetic",
            &wire,
            &operation,
            1,
        )
        .unwrap();
        assert_eq!(first.id, restored.id);
        assert!(restored.dispatch("another-attempt").is_err());
        let changed = json!({"model":"other","messages":[],"max_tokens":10});
        assert!(RequestHandle::prepare(
            Some(&log),
            &json!({}),
            "https://provider.test/v1/chat/completions",
            "synthetic",
            &changed,
            &operation,
            1
        )
        .is_err());
    }

    fn probe_record(id:&str,probe:&str,started:u64) -> RequestRecord {
        let mut value=record(id,"unused");
        value.task_id=None; value.round_id=None; value.probe_id=Some(probe.into());
        value.operation_started_at_ms=started;
        value
    }
    #[test]
    fn probe_unknown_survives_restart_and_blocks_a_new_operation_without_a_task_budget() {
        let path=path();
        let mut first=Store::open(&path,"first-boot").unwrap();
        first.prepare(probe_record("original","probe-a",100)).unwrap();
        first.dispatch("original","attempt-1").unwrap();
        drop(first);
        let mut restarted=Store::open(&path,"second-boot").unwrap();
        assert_eq!(restarted.get("original").unwrap().state,RequestState::Unknown);
        let error=restarted.prepare(probe_record("new-operation","probe-a",200)).unwrap_err();
        assert!(error.contains("MODEL_REQUEST_UNRESOLVED") && error.contains("original"));
        assert_eq!(restarted.list_probe("probe-a").unwrap().as_array().unwrap().len(),1);
        assert!(restarted.list("probe-a").unwrap().as_array().unwrap().is_empty());
        restarted.prepare(probe_record("other-connection","probe-b",200)).unwrap();
        restarted.dispatch("other-connection","other-attempt").unwrap();
    }
    #[test]
    fn probe_admission_and_dispatch_are_atomic_across_connections() {
        let path=path();
        let mut first=Store::open(&path,"same-boot").unwrap();
        let mut second=Store::open(&path,"same-boot").unwrap();
        first.prepare(probe_record("one","probe",100)).unwrap();
        second.prepare(probe_record("two","probe",100)).unwrap();
        first.dispatch("one","first-attempt").unwrap();
        assert!(second.dispatch("two","second-attempt").unwrap_err().contains("MODEL_REQUEST_UNRESOLVED"));
        assert!(second.get("two").unwrap().attempt_ids.is_empty());
        second.cancel_probe("probe",150).unwrap();
        assert!(second.prepare(probe_record("three","probe",200)).unwrap_err().contains("MODEL_REQUEST_UNRESOLVED"));
        assert_eq!(first.get("one").unwrap().state,RequestState::Dispatching);
    }
    #[test]
    fn probe_cancel_cutoff_fences_late_prepare_and_preserves_late_usage_until_confirmed() {
        let path=path();
        let mut store=Store::open(&path,"boot").unwrap();
        store.cancel_probe("probe",150).unwrap();
        assert!(store.prepare(probe_record("late-prepare","probe",100)).unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
        store.prepare(probe_record("after-stop","probe",200)).unwrap();
        store.dispatch("after-stop","attempt").unwrap();
        store.cancel_probe("probe",250).unwrap();
        let completed=store.observe("after-stop",RequestState::Completed,"completed",Some(200),Some(json!({"choices":[],"usage":{"total_tokens":21}})),json!({})).unwrap();
        assert!(completed.late && completed.cancel_requested);
        assert_eq!(completed.usage.unwrap()["total_tokens"],21);
        store.prepare(probe_record("explicit-retest","probe",300)).unwrap();
        store.dispatch("explicit-retest","new-attempt").unwrap();
        assert!(store.prepare(probe_record("new-old-timestamp","probe",240)).unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
    }
    #[test]
    fn probe_cutoff_fences_completed_undelivered_result_without_cancelling_newer_probe() {
        let path = path();
        let mut store = Store::open(&path, boot()).unwrap();
        store.prepare(probe_record("completed", "probe", 100)).unwrap();
        store.dispatch("completed", "attempt").unwrap();
        let original = store.observe("completed", RequestState::Completed, "response_received", Some(200),
            Some(json!({"choices":[],"usage":{"total_tokens":37}})), json!({})).unwrap();
        store.prepare(probe_record("newer", "probe", 200)).unwrap();
        store.prepare(probe_record("other", "other-probe", 100)).unwrap();
        store.cancel_probe("probe", 150).unwrap();
        assert_eq!(store.get("completed").unwrap(), original);
        assert!(!store.get("newer").unwrap().cancel_requested);
        assert!(!store.get("other").unwrap().cancel_requested);
        assert!(store.prepare(probe_record("late-old", "probe", 100)).unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
        drop(store);
        assert!(RequestHandle::from_test_path(path.clone(), "completed".into()).assert_deliverable().unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
        RequestHandle::from_test_path(path.clone(), "newer".into()).assert_deliverable().unwrap();
        RequestHandle::from_test_path(path, "other".into()).assert_deliverable().unwrap();
    }
    #[test]
    fn probe_scope_cannot_also_claim_task_budget_identity_and_old_records_still_decode() {
        let mut record=record("original","task");
        let mut serialized=json!(&record); serialized.as_object_mut().unwrap().remove("probeId");
        assert!(serde_json::from_value::<RequestRecord>(serialized).unwrap().probe_id.is_none());
        record.probe_id=Some("probe".into());
        assert!(Store::open(&path(),"boot").unwrap().prepare(record).unwrap_err().contains("MODEL_REQUEST_INVALID"));
    }
    #[test]
    fn probe_recovery_rejects_old_request_id_from_changed_credentials_endpoint_or_scope() {
        let record=probe_record("original","probe",100);
        assert_probe_identity(&record,"probe",&record.endpoint,"synthetic-secret").unwrap();
        for (probe,url,key) in [("other",record.endpoint.as_str(),"synthetic-secret"),
            ("probe","https://other.test/v1/chat/completions","synthetic-secret"),
            ("probe",record.endpoint.as_str(),"changed-secret")] {
            assert!(assert_probe_identity(&record,probe,url,key).unwrap_err().contains("MODEL_REQUEST_IDENTITY_CONFLICT"));
        }
    }
}
