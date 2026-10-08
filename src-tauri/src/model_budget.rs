//! Process-local recovery budgets shared across protocol and business repair calls.
//! Unknown usage retains a conservative reservation; no pricing assumptions are made.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_GENERATIONS: u64 = 6;
const DEFAULT_TRANSPORTS: u64 = 12;
const MAX_ELAPSED_MS: u64 = 900_000;
const MAX_TOTAL_TOKENS: u64 = 32_000_000;
const DEFAULT_TOTAL_TOKENS: u64 = 1_000_000;
const ADMISSION_WINDOW_MS: u64 = MAX_ELAPSED_MS;
const MAX_OPERATIONS: usize = 2048;
static RUNTIME_STARTED_MS: OnceLock<u64> = OnceLock::new();

pub(crate) fn initialize_runtime() {
    RUNTIME_STARTED_MS.get_or_init(now_ms);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

/// Called once at a business entry point, before that entry point's local loops.
pub(crate) fn ensure_context(raw: &str) -> Result<String, String> {
    let mut context: Value = serde_json::from_str(raw).map_err(|_| {
        budget_error(
            "MODEL_RECOVERY_BUDGET_INVALID",
            "模型操作上下文不是合法 JSON",
            None,
        )
    })?;
    let object = context.as_object_mut().ok_or_else(|| {
        budget_error(
            "MODEL_RECOVERY_BUDGET_INVALID",
            "模型操作上下文必须是对象",
            None,
        )
    })?;
    object.entry("_modelRecovery").or_insert_with(|| {
        json!({
            "operationId":crate::task_logs::call_id(), "startedAtMs":now_ms()
        })
    });
    Ok(context.to_string())
}

#[derive(Clone, Debug, PartialEq)]
struct Limits {
    generations: u64,
    transports: u64,
    elapsed_ms: u64,
    tokens: u64,
}

struct State {
    id: String,
    identity: String,
    policy: Value,
    started_at_ms: u64,
    started: Instant,
    limits: Limits,
    generations: u64,
    attempts: u64,
    tokens: u64,
    known_tokens: u64,
    unknown_attempts: u64,
    blocked: bool,
    output_field_repairs: u64,
    output_regenerations: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OutputRecoveryStrategy {
    Initial,
    FieldRepair,
    Regenerate,
}

/// This control is Core-owned request metadata, never read from model output.
pub(crate) fn output_strategy(context: &Value) -> Result<Option<OutputRecoveryStrategy>, String> {
    let Some(control) = context.get("_modelOutputRecovery") else { return Ok(None); };
    let strategy = match control.get("strategy").and_then(Value::as_str) {
        Some("initial") => OutputRecoveryStrategy::Initial,
        Some("field_repair") => OutputRecoveryStrategy::FieldRepair,
        Some("regenerate") => OutputRecoveryStrategy::Regenerate,
        _ => return Err(budget_error("MODEL_RECOVERY_BUDGET_INVALID", "输出恢复策略无效", None)),
    };
    if context.get("_modelRecovery").is_none() {
        return Err(budget_error("MODEL_RECOVERY_BUDGET_INVALID", "输出恢复必须沿用原模型操作预算", None));
    }
    Ok(Some(strategy))
}

fn registry() -> &'static Mutex<HashMap<String, Arc<Mutex<State>>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<Mutex<State>>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone)]
pub(crate) struct OperationBudget(Arc<Mutex<State>>);

pub(crate) struct GenerationBudget {
    pub(crate) request_id: String,
    operation: OperationBudget,
    reservation: u64,
}

pub(crate) struct AttemptBudget {
    operation: OperationBudget,
    reservation: u64,
    settled: bool,
}

fn snapshot(state: &State) -> Value {
    json!({"modelOperationId":state.id,
        "maxGenerations":state.limits.generations,"generations":state.generations,
        "maxTransportAttempts":state.limits.transports,"transportAttempts":state.attempts,
        "maxElapsedMs":state.limits.elapsed_ms,"elapsedMs":state.started.elapsed().as_millis() as u64,
        "maxTotalTokens":state.limits.tokens,"accountedTokens":state.tokens,
        "knownUsageTokens":state.known_tokens,"unknownUsageAttempts":state.unknown_attempts,
        "maxFieldRepairs":1,"fieldRepairs":state.output_field_repairs,
        "maxCandidateRegenerations":1,"candidateRegenerations":state.output_regenerations,
        "usageEstimator":"utf8-request-bytes-plus-output-plus-1024", "exactTokens":state.unknown_attempts == 0,
        "recoveryBlocked":state.blocked})
}

fn budget_error(code: &str, message: &str, state: Option<&State>) -> String {
    let mut error = json!({"code":code,"message":message,"origin":"core",
        "stage":"recovery_budget","retryable":false});
    if let Some(state) = state {
        error["modelOperationId"] = json!(state.id);
        error["recoveryBudget"] = snapshot(state);
    }
    format!(
        "{}{}",
        crate::MODEL_TRACE_ERROR_PREFIX,
        json!({"message":message,"modelError":error})
    )
}

fn limit(policy: &Value, name: &str, default: u64, ceiling: u64) -> Result<u64, String> {
    match policy.get(name) {
        None => Ok(default.min(ceiling)),
        Some(value) => value
            .as_u64()
            .filter(|value| *value > 0 && *value <= ceiling)
            .ok_or_else(|| {
                budget_error(
                    "MODEL_RECOVERY_BUDGET_INVALID",
                    "恢复预算必须是允许范围内的正整数",
                    None,
                )
            }),
    }
}

fn estimate(body: &Value) -> Result<u64, String> {
    let output = body
        .get("max_output_tokens")
        .or_else(|| body.get("max_completion_tokens"))
        .or_else(|| body.get("max_tokens"))
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            budget_error(
                "MODEL_RECOVERY_BUDGET_INVALID",
                "模型请求缺少明确输出上限",
                None,
            )
        })?;
    Ok((body.to_string().len() as u64)
        .saturating_add(output)
        .saturating_add(1024))
}

