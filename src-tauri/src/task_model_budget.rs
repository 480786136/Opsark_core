//! Durable, task/round-wide token reservations. Never dispatches or retries I/O.
//! Unknown results retain their complete conservative reservation across restart.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const VERSION: u32 = 1;
const MAX_TOKENS: u64 = 32_000_000;
const SAFETY_TOKENS: u64 = 8192;
const SAFETY_ATTEMPTS: u64 = 2;
const MAX_TASK_ATTEMPTS: u64 = 10_000;
const ESTIMATOR: &str = "complete-wire-utf8-bytes-plus-output-cap-plus-1024";
static ROOT: OnceLock<PathBuf> = OnceLock::new();

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn error(code: &str, message: &str, snapshot: Option<Value>) -> String {
    let mut detail = json!({"code":code,"message":message,"origin":"core","stage":"task_budget","retryable":false});
    if let Some(snapshot) = snapshot {
        detail["taskBudget"] = snapshot;
    }
    format!(
        "{}{}",
        crate::MODEL_TRACE_ERROR_PREFIX,
        json!({"message":message,"modelError":detail})
    )
}
fn invalid(message: &str) -> String {
    error("MODEL_TASK_BUDGET_INVALID", message, None)
}
fn storage(_: impl std::fmt::Display) -> String {
    error(
        "MODEL_TASK_BUDGET_STORAGE",
        "任务预算持久化失败，已停止模型请求",
        None,
    )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskBudgetRegistration {
    pub task_id: String,
    pub round_id: String,
    pub max_task_tokens: u64,
    pub max_round_tokens: u64,
    /// Optional, explicitly pre-registered allowance INSIDE both total caps.
    /// Ordinary context cannot select this lane; only a separate native method can.
    #[serde(default)]
    pub safety_reserve_tokens: u64,
}

#[derive(Clone, Debug)]
struct Ledger {
    path: Arc<PathBuf>,
}

pub(crate) fn initialize(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(storage)?;
    let path = root.join("task-model-budget.sqlite3");
    Ledger::open(path.clone())?;
    match ROOT.set(path.clone()) {
        Ok(()) => Ok(()),
        Err(_) if ROOT.get() == Some(&path) => Ok(()),
        Err(_) => Err(invalid("任务预算存储位置不能在运行中更换")),
    }
}

/// Integration tests share one process-local persistent store. Each caller must
/// register its own unique task/round IDs; production initialization is unchanged.
#[cfg(test)]
pub(crate) fn initialize_test_runtime() -> Result<(), String> {
    static TEST_ROOT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    let root = TEST_ROOT.get_or_init(|| {
        let root = std::env::temp_dir().join(format!(
            "opsark-task-budget-runtime-{}-{}",
            std::process::id(),
            crate::task_logs::call_id()
        ));
        std::fs::create_dir(&root).map_err(storage)?;
        Ok(root)
    });
    initialize(root.as_ref().map_err(Clone::clone)?)
}
fn global_ledger() -> Result<Ledger, String> {
    ROOT.get()
        .map(|path| Ledger {
            path: Arc::new(path.clone()),
        })
        .ok_or_else(|| {
            error(
                "MODEL_TASK_BUDGET_UNINITIALIZED",
                "任务预算存储尚未初始化",
                None,
            )
        })
}
pub(crate) fn register(registration: TaskBudgetRegistration) -> Result<Value, String> {
    global_ledger()?.register(&registration)
}
pub(crate) fn query(task_id: &str, round_id: &str) -> Result<Value, String> {
    if !valid_id(task_id) || !valid_id(round_id) {
        return Err(invalid("任务或轮次预算身份无效"));
    }
    global_ledger()?.budget(task_id, round_id)?.snapshot()
}

fn identity_from_context(context: &Value) -> Result<Option<(String, String)>, String> {
    let control = context.get("_taskModelBudget");
    // These are explicit Core metadata positions; never search user/tool text.
    let metadata: Vec<&Value> = ["", "/_log", "/baseSnapshot/_log", "/task/_log"]
        .iter()
        .filter_map(|pointer| context.pointer(pointer))
        .collect();
    if metadata.iter().any(|meta| {
        meta.get("taskId")
            .is_some_and(|value| value.as_str().is_none_or(|id| !valid_id(id)))
            || meta
                .get("roundId")
                .is_some_and(|value| value.as_str().is_none_or(|id| !valid_id(id)))
    }) {
        return Err(invalid(
            "显式任务或轮次元数据格式无效，不能当作无任务模型探测",
        ));
    }
    let identities: Vec<(&str, Option<&str>)> = metadata
        .into_iter()
        .filter_map(|meta| {
            meta.get("taskId")
                .and_then(Value::as_str)
                .map(|task| (task, meta.get("roundId").and_then(Value::as_str)))
        })
        .collect();
    let Some(control) = control else {
        return if identities.is_empty() {
            Ok(None)
        } else {
            Err(invalid("任务模型请求缺少持久任务预算身份"))
        };
    };
    let object = control
        .as_object()
        .ok_or_else(|| invalid("任务预算身份必须是对象"))?;
    if control["version"].as_u64() != Some(VERSION as u64)
        || object
            .keys()
            .any(|key| !matches!(key.as_str(), "version" | "taskId" | "roundId"))
    {
        return Err(invalid(
            "任务预算身份版本或字段无效，不能在模型上下文中改变额度或选择安全通道",
        ));
    }
    let task = control["taskId"]
        .as_str()
        .filter(|value| valid_id(value))
        .ok_or_else(|| invalid("缺少有效任务预算身份"))?;
    let round = control["roundId"]
        .as_str()
        .filter(|value| valid_id(value))
        .ok_or_else(|| invalid("缺少有效轮次预算身份"))?;
    if identities.iter().any(|(known_task, known_round)| {
        *known_task != task || known_round.is_some_and(|value| value != round)
    }) {
        return Err(invalid("任务预算身份与原请求任务或轮次不一致"));
    }
    Ok(Some((task.to_owned(), round.to_owned())))
}

/// Conservative estimator, NOT a tokenizer or evidence of actual billable usage.
/// `wire` must be the final body after protocol/schema/prompt transformations.
#[derive(Clone, Copy)]
struct WireReservation {
    request_bytes: u64,
    output_token_limit: u64,
    required_reserved_tokens: u64,
}

fn wire_reservation(wire: &Value) -> Result<WireReservation, String> {
    if !wire.is_object() {
        return Err(invalid("完整模型请求必须是对象"));
    }
    let outputs: Vec<u64> = ["max_output_tokens", "max_completion_tokens", "max_tokens"]
        .iter()
        .filter_map(|key| wire.get(key))
        .map(|value| {
            value
                .as_u64()
                .filter(|v| *v > 0)
                .ok_or_else(|| invalid("模型请求输出上限必须是正整数"))
        })
        .collect::<Result<_, _>>()?;
    let output = outputs
        .into_iter()
        .max()
        .ok_or_else(|| invalid("完整模型请求缺少明确输出上限"))?;
    let request_bytes = wire.to_string().len() as u64;
    let required_reserved_tokens = request_bytes
        .checked_add(output)
        .and_then(|v| v.checked_add(1024))
        .filter(|v| *v <= i64::MAX as u64)
        .ok_or_else(|| invalid("模型请求估计额度溢出"))?;
    Ok(WireReservation { request_bytes, output_token_limit: output, required_reserved_tokens })
}

#[cfg(test)]
fn estimate_wire(wire: &Value) -> Result<u64, String> {
    wire_reservation(wire).map(|estimate| estimate.required_reserved_tokens)
}

/// Safe admission diagnostics for the exact body checked inside the immediate
/// transaction. Counts and identifiers only: never copy prompts or credentials.
fn admission_diagnostic(
    before: &Value,
    estimate: WireReservation,
    request_id: &str,
    attempt_id: &str,
    operation_id: &str,
    wire_digest: &str,
    lane: &str,
) -> Value {
    let scopes: serde_json::Map<String, Value> = ["task", "round"].into_iter().map(|key| {
        let scope = &before[key];
        let amount = scope["accountedTokens"].as_u64().unwrap();
        let cap = scope["maxTotalTokens"].as_u64().unwrap();
        let lane_amount = scope[if lane == "safety" { "safetyAccountedTokens" } else { "businessAccountedTokens" }].as_u64().unwrap();
        let lane_cap = scope[if lane == "safety" { "safetyTokenLimit" } else { "businessTokenLimit" }].as_u64().unwrap();
        let available_total = cap.saturating_sub(amount);
        let available_lane = lane_cap.saturating_sub(lane_amount);
        let available = available_total.min(available_lane);
        let mut reasons = vec![];
        if amount.saturating_add(estimate.required_reserved_tokens) > cap { reasons.push("total_tokens"); }
        if lane_amount.saturating_add(estimate.required_reserved_tokens) > lane_cap { reasons.push("lane_tokens"); }
        if scope["transportAttempts"].as_u64().unwrap() >= MAX_TASK_ATTEMPTS { reasons.push("transport_attempts"); }
        if lane == "safety" && scope["safetyAttempts"].as_u64().unwrap() >= SAFETY_ATTEMPTS { reasons.push("safety_attempts"); }
        (key.to_owned(), json!({
            "maxTotalTokens":cap,"accountedTokens":amount,"knownUsageTokens":scope["knownUsageTokens"],
            "unknownReservedTokens":scope["estimatedReservedTokens"],"unknownUsageAttempts":scope["unknownUsageAttempts"],
            "usageEvidenceConflicts":scope["usageEvidenceConflicts"],"conservativeConflictTokens":scope["conservativeConflictTokens"],
            "laneTokenLimit":lane_cap,"laneAccountedTokens":lane_amount,
            "availableTotalTokens":available_total,"availableLaneTokens":available_lane,"availableTokens":available,
            "reservationShortfallTokens":estimate.required_reserved_tokens.saturating_sub(available),
            "transportAttempts":scope["transportAttempts"],"maxTransportAttempts":MAX_TASK_ATTEMPTS,
            "safetyAttempts":scope["safetyAttempts"],"maxSafetyAttempts":SAFETY_ATTEMPTS,"blockedReasons":reasons
        }))
    }).collect();
    json!({"version":1,"requestId":request_id,"attemptId":attempt_id,"modelOperationId":operation_id,"wireDigest":wire_digest,
        "lane":lane,"dispatchCertainty":"not_dispatched","usageEstimator":ESTIMATOR,"inputEstimateIsExact":false,
        "requestBytes":estimate.request_bytes,"outputTokenLimit":estimate.output_token_limit,
        "estimationOverheadTokens":1024,"requiredReservedTokens":estimate.required_reserved_tokens,"scopes":scopes})
}

fn admission_error(code: &str, message: &str, snapshot: &Value, diagnostic: &Value) -> String {
    let mut payload: Value = serde_json::from_str(error(code, message, Some(snapshot.clone()))
        .strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap()).unwrap();
    payload["modelError"]["dispatchCertainty"] = json!("not_dispatched");
    payload["modelError"]["requestKey"] = diagnostic["requestId"].clone();
    payload["modelError"]["taskBudgetAdmission"] = diagnostic.clone();
    format!("{}{payload}", crate::MODEL_TRACE_ERROR_PREFIX)
}

impl Ledger {
    fn open(path: PathBuf) -> Result<Self, String> {
        let ledger = Self {
            path: Arc::new(path),
        };
        let connection = ledger.connect()?;
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(storage)?;
        if version > VERSION {
            return Err(invalid("任务预算数据库版本较新，不能覆盖或重置"));
        }
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS model_task_budgets (
                task_id TEXT PRIMARY KEY, token_limit INTEGER NOT NULL, safety_limit INTEGER NOT NULL, created_ms INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS model_round_budgets (
                task_id TEXT NOT NULL, round_id TEXT NOT NULL, token_limit INTEGER NOT NULL, safety_limit INTEGER NOT NULL,
                created_ms INTEGER NOT NULL, PRIMARY KEY(task_id,round_id), FOREIGN KEY(task_id) REFERENCES model_task_budgets(task_id));
            CREATE TABLE IF NOT EXISTS model_budget_attempts (
                attempt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, task_id TEXT NOT NULL, round_id TEXT NOT NULL,
                operation_id TEXT NOT NULL, wire_digest TEXT NOT NULL, lane TEXT NOT NULL,
                reserved_tokens INTEGER NOT NULL, charged_tokens INTEGER NOT NULL, actual_tokens INTEGER,
                state TEXT NOT NULL, usage_source TEXT NOT NULL, evidence_conflict INTEGER NOT NULL DEFAULT 0,
                created_ms INTEGER NOT NULL, settled_ms INTEGER,
                FOREIGN KEY(task_id,round_id) REFERENCES model_round_budgets(task_id,round_id));
            CREATE INDEX IF NOT EXISTS model_budget_task ON model_budget_attempts(task_id,round_id);
            CREATE INDEX IF NOT EXISTS model_budget_request ON model_budget_attempts(request_id);
            CREATE INDEX IF NOT EXISTS model_budget_operation ON model_budget_attempts(operation_id);
            PRAGMA user_version=1;").map_err(storage)?;
        Ok(ledger)
    }
    fn connect(&self) -> Result<Connection, String> {
        let connection = Connection::open(self.path.as_ref()).map_err(storage)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(storage)?;
        connection
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")
            .map_err(storage)?;
        Ok(connection)
    }
    fn register(&self, registration: &TaskBudgetRegistration) -> Result<Value, String> {
        let r = registration;
        if !valid_id(&r.task_id)
            || !valid_id(&r.round_id)
            || r.max_task_tokens == 0
            || r.max_task_tokens > MAX_TOKENS
            || r.max_round_tokens == 0
            || r.max_round_tokens > r.max_task_tokens
            || !matches!(r.safety_reserve_tokens, 0 | SAFETY_TOKENS)
            || r.safety_reserve_tokens >= r.max_round_tokens
        {
            return Err(invalid(
                "任务或轮次预登记额度无效；安全预留必须包含在原总额中",
            ));
        }
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let task: Option<(u64, u64)> = tx
            .query_row(
                "SELECT token_limit,safety_limit FROM model_task_budgets WHERE task_id=?1",
                [&r.task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage)?;
        if task.is_some_and(|limits| limits != (r.max_task_tokens, r.safety_reserve_tokens)) {
            return Err(error(
                "MODEL_TASK_BUDGET_POLICY_CHANGED",
                "任务已登记额度不能由后续操作静默更改",
                snapshot(&tx, &r.task_id, &r.round_id).ok(),
            ));
        }
        let round: Option<(u64,u64)> = tx.query_row("SELECT token_limit,safety_limit FROM model_round_budgets WHERE task_id=?1 AND round_id=?2",
            params![r.task_id,r.round_id], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(storage)?;
        if round.is_some_and(|limits| limits != (r.max_round_tokens, r.safety_reserve_tokens)) {
            return Err(error(
                "MODEL_TASK_BUDGET_POLICY_CHANGED",
                "轮次已登记额度不能由后续操作静默更改",
                Some(snapshot(&tx, &r.task_id, &r.round_id)?),
            ));
        }
        tx.execute(
            "INSERT OR IGNORE INTO model_task_budgets VALUES (?1,?2,?3,?4)",
            params![
                r.task_id,
                r.max_task_tokens,
                r.safety_reserve_tokens,
                now_ms()
            ],
        )
        .map_err(storage)?;
        tx.execute(
            "INSERT OR IGNORE INTO model_round_budgets VALUES (?1,?2,?3,?4,?5)",
            params![
                r.task_id,
                r.round_id,
                r.max_round_tokens,
                r.safety_reserve_tokens,
                now_ms()
            ],
        )
        .map_err(storage)?;
        let result = snapshot(&tx, &r.task_id, &r.round_id)?;
        tx.commit().map_err(storage)?;
        Ok(result)
    }
    fn budget(&self, task: &str, round: &str) -> Result<TaskBudget, String> {
        snapshot(&self.connect()?, task, round)?;
        Ok(TaskBudget {
            ledger: self.clone(),
            task: task.to_owned(),
            round: round.to_owned(),
        })
    }
}

#[derive(Default)]
struct Totals {
    charged: u64,
    business: u64,
    safety: u64,
    actual: u64,
    reserved: u64,
    unknown: u64,
    attempts: u64,
    safety_attempts: u64,
    not_dispatched: u64,
    overruns: u64,
    conflicts: u64,
    conflict_reserved: u64,
}
impl Totals {
    fn add(
        &mut self,
        lane: &str,
        reserved: u64,
        charged: u64,
        actual: Option<u64>,
        state: &str,
        conflict: bool,
    ) -> Result<(), String> {
        self.charged = self
            .charged
            .checked_add(charged)
            .ok_or_else(|| invalid("预算累计数值溢出"))?;
        self.actual = self
            .actual
            .checked_add(actual.unwrap_or(0))
            .ok_or_else(|| invalid("实际用量累计溢出"))?;
        self.attempts += 1;
        if lane == "safety" {
            self.safety += charged;
            self.safety_attempts += 1;
        } else {
            self.business += charged;
        }
        if state == "reserved" {
            self.reserved += reserved;
            self.unknown += 1;
        }
        if state == "not_dispatched" {
            self.not_dispatched += 1;
        }
        self.overruns += actual.unwrap_or(0).saturating_sub(reserved);
        if conflict {
            self.conflicts += 1;
            self.conflict_reserved += charged.saturating_sub(actual.unwrap_or(0));
        }
        Ok(())
    }
    fn json(&self, limit: u64, safety_limit: u64) -> Value {
        json!({"maxTotalTokens":limit,"businessTokenLimit":limit-safety_limit,"safetyTokenLimit":safety_limit,
            "accountedTokens":self.charged,"knownUsageTokens":self.actual,"estimatedReservedTokens":self.reserved,
            "businessAccountedTokens":self.business,"safetyAccountedTokens":self.safety,
            "transportAttempts":self.attempts,"unknownUsageAttempts":self.unknown,"notDispatchedAttempts":self.not_dispatched,
            "safetyAttempts":self.safety_attempts,"maxSafetyAttempts":SAFETY_ATTEMPTS,"maxTransportAttempts":MAX_TASK_ATTEMPTS,
            "actualOverEstimateTokens":self.overruns,"overBudgetTokens":self.charged.saturating_sub(limit),
            "usageEvidenceConflicts":self.conflicts,"conservativeConflictTokens":self.conflict_reserved,"exactTokens":self.unknown==0 && self.conflicts==0,
            "usageEstimator":ESTIMATOR,"inputEstimateIsExact":false})
    }
}

fn snapshot(connection: &Connection, task: &str, round: &str) -> Result<Value, String> {
    let task_limits: Option<(u64, u64)> = connection
        .query_row(
            "SELECT token_limit,safety_limit FROM model_task_budgets WHERE task_id=?1",
            [task],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(storage)?;
    let round_limits: Option<(u64,u64)> = connection.query_row("SELECT token_limit,safety_limit FROM model_round_budgets WHERE task_id=?1 AND round_id=?2",
        params![task,round], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(storage)?;
    let (Some(task_limits), Some(round_limits)) = (task_limits, round_limits) else {
        return Err(error(
            "MODEL_TASK_BUDGET_UNREGISTERED",
            "任务和当前轮次尚未预登记预算，不能派发模型请求",
            None,
        ));
    };
    let mut task_totals = Totals::default();
    let mut round_totals = Totals::default();
    let mut statement = connection.prepare("SELECT round_id,lane,reserved_tokens,charged_tokens,actual_tokens,state,evidence_conflict FROM model_budget_attempts WHERE task_id=?1").map_err(storage)?;
    let records = statement
        .query_map([task], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, u64>(2)?,
                r.get::<_, u64>(3)?,
                r.get::<_, Option<u64>>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, bool>(6)?,
            ))
        })
        .map_err(storage)?;
    for record in records {
        let (record_round, lane, reserved, charged, actual, state, conflict) =
            record.map_err(storage)?;
        task_totals.add(&lane, reserved, charged, actual, &state, conflict)?;
        if record_round == round {
            round_totals.add(&lane, reserved, charged, actual, &state, conflict)?;
        }
    }
    Ok(
        json!({"version":VERSION,"taskId":task,"roundId":round,"persistent":true,
        "task":task_totals.json(task_limits.0,task_limits.1),"round":round_totals.json(round_limits.0,round_limits.1)}),
    )
}

#[derive(Clone, Debug)]
pub(crate) struct TaskBudget {
    ledger: Ledger,
    task: String,
    round: String,
}
#[derive(Debug)]
pub(crate) struct TaskAttemptBudget {
    ledger: Ledger,
    request_id: String,
    attempt_id: String,
}

impl TaskBudget {
    pub(crate) fn for_context(context: &Value) -> Result<Option<Self>, String> {
        let Some((task, round)) = identity_from_context(context)? else {
            return Ok(None);
        };
        global_ledger()?.budget(&task, &round).map(Some)
    }
    pub(crate) fn snapshot(&self) -> Result<Value, String> {
        let mut connection = self.ledger.connect()?;
        let tx = connection.transaction().map_err(storage)?;
        snapshot(&tx, &self.task, &self.round)
    }
    /// Narrow an automatic Core output ceiling before request identity exists.
    /// This is only a consistent observation; reserve() must still atomically
    /// recheck both scopes. Unknown usage and safety allowances stay charged.
    pub(crate) fn fit_output_cap(&self, wire: &mut Value, minimum: u64) -> Result<Option<Value>, String> {
        let output_fields: Vec<_> = ["max_output_tokens", "max_completion_tokens", "max_tokens"].into_iter()
            .filter(|field| wire.get(*field).is_some()).collect();
        if output_fields.len() != 1 || minimum == 0 { return Ok(None); }
        let field = output_fields[0];
        let original = wire_reservation(wire)?;
        if minimum >= original.output_token_limit { return Ok(None); }
        let before = self.snapshot()?;
        let mut available = u64::MAX;
        let mut available_scopes = json!({});
        for key in ["task", "round"] {
            let scope = &before[key];
            if scope["usageEvidenceConflicts"].as_u64().unwrap() > 0
                || scope["transportAttempts"].as_u64().unwrap() >= MAX_TASK_ATTEMPTS {
                return Ok(None);
            }
            let total_available = scope["maxTotalTokens"].as_u64().unwrap()
                .saturating_sub(scope["accountedTokens"].as_u64().unwrap());
            let business_available = scope["businessTokenLimit"].as_u64().unwrap()
                .saturating_sub(scope["businessAccountedTokens"].as_u64().unwrap());
            let scope_available = total_available.min(business_available);
            available = available.min(scope_available);
            available_scopes[key] = json!({"availableTotalTokens":total_available,
                "availableBusinessTokens":business_available,"availableTokens":scope_available,
                "accountedTokens":scope["accountedTokens"],"knownUsageTokens":scope["knownUsageTokens"],
                "unknownReservedTokens":scope["estimatedReservedTokens"],"unknownUsageAttempts":scope["unknownUsageAttempts"]});
        }
        if original.required_reserved_tokens <= available { return Ok(None); }
        let mut candidate = wire.clone();
        candidate[field] = json!(minimum);
        if wire_reservation(&candidate)?.required_reserved_tokens > available { return Ok(None); }
        let (mut low, mut high) = (minimum, original.output_token_limit - 1);
        while low < high {
            let middle = low + (high - low).div_ceil(2);
            candidate[field] = json!(middle);
            if wire_reservation(&candidate)?.required_reserved_tokens <= available { low = middle; }
            else { high = middle - 1; }
        }
        candidate[field] = json!(low);
        let effective = wire_reservation(&candidate)?;
        *wire = candidate;
        Ok(Some(json!({"version":1,"reason":"automatic_output_cap_fitted_to_persistent_budget",
            "method":"complete_wire_byte_reservation_bounded_search","usageEstimator":ESTIMATOR,
            "inputEstimateIsExact":false,"actualBillingLimitGuaranteed":false,
            "originalOutputTokenLimit":original.output_token_limit,"effectiveOutputTokenLimit":low,
            "minimumOutputTokenLimit":minimum,"providerMinimumDeclared":false,
            "originalRequiredReservedTokens":original.required_reserved_tokens,
            "effectiveRequiredReservedTokens":effective.required_reserved_tokens,
            "requestBytes":effective.request_bytes,"estimationOverheadTokens":1024,
            "availableTokens":available,"scopes":available_scopes})))
    }
    #[cfg(test)]
    pub(crate) fn test_attempt_records(&self, request_id: &str) -> Result<Vec<Value>, String> {
        let connection=self.ledger.connect()?;
        let mut statement=connection.prepare("SELECT attempt_id,request_id,operation_id,wire_digest,reserved_tokens,charged_tokens,actual_tokens,state FROM model_budget_attempts WHERE task_id=?1 AND round_id=?2 AND request_id=?3").map_err(storage)?;
        let records=statement.query_map(params![self.task,self.round,request_id],|row|Ok(json!({
            "attemptId":row.get::<_,String>(0)?,"requestId":row.get::<_,String>(1)?,
            "operationId":row.get::<_,String>(2)?,"wireDigest":row.get::<_,String>(3)?,
            "reservedTokens":row.get::<_,u64>(4)?,"chargedTokens":row.get::<_,u64>(5)?,
            "actualTokens":row.get::<_,Option<u64>>(6)?,"state":row.get::<_,String>(7)?
        }))).map_err(storage)?;
        records.map(|record|record.map_err(storage)).collect()
    }
    pub(crate) fn reserve(
        &self,
        request_id: &str,
        attempt_id: &str,
        operation_id: &str,
        wire: &Value,
    ) -> Result<TaskAttemptBudget, String> {
        self.reserve_lane(request_id, attempt_id, operation_id, wire, "business")
    }
    /// Not selectable by JSON context. Caller must be a native safety-finalizer,
    /// not ordinary planning/recovery. No automatic replenishment or borrowing.
    pub(crate) fn reserve_safety(
        &self,
        request_id: &str,
        attempt_id: &str,
        operation_id: &str,
        wire: &Value,
    ) -> Result<TaskAttemptBudget, String> {
        self.reserve_lane(request_id, attempt_id, operation_id, wire, "safety")
    }
    fn reserve_lane(
        &self,
        request_id: &str,
        attempt_id: &str,
        operation_id: &str,
        wire: &Value,
        lane: &str,
    ) -> Result<TaskAttemptBudget, String> {
        if ![request_id, attempt_id, operation_id]
            .into_iter()
            .all(valid_id)
        {
            return Err(invalid("模型请求、尝试或操作身份无效"));
        }
        let estimate = wire_reservation(wire)?;
        let reservation = estimate.required_reserved_tokens;
        let digest = format!("{:x}", Sha256::digest(wire.to_string().as_bytes()));
        let mut connection = self.ledger.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let before = snapshot(&tx, &self.task, &self.round)?;
        let admission = admission_diagnostic(&before, estimate, request_id, attempt_id, operation_id, &digest, lane);
        let existing: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM model_budget_attempts WHERE attempt_id=?1)",
                [attempt_id],
                |r| r.get(0),
            )
            .map_err(storage)?;
        if existing {
            return Err(admission_error(
                "MODEL_TASK_BUDGET_DUPLICATE_ATTEMPT",
                "已登记尝试不能再次预留或派发；迟到结算必须恢复原记录",
                &before,
                &admission,
            ));
        }
        let changed_operation: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM model_budget_attempts WHERE operation_id=?1 AND (task_id<>?2 OR round_id<>?3))",
            params![operation_id,self.task,self.round],|r|r.get(0)).map_err(storage)?;
        if changed_operation {
            return Err(invalid("同一模型操作不能切换任务或轮次预算"));
        }
        let previous: Option<(String,String,String,String,String)> = tx.query_row("SELECT task_id,round_id,operation_id,wire_digest,lane FROM model_budget_attempts WHERE request_id=?1 LIMIT 1",
            [request_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(storage)?;
        if previous.is_some_and(|identity| {
            identity
                != (
                    self.task.clone(),
                    self.round.clone(),
                    operation_id.to_owned(),
                    digest.clone(),
                    lane.to_owned(),
                )
        }) {
            return Err(invalid(
                "同一模型请求的任务、轮次、操作、请求内容或预算通道发生变化",
            ));
        }
        let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM model_budget_attempts WHERE request_id=?1 AND state<>'not_dispatched')",
            [request_id],|r|r.get(0)).map_err(storage)?;
        if pending {
            return Err(admission_error(
                "MODEL_TASK_BUDGET_REQUEST_ALREADY_RESERVED",
                "原模型请求已派发或结果未知，不能再次预留派发",
                &before,
                &admission,
            ));
        }
        for key in ["task", "round"] {
            let scope = &before[key];
            if scope["usageEvidenceConflicts"].as_u64().unwrap() > 0 {
                return Err(admission_error(
                    "MODEL_TASK_BUDGET_EVIDENCE_CONFLICT",
                    "原用量证据冲突，已停止新请求；不能静默采用较小用量",
                    &before,
                    &admission,
                ));
            }
            let amount = scope["accountedTokens"].as_u64().unwrap();
            let cap = scope["maxTotalTokens"].as_u64().unwrap();
            let lane_amount = scope[if lane == "safety" {
                "safetyAccountedTokens"
            } else {
                "businessAccountedTokens"
            }]
            .as_u64()
            .unwrap();
            let lane_cap = scope[if lane == "safety" {
                "safetyTokenLimit"
            } else {
                "businessTokenLimit"
            }]
            .as_u64()
            .unwrap();
            if amount.saturating_add(reservation) > cap
                || lane_amount.saturating_add(reservation) > lane_cap
                || scope["transportAttempts"].as_u64().unwrap() >= MAX_TASK_ATTEMPTS
                || lane == "safety" && scope["safetyAttempts"].as_u64().unwrap() >= SAFETY_ATTEMPTS
            {
                return Err(admission_error(
                    "MODEL_TASK_BUDGET_EXHAUSTED",
                    "全任务或本轮预算不足，已在新模型请求派发前停止",
                    &before,
                    &admission,
                ));
            }
        }
        tx.execute("INSERT INTO model_budget_attempts (attempt_id,request_id,task_id,round_id,operation_id,wire_digest,lane,reserved_tokens,charged_tokens,state,usage_source,created_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8,'reserved','conservative_reservation',?9)",
            params![attempt_id,request_id,self.task,self.round,operation_id,digest,lane,reservation,now_ms()]).map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(TaskAttemptBudget {
            ledger: self.ledger.clone(),
            request_id: request_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
        })
    }
}

