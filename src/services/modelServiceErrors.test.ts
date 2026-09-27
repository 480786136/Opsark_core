import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { backend, ModelInvocationError, modelServiceError } from "./backend";
import type { ModelServiceError } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const runtime = { apiKey: "fixture", endpoint: "https://test.invalid", model: "test", context: "{}" };
const quota = { httpStatus: 402, code: "INSUFFICIENT_CREDITS", message: "可用额度不足", retryable: false,
  details: { available_tokens: 12000, required_tokens: 24000, estimated_input_tokens: 16000,
    max_output_tokens: 8000, estimator: "heuristic", exact: false } };

beforeEach(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.resetAllMocks(); });

describe("local model contract failures", () => {
  const coreFailure = { code: "MODEL_SCHEMA_UNSUPPORTED", message: "unsupported schema keyword", retryable: false,
    origin: "core" as const, stage: "schema_compile", jsonPointer: "/properties/action", schemaPath: "/properties/action/allOf",
    keyword: "allOf", operation: "plan", contractVersion: "1" };

  it.each(["MODEL_SCHEMA_INVALID", "MODEL_SCHEMA_UNSUPPORTED"])("retains %s before HTTP dispatch without inventing a status or another model call", async (code) => {
    const modelError = { ...coreFailure, code };
    vi.mocked(invoke).mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({
      message: "local schema compilation rejected", modelError,
    })}`);
    const error = await backend.generatePlan("检查服务器", runtime).catch(error => error);
    expect(error).toBeInstanceOf(ModelInvocationError);
    expect(error.modelError).toEqual(modelError);
    expect(error.modelError).not.toHaveProperty("httpStatus");
    expect(error.message).toContain("结构契约未通过本地编译校验");
    expect(error.message).not.toContain("额度");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.each(["json_parse", "wire_validation", "business_validation", "metadata_decode"])("retains real HTTP 200 and %s diagnostics after bounded repair", async (stage) => {
    const modelError = { ...coreFailure, code: "MODEL_FORMAT_INVALID", stage, httpStatus: 200,
      message: "bounded repair exhausted", line: 12, column: 7 };
    vi.mocked(invoke).mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({
      message: "format failure", modelError,
    })}`);
    const error = await backend.reviewGoal("检查服务器", "{}", runtime).catch(error => error);
    expect(error).toBeInstanceOf(ModelInvocationError);
    expect(error.modelError).toEqual(modelError);
    expect(error.message).toContain("同一条件下不会重复请求模型");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("distinguishes an upstream HTTP 400 schema rejection from local compilation", async () => {
    const modelError = { code: "MODEL_SCHEMA_INVALID", message: "invalid schema definition", retryable: false,
      httpStatus: 400, origin: "upstream", stage: "request_schema", providerCode: "invalid_json_schema" };
    vi.mocked(invoke).mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({ message: "schema rejected", modelError })}`);
    const error = await backend.generatePlan("检查服务器", runtime).catch(error => error);
    expect(error).toBeInstanceOf(ModelInvocationError);
    expect(error.modelError).toEqual(modelError);
    expect(error.message).toContain("模型接口拒绝");
    expect(error.message).not.toContain("本地编译");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.each([
    ["MODEL_RESPONSE_INVALID", "response_envelope"],
    ...["MODEL_RESPONSE_INVALID", "MODEL_PROVIDER_FAILED", "MODEL_OUTPUT_CANCELLED", "MODEL_OUTPUT_PENDING", "MODEL_OUTPUT_INCOMPLETE", "MODEL_OUTPUT_ITEM_UNSUPPORTED"].map(code => [code, "response_status"]),
    ...["MODEL_CAPABILITY_UNKNOWN", "MODEL_ENDPOINT_INVALID", "MODEL_REQUEST_INVALID", "MODEL_PROBE_CONTRACT_INVALID"].map(code => [code, "request"]),
    ["MODEL_OUTPUT_REFUSED", "response_status"],
    ["MODEL_TOOL_CALL_UNEXPECTED", "response_status"],
    ["MODEL_CONTENT_FILTERED", "response_status"],
  ])("does not hide %s behind a step review fallback", async (code, stage) => {
    const modelError = { code, stage, origin: "core", httpStatus: 200, retryable: false, message: "invalid response",
      ...(code === "MODEL_OUTPUT_INCOMPLETE" ? { rawStatus: "incomplete", incompleteReason: "unknown" } : {}) };
    vi.mocked(invoke).mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({ message: "stopped", modelError })}`);
    const error = await backend.reviewStep("检查服务器", "{}", true, runtime).catch(error => error);
    expect(error).toBeInstanceOf(ModelInvocationError);
    expect(error.modelError).toEqual(modelError);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("requires an explicit supported Core code/stage for errors without an HTTP status", () => {
    for (const modelError of [
      { ...coreFailure, origin: "provider" },
      { ...coreFailure, stage: "unknown" },
      { ...coreFailure, code: "constructor" },
      { code: "MODEL_FORMAT_INVALID", message: "untrusted output", retryable: false },
    ]) {
      expect(modelServiceError(new Error(JSON.stringify({ modelError })))).toBeUndefined();
    }
  });

  it("reads serialized Core diagnostics while discarding invalid positions and arbitrary details", () => {
    const modelError = { ...coreFailure, httpStatus: "422", line: -1, column: 1.5, rawOutput: "untrusted output" };
    const parsed = modelServiceError(new Error(JSON.stringify({ modelError })));
    expect(parsed).toEqual(coreFailure);
    expect(parsed).not.toHaveProperty("httpStatus");
    expect(parsed).not.toHaveProperty("rawOutput");
    expect(parsed).not.toHaveProperty("line");
    expect(parsed).not.toHaveProperty("column");
  });
});

