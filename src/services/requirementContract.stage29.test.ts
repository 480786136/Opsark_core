import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { backend, ModelInvocationError, modelServiceError, modelServiceErrorMessage } from "./backend";
import { isExplicitModelPlanningRetryable, isRecoverableModelOutput } from "./modelRecovery";
import type { ModelServiceError } from "@/types";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const issue = (field = "environmentPolicy"): ModelServiceError => ({ code: "MODEL_REQUIREMENT_INVALID", stage: "requirement_contract", origin: "core", retryable: false,
  jsonPointer: `/constraints/${field}`, keyword: "enum", message: "private model response must not be shown" });
const runtime = { apiKey: "fixture", model: "fixture", endpoint: "https://fixture.invalid", context: JSON.stringify({ _modelRecovery: { operationId: "same", startedAtMs: 123 },
  _taskModelBudget: { taskMaxTotalTokens: 250000, roundMaxTotalTokens: 250000 } }) };
beforeEach(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.restoreAllMocks(); vi.resetAllMocks(); });
describe("第二十九批：约束语义首因与有界入口（模拟IPC）", () => {
  it.each(["changePolicy", "environmentPolicy", "failurePolicy"])("保留具体合法字段%s，无虚构HTTP状态或额外调用", async field => {
    vi.mocked(invoke).mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({ message: "invalid", modelError: issue(field), developerTrace: { attempts: [] } })}`);
    const failure = await backend.processRequirement("修改配置前确认", runtime).catch(e => e);
    expect(failure).toBeInstanceOf(ModelInvocationError); expect(invoke).toHaveBeenCalledOnce();
    expect(modelServiceError(failure)).toMatchObject({ code: "MODEL_REQUIREMENT_INVALID", jsonPointer: `/constraints/${field}` });
    expect(modelServiceError(failure)).not.toHaveProperty("httpStatus");
    expect(failure.message).toContain(`constraints.${field}`); expect(failure.message).toContain("允许枚举");
    expect(failure.message).not.toContain("private model"); expect(failure.message).not.toContain("模型接入能力");
    const context=JSON.parse((vi.mocked(invoke).mock.calls[0][1] as { context: string }).context);
    for (const key of ["_modelRecovery", "_taskModelBudget"]) expect(context[key]).toEqual(JSON.parse(runtime.context)[key]);
  });
  it("原生语义错误明确停止自动恢复，保留用户显式重规划资格", () => {
    expect(isRecoverableModelOutput(issue())).toBe(false);
    expect(isExplicitModelPlanningRetryable(issue())).toBe(true);
  });
  it.each(["provider", "upstream"] as const)("不把%s的相同字样伪装成Core语义错误", origin => {
    expect(new ModelInvocationError("untrusted", undefined, { ...issue(), origin }).modelError).toBeUndefined();
    expect(isExplicitModelPlanningRetryable({ ...issue(), origin })).toBe(false);
  });
  it("错误stage或任意未知指针不能扩大信任和展示范围", () => {
    expect(new ModelInvocationError("untrusted", undefined, { ...issue(), stage: "transport" }).modelError).toBeUndefined();
    expect(modelServiceErrorMessage({ ...issue(), jsonPointer: "/constraints/password/private-value" })).not.toContain("private-value");
  });
  it.each([["required", "缺失"], ["type", "类型不符合契约"], ["additionalProperties", "未通过本轮语义校验"]])("安全展示%s原因且不带原响应", (keyword, text) => {
    const message=modelServiceErrorMessage({ ...issue(), keyword });expect(message).toContain(text);expect(message).not.toContain("private model");
  });
  it("已保存的语义错误重新解析仍保留字段和静态说明", () => {
    const restored=new ModelInvocationError(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({modelError:issue("failurePolicy")})}`);
    expect(modelServiceError(restored)?.jsonPointer).toBe("/constraints/failurePolicy");expect(restored.message).toContain("constraints.failurePolicy");
  });
});
