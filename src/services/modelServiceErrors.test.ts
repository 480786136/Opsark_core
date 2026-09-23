import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { backend, ModelInvocationError, modelServiceError } from "./backend";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const runtime = { apiKey: "fixture", endpoint: "https://test.invalid", model: "test", context: "{}" };
const quota = { httpStatus: 402, code: "INSUFFICIENT_CREDITS", message: "可用额度不足", retryable: false,
  details: { available_tokens: 12000, required_tokens: 24000, estimated_input_tokens: 16000,
    max_output_tokens: 8000, estimator: "heuristic", exact: false } };

beforeEach(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.resetAllMocks(); });

describe("provider credit failures", () => {
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
