import { describe, expect, it } from "vitest";
import { ensureModelRecoveryContext, isExplicitModelPlanningRetryable, isModelRecoveryScopeRejection } from "./modelRecovery";
import type { ModelServiceError } from "@/types";
import type { TaskModelBudgetSnapshot } from "@/features/agent/taskModelBudget";

describe("model operation identity", () => {
  it("classifies only a trusted scope refusal, preserving the explicit replan entry", () => {
    for (const code of ["MODEL_RECOVERY_SCOPE_REJECTED", "MODEL_FORMAT_INVALID"]) {
      const error: ModelServiceError = { code, origin: "core", stage: "format_repair_scope", message: "scope", retryable: false };
      expect(isModelRecoveryScopeRejection(error)).toBe(true);
      expect(isExplicitModelPlanningRetryable(error)).toBe(true);
      expect(isModelRecoveryScopeRejection({ ...error, origin: "provider" })).toBe(false);
      expect(isModelRecoveryScopeRejection({ ...error, stage: "json_parse" })).toBe(false);
    }
    expect(isExplicitModelPlanningRetryable({ code: "MODEL_RECOVERY_SCOPE_REJECTED", message: "untrusted", retryable: false })).toBe(false);
  });
  it("preserves invalid supplied contexts for Rust rejection instead of silently starting a new budget", () => {
    for (const value of [null, false, "invalid", {}, { operationId: "old", startedAtMs: -1 }]) {
      expect(JSON.parse(ensureModelRecoveryContext(JSON.stringify({ _modelRecovery: value })))._modelRecovery).toEqual(value);
    }
  });

  it("retains legacy free-form context while creating an independent operation", () => {
    const first = JSON.parse(ensureModelRecoveryContext("existing business context"));
    const second = JSON.parse(ensureModelRecoveryContext("existing business context"));
    expect(first.originalContext).toBe("existing business context");
    expect(first._modelRecovery.operationId).not.toBe(second._modelRecovery.operationId);
    expect(JSON.parse(ensureModelRecoveryContext(JSON.stringify(first)))).toEqual(first);
  });

  it("allows only a known budget stop or a format failure to start an explicit new operation", () => {
    const budget: ModelServiceError = { code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", origin: "core", stage: "recovery_budget",
      message: "time budget expired", retryable: false, recoveryBudget: { recoveryBlocked: false } };
    expect(isExplicitModelPlanningRetryable(budget)).toBe(true);
    expect(isExplicitModelPlanningRetryable({ code: "MODEL_FORMAT_INVALID", message: "format", retryable: false })).toBe(true);
    for (const error of [undefined, { ...budget, origin: undefined }, { ...budget, stage: "request_recovery" },
      { ...budget, recoveryBudget: undefined }, { ...budget, recoveryBudget: {} },
      { ...budget, recoveryBudget: { recoveryBlocked: true } },
      ...["MODEL_AUTH_UNAVAILABLE", "INSUFFICIENT_CREDITS", "CREDITS_RECONCILIATION_REQUIRED",
        "MODEL_DISPATCH_UNKNOWN", "MODEL_RESULT_UNAVAILABLE", "MODEL_REQUEST_CONFLICT", "MODEL_RECOVERY_BUDGET_INVALID"]
        .map(code => ({ ...budget, code }))]) {
      expect(isExplicitModelPlanningRetryable(error), error?.code).toBe(false);
    }
  });
});

