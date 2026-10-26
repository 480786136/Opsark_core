use super::*;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Barrier,
};

struct Fixture {
    root: PathBuf,
    ledger: Ledger,
}
impl Fixture {
    fn new() -> Self {
        static SERIAL: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "opsark-task-budget-{}-{}-{}",
            std::process::id(),
            now_ms(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        let ledger = Ledger::open(root.join("budget.sqlite3")).unwrap();
        Self { root, ledger }
    }
    fn register(&self, task: &str, round: &str, task_cap: u64, round_cap: u64) -> TaskBudget {
        self.ledger
            .register(&registration(task, round, task_cap, round_cap, 0))
            .unwrap();
        self.ledger.budget(task, round).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        assert_eq!(self.root.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self
            .root
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("opsark-task-budget-"));
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
fn registration(
    task: &str,
    round: &str,
    task_cap: u64,
    round_cap: u64,
    safety: u64,
) -> TaskBudgetRegistration {
    TaskBudgetRegistration {
        task_id: task.into(),
        round_id: round.into(),
        max_task_tokens: task_cap,
        max_round_tokens: round_cap,
        safety_reserve_tokens: safety,
    }
}
fn wire() -> Value {
    json!({"model":"fixture","max_output_tokens":100,"input":[{"role":"user","content":"中文运维需求"}]})
}
fn usage(input: u64, output: u64) -> Value {
    json!({"usage":{"input_tokens":input,"output_tokens":output,"total_tokens":input+output}})
}
fn number(snapshot: &Value, scope: &str, name: &str) -> u64 {
    snapshot[scope][name].as_u64().unwrap()
}

#[test]
fn complete_wire_estimate_includes_tools_instructions_format_and_output_not_just_user_text() {
    let base = wire();
    let baseline = estimate_wire(&base).unwrap();
    let mut full = base.clone();
    full["instructions"] = json!("规则".repeat(40));
    full["tools"] =
        json!([{"name":"inspect","description":"证据".repeat(30),"parameters":{"type":"object"}}]);
    full["text"] = json!({"format":{"type":"json_schema","schema":{"type":"object"}}});
    assert_eq!(
        estimate_wire(&full).unwrap(),
        full.to_string().len() as u64 + 100 + 1024
    );
    assert!(estimate_wire(&full).unwrap() > baseline);
    for output_key in ["max_tokens", "max_completion_tokens"] {
        let mut chat = full.clone();
        chat.as_object_mut().unwrap().remove("max_output_tokens");
        chat[output_key] = json!(777);
        assert_eq!(
            estimate_wire(&chat).unwrap(),
            chat.to_string().len() as u64 + 777 + 1024
        );
    }
    for invalid in [
        json!({}),
        json!({"max_tokens":0}),
        json!({"max_output_tokens":-1}),
        json!({"max_tokens":1.5}),
        json!({"max_tokens":u64::MAX}),
    ] {
        assert!(estimate_wire(&invalid).is_err());
    }
}

#[test]
fn near_preregistered_250k_and_600k_caps_next_request_stops_before_reservation() {
    for cap in [250_000, 600_000] {
        let fixture = Fixture::new();
        let budget = fixture.register("task", "round", cap, cap);
        let body = wire();
        let reservation = estimate_wire(&body).unwrap();
        let mut initial = budget
            .reserve(
                "request-understanding",
                "attempt-understanding",
                "operation-understanding",
                &body,
            )
            .unwrap();
        initial.settle_total(cap - reservation + 1).unwrap();
        let error = budget
            .reserve(
                "request-planning",
                "attempt-planning",
                "new-operation",
                &body,
            )
            .unwrap_err();
        assert!(error.contains("MODEL_TASK_BUDGET_EXHAUSTED"));
        let state = budget.snapshot().unwrap();
        assert_eq!(number(&state, "task", "transportAttempts"), 1);
        assert_eq!(
            number(&state, "task", "accountedTokens"),
            cap - reservation + 1
        );
    }
}

fn model_error(raw: &str) -> Value {
    serde_json::from_str::<Value>(raw.strip_prefix(crate::MODEL_TRACE_ERROR_PREFIX).unwrap()).unwrap()["modelError"].clone()
}

#[test]
fn refusal_records_wire_components_scope_shortfall_and_keeps_original_250k_ledger() {
    let fixture = Fixture::new();
    let budget = fixture.register("task", "round", 250_000, 250_000);
    budget.reserve("first", "first-attempt", "first-operation", &wire()).unwrap()
        .settle_total(146_393).unwrap();
    let secret = "SENTINEL_PRIVATE_REQUIREMENT";
    let mut large = wire();
    large["instructions"] = json!(format!("{secret}{}", "中".repeat(36_000)));
    large["max_completion_tokens"] = json!(16_384);
    let before = budget.snapshot().unwrap();
    let refusal = model_error(&budget.reserve("next", "next-attempt", "next-operation", &large).unwrap_err());
    assert_eq!(refusal["code"], "MODEL_TASK_BUDGET_EXHAUSTED");
    assert_eq!(refusal["dispatchCertainty"], "not_dispatched");
    assert_eq!(refusal["requestKey"], "next");
    let admission = &refusal["taskBudgetAdmission"];
    assert_eq!(admission["requestBytes"], large.to_string().len() as u64);
    assert_eq!(admission["outputTokenLimit"], 16_384);
    assert_eq!(admission["estimationOverheadTokens"], 1024);
    assert_eq!(admission["requiredReservedTokens"], large.to_string().len() as u64 + 16_384 + 1024);
    assert_eq!(admission["inputEstimateIsExact"], false);
    assert_eq!(admission["wireDigest"], format!("{:x}", Sha256::digest(large.to_string().as_bytes())));
    for key in ["task", "round"] {
        let scope = &admission["scopes"][key];
        assert_eq!(scope["maxTotalTokens"], 250_000);
        assert_eq!(scope["knownUsageTokens"], 146_393);
        assert_eq!(scope["accountedTokens"], 146_393);
        assert_eq!(scope["availableTokens"], 103_607);
        assert_eq!(scope["unknownReservedTokens"], 0);
        assert_eq!(scope["reservationShortfallTokens"], estimate_wire(&large).unwrap() - 103_607);
        assert_eq!(scope["blockedReasons"], json!(["total_tokens", "lane_tokens"]));
    }
    assert!(!refusal.to_string().contains(secret));
    assert_eq!(budget.snapshot().unwrap(), before);
    assert!(!fixture.ledger.connect().unwrap().query_row(
        "SELECT EXISTS(SELECT 1 FROM model_budget_attempts WHERE attempt_id='next-attempt')", [], |r| r.get::<_, bool>(0)).unwrap());
}

#[test]
fn admission_distinguishes_task_round_safety_lane_unknown_and_attempt_limits() {
    let fixture = Fixture::new();
    let first = fixture.register("task", "first-round", 10_000, 10_000);
    first.reserve("previous", "previous-attempt", "previous-op", &wire()).unwrap().settle_total(2_000).unwrap();
    let second = fixture.register("task", "second-round", 10_000, 1_500);
    let _unknown = second.reserve("unknown", "unknown-attempt", "unknown-op", &wire()).unwrap();
    let refusal = model_error(&second.reserve("next", "next-attempt", "next-op", &wire()).unwrap_err());
    let admission = &refusal["taskBudgetAdmission"];
    assert_eq!(admission["scopes"]["task"]["blockedReasons"], json!([]));
    assert_eq!(admission["scopes"]["round"]["blockedReasons"], json!(["total_tokens", "lane_tokens"]));
    assert_eq!(admission["scopes"]["task"]["unknownReservedTokens"], estimate_wire(&wire()).unwrap());
    assert_eq!(admission["scopes"]["round"]["unknownUsageAttempts"], 1);
    assert_eq!(admission["scopes"]["task"]["knownUsageTokens"], 2_000);

    fixture.ledger.register(&registration("safety-task", "round", 10_000, 10_000, 8192)).unwrap();
    let safety = fixture.ledger.budget("safety-task", "round").unwrap();
    safety.reserve("business", "business-a", "business-o", &wire()).unwrap().settle_total(1_800).unwrap();
    let refusal = model_error(&safety.reserve("more-business", "more-a", "more-o", &wire()).unwrap_err());
    assert_eq!(refusal["taskBudgetAdmission"]["scopes"]["task"]["blockedReasons"], json!(["lane_tokens"]));
    assert_eq!(refusal["taskBudgetAdmission"]["scopes"]["task"]["availableTotalTokens"], 8_200);
    assert_eq!(refusal["taskBudgetAdmission"]["scopes"]["task"]["availableLaneTokens"], 8);
    for index in 0..2 {
        safety.reserve_safety(&format!("safe-{index}"), &format!("safe-a-{index}"), &format!("safe-o-{index}"), &wire())
            .unwrap().settle_total(100).unwrap();
    }
    let refusal = model_error(&safety.reserve_safety("safe-third", "safe-a-third", "safe-o-third", &wire()).unwrap_err());
    assert_eq!(refusal["taskBudgetAdmission"]["scopes"]["task"]["blockedReasons"], json!(["safety_attempts"]));
    assert_eq!(refusal["taskBudgetAdmission"]["scopes"]["task"]["reservationShortfallTokens"], 0);
}

#[test]
fn reducing_real_wire_bytes_allows_summary_inside_original_cap_without_releasing_unknown_or_safety() {
    let fixture = Fixture::new();
    let budget = fixture.register("task", "round", 250_000, 250_000);
    budget.reserve("earlier", "earlier-a", "earlier-o", &wire()).unwrap().settle_total(146_393).unwrap();
    let mut bloated = wire();
    bloated["instructions"] = json!("repeat-history".repeat(10_000));
    assert!(budget.reserve("summary-large", "summary-large-a", "summary-large-o", &bloated).is_err());
    let before = budget.snapshot().unwrap();
    let mut compact = wire();
    compact["max_output_tokens"] = json!(3000);
    compact["input"] = json!("CURRENT_TASK_AND_VERIFIED_EVIDENCE".repeat(250));
    budget.reserve("summary-compact", "summary-compact-a", "summary-compact-o", &compact).unwrap()
        .settle_total(3500).unwrap();
    let result = budget.snapshot().unwrap();
    assert_eq!(number(&before, "task", "knownUsageTokens"), 146_393);
    assert_eq!(number(&result, "task", "knownUsageTokens"), 149_893);
    assert_eq!(number(&result, "task", "maxTotalTokens"), 250_000);
    assert_eq!(number(&result, "round", "maxTotalTokens"), 250_000);
    assert_eq!(number(&result, "task", "transportAttempts"), 2);
    assert_eq!(number(&result, "task", "safetyAttempts"), 0);
    assert_eq!(number(&result, "task", "unknownUsageAttempts"), 0);
}

fn wire_with_bytes(request_bytes: usize, output: u64) -> Value {
    let mut body=wire();
    body["max_output_tokens"]=json!(output);
    body["instructions"]=json!("");
    let padding=request_bytes-body.to_string().len();
    body["instructions"]=json!("x".repeat(padding));
    assert_eq!(body.to_string().len(),request_bytes);
    body
}

#[test]
fn automatic_output_cap_fits_original_250k_without_changing_wire_contract_or_ledger() {
    let fixture=Fixture::new();
    let budget=fixture.register("task","round",250_000,250_000);
    budget.reserve("earlier","earlier-a","earlier-o",&wire()).unwrap().settle_total(103_541).unwrap();
    let mut body=wire_with_bytes(131_826,16_384);
    let original=body.clone();
    let before=budget.snapshot().unwrap();
    let diagnostic=budget.fit_output_cap(&mut body,5000).unwrap().unwrap();
    assert_eq!(body["max_output_tokens"],13_609);
    let mut without_cap=body.clone();
    without_cap["max_output_tokens"]=json!(16_384);
    assert_eq!(without_cap,original);
    assert_eq!(diagnostic["originalRequiredReservedTokens"],149_234);
    assert_eq!(diagnostic["effectiveRequiredReservedTokens"],146_459);
    assert_eq!(diagnostic["availableTokens"],146_459);
    assert_eq!(diagnostic["providerMinimumDeclared"],false);
    assert_eq!(diagnostic["actualBillingLimitGuaranteed"],false);
    assert_eq!(budget.snapshot().unwrap(),before);
    budget.reserve("next","next-a","next-o",&body).unwrap();
    let after=budget.snapshot().unwrap();
    assert_eq!(number(&after,"task","accountedTokens"),250_000);
    assert_eq!(number(&after,"task","knownUsageTokens"),103_541);
    assert_eq!(number(&after,"task","estimatedReservedTokens"),146_459);
}

#[test]
fn archived_013_budget_boundary_requires_smaller_input_without_lowering_output_floor() {
    // A byte-size counterfactual from the archived rejection, not a replay of
    // the unsent final prompt or a claim about actual model billing.
    let fixture = Fixture::new();
    let budget = fixture.register("task-013-boundary", "round", 250_000, 250_000);
    budget.reserve("previous", "previous-a", "previous-o", &wire()).unwrap()
        .settle_total(107_388).unwrap();
    let before = budget.snapshot().unwrap();
    let mut original = wire_with_bytes(139_640, 16_384);
    let retained = original.clone();
    assert!(budget.fit_output_cap(&mut original, 5_000).unwrap().is_none());
    assert_eq!(original, retained);
    assert!(budget.reserve("refused", "refused-a", "refused-o", &original).is_err());
    assert_eq!(budget.snapshot().unwrap(), before);
    // Keep at least the same 5000 output floor and the same total/estimator.
    let mut smaller = wire_with_bytes(139_640 - 3_509, 16_384);
    let adjustment = budget.fit_output_cap(&mut smaller, 5_000).unwrap().unwrap();
    assert!(smaller["max_output_tokens"].as_u64().unwrap() >= 5_000);
    assert_eq!(adjustment["effectiveRequiredReservedTokens"], 142_612);
    assert_eq!(budget.snapshot().unwrap(), before);
    budget.reserve("smaller", "smaller-a", "smaller-o", &smaller).unwrap();
    assert_eq!(number(&budget.snapshot().unwrap(), "task", "accountedTokens"), 250_000);
}

#[test]
fn output_cap_adaptation_preserves_unknown_safety_round_and_full_input_boundaries() {
    let fixture=Fixture::new();
    fixture.ledger.register(&registration("task","round",250_000,250_000,8192)).unwrap();
    let budget=fixture.ledger.budget("task","round").unwrap();
    budget.reserve("earlier","earlier-a","earlier-o",&wire()).unwrap().settle_total(103_541).unwrap();
    let _unknown=budget.reserve("unknown","unknown-a","unknown-o",&wire()).unwrap();
    let before=budget.snapshot().unwrap();
    let mut large=wire_with_bytes(131_826,16_384);
    let unchanged=large.clone();
    assert!(budget.fit_output_cap(&mut large,5000).unwrap().is_none());
    assert_eq!(large,unchanged);
    assert_eq!(budget.snapshot().unwrap(),before);
    assert_eq!(number(&before,"task","unknownUsageAttempts"),1);

    let round=fixture.register("round-task","round",250_000,200_000);
    round.reserve("round-earlier","round-earlier-a","round-earlier-o",&wire()).unwrap().settle_total(103_541).unwrap();
    let mut body=wire_with_bytes(131_826,16_384);
    assert!(round.fit_output_cap(&mut body,5000).unwrap().is_none());
    assert_eq!(body,unchanged);

    let small=fixture.register("small-task","round",10_000,10_000);
    let mut multi=wire_with_bytes(3000,16_384);
    multi["max_tokens"]=json!(16_384);
    let before_multi=multi.clone();
    assert!(small.fit_output_cap(&mut multi,5000).unwrap().is_none());
    assert_eq!(multi,before_multi);
    let mut floor=wire_with_bytes(3000,16_384);
    assert!(small.fit_output_cap(&mut floor,8192).unwrap().is_none());
    assert_eq!(floor["max_output_tokens"],16_384);
}

#[test]
fn negotiated_cap_is_largest_safe_value_and_atomic_reservation_still_rejects_a_race() {
    let fixture=Fixture::new();
    let budget=fixture.register("task","round",10_000,10_000);
    let mut body=wire_with_bytes(6000,16_384);
    let adjustment=budget.fit_output_cap(&mut body,2048).unwrap().unwrap();
    assert_eq!(adjustment["effectiveRequiredReservedTokens"],10_000);
    let mut larger=body.clone();
    larger["max_output_tokens"]=json!(body["max_output_tokens"].as_u64().unwrap()+1);
    assert!(estimate_wire(&larger).unwrap()>10_000);
    budget.reserve("racer","racer-a","racer-o",&wire()).unwrap().settle_total(3000).unwrap();
    let before=budget.snapshot().unwrap();
    let refusal=model_error(&budget.reserve("next","next-a","next-o",&body).unwrap_err());
    assert_eq!(refusal["code"],"MODEL_TASK_BUDGET_EXHAUSTED");
    assert_eq!(budget.snapshot().unwrap(),before);
    assert_eq!(number(&before,"task","transportAttempts"),1);
}

#[test]
fn understanding_planning_repair_replan_summary_accumulate_across_operations() {
    let fixture = Fixture::new();
    let budget = fixture.register("task", "round", 20_000, 20_000);
    for (index, phase) in ["understand", "plan", "repair", "replan", "summary"]
        .into_iter()
        .enumerate()
    {
        let mut attempt = budget
            .reserve(
                &format!("request-{phase}"),
                &format!("attempt-{phase}"),
                &format!("operation-{phase}"),
                &wire(),
            )
            .unwrap();
        attempt.settle(&usage(100 + index as u64, 50)).unwrap();
    }
    let result = budget.snapshot().unwrap();
    assert_eq!(number(&result, "task", "knownUsageTokens"), 760);
    assert_eq!(number(&result, "round", "accountedTokens"), 760);
    assert_eq!(number(&result, "task", "transportAttempts"), 5);
    assert_eq!(result["task"]["exactTokens"], true);
}

#[test]
fn unknown_usage_is_reserved_across_restart_and_new_operation_cannot_reset_it() {
    let fixture = Fixture::new();
    let amount = estimate_wire(&wire()).unwrap();
    let budget = fixture.register("task", "round", amount * 2 - 1, amount * 2 - 1);
    let mut attempt = budget
        .reserve("request", "attempt", "operation", &wire())
        .unwrap();
    for payload in [
        json!({}),
        json!({"usage":{"total_tokens":0}}),
        json!({"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":0}}),
        json!({"usage":{"input_tokens":-1,"output_tokens":0}}),
    ] {
        let result = attempt.settle(&payload).unwrap();
        assert_eq!(number(&result, "task", "accountedTokens"), amount);
        assert_eq!(number(&result, "task", "knownUsageTokens"), 0);
        assert_eq!(number(&result, "task", "unknownUsageAttempts"), 1);
        assert_eq!(result["task"]["exactTokens"], false);
    }
    drop(attempt);
    drop(budget);
    let reopened = Ledger::open(fixture.root.join("budget.sqlite3")).unwrap();
    reopened
        .register(&registration(
            "task",
            "round",
            amount * 2 - 1,
            amount * 2 - 1,
            0,
        ))
        .unwrap();
    let resumed = reopened.budget("task", "round").unwrap();
    assert!(resumed
        .reserve("new-request", "new-attempt", "new-operation", &wire())
        .is_err());
    assert_eq!(
        number(&resumed.snapshot().unwrap(), "task", "accountedTokens"),
        amount
    );
}

#[test]
fn concurrent_connections_atomically_reserve_both_scopes_without_overallocating() {
    let fixture = Fixture::new();
    let amount = estimate_wire(&wire()).unwrap();
    let budget = fixture.register("task", "round", amount * 3, amount * 3);
    let barrier = Arc::new(Barrier::new(12));
    let threads: Vec<_> = (0..12)
        .map(|index| {
            let budget = budget.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                budget
                    .reserve(
                        &format!("request-{index}"),
                        &format!("attempt-{index}"),
                        &format!("operation-{index}"),
                        &wire(),
                    )
                    .is_ok()
            })
        })
        .collect();
    assert_eq!(
        threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .filter(|ok| *ok)
            .count(),
        3
    );
    let result = budget.snapshot().unwrap();
    assert_eq!(number(&result, "task", "accountedTokens"), amount * 3);
    assert_eq!(number(&result, "round", "unknownUsageAttempts"), 3);
}

