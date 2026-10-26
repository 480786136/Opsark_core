import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { PlanStep } from "@/types";
import { backend, ModelInvocationError, modelServiceError, type RuntimeModel } from "./backend";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const step = (): PlanStep => ({ id: "s", kind: "observe", title: "检查", description: "检查对象", expected: "结果正确", risk: "low", status: "pending",
  command: "", validation: "", evidenceRequirements: ["file_content"], action: { type: "tool", toolId: "files.read_content", arguments: { path: "/fixture" } } });
const runtime: RuntimeModel = { apiKey: "fixture", model: "fixture", endpoint: "https://fixture.invalid", context: JSON.stringify({ permission: "safe",
  _modelRecovery: { operationId: "same-operation", startedAtMs: 123 },
  _taskModelBudget: { taskMaxTotalTokens: 250000, roundMaxTotalTokens: 250000 } }) };
beforeEach(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.restoreAllMocks(); vi.resetAllMocks(); });
const contexts = () => vi.mocked(invoke).mock.calls.map(([, args]) => JSON.parse((args as { context: string }).context));
describe("第二十七批：模拟IPC结构化证据协商与有界恢复", () => {
  it("生成计划协商v1并保留声明，不执行动作", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([step()]);
    const plan = await backend.generatePlan("检查对象", runtime);
    expect(plan[0]?.evidenceRequirements).toEqual(["file_content"]); expect(invoke).toHaveBeenCalledOnce();
    expect(contexts()[0]._planEvidenceContract).toEqual({ version: 1 }); expect(plan[0]?.status).toBe("pending");
  });
  it("联合分类计划协商同一字段，不重复分类", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ intent: "execute", answer: "", selectedSkillIds: [], plan: [step()] });
    const result = await backend.processRequirement("检查对象", runtime);
    expect(result.plan[0]?.evidenceRequirements).toEqual(["file_content"]);
    expect(invoke).toHaveBeenCalledOnce(); expect(contexts()[0]._planEvidenceContract).toEqual({ version: 1 });
  });
  it("下一阶段计划也保留结构化声明", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ decision: "continue", reason: "继续取证", summary: "尚未验收", steps: [step()] });
    const result = await backend.decideNextStage("检查对象", runtime);
    expect(result.steps[0]?.evidenceRequirements).toEqual(["file_content"]);
    expect(invoke).toHaveBeenCalledOnce(); expect(contexts()[0]._planEvidenceContract).toEqual({ version: 1 });
  });
  it("错误工具仅重生成一次完整候选，原预算和操作不变", async () => {
    const wrong = step(); wrong.action = { type: "tool", toolId: "files.preview_deletion", arguments: { paths: ["/fixture"] } };
    vi.mocked(invoke).mockResolvedValueOnce([wrong]).mockResolvedValueOnce([step()]);
    expect((await backend.generatePlan("检查对象", runtime))[0]?.evidenceRequirements).toEqual(["file_content"]);
    expect(invoke).toHaveBeenCalledTimes(2);
    for (const key of ["_taskModelBudget", "_modelRecovery", "permission", "_planEvidenceContract"]) expect(contexts()[1][key]).toEqual(contexts()[0][key]);
    expect(contexts()[1].outputRecovery.diagnostic.candidateRejection.code).toBe("TOOL_EVIDENCE_CAPABILITY_MISMATCH");
  });
  it("畸形声明之后的预算停止保留原始安全原因", async () => {
    const wrong = { ...step(), evidenceRequirements: ["unknown"] } as unknown as PlanStep;
    const stop = new ModelInvocationError("stop", undefined, { code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", origin: "core", stage: "recovery_budget",
      message: "time gate", retryable: false, modelOperationId: "same-operation" });
    vi.mocked(invoke).mockResolvedValueOnce([wrong]).mockRejectedValueOnce(stop);
    const failure = await backend.generatePlan("检查对象", runtime).catch(e => e);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(modelServiceError(failure)).toMatchObject({ code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", candidateRejection: { code: "PLAN_EVIDENCE_REQUIREMENTS_INVALID", rejectedCandidateExecuted: false } });
  });
});
