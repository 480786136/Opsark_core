import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { backend, canRegenerateModelCandidate, exhaustedCandidateRecovery, ModelInvocationError, modelServiceError, modelServiceErrorMessage, PlanProtocolError, preserveCandidateRejection } from "./backend";
import { candidateRejectionMessage, parseCandidateRejection } from "./candidateRejection";
import type { ModelServiceError, PlanStep } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const cause = { version: 1 as const, code: "TOOL_ARGUMENT_INVALID" as const, stepIndex: 0,
  toolIds: ["files.preview_deletion"], keyword: "minItems", rejectedCandidateExecuted: false as const };
function stop(): ModelServiceError {
  return { code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", origin: "core", stage: "recovery_budget", message: "private-stop",
    retryable: false, requestKey: "original-request", modelOperationId: "original-operation", dispatchCertainty: "response_received",
    recoveryBudget: { remainingWaitMs: 88067, requiredWaitMs: 90000, fieldRepairs: 0, candidateRegenerations: 0, generations: 2 } };
}
function rejection() {
  return new PlanProtocolError({ errorCode: "tool_schema_validation_failed", fieldPath: "steps[0].action.arguments.paths",
    validationError: "private-parameter-value", instruction: "private-instruction", previousModelOutput: [{ id: "rejected", title: "private-title",
      action: { type: "tool", toolId: "files.preview_deletion", arguments: { paths: [] } } } as unknown as PlanStep] }, "private-repair");
}
const runtime = { apiKey: "fixture", endpoint: "https://fixture.invalid", model: "fixture", context: "{}" };
function trace(modelError: ModelServiceError) { return "OPSARK_MODEL_TRACE_V1:" + JSON.stringify({ message: "private-envelope", modelError }); }
beforeEach(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.resetAllMocks(); });

describe("第十八批：候选拒绝和派发停止原因链", () => {
  it("只保存有界的程序诊断，拒绝模型参数、任意工具名和伪造执行状态", () => {
    const parsed = parseCandidateRejection({ ...cause, toolIds: ["files.preview_deletion", "private-tool", "files.preview_deletion"],
      rawModelResponse: "private-response", arguments: { password: "private-password" }, message: "private-message" });
    expect(parsed).toEqual(cause);
    expect(JSON.stringify(parsed)).not.toContain("private");
    expect(parseCandidateRejection({ ...cause, rejectedCandidateExecuted: true })).toBeUndefined();
    expect(parseCandidateRejection({ ...cause, code: "private-code" })).toBeUndefined();
    expect(parseCandidateRejection({ ...cause, stepIndex: 10000, keyword: "private-keyword" })).not.toHaveProperty("stepIndex");
    expect(candidateRejectionMessage(parsed)).toContain("工具参数列表条目不足");
  });

  it("原生双原因经IPC及归档JSON恢复后仍保持预算和原请求身份，且不触发第三次请求", async () => {
    const original = { ...stop(), candidateRejection: cause };
    vi.mocked(invoke).mockRejectedValueOnce(trace(original));
    const error = await backend.generatePlan("读取配置正文", runtime).catch(error => error);
    expect(error).toBeInstanceOf(ModelInvocationError);
    const saved = JSON.parse(JSON.stringify({ modelError: modelServiceError(error) }));
    const restored = modelServiceError(new Error(JSON.stringify(saved)))!;
    expect(restored).toEqual(original);
    const message = modelServiceErrorMessage(restored);
    expect(message).toContain("原候选第 1 步"); expect(message).toContain("工具参数列表条目不足");
    expect(message).toContain("88.067"); expect(message).toContain("90");
    expect(message).not.toContain("private");
    expect(canRegenerateModelCandidate(error)).toBe(false);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("前端拒绝后新方案被时间守门拦截，只附加安全首因且保留当前停止代码", () => {
    const original = new ModelInvocationError("stop", undefined, stop());
    const result = exhaustedCandidateRecovery(original, "budget_exhausted", rejection());
    const parsed = modelServiceError(result)!;
    const { keyword: _keyword, ...frontendCause } = cause;
    expect(parsed).toMatchObject({ ...stop(), candidateRejection: frontendCause });
    expect(parsed.candidateRejection).not.toHaveProperty("keyword");
    expect(JSON.stringify(parsed)).not.toContain("private-parameter");
    expect(modelServiceErrorMessage(parsed)).toContain("工具参数未通过校验");
    expect(canRegenerateModelCandidate(result)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("已有首因在多层传递中不被较晚候选覆盖", () => {
    const first = new ModelInvocationError("first", undefined, { ...stop(), candidateRejection: cause });
    const terminal = new ModelInvocationError("terminal", undefined, stop());
    const result = preserveCandidateRejection(terminal, first);
    expect(modelServiceError(result)?.candidateRejection).toEqual(cause);
    const final = preserveCandidateRejection(result, rejection());
    expect(modelServiceError(final)?.candidateRejection).toEqual(cause);
  });

  it("分类成功但计划停止时保留分类及诊断，不重新分类或创建计划", async () => {
    const classified = { intent: "execute", relation: "new_goal", selectedSkillIds: [], plan: [], planError: trace({ ...stop(), candidateRejection: cause }) };
    vi.mocked(invoke).mockResolvedValueOnce(classified);
    const result = await backend.processRequirement("读取配置正文", runtime);
    expect(result).toMatchObject({ intent: "execute", relation: "new_goal", plan: [] });
    expect(modelServiceError(result.planError)?.candidateRejection).toEqual(cause);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("取消或目标更正的旧操作错误保持原对象，诊断不授予恢复权限", async () => {
    const stale = new Error("目标已更正：旧操作失效");
    expect(preserveCandidateRejection(stale, rejection())).toBe(stale);
    let cancelled = false;
    vi.mocked(invoke).mockImplementationOnce(async () => { cancelled = true; throw trace({ ...stop(), candidateRejection: cause }); });
    await expect(backend.generatePlan("读取配置正文", { ...runtime, assertCurrent() { if (cancelled) throw stale; } })).rejects.toBe(stale);
    expect(invoke).toHaveBeenCalledOnce();
  });
});