#[test]
fn independent_round_limits_share_task_cap_and_late_results_settle_original_round() {
    let fixture = Fixture::new();
    let first = fixture.register("task", "round-one", 5000, 2500);
    let _unknown = first
        .reserve("request-one", "attempt-one", "operation-one", &wire())
        .unwrap();
    let second = fixture.register("task", "round-two", 5000, 2500);
    let mut current = second
        .reserve("request-two", "attempt-two", "operation-two", &wire())
        .unwrap();
    current.settle_total(2000).unwrap();
    let mut recovered = TaskAttemptBudget::reopen_in(
        Ledger::open(fixture.root.join("budget.sqlite3")).unwrap(),
        "request-one",
        "attempt-one",
    )
    .unwrap();
    let result = recovered.settle_total(2400).unwrap();
    assert_eq!(result["roundId"], "round-one");
    assert_eq!(number(&result, "round", "knownUsageTokens"), 2400);
    let newer = second.snapshot().unwrap();
    assert_eq!(number(&newer, "round", "knownUsageTokens"), 2000);
    assert_eq!(number(&newer, "task", "knownUsageTokens"), 4400);
    assert!(first.reserve("r3", "a3", "o3", &wire()).is_err());
    assert!(second.reserve("r4", "a4", "o4", &wire()).is_err());
}

