import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { backend, ModelInvocationError } from "./backend";
import type { RuntimeModel } from "./backend";
import type { ModelServiceError, PlanStep, RequirementProcessingResult } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const candidate: PlanStep = { id: "read", title: "核对环境", description: "读取系统信息", kind: "observe",
  action: { type: "shell", command: "uname -a" }, command: "uname -a", expected: "取得系统信息",
  validation: "", risk: "low", status: "pending" };
const constraints = { changePolicy: "read_only" as const, environmentPolicy: "preserve" as const,
  failurePolicy: "strict" as const, prohibitedActions: [], requiredConditions: [], userDirectives: ["只读"] };
function runtime(): RuntimeModel {
  return { apiKey: "fixture", endpoint: "https://fixture.invalid", model: "fixture",
    context: JSON.stringify({ taskGoal: { rootGoal: "读取系统信息" }, permission: "safe",
      executionConstraints: { changePolicy: "read_only" }, knownExecutionFacts: { inspected: true } }) };
}
function failure(code = "MODEL_FORMAT_INVALID", stage = "json_parse", extra: Partial<ModelServiceError> = {}) {
  return "OPSARK_MODEL_TRACE_V1:" + JSON.stringify({ message: "candidate rejected", modelError: {
    code, stage, origin: "core", message: "candidate rejected", retryable: false,
    dispatchCertainty: "response_received", recoveryBudget: { recoveryBlocked: false }, ...extra,
  } });
}
function requestContext(index: number) {
  return JSON.parse((vi.mocked(invoke).mock.calls[index][1] as { context: string }).context);
}

beforeEach(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.resetAllMocks(); });

describe("candidate output recovery through the backend boundary", () => {
  it.each([
    ["MODEL_FORMAT_INVALID", "json_parse"],
    ["MODEL_OUTPUT_TRUNCATED", "response_status"],
    ["MODEL_OUTPUT_REPAIR_EXHAUSTED", "output_recovery"],
  ])("regenerates %s once with the original budget and authority", async (code, stage) => {
    vi.mocked(invoke).mockRejectedValueOnce(failure(code, stage)).mockResolvedValueOnce([candidate]);
    const original = runtime();
    const result = await backend.generatePlan("读取系统信息", original);
    expect(result[0].command).toBe("uname -a");
    expect(invoke).toHaveBeenCalledTimes(2);
    const first = requestContext(0), regenerated = requestContext(1);
    expect(first._modelOutputRecovery.strategy).toBe("initial");
    expect(regenerated._modelOutputRecovery.strategy).toBe("regenerate");
    expect(regenerated._modelRecovery).toEqual(first._modelRecovery);
    for (const key of ["taskGoal", "permission", "executionConstraints", "knownExecutionFacts"]) {
      expect(regenerated[key]).toEqual(first[key]);
    }
    expect(regenerated.planGenerationRepair).toBeUndefined();
    expect(regenerated.outputRecovery.diagnostic.code).toBe(code);
    expect(JSON.parse(original.context)._modelRecovery).toBeUndefined();
  });

  it("stops after the fresh candidate fails, without starting a third generation", async () => {
    vi.mocked(invoke).mockRejectedValue(failure());
    await expect(backend.generatePlan("读取系统信息", runtime())).rejects.toBeInstanceOf(ModelInvocationError);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["MODEL_AUTH_UNAVAILABLE", "request_auth"],
    ["MODEL_DISPATCH_UNKNOWN", "request_recovery"],
    ["MODEL_RECOVERY_BUDGET_EXHAUSTED", "recovery_budget"],
    ["MODEL_OUTPUT_REFUSED", "response_status"],
  ])("does not reinterpret %s as a candidate error", async (code, stage) => {
    vi.mocked(invoke).mockRejectedValue(failure(code, stage));
    await expect(backend.generatePlan("读取系统信息", runtime())).rejects.toBeInstanceOf(ModelInvocationError);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("recovers the classified plan without reclassifying the requirement or losing constraints", async () => {
    const classified: RequirementProcessingResult = { intent: "execute", relation: "new_goal", answer: "",
      constraints, selectedSkillIds: [], plan: [], planError: failure() };
    vi.mocked(invoke).mockResolvedValueOnce(classified).mockResolvedValueOnce([candidate]);
    const result = await backend.processRequirement("读取系统信息", runtime());
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual(["process_ai_requirement", "generate_ai_plan"]);
    expect(result).toMatchObject({ intent: "execute", relation: "new_goal", constraints: classified.constraints,
      selectedSkillIds: [], plan: [expect.objectContaining({ command: "uname -a" })] });
    expect(result.planError).toBeUndefined();
    expect(requestContext(1)._modelRecovery).toEqual(requestContext(0)._modelRecovery);
    expect(requestContext(1)._modelOutputRecovery.strategy).toBe("regenerate");
    expect(requestContext(1).executionConstraints.changePolicy).toBe("read_only");
  });

  it("preserves successful classification when the fresh plan also fails", async () => {
    const classified: RequirementProcessingResult = { intent: "execute", relation: "continue", constraints,
      selectedSkillIds: [], plan: [], planError: failure() };
    vi.mocked(invoke).mockResolvedValueOnce(classified).mockRejectedValueOnce(failure());
    const result = await backend.processRequirement("继续核对", runtime());
    expect(result).toMatchObject({ intent: "execute", relation: "continue", constraints: classified.constraints, plan: [] });
    expect(result.planError).toContain("MODEL_FORMAT_INVALID");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not regenerate after cancellation while the first request was in flight", async () => {
    let cancelled = false;
    const stale = new Error("stale operation");
    vi.mocked(invoke).mockImplementationOnce(async () => { cancelled = true; throw failure(); });
    await expect(backend.generatePlan("读取系统信息", { ...runtime(), assertCurrent() { if (cancelled) throw stale; } })).rejects.toBe(stale);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("does not expand a caller's metadata-only operation to a whole candidate", async () => {
    vi.mocked(invoke).mockRejectedValue(failure());
    const scoped = runtime();
    scoped.context = JSON.stringify({ ...JSON.parse(scoped.context), operationalRepair: { rejectedProposal: { responseMode: "metadata_fields" } } });
    await expect(backend.generatePlan("仅修正验收引用", scoped)).rejects.toBeInstanceOf(ModelInvocationError);
    expect(invoke).toHaveBeenCalledOnce();
  });
});
