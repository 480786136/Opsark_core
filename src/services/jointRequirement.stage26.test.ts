import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { backend, ModelInvocationError, modelServiceError } from "./backend";
import { assertTaskPlanAuthorization } from "@/features/agent/recoveryContract";
import type { OpsTask, PlanStep, RequirementProcessingResult } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const step = (): PlanStep => ({ id: "joint-proposal", kind: "observe", title: "读取配置B", description: "只读读取配置B",
  expected: "获得配置B正文", action: { type: "tool", toolId: "files.read_content", arguments: { path: "/srv/B.json" } },
  command: "", validation: "", risk: "low", status: "pending" });
const constraints = { changePolicy: "read_only" as const, environmentPolicy: "preserve" as const, failurePolicy: "strict" as const,
  prohibitedActions: [], requiredConditions: [], userDirectives: [] };
const result = (): RequirementProcessingResult => ({ intent: "execute", relation: "supplement", plan: [step()], constraints,
  selectedSkillIds: [], developerTrace: { attempts: [] } });
const runtime = { apiKey: "fixture", model: "fixture", endpoint: "https://fixture.invalid",
  context: JSON.stringify({ permission: "observe", _log: { taskId: "task", roundId: "round" },
    _modelRecovery: { operationId: "same-operation", startedAtMs: 123 },
    _taskModelBudget: { version: 1, taskId: "task", roundId: "round", taskMaxTotalTokens: 250000, roundMaxTotalTokens: 250000 }, executionConstraints: constraints }) };
beforeEach(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("第二十六批：联合原生结果进入既有前端边界（模拟IPC）", () => {
  it("正常联合结果只调用一次原生入口，计划仍为待执行且没有批准", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(result());
    const accepted = await backend.processRequirement("读取配置B", runtime);
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual(["process_ai_requirement"]);
    expect(accepted.plan[0]).toMatchObject({ status: "pending", action: { toolId: "files.read_content" } });
    expect(accepted.plan[0]!.approvalGrant).toBeUndefined();
  });
  it("联合结果选错正文工具时仍经第二十五批校验，只恢复计划而不重新分类", async () => {
    const wrong = result();
    wrong.plan[0]!.action = { type: "tool", toolId: "files.preview_deletion", arguments: { paths: ["/srv/B.json"] } };
    vi.mocked(invoke).mockResolvedValueOnce(wrong).mockResolvedValueOnce([step()]);
    const accepted = await backend.processRequirement("读取配置B", runtime);
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual(["process_ai_requirement", "generate_ai_plan"]);
    expect(accepted.relation).toBe("supplement"); expect(accepted.constraints).toEqual(constraints);
    const contexts = vi.mocked(invoke).mock.calls.map(([, args]) => JSON.parse((args as { context: string }).context));
    for (const key of ["_modelRecovery", "_taskModelBudget", "permission"]) expect(contexts[1][key]).toEqual(contexts[0][key]);
    expect(contexts[1].outputRecovery.diagnostic.candidateRejection.code).toBe("TOOL_EVIDENCE_CAPABILITY_MISMATCH");
  });
  it("联合结果后的时间停止保留分类和能力首因，不提高预算", async () => {
    const wrong = result();wrong.plan[0]!.action = { type: "tool", toolId: "files.preview_deletion", arguments: { paths: ["/srv/B.json"] } };
    const stop = new ModelInvocationError("stop", undefined, { code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", origin: "core", stage: "recovery_budget",
      message: "stop", retryable: false, modelOperationId: "same-operation" });
    vi.mocked(invoke).mockResolvedValueOnce(wrong).mockRejectedValueOnce(stop);
    const accepted = await backend.processRequirement("读取配置B", runtime);
    expect(invoke).toHaveBeenCalledTimes(2); expect(accepted.relation).toBe("supplement"); expect(accepted.plan).toEqual([]);
    expect(modelServiceError(accepted.planError)).toMatchObject({ code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", modelOperationId: "same-operation",
      candidateRejection: { code: "TOOL_EVIDENCE_CAPABILITY_MISMATCH" } });
  });
  it("旁问联合结果不会生成计划或触发后续模型调用", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ intent: "answer", relation: "side_question", answer: "说明", plan: [], selectedSkillIds: [] });
    expect((await backend.processRequirement("解释一下", runtime)).plan).toEqual([]); expect(invoke).toHaveBeenCalledOnce();
  });
  it("在途用户更改使联合结果过期时拒绝接纳，不自动再发请求", async () => {
    let current = true;
    vi.mocked(invoke).mockImplementationOnce(async () => { current = false; return result(); });
    await expect(backend.processRequirement("读取配置B", { ...runtime, assertCurrent: () => { if (!current) throw new Error("当前需求已更改"); } })).rejects.toThrow("当前需求已更改");
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("联合计划不扩大只读权限，原任务授权检查仍拒绝变更", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(result());
    const accepted = await backend.processRequirement("读取配置B", runtime);
    const task = { executionConstraints: accepted.constraints } as OpsTask;
    expect(() => assertTaskPlanAuthorization(task, accepted.plan)).not.toThrow();
    expect(() => assertTaskPlanAuthorization(task, [{ ...step(), kind: "change" }])).toThrow("只读授权");
  });
});