#[test]
fn registration_limits_are_immutable_and_new_round_does_not_upgrade_task() {
    let fixture = Fixture::new();
    fixture.register("task", "round", 250_000, 200_000);
    fixture
        .ledger
        .register(&registration("task", "round", 250_000, 200_000, 0))
        .unwrap();
    for modified in [
        registration("task", "round", 600_000, 200_000, 0),
        registration("task", "round", 250_000, 250_000, 0),
        registration("task", "round", 250_000, 150_000, 0),
        registration("task", "new-round", 600_000, 200_000, 0),
    ] {
        assert!(fixture
            .ledger
            .register(&modified)
            .unwrap_err()
            .contains("MODEL_TASK_BUDGET_POLICY_CHANGED"));
    }
    assert!(fixture.ledger.budget("task", "new-round").is_err());
    assert_eq!(
        number(
            &fixture
                .ledger
                .budget("task", "round")
                .unwrap()
                .snapshot()
                .unwrap(),
            "task",
            "maxTotalTokens"
        ),
        250_000
    );
}

#[test]
fn usage_settlement_is_idempotent_across_reopen_and_subsets_are_not_double_counted() {
    let fixture = Fixture::new();
    let budget = fixture.register("task", "round", 10_000, 10_000);
    let mut attempt = budget
        .reserve("request", "attempt", "operation", &wire())
        .unwrap();
    let value = json!({"usage":{"input_tokens":100,"output_tokens":40,"total_tokens":140,
        "input_tokens_details":{"cached_tokens":80},"output_tokens_details":{"reasoning_tokens":30}}});
    attempt.settle(&value).unwrap();
    drop(attempt);
    let mut recovered =
        TaskAttemptBudget::reopen_in(fixture.ledger.clone(), "request", "attempt").unwrap();
    recovered.settle(&value).unwrap();
    recovered.settle_total(140).unwrap();
    recovered.not_dispatched().unwrap();
    let result = recovered.snapshot().unwrap();
    assert_eq!(number(&result, "task", "knownUsageTokens"), 140);
    assert_eq!(number(&result, "task", "accountedTokens"), 140);
    assert_eq!(number(&result, "task", "transportAttempts"), 1);
    assert_eq!(number(&result, "task", "unknownUsageAttempts"), 0);
}

