import { describe, expect, it } from "vitest";
import { ModelInvocationError } from "./backend";
import { parseTaskBudgetAdmission, parseOutputBudgetAdjustment } from "@/features/agent/taskModelBudget";

const fixture = { version: 1, inputEstimateIsExact: false, usageEstimator: "complete-wire-utf8-bytes-plus-output-cap-plus-1024",
  lane: "business", requestBytes: 120_224, outputTokenLimit: 5_000, estimationOverheadTokens: 1_024, requiredReservedTokens: 126_248,
  scopes: { task: { knownUsageTokens: 146_393, availableTokens: 103_607, reservationShortfallTokens: 22_641,
    blockedReasons: ["total_tokens", "secret reason"], secret: "never-copy" }, round: { availableTokens: 103_607 } },
  prompt: "never-copy", credential: "never-copy" };
describe("任务预算准入诊断安全投影", () => {
  it("keeps exact admission numbers through the normal error boundary and removes arbitrary text", () => {
    const failure = new ModelInvocationError("ignored", undefined, {
      code: "MODEL_TASK_BUDGET_EXHAUSTED", origin: "core", stage: "task_budget", retryable: false,
      message: "budget stopped", taskBudgetAdmission: fixture as never,
    });
    expect(failure.modelError?.taskBudgetAdmission).toMatchObject({ requiredReservedTokens: 126_248, inputEstimateIsExact: false,
      scopes: { task: { availableTokens: 103_607, blockedReasons: ["total_tokens"] } } });
    expect(JSON.stringify(failure.modelError)).not.toContain("never-copy");
    expect(JSON.stringify(failure.modelError)).not.toContain("secret reason");
  });
  it("does not adopt provider metadata as a local budget admission", () => {
    const failure = new ModelInvocationError("ignored", undefined, {
      code: "MODEL_TASK_BUDGET_EXHAUSTED", origin: "provider", stage: "task_budget", retryable: false,
      message: "provider claim", taskBudgetAdmission: fixture as never,
    });
    expect(failure.modelError?.taskBudgetAdmission).toBeUndefined();
  });
  it("rejects unknown versions or claims of exact tokens and omits invalid numeric fields", () => {
    expect(parseTaskBudgetAdmission({ ...fixture, version: 2 })).toBeUndefined();
    expect(parseTaskBudgetAdmission({ ...fixture, inputEstimateIsExact: true })).toBeUndefined();
    expect(parseTaskBudgetAdmission({ ...fixture, requestBytes: Infinity, requiredReservedTokens: -1 })).toMatchObject({ version: 1 });
    expect(parseTaskBudgetAdmission({ ...fixture, requestBytes: Infinity })?.requestBytes).toBeUndefined();
  });
  it("projects output ceiling adjustments without prompts or billing guarantees", () => {
    const raw = { version: 1, originalOutputTokenLimit: 16384, effectiveOutputTokenLimit: 13609,
      inputEstimateIsExact: false, actualBillingLimitGuaranteed: false, providerMinimumDeclared: false,
      credential: "never-copy", prompt: "never-copy", availableTokens: 146459 };
    expect(parseOutputBudgetAdjustment(raw)).toMatchObject({ originalOutputTokenLimit: 16384, effectiveOutputTokenLimit: 13609,
      availableTokens: 146459, actualBillingLimitGuaranteed: false });
    expect(JSON.stringify(parseOutputBudgetAdjustment(raw))).not.toContain("never-copy");
    expect(parseOutputBudgetAdjustment({ ...raw, actualBillingLimitGuaranteed: true })).toBeUndefined();
  });
});