impl OperationBudget {
    /// Freeze the budget under the original connection identity, never under a new HTTP ID.
    pub(crate) fn for_request(
        url: &str,
        api_key: &str,
        original_body: &Value,
        timeout_seconds: u64,
    ) -> Result<Self, String> {
        let context: Value =
            serde_json::from_str(original_body["_opsarkContext"].as_str().unwrap_or("{}"))
                .map_err(|_| {
                    budget_error("MODEL_RECOVERY_BUDGET_INVALID", "模型恢复上下文无效", None)
                })?;
        let fallback = json!({"operationId":crate::task_logs::call_id(),"startedAtMs":now_ms()});
        let policy = context.get("_modelRecovery").unwrap_or(&fallback);
        if !policy.is_object() {
            return Err(budget_error(
                "MODEL_RECOVERY_BUDGET_INVALID",
                "模型恢复预算必须是对象",
                None,
            ));
        }
        let id = policy["operationId"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(|| {
                budget_error(
                    "MODEL_RECOVERY_BUDGET_INVALID",
                    "缺少有效的模型操作身份",
                    None,
                )
            })?;
        let started_at_ms = policy["startedAtMs"].as_u64().ok_or_else(|| {
            budget_error(
                "MODEL_RECOVERY_BUDGET_INVALID",
                "缺少模型操作起始时间",
                None,
            )
        })?;
        let now = now_ms();
        if started_at_ms > now.saturating_add(5000) {
            return Err(budget_error(
                "MODEL_RECOVERY_BUDGET_INVALID",
                "模型操作起始时间无效",
                None,
            ));
        }
        let identity = format!(
            "{:x}",
            Sha256::digest(
                json!([url, api_key, original_body["model"]])
                    .to_string()
                    .as_bytes()
            )
        );
        let mut entries = registry().lock().unwrap_or_else(|error| error.into_inner());
        if let Some(entry) = entries.get(id) {
            let state = entry.lock().unwrap_or_else(|error| error.into_inner());
            if state.identity != identity
                || state.policy != *policy
                || state.started_at_ms != started_at_ms
            {
                return Err(budget_error(
                    "MODEL_RECOVERY_BUDGET_INVALID",
                    "同一模型操作的接入身份或预算被改变",
                    Some(&state),
                ));
            }
            Self::check(&state)?;
            return Ok(Self(entry.clone()));
        }
        // An old identifier whose state was lost/expired must never acquire a fresh budget.
        // Persisted task recovery may explicitly start a new operation; silent resume may not.
        if now.saturating_sub(started_at_ms) > ADMISSION_WINDOW_MS
            || RUNTIME_STARTED_MS
                .get()
                .is_some_and(|start| started_at_ms <= *start)
        {
            return Err(budget_error(
                "MODEL_RECOVERY_BUDGET_EXHAUSTED",
                "原模型操作预算已失效，不能自动建立新的恢复预算",
                None,
            ));
        }
        entries.retain(|_, entry| {
            let state = entry.lock().unwrap_or_else(|error| error.into_inner());
            state.started.elapsed() <= Duration::from_millis(MAX_ELAPSED_MS + 10_000)
        });
        if entries.len() >= MAX_OPERATIONS {
            return Err(budget_error(
                "MODEL_RECOVERY_BUDGET_EXHAUSTED",
                "当前模型操作登记数量达到上限",
                None,
            ));
        }
        let limits = Limits {
            generations: limit(
                policy,
                "maxGenerations",
                DEFAULT_GENERATIONS,
                DEFAULT_GENERATIONS,
            )?,
            transports: limit(
                policy,
                "maxTransportAttempts",
                DEFAULT_TRANSPORTS,
                DEFAULT_TRANSPORTS,
            )?,
            elapsed_ms: limit(
                policy,
                "maxElapsedMs",
                timeout_seconds.saturating_mul(4000).max(1000),
                MAX_ELAPSED_MS,
            )?,
            tokens: limit(
                policy,
                "maxTotalTokens",
                DEFAULT_TOTAL_TOKENS,
                MAX_TOTAL_TOKENS,
            )?,
        };
        let state = Arc::new(Mutex::new(State {
            id: id.to_owned(),
            identity,
            policy: policy.clone(),
            started_at_ms,
            started: Instant::now()
                .checked_sub(Duration::from_millis(now.saturating_sub(started_at_ms)))
                .unwrap_or_else(Instant::now),
            limits,
            generations: 0,
            attempts: 0,
            tokens: 0,
            known_tokens: 0,
            unknown_attempts: 0,
            blocked: false,
            output_field_repairs: 0,
            output_regenerations: 0,
        }));
        entries.insert(id.to_owned(), state.clone());
        Ok(Self(state))
    }

    fn check(state: &State) -> Result<(), String> {
        if state.blocked {
            return Err(budget_error(
                "MODEL_RECOVERY_BUDGET_EXHAUSTED",
                "原模型操作结果未知或不可恢复，已停止自动重生成",
                Some(state),
            ));
        }
        if state.started.elapsed() >= Duration::from_millis(state.limits.elapsed_ms) {
            return Err(budget_error(
                "MODEL_RECOVERY_BUDGET_EXHAUSTED",
                "模型操作总等待时间已耗尽",
                Some(state),
            ));
        }
        Ok(())
    }

    pub(crate) fn start_generation(&self, body: &Value) -> Result<GenerationBudget, String> {
        let reservation = estimate(body)?;
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        Self::check(&state)?;
        if state.generations >= state.limits.generations
            || state.tokens.saturating_add(reservation) > state.limits.tokens
        {
            return Err(budget_error(
                "MODEL_RECOVERY_BUDGET_EXHAUSTED",
                "模型操作生成次数或总 Token 预算不足",
                Some(&state),
            ));
        }
        state.generations += 1;
        Ok(GenerationBudget {
            request_id: crate::task_logs::call_id(),
            operation: self.clone(),
            reservation,
        })
    }

    /// Strategy slots are shared by Rust repairs and later frontend invokes.
    /// Preserve a generation and transport attempt for a whole candidate;
    /// never replenish the ledger.
    pub(crate) fn claim_output_strategy(
        &self,
        strategy: OutputRecoveryStrategy,
        body: &Value,
    ) -> Result<(), String> {
        if strategy == OutputRecoveryStrategy::Initial { return Ok(()); }
        let reservation = estimate(body)?;
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        Self::check(&state)?;
        if state.generations >= state.limits.generations
            || state.attempts >= state.limits.transports
            || state.tokens.saturating_add(reservation) > state.limits.tokens {
            return Err(budget_error("MODEL_RECOVERY_BUDGET_EXHAUSTED", "模型操作总预算不足，不能切换恢复策略", Some(&state)));
        }
        match strategy {
            OutputRecoveryStrategy::FieldRepair => {
                if state.output_field_repairs > 0 || state.output_regenerations > 0
                    || state.limits.generations - state.generations <= 1
                    || state.limits.transports - state.attempts <= 1 {
                    let mut error = serde_json::from_str::<Value>(
                        budget_error("MODEL_OUTPUT_REPAIR_EXHAUSTED", "字段修复机会已用完或已为候选重生成保留预算", Some(&state))
                            .strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap(),
                    ).unwrap();
                    error["modelError"]["stage"] = json!("output_recovery");
                    return Err(format!("{}{error}", crate::MODEL_TRACE_ERROR_PREFIX));
                }
                state.output_field_repairs += 1;
            }
            OutputRecoveryStrategy::Regenerate => {
                if state.output_regenerations > 0 {
                    return Err(budget_error("MODEL_RECOVERY_BUDGET_EXHAUSTED", "当前候选重生成机会已用完", Some(&state)));
                }
                state.output_regenerations += 1;
            }
            OutputRecoveryStrategy::Initial => unreachable!(),
        }
        Ok(())
    }

    pub(crate) fn can_repair_output_field(&self) -> bool {
        let state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        Self::check(&state).is_ok() && state.output_field_repairs == 0 && state.output_regenerations == 0
            && state.limits.generations.saturating_sub(state.generations) > 1
            && state.limits.transports.saturating_sub(state.attempts) > 1
    }

    pub(crate) fn remaining_timeout_seconds(&self, configured: u64) -> Result<u64, String> {
        let state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        Self::check(&state)?;
        let remaining = Duration::from_millis(state.limits.elapsed_ms)
            .saturating_sub(state.started.elapsed())
            .as_secs();
        if remaining == 0 {
            return Err(budget_error(
                "MODEL_RECOVERY_BUDGET_EXHAUSTED",
                "模型操作剩余等待时间不足",
                Some(&state),
            ));
        }
        Ok(configured.max(1).min(remaining))
    }

    pub(crate) fn snapshot(&self) -> Value {
        snapshot(&self.0.lock().unwrap_or_else(|error| error.into_inner()))
    }

    pub(crate) fn block_recovery(&self) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .blocked = true;
    }
}