#[test]
fn duplicate_attempt_and_unknown_request_cannot_acquire_another_dispatch_reservation() {
    let fixture = Fixture::new();
    let budget = fixture.register("task", "round", 20_000, 20_000);
    let _attempt = budget
        .reserve("request", "attempt", "operation", &wire())
        .unwrap();
    assert!(budget
        .reserve("request", "attempt", "operation", &wire())
        .unwrap_err()
        .contains("DUPLICATE_ATTEMPT"));
    assert!(budget
        .reserve("request", "another-attempt", "operation", &wire())
        .unwrap_err()
        .contains("REQUEST_ALREADY_RESERVED"));
    assert!(
        TaskAttemptBudget::reopen_in(fixture.ledger.clone(), "other-request", "attempt").is_err()
    );
    assert_eq!(
        number(&budget.snapshot().unwrap(), "task", "transportAttempts"),
        1
    );
}

#[test]
fn only_definitely_not_dispatched_can_release_tokens_and_retry_same_request() {
    let fixture = Fixture::new();
    let amount = estimate_wire(&wire()).unwrap();
    let budget = fixture.register("task", "round", amount, amount);
    let mut first = budget
        .reserve("request", "attempt-one", "operation", &wire())
        .unwrap();
    let result = first.not_dispatched().unwrap();
    assert_eq!(number(&result, "task", "accountedTokens"), 0);
    assert_eq!(number(&result, "task", "notDispatchedAttempts"), 1);
    let mut second = budget
        .reserve("request", "attempt-two", "operation", &wire())
        .unwrap();
    second.settle(&usage(1, 2)).unwrap();
    assert_eq!(
        number(&second.snapshot().unwrap(), "task", "knownUsageTokens"),
        3
    );
    assert!(budget
        .reserve("request", "attempt-three", "operation", &wire())
        .is_err());
}

