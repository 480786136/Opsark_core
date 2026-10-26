import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import fixture from "../../tests/fixtures/joint-requirement-stage30.json";
import { backend, modelServiceError, modelServiceErrorMessage } from "./backend";
import type { RuntimeModel } from "./backend";
import type { ModelServiceError, PlanStep, RequirementProcessingResult } from "@/types";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const error = (): ModelServiceError => ({ ...clone(fixture.modelError) as ModelServiceError,
  modelOperationId: "offline-operation", recoveryBudget: { ...fixture.modelError.recoveryBudget, modelOperationId: "offline-operation" } });
function classified(): RequirementProcessingResult {
  const raw = clone(fixture.response);
  const update = raw.requirementUpdate as unknown as { acceptanceCoverage: Array<Record<string, unknown>> };
  update.acceptanceCoverage.forEach(item => delete item.staticSite);
  return { intent: "execute", relation: "new_goal", selectedSkillIds: [], constraints: raw.constraints as RequirementProcessingResult["constraints"],
    plan: [], requirementUpdate: raw.requirementUpdate as unknown as RequirementProcessingResult["requirementUpdate"],
    planError: `OPSARK_MODEL_TRACE_V1:${JSON.stringify({ modelError: error() })}` };
}
function runtime(): RuntimeModel {
  return { model: "offline", endpoint: "https://fixture.invalid", apiKey: "fixture",
    context: JSON.stringify({ ...clone(fixture.context), permission: "observe",
      _log: { taskId: "offline-task", roundId: "offline-round", _modelTokenBudget: { version: 1, maxTaskTokens: 250000, maxRoundTokens: 250000, coverage: "complete" } },
      _taskModelBudget: { version: 1, taskId: "offline-task", roundId: "offline-round" },
      _modelRecovery: { operationId: "offline-operation", startedAtMs: Date.now(), maxElapsedMs: 360000 } }) };
}
const step = (): PlanStep => ({ id: "fresh-candidate", title: "读取配置正文", description: "只读读取配置正文", expected: "取得配置正文",
  kind: "observe", risk: "low", status: "pending", command: "", validation: "", evidenceRequirements: ["file_content"],
  action: { type: "tool", toolId: "files.read_content", arguments: { path: "/opt/opsark-core-test-20261025-stage30/AGENT-22/配置A.json" } } });
function modelCalls() { return vi.mocked(invoke).mock.calls.filter(([name]) => name !== "register_task_model_budget"); }
function mockCommands(plan: () => unknown | Promise<unknown>, first: () => unknown = classified) {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "register_task_model_budget") return undefined;
    if (command === "process_ai_requirement") return first();
    if (command === "generate_ai_plan") return plan();
    throw new Error(`unexpected IPC ${command}`);
  });
}
beforeEach(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.resetAllMocks(); });

