import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { invokeTaskModel, isReconciledModelRequestRetryable, modelRequestStateLabel, subscribeTaskModelAccounting } from "./taskModelRequests";
import { createTaskModelBudget, taskBudgetRegistration } from "@/features/agent/taskModelBudget";
import { ModelInvocationError } from "./backend";
import { localModelAdapterBase } from "@/features/agent/modelRuntime";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const meta = { taskId: "task-1", roundId: "round-1", _modelTokenBudget: createTaskModelBudget(250_000, 200_000) };

describe("persistent task budget admission", () => {
  it.each([false, true])("notifies the original account after native settlement/rejection, rejection=%s", async reject => {
    const order: string[] = [];
    const original = new Error("native original error");
    vi.mocked(invoke).mockImplementation(async command => {
      order.push(command);
      if (command === "model-command" && reject) throw original;
      return "native-result" as never;
    });
    const stop = subscribeTaskModelAccounting(async (task, round) => {
      order.push(`${task}/${round}`); throw new Error("observer failure must not replace native result");
    });
    try {
      const request = invokeTaskModel("model-command", { context: JSON.stringify({ _log: meta }) });
      if (reject) await expect(request).rejects.toBe(original);
      else await expect(request).resolves.toBe("native-result");
      expect(order).toEqual(["register_task_model_budget", "model-command", "task-1/round-1"]);
    } finally { stop(); }
    const observer = vi.fn(); const unsub = subscribeTaskModelAccounting(observer); unsub();
    vi.mocked(invoke).mockResolvedValue({});
    await invokeTaskModel("model-command", { context: JSON.stringify({ _log: meta }) });
    expect(observer).not.toHaveBeenCalled();
  });
  it.each(["context", "reviewContext", "executionContext"])("registers before dispatch through %s", async key => {
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async command => { calls.push(command); return {} as never; });
    await invokeTaskModel("model-command", { [key]: JSON.stringify({ _log: meta }), apiKey: "fixture" });
    expect(calls).toEqual(["register_task_model_budget", "model-command"]);
    expect(vi.mocked(invoke).mock.calls[0][1]).toEqual({ registration: {
      taskId: "task-1", roundId: "round-1", maxTaskTokens: 250_000, maxRoundTokens: 200_000, safetyReserveTokens: 0,
    } });
    const context = JSON.parse((vi.mocked(invoke).mock.calls[1][1] as Record<string, string>)[key]);
    expect(context._taskModelBudget).toEqual({ version: 1, taskId: "task-1", roundId: "round-1" });
    expect(context._modelRecovery.operationId).toBeTruthy();
  });

  it("does not send when registration fails and retains original operation across repair", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("budget policy changed"));
    const raw = JSON.stringify({ _log: meta, _modelRecovery: { operationId: "original", startedAtMs: 123 } });
    await expect(invokeTaskModel("generate_ai_plan", { context: raw })).rejects.toThrow("budget policy changed");
    expect(invoke).toHaveBeenCalledOnce();
    vi.mocked(invoke).mockResolvedValue({});
    await invokeTaskModel("generate_ai_plan", { context: raw });
    const args = vi.mocked(invoke).mock.calls[2][1] as { context: string };
    expect(JSON.parse(args.context)._modelRecovery).toMatchObject({ operationId: "original", startedAtMs: 123 });
  });

  it("captures operation timestamp before delayed budget registration", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    vi.mocked(invoke).mockResolvedValueOnce({});
    const before = Date.now();
    const pending = invokeTaskModel("model-command", { context: JSON.stringify({ _log: meta }) });
    expect(invoke).toHaveBeenCalledOnce();
    const cutoff = Date.now();
    resolve({}); await pending;
    const args = vi.mocked(invoke).mock.calls[1][1] as { context: string };
    const startedAtMs = JSON.parse(args.context)._modelRecovery.startedAtMs;
    expect(startedAtMs).toBeGreaterThanOrEqual(before);
    expect(startedAtMs).toBeLessThanOrEqual(cutoff);
  });

  it("never mines nested tool or user content for a budget policy", () => {
    expect(taskBudgetRegistration(JSON.stringify({ output: { _log: meta }, user: JSON.stringify(meta) }))).toBeUndefined();
    expect(taskBudgetRegistration(JSON.stringify({ _log: { taskId: "legacy", roundId: "r" } }))).toBeUndefined();
    expect(() => taskBudgetRegistration(JSON.stringify({ _log: meta,
      baseSnapshot: { _log: { ...meta, taskId: "different-task" } } }))).toThrow("冲突");
    expect(() => taskBudgetRegistration(JSON.stringify({ _log: meta,
      _taskModelBudget: { version: 1, taskId: "old-owner", roundId: "round-1" } }))).toThrow("改绑");
  });

  it("keeps taskless model probes free of fabricated task quotas", async () => {
    vi.mocked(invoke).mockResolvedValue({});
    await invokeTaskModel("check-model", { context: "{}" });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("check-model", expect.objectContaining({ context: expect.not.stringContaining("_taskModelBudget") }));
  });
});