#[test]
fn replay_cannot_change_original_request_wire_or_scope_even_after_not_dispatched() {
    let fixture = Fixture::new();
    let first = fixture.register("task", "one", 20_000, 20_000);
    first
        .reserve("request", "attempt", "operation", &wire())
        .unwrap()
        .not_dispatched()
        .unwrap();
    let mut changed = wire();
    changed["input"] = json!("different target");
    assert!(first
        .reserve("request", "retry-one", "operation", &changed)
        .is_err());
    assert!(first
        .reserve("request", "retry-two", "new-operation", &wire())
        .is_err());
    let second = fixture.register("task", "two", 20_000, 20_000);
    assert!(second
        .reserve("request", "retry-three", "operation", &wire())
        .is_err());
    assert!(second
        .reserve("new-request", "new-attempt", "operation", &wire())
        .is_err());
}

#[test]
fn actual_usage_above_reservation_and_total_cap_is_saved_without_clamping() {
    let fixture = Fixture::new();
    let body = wire();
    let reserved = estimate_wire(&body).unwrap();
    let budget = fixture.register("task", "round", 2000, 2000);
    let result = budget
        .reserve("request", "attempt", "operation", &body)
        .unwrap()
        .settle_total(2500)
        .unwrap();
    assert_eq!(number(&result, "task", "accountedTokens"), 2500);
    assert_eq!(number(&result, "task", "overBudgetTokens"), 500);
    assert_eq!(
        number(&result, "task", "actualOverEstimateTokens"),
        2500 - reserved
    );
    assert_eq!(result["task"]["exactTokens"], true);
    assert!(budget
        .reserve("next-request", "next-attempt", "next-operation", &body)
        .is_err());
}