impl GenerationBudget {
    pub(crate) fn start_attempt(&self) -> Result<AttemptBudget, String> {
        let mut state = self
            .operation
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        OperationBudget::check(&state)?;
        if state.attempts >= state.limits.transports
            || state.tokens.saturating_add(self.reservation) > state.limits.tokens
        {
            return Err(budget_error(
                "MODEL_RECOVERY_BUDGET_EXHAUSTED",
                "模型操作传输次数或总 Token 预算不足",
                Some(&state),
            ));
        }
        state.attempts += 1;
        state.tokens += self.reservation;
        state.unknown_attempts += 1;
        Ok(AttemptBudget {
            operation: self.operation.clone(),
            reservation: self.reservation,
            settled: false,
        })
    }
}

impl AttemptBudget {
    /// Only exact, nonnegative usage replaces a reservation; malformed/missing usage is unknown.
    pub(crate) fn settle(&mut self, payload: &Value) {
        let usage = &payload["usage"];
        let Some((input, output)) = usage.get("input_tokens").or_else(|| usage.get("prompt_tokens"))
            .and_then(Value::as_u64)
            .zip(usage.get("output_tokens").or_else(|| usage.get("completion_tokens")).and_then(Value::as_u64))
        else {
            return;
        };
        let Some(total) = input.checked_add(output) else {
            return;
        };
        if usage
            .get("total_tokens")
            .is_some_and(|value| value.as_u64() != Some(total))
        {
            return;
        }
        self.finish(total);
    }

