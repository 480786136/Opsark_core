import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import frozen from "../../tests/fixtures/tool-evidence-stage24.json";
import { backend, ModelInvocationError, modelServiceError, type RuntimeModel } from "./backend";
import { candidateRejectionMessage } from "./candidateRejection";
import type { PlanStep } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const wrong = (): PlanStep[] => JSON.parse(JSON.stringify(frozen[0]!["模型原文解析"].steps))
  .map((step: PlanStep) => ({ ...step, id: "candidate", status: "pending", command: "" }));
const runtime: RuntimeModel = { apiKey: "fixture", endpoint: "https://fixture.invalid", model: "fixture",
  context: JSON.stringify({ permission: "safe", tools: [], _modelRecovery: { operationId: "original", startedAtMs: 123 },
    _taskModelBudget: { taskId: "task", roundId: "round", taskMaxTotalTokens: 250000, roundMaxTotalTokens: 250000 },
    executionConstraints: { changePolicy: "confirm_changes" } }) };
beforeEach(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("第二十五批：通过原生适配入口验证有界候选恢复（模拟IPC，无真实模型）", () => {
  it("拒绝原A候选后只重生成一次完整候选，保留原预算与权限，正确读取工具仍需后续审批", async () => {
    const replacement = wrong();
    replacement[0]!.action = { type: "tool", toolId: "files.read_content", arguments: { path: "/srv/independent.json" } };
    vi.mocked(invoke).mockResolvedValueOnce(wrong()).mockResolvedValueOnce(replacement);
    const result = await backend.generatePlan("读取配置正文", runtime);
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual(["generate_ai_plan", "generate_ai_plan"]);
    const contexts = vi.mocked(invoke).mock.calls.map(([, args]) => JSON.parse((args as { context: string }).context));
    expect(contexts[1]._modelOutputRecovery.strategy).toBe("regenerate");
    for (const key of ["_modelRecovery", "_taskModelBudget", "permission", "executionConstraints"])
      expect(contexts[1][key]).toEqual(contexts[0][key]);
    expect(contexts[1].outputRecovery.diagnostic.candidateRejection).toMatchObject({ code: "TOOL_EVIDENCE_CAPABILITY_MISMATCH", toolIds: ["files.preview_deletion"] });
    expect(result[0]).toMatchObject({ status: "pending", action: { toolId: "files.read_content" } });
    expect(result[0]!.approvalGrant).toBeUndefined();
  });
  it("第二个候选仍错则停止，不循环；持久化安全首因不包含文件路径", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(wrong()).mockResolvedValueOnce(wrong());
    const failure = await backend.generatePlan("读取配置正文", runtime).catch(error => error);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(failure.repair.candidateRejection).toMatchObject({ code: "TOOL_EVIDENCE_CAPABILITY_MISMATCH", rejectedCandidateExecuted: false });
    expect(JSON.stringify(failure.repair.candidateRejection)).not.toContain("/opt/");
  });
  it("时间守门拒绝重生成时保留正文能力首因，不把停止改报为上游失败", async () => {
    const stop = new ModelInvocationError("stop", undefined, { code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", origin: "core", stage: "recovery_budget",
      message: "time gate", retryable: false, modelOperationId: "original", recoveryBudget: { remainingWaitMs: 88870, requiredWaitMs: 90000 } });
    vi.mocked(invoke).mockResolvedValueOnce(wrong()).mockRejectedValueOnce(stop);
    const failure = await backend.generatePlan("读取配置正文", runtime).catch(error => error);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(modelServiceError(failure)).toMatchObject({ code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", modelOperationId: "original",
      candidateRejection: { code: "TOOL_EVIDENCE_CAPABILITY_MISMATCH", rejectedCandidateExecuted: false } });
    expect(candidateRejectionMessage(modelServiceError(failure)?.candidateRejection)).toContain("正文");
  });
});
