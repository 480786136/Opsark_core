import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { NextStageDecision, PlanStep, RequirementProcessingResult, StepReview } from "@/types";
import { backend } from "./backend";
import { legacyModelOperationValue, modelOperationResult, ModelOperationBoundaryError, operationPlanProposal } from "./modelOperationBoundary";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const runtime = { apiKey: "fixture", endpoint: "https://test.invalid", model: "fixture", context: "{}" };
const candidate = { id: "s1", action: { type: "shell", command: "uname -a" }, command: "uname -a", title: "检查", description: "检查系统", expected: "返回系统", kind: "observe", risk: "low", status: "pending", validation: "" } as PlanStep;
const decision = (kind: NextStageDecision["decision"], steps: PlanStep[] = []): NextStageDecision => ({ decision: kind, reason: "依据已有证据", summary: "阶段决策", source: "model", steps });
beforeEach(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.resetAllMocks(); });

describe("J1 model operation boundary", () => {
  it.each(["plan.generate", "plan.repair"] as const)("admits %s as a proposal without approval", operation => {
    const result = modelOperationResult(operation, [candidate]);
    expect(operationPlanProposal(result)).toEqual({ operation, steps: [candidate] });
    expect(result).not.toHaveProperty("approvalGrant");
    expect(legacyModelOperationValue(operation, [candidate])).toEqual([candidate]);
  });

  it.each(["continue", "adjust"] as const)("preserves %s candidate stages", kind => {
    const result = modelOperationResult("stage.decide", decision(kind, [candidate]));
    expect(operationPlanProposal(result)).toEqual({ operation: "stage.decide", steps: [candidate] });
    expect(legacyModelOperationValue("stage.decide", decision(kind, [candidate])).decision).toBe(kind);
  });

  it.each(["adjust", "complete"] as const)("does not invent actions for %s without steps", kind => {
    expect(operationPlanProposal(modelOperationResult("stage.decide", decision(kind)))).toBeUndefined();
  });

  it("does not turn classification answers, failed plans, review, draft or probe into proposals", () => {
    const classified: RequirementProcessingResult = { intent: "answer", relation: "new_goal", answer: "已有证据说明服务正在运行", plan: [] };
    const review: StepReview = { decision: "complete", reason: "证据充分", summary: "已完成", source: "model" };
    const draft = { name: "检查服务", category: "other" as const, description: "检查", matchRules: ["服务"], instructions: "仅使用真实证据" };
    for (const result of [
      modelOperationResult("requirement.classify", classified),
      modelOperationResult("requirement.classify", { ...classified, intent: "terminal_context" }),
      modelOperationResult("requirement.classify", { intent: "execute", plan: [candidate], planError: "MODEL_FORMAT_INVALID" }),
      modelOperationResult("result.review", review),
      modelOperationResult("summary.generate", "只总结已有结果"),
      modelOperationResult("skill.draft", draft),
      modelOperationResult("model.probe", { available: true, reason: "接口可用" }),
    ]) expect(operationPlanProposal(result)).toBeUndefined();
    expect(modelOperationResult("requirement.classify", { intent: "execute", plan: [candidate] }).proposal?.steps).toEqual([candidate]);
  });

  it("rejects non-execution results that attempt to carry plans", () => {
    expect(() => modelOperationResult("requirement.classify", { intent: "answer", answer: "回答", plan: [candidate] })).toThrow(ModelOperationBoundaryError);
    expect(() => modelOperationResult("stage.decide", decision("complete", [candidate]))).toThrow(ModelOperationBoundaryError);
    expect(() => modelOperationResult("result.review", { ...decision("continue", [candidate]) })).toThrow(ModelOperationBoundaryError);
  });

  it("routes actual backend answers without another model call or plan repair", async () => {
    const classified: RequirementProcessingResult = { intent: "answer", answer: "这是说明", relation: "new_goal", plan: [] };
    vi.mocked(invoke).mockResolvedValueOnce(classified);
    expect(await backend.processRequirement("说明现有结果", runtime)).toEqual(classified);
    expect(invoke).toHaveBeenCalledOnce();
    vi.mocked(invoke).mockResolvedValueOnce({ ...classified, plan: [candidate] });
    await expect(backend.processRequirement("说明现有结果", runtime)).rejects.toBeInstanceOf(ModelOperationBoundaryError);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not turn an invalid model review into rules-based completion", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(decision("continue", [candidate]));
    await expect(backend.reviewStep("检查", "{}", false, runtime)).rejects.toBeInstanceOf(ModelOperationBoundaryError);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("preserves public summary, draft and model probe shapes through the common result boundary", async () => {
    const draft = { name: "检查", category: "other" as const, description: "说明", matchRules: [], instructions: "检查当前证据" };
    vi.mocked(invoke).mockResolvedValueOnce("已有执行摘要").mockResolvedValueOnce(draft).mockResolvedValueOnce({ available: true, reason: "已验证" });
    expect(await backend.generateSummary("检查", [], runtime)).toBe("已有执行摘要");
    expect(await backend.generateSkill("检查", "generate", runtime)).toEqual(draft);
    expect(await backend.checkModel(runtime)).toEqual({ available: true, reason: "已验证" });
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual(["generate_ai_summary", "generate_ai_skill", "check_ai_model"]);
  });
});