fn actual_usage(payload: &Value) -> Option<u64> {
    let usage = payload.get("usage")?;
    let input = usage
        .get("input_tokens")
        .or_else(|| usage.get("prompt_tokens"))?
        .as_u64()?;
    let output = usage
        .get("output_tokens")
        .or_else(|| usage.get("completion_tokens"))?
        .as_u64()?;
    let total = input.checked_add(output)?;
    if total > i64::MAX as u64
        || usage
            .get("total_tokens")
            .is_some_and(|value| value.as_u64() != Some(total))
    {
        return None;
    }
    Some(total) // cached/reasoning details are subsets, never added again.
}
impl TaskAttemptBudget {
    pub(crate) fn reopen(request_id: &str, attempt_id: &str) -> Result<Self, String> {
        Self::reopen_in(global_ledger()?, request_id, attempt_id)
    }
    fn reopen_in(ledger: Ledger, request_id: &str, attempt_id: &str) -> Result<Self, String> {
        let exists: bool = ledger.connect()?.query_row("SELECT EXISTS(SELECT 1 FROM model_budget_attempts WHERE request_id=?1 AND attempt_id=?2)",
            params![request_id,attempt_id],|r|r.get(0)).map_err(storage)?;
        if !exists {
            return Err(invalid("原模型尝试预算记录不存在，不能在新轮次补建"));
        }
        Ok(Self {
            ledger,
            request_id: request_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
        })
    }
    pub(crate) fn snapshot(&self) -> Result<Value, String> {
        self.finish(None, "unknown")
    }
    pub(crate) fn settle(&mut self, payload: &Value) -> Result<Value, String> {
        self.finish(actual_usage(payload), "provider_usage")
    }
    pub(crate) fn settle_total(&mut self, total: u64) -> Result<Value, String> {
        if total > i64::MAX as u64 {
            return Err(invalid("实际模型用量数值超出持久化范围"));
        }
        self.finish(Some(total), "authenticated_gateway_usage")
    }
    pub(crate) fn not_dispatched(&mut self) -> Result<Value, String> {
        self.finish(Some(0), "not_dispatched")
    }
    fn finish(&self, actual: Option<u64>, source: &str) -> Result<Value, String> {
        let mut connection = self.ledger.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let current: Option<(String,String,String,Option<u64>,u64)> = tx.query_row("SELECT task_id,round_id,state,actual_tokens,charged_tokens FROM model_budget_attempts WHERE request_id=?1 AND attempt_id=?2",
            params![self.request_id,self.attempt_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(storage)?;
        let Some((task, round, state, known, charged)) = current else {
            return Err(invalid("原模型尝试预算记录不存在"));
        };
        if let Some(actual) = actual {
            // Zero-dispatch evidence cannot erase already observed real usage.
            if state == "actual" && source == "not_dispatched" {
                return snapshot(&tx, &task, &round);
            }
            let conflict = state == "actual" && known != Some(actual)
                || state == "not_dispatched" && source != "not_dispatched";
            if conflict && state == "actual" {
                // Preserve the higher claim conservatively, and make the
                // evidence conflict visible instead of inventing exact usage.
                tx.execute("UPDATE model_budget_attempts SET charged_tokens=?1,evidence_conflict=1,settled_ms=?2 WHERE attempt_id=?3",
                    params![charged.max(actual),now_ms(),self.attempt_id]).map_err(storage)?;
            } else if state != "actual" {
                tx.execute("UPDATE model_budget_attempts SET charged_tokens=?1,actual_tokens=?2,state=?3,usage_source=?4,evidence_conflict=?5,settled_ms=?6 WHERE attempt_id=?7",
                    params![actual,if source=="not_dispatched" { None } else { Some(actual) },
                        if source=="not_dispatched" { "not_dispatched" } else { "actual" },source,conflict,now_ms(),self.attempt_id]).map_err(storage)?;
            }
        }
        let result = snapshot(&tx, &task, &round)?;
        tx.commit().map_err(storage)?;
        Ok(result)
    }
}

#[cfg(test)]
#[path = "task_model_budget_tests.rs"]
mod tests;