#[test]
fn contradictory_usage_keeps_higher_conservative_charge_and_blocks_new_requests() {
    let fixture = Fixture::new();
    let budget = fixture.register("task", "round", 20_000, 20_000);
    let mut attempt = budget
        .reserve("request", "attempt", "operation", &wire())
        .unwrap();
    attempt.settle_total(100).unwrap();
    let result = attempt.settle_total(500).unwrap();
    assert_eq!(number(&result, "task", "knownUsageTokens"), 100);
    assert_eq!(number(&result, "task", "accountedTokens"), 500);
    assert_eq!(number(&result, "task", "conservativeConflictTokens"), 400);
    assert_eq!(result["task"]["exactTokens"], false);
    assert!(budget
        .reserve("new-request", "new-attempt", "new-operation", &wire())
        .unwrap_err()
        .contains("EVIDENCE_CONFLICT"));
    assert_eq!(
        number(
            &attempt.not_dispatched().unwrap(),
            "task",
            "accountedTokens"
        ),
        500
    );
}

#[test]
fn actual_result_after_not_dispatched_is_accounted_as_conflicting_evidence_not_discarded() {
    let fixture = Fixture::new();
    let budget = fixture.register("task", "round", 20_000, 20_000);
    let mut attempt = budget
        .reserve("request", "attempt", "operation", &wire())
        .unwrap();
    attempt.not_dispatched().unwrap();
    let result = attempt.settle_total(300).unwrap();
    assert_eq!(number(&result, "task", "accountedTokens"), 300);
    assert_eq!(number(&result, "task", "knownUsageTokens"), 300);
    assert_eq!(number(&result, "task", "usageEvidenceConflicts"), 1);
}