describe("第三十一批：联合分类复用和既有有界恢复（模拟IPC，无真实请求）", () => {
  it("只恢复独立有效分类的计划，保留原25万额度、操作及确认条件", async () => {
    mockCommands(() => [step()]); const original = runtime(); const result = await backend.processRequirement(fixture.requirement, original);
    expect(modelCalls().map(([name]) => name)).toEqual(["process_ai_requirement", "generate_ai_plan"]);
    const contexts = modelCalls().map(([, args]) => JSON.parse((args as { context: string }).context));
    expect(contexts[1]._modelOutputRecovery.strategy).toBe("regenerate");
    for (const key of ["_modelRecovery", "_taskModelBudget", "permission"]) expect(contexts[1][key]).toEqual(contexts[0][key]);
    expect(contexts[1].executionConstraints.changePolicy).toBe("confirm_changes");
    expect(contexts[1].executionConstraints.requiredConditions).toContain("执行前让我看一下计划");
    expect(contexts[1].outputRecovery.diagnostic.candidateRejection).toMatchObject({ code: "TOOL_ARGUMENT_INVALID", toolIds: ["files.preview_deletion"] });
    expect(contexts[1].planGenerationRepair).toBeUndefined();
    expect(result.planError).toBeUndefined(); expect(result.plan[0]).toMatchObject({ status: "pending", action: { toolId: "files.read_content" } });
    expect(result.plan[0].approvalGrant).toBeUndefined();
    expect(result.relation).toBe("new_goal"); expect(result.requirementUpdate).toEqual(classified().requirementUpdate);
    const registrations = vi.mocked(invoke).mock.calls.filter(([name]) => name === "register_task_model_budget");
    expect(registrations).toHaveLength(2); expect(registrations[0][1]).toEqual(registrations[1][1]);
    expect(registrations[1][1]).toMatchObject({ registration: { maxTaskTokens: 250000, maxRoundTokens: 250000 } });
    expect(JSON.parse(original.context)._modelOutputRecovery).toBeUndefined();
  });
  it("完整候选再次失败后保留首因，不发第三次生成", async () => {
    mockCommands(() => { throw `OPSARK_MODEL_TRACE_V1:${JSON.stringify({ modelError: error() })}`; });
    const result = await backend.processRequirement(fixture.requirement, runtime());
    expect(modelCalls()).toHaveLength(2); expect(result.plan).toEqual([]);
    expect(modelServiceError(result.planError)?.candidateRejection?.toolIds).toEqual(["files.preview_deletion"]);
    expect(result.constraints?.changePolicy).toBe("confirm_changes");
  });
  it("新请求预算拒绝时不重置额度或继续生成，保留原候选首因", async () => {
    mockCommands(() => { throw `OPSARK_MODEL_TRACE_V1:${JSON.stringify({ modelError: { code: "MODEL_TASK_BUDGET_EXHAUSTED", origin: "core", stage: "task_budget", message: "budget", retryable: false } })}`; });
    const result = await backend.processRequirement(fixture.requirement, runtime());
    expect(modelCalls()).toHaveLength(2); expect(result.plan).toEqual([]);
    expect(modelServiceError(result.planError)).toMatchObject({ code: "MODEL_TASK_BUDGET_EXHAUSTED", candidateRejection: { toolIds: ["files.preview_deletion"] } });
  });
  it.each(["取消", "目标更正", "连接代次变化", "工具目录变化"])("%s使分类结果过期时不接纳、不再生成", async reason => {
    let valid = true; mockCommands(() => [step()], () => { valid = false; return classified(); });
    await expect(backend.processRequirement(fixture.requirement, { ...runtime(), assertCurrent() { if (!valid) throw new Error(reason); } })).rejects.toThrow(reason);
    expect(modelCalls()).toHaveLength(1);
  });
  it("原生未给出独立校验通过的分类时，原错误不触发联合重分类", async () => {
    mockCommands(() => [step()], () => { throw `OPSARK_MODEL_TRACE_V1:${JSON.stringify({ modelError: error() })}`; });
    await expect(backend.processRequirement(fixture.requirement, runtime())).rejects.toThrow(); expect(modelCalls()).toHaveLength(1);
  });
});

describe("第三十一批：真实首因及恢复计数文案", () => {
  it("第007次零修复明确说明动作参数范围，不虚构修复失败", () => {
    const message = modelServiceErrorMessage(error());
    expect(message).toContain("未进行字段修复或候选重生成"); expect(message).toContain("动作参数不属于字段修复范围");
    expect(message).toContain("files.preview_deletion"); expect(message).toContain("/steps/0/action/arguments/paths");
    expect(message).not.toContain("格式修复未成功");
  });
  it.each([[1, 0, "本轮字段修复"], [0, 1, "本轮完整候选重生成"]])("按实际计数区分字段%d与候选%d恢复", (fieldRepairs, candidateRegenerations, expected) => {
    expect(modelServiceErrorMessage({ ...error(), recoveryBudget: { generations: 2, fieldRepairs, candidateRegenerations } })).toContain(expected);
  });
  it.each([undefined, {}, { fieldRepairs: 0, candidateRegenerations: 0, generations: 2 }, { fieldRepairs: -1 }])("旧归档或不完整计数%s不推断修复历史", recoveryBudget => {
    const message = modelServiceErrorMessage({ ...error(), recoveryBudget });
    expect(message).toContain("模型响应未通过契约校验"); expect(message).not.toContain("未进行字段修复"); expect(message).not.toContain("修复未成功");
  });
  it("不以provider计数冒充原生恢复记录", () => {
    expect(modelServiceErrorMessage({ ...error(), origin: "provider" })).not.toContain("未进行字段修复");
  });
  it("未知输出耗尽记录不声称局部修复已用完", () => {
    const message = modelServiceErrorMessage({ code: "MODEL_OUTPUT_REPAIR_EXHAUSTED", origin: "core", stage: "output_recovery", message: "unknown", retryable: false });
    expect(message).toContain("模型输出恢复已停止"); expect(message).not.toContain("局部修复机会已用完");
  });
});