describe("explicit local adapter routing", () => {
  it("rejects remote hosts and credential-bearing URLs for the local opt-in", () => {
    for (const value of ["https://example.com/v1", "http://user:secret@127.0.0.1/v1", "http://127.0.0.1/v1?secret=1", "not-a-url"]) {
      expect(localModelAdapterBase(value)).toBeUndefined();
    }
    expect(localModelAdapterBase("http://127.0.0.1:18765/v1")).toBe("http://127.0.0.1:18765/");
  });
  it("puts opt-in metadata in the private context instead of native command extras", async () => {
    vi.mocked(invoke).mockResolvedValue({});
    const adapter = { protocol: "opsark-local-v1", baseUrl: "http://127.0.0.1:18765/" };
    await invokeTaskModel("model-command", { context: JSON.stringify({ _log: meta }), _requestLifecycleAdapter: adapter });
    const args = vi.mocked(invoke).mock.calls[1][1] as Record<string, string>;
    expect(args).not.toHaveProperty("_requestLifecycleAdapter");
    expect(JSON.parse(args.context)._modelRequestLifecycle).toEqual({ adapter });
  });
});

describe("user-visible lifecycle and quota boundaries", () => {
  it.each([false, true])("keeps a completed receipt terminal despite historical cancellation (late=%s)", late => {
    const request = { requestId: "completed-original", operationId: "original", state: "completed" as const,
      phase: "completed", cancelRequested: true, late, usage: { total_tokens: 17843 }, createdAtMs: 1, updatedAtMs: 2 };
    const before = structuredClone(request);
    expect(modelRequestStateLabel(request)).toBe(`响应已记录 · 取消请求已记录${late ? " · 迟到响应" : ""}`);
    expect(request).toEqual(before);
  });
  it.each(["dispatching", "accepted", "unknown"] as const)("keeps %s cancellation unconfirmed in both languages", state => {
    const request = { requestId: "pending-original", operationId: "original", state, phase: "running",
      cancelRequested: true, late: false, createdAtMs: 1, updatedAtMs: 2 };
    expect(modelRequestStateLabel(request)).toContain("已请求取消，未确认停止");
    expect(modelRequestStateLabel(request, "en")).toContain("provider confirmation required");
    expect(modelRequestStateLabel({ ...request, state: "cancelled" }, "en")).toBe("provider confirmed cancellation");
    expect(modelRequestStateLabel({ ...request, state: "not_dispatched" }, "en")).toBe("not dispatched · local cancellation recorded");
  });
  it("does not label local cancellation as confirmed provider cancellation", () => {
    const request = { requestId: "a", operationId: "o", state: "unknown" as const, phase: "timeout",
      cancelRequested: true, late: false, createdAtMs: 1, updatedAtMs: 2 };
    expect(modelRequestStateLabel(request)).toBe("结果待核对 · 已请求取消，未确认停止");
    expect(modelRequestStateLabel({ ...request, state: "accepted", phase: "queued", cancelRequested: false })).toBe("排队中");
    expect(modelRequestStateLabel({ ...request, state: "accepted", phase: "running", cancelRequested: false })).toBe("模型生成中");
    expect(modelRequestStateLabel({ ...request, state: "not_dispatched" })).toBe("未派发 · 本地取消已记录");
  });
  it.each(["MODEL_TASK_BUDGET_EXHAUSTED", "MODEL_TASK_BUDGET_POLICY_CHANGED", "MODEL_TASK_BUDGET_UNREGISTERED"])("classifies %s without inventing HTTP failure", code => {
    const error = new ModelInvocationError("raw detail", undefined, { code, message: "raw detail", stage: "task_budget", origin: "core", retryable: false });
    expect(error.modelError?.code).toBe(code);
    expect(error.modelError?.httpStatus).toBeUndefined();
    expect(error.message).not.toContain("raw detail");
  });
  it("preserves no-resend explanation for an unresolved native request", () => {
    const error = new ModelInvocationError("raw", undefined, { code: "MODEL_REQUEST_UNRESOLVED", message: "raw", stage: "request_lifecycle", origin: "core", retryable: false });
    expect(error.message).toContain("停止重新发送");
    expect(error.message).toContain("原请求");
  });
  it.each(["MODEL_ADAPTER_BUSY", "MODEL_REQUEST_NOT_ACCEPTED"])("explains %s without inferring an upstream HTTP failure", code => {
    const error = new ModelInvocationError("raw private detail", undefined, { code, message: "raw private detail", stage: "request_recovery", origin: "core", retryable: false });
    expect(error.modelError?.code).toBe(code);
    expect(error.modelError?.httpStatus).toBeUndefined();
    expect(error.message).toContain("未受理");
    expect(error.message).toContain("手动重试");
    expect(error.message).not.toContain("raw private detail");
    if (code === "MODEL_ADAPTER_BUSY") expect(error.message).toContain("本地模型适配器");
  });
  it("permits explicit replanning only after the exact original request reaches a terminal observation", () => {
    const failure = { code: "MODEL_DISPATCH_UNKNOWN", origin: "core" as const, stage: "request_recovery",
      retryable: false as const, message: "unknown", requestKey: "request-old" };
    const original = { requestId: "request-old", taskId: "task-1", roundId: "round-1", operationId: "original-op",
      state: "unknown" as const, phase: "timeout", cancelRequested: false, late: false, createdAtMs: 1, updatedAtMs: 2 };
    expect(isReconciledModelRequestRetryable(failure, "task-1", [original])).toBe(false);
    expect(isReconciledModelRequestRetryable(failure, "task-1", [{ ...original, state: "completed" }])).toBe(true);
    expect(isReconciledModelRequestRetryable(failure, "other-task", [{ ...original, state: "completed" }])).toBe(false);
    expect(isReconciledModelRequestRetryable({ ...failure, requestKey: "different" }, "task-1", [{ ...original, state: "completed" }])).toBe(false);
    expect(isReconciledModelRequestRetryable({ ...failure, code: "MODEL_REQUEST_IDENTITY_CONFLICT" }, "task-1", [{ ...original, state: "completed" }])).toBe(false);
    for (const code of ["MODEL_ADAPTER_BUSY", "MODEL_REQUEST_NOT_ACCEPTED"]) {
      expect(isReconciledModelRequestRetryable({ ...failure, code }, "task-1", [original])).toBe(false);
      expect(isReconciledModelRequestRetryable({ ...failure, code }, "task-1", [{ ...original, state: "not_dispatched" }])).toBe(true);
    }
    expect(invoke).not.toHaveBeenCalled();
  });
});