    pub(crate) fn not_dispatched(&mut self) {
        self.finish(0);
    }

    /// OpsArk's authenticated status endpoint reports actual input+output tokens
    /// as its billing unit. Do not use this for currency or an arbitrary provider estimate.
    pub(crate) fn settle_total(&mut self, total: u64) {
        self.finish(total);
    }

    fn finish(&mut self, total: u64) {
        if self.settled {
            return;
        }
        let mut state = self
            .operation
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.tokens = state
            .tokens
            .saturating_sub(self.reservation)
            .saturating_add(total);
        state.known_tokens = state.known_tokens.saturating_add(total);
        state.unknown_attempts = state.unknown_attempts.saturating_sub(1);
        self.settled = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn body(limits: Value) -> Value {
        let mut context: Value = serde_json::from_str(&ensure_context("{}").unwrap()).unwrap();
        for (key, value) in limits.as_object().unwrap() {
            context["_modelRecovery"][key] = value.clone();
        }
        json!({"model":"test","max_tokens":100,"messages":[],"_opsarkContext":context.to_string()})
    }
    fn budget(body: &Value) -> OperationBudget {
        OperationBudget::for_request("http://test/v1/chat/completions", "key", body, 90).unwrap()
    }
    #[test]
    fn output_strategy_slots_are_atomic_shared_and_never_reset_budget() {
        let body = body(json!({}));
        let first = budget(&body);
        first.start_generation(&body).unwrap();
        let resumed = budget(&body);
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8).map(|_| {
            let budget = resumed.clone(); let body = body.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                budget.claim_output_strategy(OutputRecoveryStrategy::FieldRepair, &body).is_ok()
            })
        }).collect();
        assert_eq!(threads.into_iter().map(|thread| thread.join().unwrap()).filter(|ok| *ok).count(), 1);
        assert_eq!(first.snapshot()["fieldRepairs"], 1);
        assert_eq!(first.snapshot()["generations"], 1);
        resumed.claim_output_strategy(OutputRecoveryStrategy::Regenerate, &body).unwrap();
        assert!(first.claim_output_strategy(OutputRecoveryStrategy::Regenerate, &body).unwrap_err().contains("MODEL_RECOVERY_BUDGET_EXHAUSTED"));
    }

    #[test]
    fn output_strategy_preserves_last_generation_and_honors_terminal_gates() {
        let body = body(json!({"maxGenerations":2}));
        let budget = budget(&body);
        budget.start_generation(&body).unwrap();
        assert!(!budget.can_repair_output_field());
        let error = budget.claim_output_strategy(OutputRecoveryStrategy::FieldRepair, &body).unwrap_err();
        assert!(error.contains("MODEL_OUTPUT_REPAIR_EXHAUSTED"));
        budget.claim_output_strategy(OutputRecoveryStrategy::Regenerate, &body).unwrap();
        budget.block_recovery();
        assert!(budget.start_generation(&body).err().unwrap().contains("MODEL_RECOVERY_BUDGET_EXHAUSTED"));
        assert_eq!(budget.snapshot()["generations"], 1);
    }
    #[test]
    fn output_strategy_preserves_last_transport_attempt_for_the_candidate() {
        let body = body(json!({"maxGenerations":6,"maxTransportAttempts":2}));
        let budget = budget(&body);
        let initial = budget.start_generation(&body).unwrap();
        initial.start_attempt().unwrap().not_dispatched();
        assert!(!budget.can_repair_output_field());
        let error = budget.claim_output_strategy(OutputRecoveryStrategy::FieldRepair, &body).unwrap_err();
        assert!(error.contains("MODEL_OUTPUT_REPAIR_EXHAUSTED"));
        assert_eq!(budget.snapshot()["fieldRepairs"], 0);
        budget.claim_output_strategy(OutputRecoveryStrategy::Regenerate, &body).unwrap();
        let candidate = budget.start_generation(&body).unwrap();
        candidate.start_attempt().unwrap().not_dispatched();
        assert_eq!(budget.snapshot()["transportAttempts"], 2);
        assert_eq!(budget.snapshot()["candidateRegenerations"], 1);
        assert!(budget.claim_output_strategy(OutputRecoveryStrategy::FieldRepair, &body)
            .unwrap_err().contains("MODEL_RECOVERY_BUDGET_EXHAUSTED"));
    }
    #[test]
    fn nested_generations_and_new_handles_share_frozen_limits() {
        let body = body(json!({"maxGenerations":2,"maxTransportAttempts":3}));
        let first = budget(&body);
        let generation = first.start_generation(&body).unwrap();
        let first_id = generation.request_id.clone();
        generation.start_attempt().unwrap().not_dispatched();
        generation.start_attempt().unwrap().not_dispatched();
        let resumed = budget(&body);
        let second = resumed.start_generation(&body).unwrap();
        assert_ne!(first_id, second.request_id);
        second.start_attempt().unwrap().not_dispatched();
        assert!(second.start_attempt().is_err());
        assert!(first.start_generation(&body).is_err());
        assert_eq!(first.snapshot()["transportAttempts"], 3);
    }
    #[test]
    fn usage_is_charged_before_business_validation_and_unknown_is_not_zero() {
        let body = body(json!({"maxTotalTokens":5000}));
        let budget = budget(&body);
        let generation = budget.start_generation(&body).unwrap();
        let mut first = generation.start_attempt().unwrap();
        first.settle(&json!({"usage":{"prompt_tokens":40,"completion_tokens":60},
            "choices":[{"message":{"content":"not JSON"}}]}));
        assert_eq!(budget.snapshot()["accountedTokens"], 100);
        first.not_dispatched();
        assert_eq!(budget.snapshot()["accountedTokens"], 100);
        let mut unknown = generation.start_attempt().unwrap();
        unknown.settle(&json!({"usage":{"total_tokens":0}}));
        drop(unknown);
        assert!(budget.snapshot()["accountedTokens"].as_u64().unwrap() > 100);
        assert_eq!(budget.snapshot()["unknownUsageAttempts"], 1);
    }
    #[test]
    fn exhausted_tokens_prevent_a_new_http_attempt() {
        let body = body(json!({"maxTotalTokens":2000}));
        let budget = budget(&body);
        let generation = budget.start_generation(&body).unwrap();
        let _unknown = generation.start_attempt().unwrap();
        assert!(generation.start_attempt().is_err());
        assert_eq!(budget.snapshot()["transportAttempts"], 1);
    }
    #[test]
    fn context_identity_budget_and_terminal_state_cannot_be_reset() {
        let original = body(json!({"maxGenerations":1}));
        let budget = budget(&original);
        let mut modified = original.clone();
        let mut context: Value =
            serde_json::from_str(original["_opsarkContext"].as_str().unwrap()).unwrap();
        context["_modelRecovery"]["maxGenerations"] = json!(6);
        modified["_opsarkContext"] = json!(context.to_string());
        assert!(OperationBudget::for_request(
            "http://test/v1/chat/completions",
            "key",
            &modified,
            90
        )
        .is_err());
        assert!(OperationBudget::for_request(
            "http://other/v1/chat/completions",
            "key",
            &original,
            90
        )
        .is_err());
        budget.block_recovery();
        assert!(budget.start_generation(&original).is_err());
        assert!(OperationBudget::for_request(
            "http://test/v1/chat/completions",
            "key",
            &original,
            90
        )
        .is_err());
    }
    #[test]
    fn deadline_expiry_and_missing_old_state_do_not_replenish_budget() {
        let original = body(json!({"maxElapsedMs":1000}));
        let budget = budget(&original);
        budget.0.lock().unwrap().started = Instant::now() - Duration::from_secs(2);
        assert!(budget.remaining_timeout_seconds(90).is_err());
        assert!(budget.start_generation(&original).is_err());
        let mut old = body(json!({}));
        let mut context: Value =
            serde_json::from_str(old["_opsarkContext"].as_str().unwrap()).unwrap();
        context["_modelRecovery"]["startedAtMs"] = json!(now_ms() - ADMISSION_WINDOW_MS - 1);
        old["_opsarkContext"] = json!(context.to_string());
        assert!(
            OperationBudget::for_request("http://test/v1/chat/completions", "key", &old, 90)
                .is_err()
        );
    }
    #[test]
    fn responses_reasoning_is_already_in_output_and_missing_usage_remains_unknown() {
        let body=body(json!({}));let budget=budget(&body);
        let mut wire=body.clone();let output=wire.as_object_mut().unwrap().remove("max_tokens").unwrap();wire["max_output_tokens"]=output;
        let generation=budget.start_generation(&wire).unwrap();
        generation.start_attempt().unwrap().settle(&json!({"usage":{"input_tokens":40,"output_tokens":60,"total_tokens":100,"output_tokens_details":{"reasoning_tokens":20}}}));
        assert_eq!(budget.snapshot()["knownUsageTokens"],100);assert_eq!(budget.snapshot()["unknownUsageAttempts"],0);
        generation.start_attempt().unwrap().settle(&json!({"usage":{"input_tokens":10,"output_tokens_details":{"reasoning_tokens":5}}}));
        assert_eq!(budget.snapshot()["knownUsageTokens"],100);assert_eq!(budget.snapshot()["unknownUsageAttempts"],1);
    }

    #[test]
    fn known_usage_over_cap_stops_future_attempts_without_discarding_usage() {
        let body = body(json!({"maxTotalTokens":2000}));
        let budget = budget(&body);
        let generation = budget.start_generation(&body).unwrap();
        generation
            .start_attempt()
            .unwrap()
            .settle(&json!({"usage":{"prompt_tokens":1000,"completion_tokens":1500}}));
        assert_eq!(budget.snapshot()["knownUsageTokens"], 2500);
        assert!(generation.start_attempt().is_err());
    }
    #[test]
    fn concurrent_calls_cannot_pass_the_same_generation_limit() {
        let body = body(json!({"maxGenerations":2}));
        let budget = budget(&body);
        let barrier = Arc::new(std::sync::Barrier::new(12));
        let threads: Vec<_> = (0..12)
            .map(|_| {
                let budget = budget.clone();
                let barrier = barrier.clone();
                let body = body.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    budget.start_generation(&body).is_ok()
                })
            })
            .collect();
        let successes = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|ok| *ok)
            .count();
        assert_eq!(successes, 2);
        assert_eq!(budget.snapshot()["generations"], 2);
    }
}
