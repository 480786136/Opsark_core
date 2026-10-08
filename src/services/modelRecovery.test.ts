import { describe, expect, it } from "vitest";
import { ensureModelRecoveryContext, isExplicitModelPlanningRetryable, isModelRecoveryScopeRejection } from "./modelRecovery";
import type { ModelServiceError } from "@/types";

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