describe("cross-layer model recovery failures", () => {
  it.each([
    ["MODEL_RESULT_UNAVAILABLE", "request_recovery"],
    ["MODEL_DISPATCH_UNKNOWN", "request_recovery"],
    ["MODEL_REQUEST_FAILED", "request_recovery"],
    ["MODEL_CONNECT_FAILED", "transport_connect"],
    ["MODEL_AUTH_UNAVAILABLE", "request_auth"],
    ["MODEL_REQUEST_CONFLICT", "request_status"],
    ["MODEL_RECOVERY_BUDGET_EXHAUSTED", "recovery_budget"],
    ["MODEL_RECOVERY_BUDGET_INVALID", "recovery_budget"],
  ])("keeps %s without inventing HTTP status or starting local repair", async (code, stage) => {
    const modelError = { code, stage, origin: "core", retryable: false, message: "recovery stopped",
      dispatchCertainty: "may_have_dispatched", requestKey: "request-one", callId: "call-one",
      modelOperationId: "operation-one", generationId: "generation-one",
      recoveryBudget: { generations: 6, transportAttempts: 8, maxGenerations: 6, maxTransportAttempts: 12,
        accountedTokens: 9000, knownUsageTokens: 3000, unknownUsageAttempts: 1, exactTokens: false,
        maxTotalTokens: 10000, elapsedMs: 1600, maxElapsedMs: 300000, recoveryBlocked: true,
        modelOperationId: "operation-one", usageEstimator: "conservative" } };
    const wrapped = `OPSARK_MODEL_TRACE_V1:${JSON.stringify({ message: "stopped", modelError })}`;
    for (const operation of [
      () => backend.generatePlan("检查服务器", runtime),
      () => backend.decideNextStage("检查服务器", runtime),
      () => backend.reviewGoal("检查服务器", "{}", runtime),
      () => backend.reviewStep("检查服务器", "{}", true, runtime),
    ]) {
      vi.mocked(invoke).mockClear().mockRejectedValueOnce(wrapped);
      const error = await operation().catch(error => error);
      expect(error).toBeInstanceOf(ModelInvocationError);
      expect(error.modelError).toEqual(modelError);
      expect(error.modelError).not.toHaveProperty("httpStatus");
      expect(error.message).not.toContain("额度不足");
      expect(invoke).toHaveBeenCalledOnce();
    }
  });

  it("preserves distinct gateway, provider and status-query statuses and safe accounting diagnostics", () => {
    const modelError: ModelServiceError = { code: "MODEL_RESULT_UNAVAILABLE", stage: "request_recovery", origin: "core",
      retryable: false, message: "completed response unavailable", httpStatus: 409, gatewayHttpStatus: 409,
      providerHttpStatus: 200, statusQueryHttpStatus: 200, dispatchCertainty: "response_received",
      requestKey: "key", callId: "call", responseAvailable: false, billingMode: "direct", reserved: 0,
      actual: 124, creditState: "settled" };
    expect(new ModelInvocationError("unavailable", undefined, modelError).modelError).toEqual(modelError);
  });

  it("keeps an account authentication failure before dispatch without a successful review fallback", async () => {
    const modelError: ModelServiceError = { code: "MODEL_AUTH_UNAVAILABLE", stage: "request_auth", origin: "core",
      retryable: false, message: "account unavailable", dispatchCertainty: "not_dispatched" };
    vi.mocked(invoke).mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({ message: "stopped", modelError })}`);
    const error = await backend.reviewStep("检查", "{}", false, runtime).catch(error => error);
    expect(error).toBeInstanceOf(ModelInvocationError);
    expect(error.modelError).toEqual(modelError);
    expect(error.modelError).not.toHaveProperty("httpStatus");
    expect(error.message).toContain("请求尚未派发");
    expect(error.message).toContain("登录状态");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("recognizes a gateway idempotency conflict without treating it as a format failure", () => {
    const error = new ModelInvocationError("conflict", undefined, { code: "IDEMPOTENCY_KEY_CONFLICT",
      message: "same key different request", retryable: false, origin: "gateway", stage: "request_deduplication",
      httpStatus: 409, gatewayHttpStatus: 409, dispatchCertainty: "not_dispatched" });
    expect(error.modelError?.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(error.message).toContain("冲突");
    expect(error.message).not.toContain("格式");
  });

  it.each(["UPSTREAM_SCHEMA_INVALID", "UPSTREAM_HTTP_ERROR", "UPSTREAM_CONNECT_FAILED", "UPSTREAM_CONNECT_TIMEOUT",
    "UPSTREAM_WRITE_FAILED", "UPSTREAM_TIMEOUT", "UPSTREAM_READ_FAILED", "UPSTREAM_RESPONSE_INVALID", "GATEWAY_BUSY",
    "REQUEST_ALREADY_ACCEPTED", "REQUEST_STATE_CONFLICT", "INVALID_API_PROTOCOL", "PRESET_PROTOCOL_UNSUPPORTED",
    "PARAMETER_SEMANTICS_CONFLICT", "PROTOCOL_PARAMETER_UNSUPPORTED", "INVALID_RESPONSES_REQUEST",
    "RESPONSES_STREAM_NOT_SUPPORTED", "PROVIDER_STORAGE_NOT_SUPPORTED", "UPSTREAM_PROTOCOL_MISMATCH",
    "API_PROTOCOL_MISMATCH", "CAPABILITY_REVISION_MISMATCH", "OUTPUT_CAPABILITY_UNKNOWN", "UNSUPPORTED_MESSAGE", "OFFICIAL_CONTEXT_TOO_LARGE"])("does not turn gateway %s into a successful review fallback", async (code) => {
    const modelError = { code, origin: "gateway", stage: "upstream_http", message: "upstream failed", retryable: false,
      httpStatus: 502, gatewayHttpStatus: 502, providerHttpStatus: 401, dispatchCertainty: "response_received" };
    vi.mocked(invoke).mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({ message: "stopped", modelError })}`);
    const error = await backend.reviewStep("检查", "{}", false, runtime).catch(error => error);
    expect(error).toBeInstanceOf(ModelInvocationError);
    expect(error.modelError).toEqual(modelError);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("preserves successful classification and its terminal plan error without starting another model call", async () => {
    const modelError = { code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", stage: "recovery_budget", origin: "core",
      message: "budget exhausted", retryable: false };
    const classified = { intent: "execute", relation: "new_goal", selectedSkillIds: ["inspection"],
      constraints: { userDirectives: ["只读检查"] }, developerTrace: { attempts: [] },
      planError: `OPSARK_MODEL_TRACE_V1:${JSON.stringify({ message: "stopped", modelError })}` };
    vi.mocked(invoke).mockResolvedValueOnce({ ...classified, plan: [{ command: "untrusted partial plan" }] });
    const result = await backend.processRequirement("检查服务器", runtime);
    expect(result).toEqual({ ...classified, plan: [] });
    expect(modelServiceError(result.planError)).toEqual(modelError);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 429, 400])("does not turn direct-provider HTTP %s into a successful review fallback", async (status) => {
    const modelError = { code: "MODEL_HTTP_ERROR", origin: "upstream", stage: "http_response", message: "HTTP rejection",
      retryable: false, httpStatus: status, providerHttpStatus: status, providerCode: "invalid_api_key" };
    vi.mocked(invoke).mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({ message: "stopped", modelError })}`);
    const error = await backend.reviewStep("检查", "{}", false, runtime).catch(error => error);
    expect(error).toBeInstanceOf(ModelInvocationError);
    expect(error.modelError).toEqual(modelError);
    expect(error.message).toContain(status === 401 || status === 403 ? "认证或权限" : status === 429 ? "频率受限" : "HTTP 400");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("drops invalid transport and budget fields and never accepts arbitrary nested provider data", () => {
    const parsed = modelServiceError(new Error(JSON.stringify({ modelError: {
      code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", stage: "recovery_budget", origin: "core", retryable: false,
      message: "exhausted", gatewayHttpStatus: 0, providerHttpStatus: "200", statusQueryHttpStatus: 700,
      dispatchCertainty: "guess", responseAvailable: "false", reserved: -1, actual: "100",
      recoveryBudget: { generations: 6, transportAttempts: -1, elapsedMs: 1.5, maxTotalTokens: "9000",
        usageEstimator: {}, exactTokens: "no", rawResponse: "secret", arbitrary: "ignored" },
    } })));
    expect(parsed).toMatchObject({ code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", recoveryBudget: { generations: 6 } });
    expect(parsed?.recoveryBudget).toEqual({ generations: 6 });
    for (const field of ["gatewayHttpStatus", "providerHttpStatus", "statusQueryHttpStatus", "dispatchCertainty", "responseAvailable", "reserved", "actual"]) {
      expect(parsed).not.toHaveProperty(field);
    }
  });
});

describe("provider credit failures", () => {
  it.each(["MODEL_OUTPUT_TRUNCATED", "MODEL_FORMAT_INVALID", "PRESET_PARAMETER_UNSUPPORTED"])("preserves compatibility failure %s without a second frontend call", async (code) => {
    vi.mocked(invoke).mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({
      message: "bounded compatibility recovery stopped",
      modelError: { httpStatus: 422, code, message: "repair exhausted", retryable: false },
    })}`);
    const error = await backend.reviewStep("检查服务器", "{}", true, runtime).catch(error => error);
    expect(error).toBeInstanceOf(ModelInvocationError);
    expect(error.modelError?.code).toBe(code);
    expect(error.message).toContain("同一条件下不会重复请求模型");
    expect(error.message).not.toContain("稍后重试");
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("describes direct billing without claiming an estimated reservation", () => {
    const error = new ModelInvocationError("balance", undefined, {
      httpStatus: 402, code: "INSUFFICIENT_CREDITS", message: "余额已用完", retryable: false,
      details: { billing_mode: "direct", available_tokens: 0, reserved_tokens: 0 },
    });
    expect(error.modelError?.details?.billing_mode).toBe("direct");
    expect(error.message).toContain("按实际用量直接扣余额");
    expect(error.message).not.toContain("预留额度不足");
    expect(error.message).not.toContain("所需预留量为估算");
  });
  it("preserves structured quota details across the Tauri trace without a retry call", async () => {
    const developerTrace = { attempts: [] };
    vi.mocked(invoke).mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({
      message: "计划生成返回错误（402 Payment Required）", developerTrace, modelError: quota,
    })}`);
    const error = await backend.generatePlan("检查服务器", runtime).catch(error => error);
    expect(error).toBeInstanceOf(ModelInvocationError);
    expect(error.modelError).toEqual(quota);
    expect(error.developerTrace).toEqual(developerTrace);
    expect(error.message).toContain("可用 2 积分");
    expect(error.message).toContain("需要预留 3 积分");
    expect(error.message).toContain("不是实际扣费");
    expect(error.message).not.toContain("稍后重试");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.each([false, true])("recognizes legacy HTTP JSON with a trace wrapper=%s", async (wrapped) => {
    const message = `计划生成返回错误（402 Payment Required）：${JSON.stringify({ error: quota })}`;
    vi.mocked(invoke).mockRejectedValueOnce(wrapped
      ? `OPSARK_MODEL_TRACE_V1:${JSON.stringify({ message, developerTrace: { attempts: [] } })}` : message);
    const error = await backend.generatePlan("检查服务器", runtime).catch(error => error);
    expect(modelServiceError(error)).toEqual(quota);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("treats reconciliation as a non-retryable account condition without inventing amounts", () => {
    const error = new ModelInvocationError("quota", undefined, {
      httpStatus: 402, code: "CREDITS_RECONCILIATION_REQUIRED", message: "账户待核对", retryable: false,
    });
    expect(error.modelError?.retryable).toBe(false);
    expect(error.message).toContain("结算核对");
    expect(error.message).not.toContain("可用 0");
  });

  it("does not classify arbitrary token prose or other errors as a credit lock", () => {
    expect(modelServiceError(new Error("模型输出提到了额度不足"))).toBeUndefined();
    expect(modelServiceError(new Error('{"error":{"code":"RATE_LIMIT","message":"retry later"}}'))).toBeUndefined();
  });

  it("does not hide goal-review credit failures behind a rule fallback", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({
      message: "整体目标复核返回错误（402 Payment Required）", modelError: quota,
    })}`);
    const error = await backend.reviewGoal("检查服务器", "{}", runtime).catch(error => error);
    expect(error).toBeInstanceOf(ModelInvocationError);
    expect(error.modelError).toEqual(quota);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("preserves step-review credit failures instead of continuing through a rule fallback", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({
      message: "步骤复核返回错误（402 Payment Required）", modelError: quota,
    })}`);
    const error = await backend.reviewStep("检查服务器", "{}", true, runtime).catch(error => error);
    expect(error).toBeInstanceOf(ModelInvocationError);
    expect(error.modelError).toEqual(quota);
    expect(error.message).toContain("额度不足");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("keeps the step-review fallback for ordinary unavailability", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("network unavailable"));
    await expect(backend.reviewStep("检查服务器", "{}", true, runtime)).resolves.toMatchObject({ source: "rules" });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("retains the established goal-review fallback for ordinary unavailability", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("network unavailable"));
    await expect(backend.reviewGoal("检查服务器", "{}", runtime)).resolves.toMatchObject({
      decision: "adjust", source: "rules",
    });
    expect(invoke).toHaveBeenCalledOnce();
  });
});
