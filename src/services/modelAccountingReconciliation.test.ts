import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOriginalAccountingReconciler } from "./modelAccountingReconciliation";
import { reconciledModelStopMessage, type TaskModelRequest } from "./taskModelRequests";

const request = (id = "original"): TaskModelRequest => ({ requestId: id, taskId: "task", roundId: "old-round", operationId: "old-operation",
  state: "unknown", phase: "transport_uncertain", cancelRequested: false, late: false, createdAtMs: Date.now(), updatedAtMs: Date.now() });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("bounded original accounting, no workflow consumer", () => {
  it.each([false, true])("settles a late original once, including local cancellation=%s", async cancelled => {
    let current = request(); current.cancelRequested = cancelled;
    const query = vi.fn(async () => { if (query.mock.calls.length === 3) current = { ...current, state: "completed", late: true }; });
    const refresh = vi.fn(async () => {});
    const observer = createOriginalAccountingReconciler();
    const job = { request: current, current: () => current, query, refresh };
    observer.schedule(job); observer.schedule(job);
    await vi.advanceTimersByTimeAsync(5000);
    expect(query).toHaveBeenCalledTimes(3); expect(refresh).toHaveBeenCalledTimes(3);
    observer.schedule({ ...job, request: { ...current, state: "unknown" } });
    await vi.advanceTimersByTimeAsync(100000);
    expect(query).toHaveBeenCalledTimes(3);
  });
  it("never reopens the operation budget and stops querying after its own cap", async () => {
    const current = request(), query = vi.fn(async () => {});
    createOriginalAccountingReconciler().schedule({ request: current, current: () => current, query, refresh: async () => {} });
    await vi.advanceTimersByTimeAsync(200000);
    expect(query).toHaveBeenCalledTimes(12);
    expect(current).toMatchObject({ operationId: "old-operation", roundId: "old-round", state: "unknown" });
  });
  it("does not start another observation after changed ownership, missing task or identity failure", async () => {
    const current = request(), query = vi.fn(async () => {});
    createOriginalAccountingReconciler().schedule({ request: current, current: () => undefined, query, refresh: async () => {} });
    await vi.advanceTimersByTimeAsync(100000); expect(query).not.toHaveBeenCalled();
    query.mockRejectedValue(new Error("original identity mismatch"));
    createOriginalAccountingReconciler().schedule({ request: current, current: () => current, query, refresh: async () => {} });
    await vi.advanceTimersByTimeAsync(100000); expect(query).toHaveBeenCalledOnce();
  });
  it("can resume finite accounting from a recent durable unknown after restart, but leaves old history manual", async () => {
    const current = request(), query = vi.fn(async () => {});
    const job = { request: current, current: () => current, query, refresh: async () => {} };
    createOriginalAccountingReconciler().schedule(job);
    await vi.advanceTimersByTimeAsync(1); expect(query).toHaveBeenCalledOnce();
    vi.clearAllTimers();
    vi.setSystemTime(current.createdAtMs + 1);
    createOriginalAccountingReconciler().schedule(job);
    await vi.runOnlyPendingTimersAsync(); expect(query).toHaveBeenCalledTimes(2);
    vi.clearAllTimers(); query.mockClear();
    createOriginalAccountingReconciler().schedule({ ...job, request: { ...current, createdAtMs: 1 } });
    await vi.advanceTimersByTimeAsync(100000); expect(query).not.toHaveBeenCalled();
  });
  it("queues eligible originals and ignores terminal or foreign current records", async () => {
    const observer = createOriginalAccountingReconciler(), query = vi.fn(async () => {});
    for (let i = 0; i < 6; i++) { const current = request(String(i)); observer.schedule({ request: current, current: () => current, query, refresh: async () => {} }); }
    for (const foreign of [false, true]) {
      const original = request(`ignored-${foreign}`);
      observer.schedule({ request: original,
        current: () => foreign ? { ...original, taskId: "foreign" } : { ...original, state: "completed" },
        query, refresh: async () => {} });
    }
    await vi.advanceTimersByTimeAsync(1); expect(query).toHaveBeenCalledTimes(6);
  });
  it("shows current receipt separately from the unchanged historical stop", () => {
    const error = { code: "MODEL_DISPATCH_UNKNOWN", requestKey: "original", origin: "core" as const, message: "unknown then", retryable: false };
    const original = { ...request(), state: "completed" as const };
    const task = { id: "task", modelPlanningBlocker: { error }, modelRequests: [original] };
    expect(reconciledModelStopMessage(task)).toContain("迟到方案未采用");
    expect(task.modelPlanningBlocker.error).toBe(error);
    expect(reconciledModelStopMessage({ ...task, modelRequests: [{ ...original, taskId: "other" }] })).toBeUndefined();
    expect(reconciledModelStopMessage({ ...task, modelRequests: [{ ...original, state: "unknown" }] })).toBeUndefined();
  });
});