#[test]
fn safety_reserve_is_inside_total_separate_fixed_and_not_an_unlimited_retry_lane() {
    let fixture = Fixture::new();
    fixture
        .ledger
        .register(&registration("task", "round", 10_000, 10_000, 8192))
        .unwrap();
    let budget = fixture.ledger.budget("task", "round").unwrap();
    budget
        .reserve("business", "a-business", "o-business", &wire())
        .unwrap()
        .settle_total(1800)
        .unwrap();
    assert!(budget
        .reserve("more-business", "a-more", "o-more", &wire())
        .is_err());
    for index in 0..2 {
        budget
            .reserve_safety(
                &format!("safety-{index}"),
                &format!("a-safe-{index}"),
                &format!("o-safe-{index}"),
                &wire(),
            )
            .unwrap()
            .settle_total(100)
            .unwrap();
    }
    assert!(budget
        .reserve_safety("safety-3", "a-safe-3", "o-safe-3", &wire())
        .is_err());
    let result = budget.snapshot().unwrap();
    assert_eq!(number(&result, "task", "maxTotalTokens"), 10_000);
    assert_eq!(number(&result, "task", "accountedTokens"), 2000);
    assert_eq!(number(&result, "task", "safetyAccountedTokens"), 200);
    assert_eq!(number(&result, "task", "businessTokenLimit"), 1808);
    let ordinary = fixture.register("ordinary", "round", 10_000, 10_000);
    assert!(ordinary
        .reserve_safety("no-safety", "no-attempt", "no-operation", &wire())
        .is_err());
}