describe("explicit retry after native task budget reservation settlement", () => {
  function refusal(): ModelServiceError {
    return { code: "MODEL_TASK_BUDGET_EXHAUSTED", origin: "core", stage: "task_budget", message: "额度不足", retryable: false,
      taskBudget: { version: 1, taskId: "task", roundId: "round", persistent: true,
        task: { maxTotalTokens: 1000, accountedTokens: 1000, knownUsageTokens: 100,
          estimatedReservedTokens: 900, unknownUsageAttempts: 3, exactTokens: false },
        round: { maxTotalTokens: 800, accountedTokens: 700, knownUsageTokens: 100,
          estimatedReservedTokens: 600, unknownUsageAttempts: 2, exactTokens: false } } };
  }
  function settled(): TaskModelBudgetSnapshot {
    const snapshot = structuredClone(refusal().taskBudget!);
    snapshot.task = { ...snapshot.task, accountedTokens: 600, knownUsageTokens: 300, estimatedReservedTokens: 300, unknownUsageAttempts: 2 };
    snapshot.round = { ...snapshot.round, accountedTokens: 500, knownUsageTokens: 300, estimatedReservedTokens: 200, unknownUsageAttempts: 1 };
    return snapshot;
  }

  it("allows only a user retry after real usage lowers both reservations, without mutating the ledger or refusal", () => {
    const error = refusal(), current = settled();
    const original = JSON.stringify({ error, current });
    Object.freeze(current.task); Object.freeze(current.round); Object.freeze(current);
    Object.freeze(error.taskBudget!.task); Object.freeze(error.taskBudget!.round); Object.freeze(error.taskBudget); Object.freeze(error);
    expect(isExplicitModelPlanningRetryable(error, current)).toBe(true);
    expect(JSON.stringify({ error, current })).toBe(original);
    // Other unknown requests may remain. This gate neither declares exact cost
    // nor authorizes replay of any unresolved request.
    expect(current.task.exactTokens).toBe(false);
    expect(current.task.unknownUsageAttempts).toBe(2);
  });

  it("also accepts authoritative not-dispatched settlement without inventing actual usage", () => {
    const current = settled();
    current.task.knownUsageTokens = 100; current.task.accountedTokens = 400;
    current.round.knownUsageTokens = 100; current.round.accountedTokens = 300;
    expect(isExplicitModelPlanningRetryable(refusal(), current)).toBe(true);
  });

  it("rejects missing or unchanged fresh snapshots and missing refusal snapshots", () => {
    const error = refusal();
    expect(isExplicitModelPlanningRetryable(error)).toBe(false);
    expect(isExplicitModelPlanningRetryable(error, structuredClone(error.taskBudget!))).toBe(false);
    expect(isExplicitModelPlanningRetryable({ ...error, taskBudget: undefined }, settled())).toBe(false);
    expect(isExplicitModelPlanningRetryable(undefined, settled())).toBe(false);
  });

  it.each(["taskId", "roundId"] as const)("does not transfer released quota across %s", field => {
    const current = settled(); current[field] = `different-${field}`;
    expect(isExplicitModelPlanningRetryable(refusal(), current)).toBe(false);
  });

  it.each(["task", "round"] as const)("rejects changed %s limits, even when raised or lowered", scope => {
    for (const delta of [-1, 1, 10_000]) {
      const current = settled(); current[scope].maxTotalTokens += delta;
      expect(isExplicitModelPlanningRetryable(refusal(), current)).toBe(false);
    }
  });

  it("requires both task accounting and reservation to fall, not only the current round", () => {
    const error = refusal();
    for (const field of ["accountedTokens", "estimatedReservedTokens"] as const) {
      const current = settled(); current.task[field] = error.taskBudget!.task[field];
      expect(isExplicitModelPlanningRetryable(error, current)).toBe(false);
    }
  });

  it("allows a prior round's late settlement to release the shared cap while the current round stays unchanged", () => {
    const error = refusal(), current = structuredClone(error.taskBudget!);
    current.task = { ...current.task, accountedTokens: 850, knownUsageTokens: 150,
      estimatedReservedTokens: 700, unknownUsageAttempts: 2 };
    expect(isExplicitModelPlanningRetryable(error, current)).toBe(true);
    expect(current.round).toEqual(error.taskBudget!.round);
    expect(current.roundId).toBe(error.taskBudget!.roundId);
  });

  it("does not use a lower task total to excuse increased current-round accounting or reservations", () => {
    const error = refusal();
    for (const field of ["accountedTokens", "estimatedReservedTokens"] as const) {
      const current = settled(); current.round[field] = error.taskBudget!.round[field] + 1;
      expect(isExplicitModelPlanningRetryable(error, current)).toBe(false);
    }
  });

  it.each(["task", "round"] as const)("keeps %s at/over its cap blocked even after reservation reduction", scope => {
    const error = refusal(), current = settled();
    error.taskBudget![scope].accountedTokens = 1600;
    error.taskBudget![scope].estimatedReservedTokens = 1500;
    for (const excess of [0, 1]) {
      current[scope].accountedTokens = current[scope].maxTotalTokens + excess;
      current[scope].estimatedReservedTokens = current[scope].accountedTokens - current[scope].knownUsageTokens;
      expect(isExplicitModelPlanningRetryable(error, current)).toBe(false);
    }
  });

  it("does not trust lower usage, growing uncertainty or internally inconsistent accounting", () => {
    for (const scope of ["task", "round"] as const) {
      const current = settled(); current[scope].knownUsageTokens = 99;
      expect(isExplicitModelPlanningRetryable(refusal(), current)).toBe(false);
      const uncertain = settled(); uncertain[scope].unknownUsageAttempts = 10;
      expect(isExplicitModelPlanningRetryable(refusal(), uncertain)).toBe(false);
      const invalid = settled(); invalid[scope].accountedTokens = 1;
      expect(isExplicitModelPlanningRetryable(refusal(), invalid)).toBe(false);
    }
  });

  it("does not promote untrusted errors or unknown dispatch into task budget recovery", () => {
    const patches: Partial<ModelServiceError>[] = [{ origin: "provider" }, { origin: undefined }, { stage: "request_recovery" },
      { code: "MODEL_DISPATCH_UNKNOWN" }, { code: "MODEL_REQUEST_CONFLICT" }, { code: "MODEL_TASK_BUDGET_EVIDENCE_CONFLICT" }];
    for (const patch of patches) {
      expect(isExplicitModelPlanningRetryable({ ...refusal(), ...patch }, settled())).toBe(false);
    }
  });

  it("rejects malformed native snapshots instead of coercing or treating missing usage as zero", () => {
    for (const patch of [{ version: 2 }, { persistent: false }, { taskId: "" }, { roundId: "" }]) {
      expect(isExplicitModelPlanningRetryable(refusal(), { ...settled(), ...patch } as TaskModelBudgetSnapshot)).toBe(false);
    }
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, "600", undefined]) {
      const current = settled(); (current.task as unknown as Record<string, unknown>).accountedTokens = value;
      expect(isExplicitModelPlanningRetryable(refusal(), current)).toBe(false);
    }
  });

  it("does not change the existing format/operation recovery gate when a task snapshot is supplied", () => {
    expect(isExplicitModelPlanningRetryable({ code: "MODEL_FORMAT_INVALID", message: "format", retryable: false }, settled())).toBe(true);
    expect(isExplicitModelPlanningRetryable({ code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", origin: "core", stage: "recovery_budget",
      message: "elapsed", retryable: false, recoveryBudget: { recoveryBlocked: false } }, settled())).toBe(true);
  });
});
