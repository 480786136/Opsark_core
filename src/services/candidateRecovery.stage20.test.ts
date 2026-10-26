import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { backend, ModelInvocationError, modelCandidateDiagnostic, modelServiceError, type RuntimeModel } from "./backend";
import { protocolReplanContext } from "@/features/agent/protocolReplan";
import { decideTaskNextStage } from "@/features/agent/agentService";
import { candidateRejectionFromPlan } from "./candidateRejection";
import type { ModelProfile, ModelServiceError, NextStageDecision, OpsTask, PlanStep } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const cause = { version: 1 as const, code: "TOOL_ARGUMENT_INVALID" as const, stepIndex: 0,
  toolIds: ["files.preview_deletion"], keyword: "minItems", rejectedCandidateExecuted: false as const };
const model: ModelProfile = { id: "model", name: "fixture", provider: "Remote", model: "fixture", endpoint: "https://fixture.invalid", enabled: true, hasApiKey: true };
const runtime = { apiKey: "fixture", model: "fixture", endpoint: "https://fixture.invalid", context: JSON.stringify({ permission: "safe", executionConstraints: { changePolicy: "read_only" } }) };
function originalError() {
  return new ModelInvocationError("rejected", undefined, { code: "MODEL_FORMAT_INVALID", stage: "business_validation", origin: "core", message: "private-prose", retryable: false,
    dispatchCertainty: "response_received", jsonPointer: "/steps/0/action/arguments/paths", keyword: "minItems", candidateRejection: cause });
}
function stopError() {
  return new ModelInvocationError("stop", undefined, { code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", origin: "core", stage: "recovery_budget", message: "private-stop", retryable: false,
    modelOperationId: "original-operation", requestKey: "original-request", recoveryBudget: { remainingWaitMs: 88067, requiredWaitMs: 90000, fieldRepairs: 0, candidateRegenerations: 0 } });
}
function proposal(toolId: "files.read_content" | "files.preview_deletion"): PlanStep {
  return { id: "unexecuted", title: "取证", description: "模型候选", command: "", validation: "", expected: "真实结果", risk: "low", kind: "observe", status: "pending",
    action: { type: "tool", toolId, arguments: toolId === "files.read_content" ? { path: "/srv/config.json", maxBytes: 4096 } : { paths: ["/srv/config.json"] } } };
}
function task(): OpsTask {
  return { id: "task", serverId: "server", currentRoundId: "round", title: "读取配置", rootGoal: "读取配置", status: "needs_adjustment", permission: "safe", modelId: "model",
    createdAt: "2026-10-23", updatedAt: "2026-10-23", plan: [], messages: [],
    executionConstraints: { changePolicy: "read_only", environmentPolicy: "preserve", failurePolicy: "strict", prohibitedActions: [], requiredConditions: [], userDirectives: ["只读"] },
    protocolRepair: { serverId: "server", roundId: "round", repairError: "候选尚未执行", repair: {
      errorCode: "tool_schema_validation_failed", fieldPath: "steps[0].action.arguments.paths", validationError: "invalid arguments", instruction: "重新规划",
      previousModelOutput: [proposal("files.preview_deletion")], candidateRejection: cause,
      modelRecovery: { operationId: "saved-operation", startedAtMs: 123456 } } } };
}
function input(saved: OpsTask) {
  return { task: saved, model, apiKey: "fixture", tools: [], skills: [], secretMetadata: [],
    generationSettings: { limitOutput: false, maxPlanSteps: 6, maxOutputTokens: 5000, maxTextChars: 200, maxCommandChars: 4000 } };
}
beforeEach(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("第二十批：候选恢复的已知工具身份及归档首因", () => {
  it("原生首因中的安全工具身份进入重生成诊断，不复制参数或模型正文", () => {
    const diagnostic = modelCandidateDiagnostic(originalError());
    expect(diagnostic.candidateRejection).toEqual(cause);
    expect(diagnostic.rejectedToolIds).toEqual(["files.preview_deletion"]);
    expect(JSON.stringify(diagnostic)).not.toContain("private-prose");
  });

  it.each(["files.read_content", "files.preview_deletion"] as const)("反馈到实际IPC而不替换合法新候选：%s", async toolId => {
    const error = modelServiceError(originalError())!;
    vi.mocked(invoke).mockRejectedValueOnce("OPSARK_MODEL_TRACE_V1:" + JSON.stringify({ message: "rejected", modelError: error })).mockResolvedValueOnce([proposal(toolId)]);
    const result = await backend.generatePlan("读取配置正文", runtime);
    expect(invoke).toHaveBeenCalledTimes(2);
    const contexts = vi.mocked(invoke).mock.calls.map(([, args]) => JSON.parse((args as { context: string }).context));
    expect(contexts[1].outputRecovery.diagnostic.candidateRejection).toEqual(cause);
    expect(contexts[1].outputRecovery.diagnostic.rejectedToolIds).toEqual(["files.preview_deletion"]);
    expect(contexts[1]._modelRecovery).toEqual(contexts[0]._modelRecovery);
    expect(contexts[1].permission).toBe("safe"); expect(contexts[1].executionConstraints).toEqual(contexts[0].executionConstraints);
    expect(result[0].action).toEqual(proposal(toolId).action); expect(result[0].status).toBe("pending");
  });

  it("归档协议记录的重规划上下文保留安全工具首因", () => {
    const saved = task(), before = JSON.stringify(saved);
    expect(protocolReplanContext(saved)?.candidateRejection).toEqual(cause);
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("归档记录恢复后被时间守门停止，保留原首因及预算，不新建恢复身份", async () => {
    const saved = JSON.parse(JSON.stringify(task())) as OpsTask, before = JSON.stringify(saved);
    const decide = vi.fn<(requirement: string, runtime?: RuntimeModel) => Promise<NextStageDecision>>().mockRejectedValue(stopError());
    const error = await decideTaskNextStage(input(saved), decide).catch(error => error);
    expect(modelServiceError(error)?.candidateRejection).toEqual(cause);
    expect(modelServiceError(error)).toMatchObject(modelServiceError(stopError())!);
    expect(decide).toHaveBeenCalledOnce();
    const context = JSON.parse(decide.mock.calls[0][1]!.context);
    expect(context._modelRecovery).toEqual(saved.protocolRepair!.repair.modelRecovery);
    expect(context.protocolReplan.candidateRejection).toEqual(cause);
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("只标记被诊断步骤的已知工具，不复制其他步骤或参数", () => {
    const saved = task().protocolRepair!.repair;
    saved.candidateRejection = undefined; saved.fieldPath = "steps[1].action.arguments.paths";
    saved.previousModelOutput = [proposal("files.read_content"), proposal("files.preview_deletion")];
    const diagnostic = candidateRejectionFromPlan(saved)!;
    expect(diagnostic.toolIds).toEqual(["files.preview_deletion"]); expect(diagnostic.stepIndex).toBe(1);
    expect(JSON.stringify(diagnostic)).not.toContain("config.json");
    expect(JSON.stringify(diagnostic)).not.toContain("maxBytes");
  });

  it("未经校验的首因附加字段和工具名不进入新反馈", () => {
    const error = originalError();
    error.modelError!.candidateRejection = { ...cause, toolIds: ["private-unknown-tool", "files.preview_deletion"],
      rawResponse: "private-response", arguments: { password: "private-password" } } as typeof cause;
    const diagnostic = modelCandidateDiagnostic(error);
    expect(diagnostic.candidateRejection).toEqual(cause);
    expect(JSON.stringify(diagnostic)).not.toContain("private");
    expect(JSON.stringify(diagnostic)).not.toContain("password");
  });

  it("旧归档缺少候选数组时保持可解释，不猜测工具或重新执行", () => {
    const saved = task(); saved.protocolRepair!.repair.candidateRejection = undefined;
    Reflect.deleteProperty(saved.protocolRepair!.repair, "previousModelOutput");
    const context = protocolReplanContext(saved)!;
    expect(context.rejectedStepCount).toBe(0);
    expect(context.candidateRejection?.toolIds).toBeUndefined();
    expect(context.candidateRejection?.rejectedCandidateExecuted).toBe(false);
    expect(saved.plan).toEqual([]);
  });

  it.each(["round", "target"])("旧%s的归档首因不传给当前操作", async boundary => {
    const saved = task();
    if (boundary === "round") saved.currentRoundId = "new-round";
    else saved.executionTargetServerId = "new-server";
    expect(protocolReplanContext(saved)).toBeUndefined();
    const stop = stopError(), decide = vi.fn<(requirement: string, runtime?: RuntimeModel) => Promise<NextStageDecision>>().mockRejectedValue(stop);
    const error = await decideTaskNextStage(input(saved), decide).catch(error => error);
    expect(modelServiceError(error)).toEqual(modelServiceError(stop)); expect(decide).toHaveBeenCalledOnce();
    const context = JSON.parse(decide.mock.calls[0][1]!.context);
    expect(context.protocolReplan).toBeUndefined();
    expect(context._modelRecovery.operationId).not.toBe(saved.protocolRepair!.repair.modelRecovery!.operationId);
  });

  it("分类内嵌计划失败的重生成也保留工具身份，不重新分类", async () => {
    const planError = "OPSARK_MODEL_TRACE_V1:" + JSON.stringify({ message: "rejected", modelError: modelServiceError(originalError()) });
    vi.mocked(invoke).mockResolvedValueOnce({ intent: "execute", relation: "new_goal", plan: [], selectedSkillIds: [], planError })
      .mockResolvedValueOnce([proposal("files.read_content")]);
    const result = await backend.processRequirement("读取配置正文", runtime);
    expect(result.planError).toBeUndefined();
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual(["process_ai_requirement", "generate_ai_plan"]);
    const context = JSON.parse((vi.mocked(invoke).mock.calls[1][1] as { context: string }).context);
    expect(context.outputRecovery.diagnostic.candidateRejection).toEqual(cause);
    expect(context.outputRecovery.diagnostic.rejectedToolIds).toEqual(cause.toolIds);
  });

  it("上游错误即使携带相同首因，也不能因此重生成候选", async () => {
    const error: ModelServiceError = { ...modelServiceError(originalError())!, origin: "provider" };
    vi.mocked(invoke).mockRejectedValueOnce("OPSARK_MODEL_TRACE_V1:" + JSON.stringify({ modelError: error }));
    await expect(backend.generatePlan("读取配置正文", runtime)).rejects.toBeInstanceOf(ModelInvocationError);
    expect(invoke).toHaveBeenCalledOnce();
    expect(modelCandidateDiagnostic(new ModelInvocationError("provider", undefined, error))).not.toHaveProperty("candidateRejection");
  });
});