#[test]
fn context_requires_explicit_task_and_round_scope_and_cannot_change_lane_or_limit() {
    assert!(TaskBudget::for_context(&json!({"messages":[]}))
        .unwrap()
        .is_none());
    for context in [
        json!({"taskId":"task"}),
        json!({"_log":{"taskId":"task"}}),
        json!({"baseSnapshot":{"_log":{"taskId":"task"}}}),
        json!({"_log":{"taskId":null}}),
        json!({"taskId":123}),
        json!({"_log":{"taskId":""}}),
    ] {
        assert!(identity_from_context(&context).is_err());
    }
    let valid = json!({"_log":{"taskId":"task","roundId":"round"},"_taskModelBudget":{"version":1,"taskId":"task","roundId":"round"}});
    assert_eq!(
        identity_from_context(&valid).unwrap(),
        Some(("task".into(), "round".into()))
    );
    for (key, value) in [
        ("lane", json!("safety")),
        ("maxTaskTokens", json!(32_000_000)),
        ("roundId", json!("different")),
        ("version", json!(2)),
    ] {
        let mut context = valid.clone();
        context["_taskModelBudget"][key] = value;
        assert!(identity_from_context(&context).is_err());
    }
}

#[test]
fn unknown_database_or_budget_does_not_auto_register_or_reset_state() {
    let fixture = Fixture::new();
    assert!(fixture
        .ledger
        .budget("unregistered", "round")
        .unwrap_err()
        .contains("UNREGISTERED"));
    fixture
        .ledger
        .connect()
        .unwrap()
        .pragma_update(None, "user_version", 2)
        .unwrap();
    assert!(Ledger::open(fixture.root.join("budget.sqlite3")).is_err());
}
