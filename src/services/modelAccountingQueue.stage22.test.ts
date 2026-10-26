import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOriginalAccountingReconciler, ACCOUNTING_WINDOW_MS } from "./modelAccountingReconciliation";
import type { TaskModelRequest } from "./taskModelRequests";

const record = (id: number): TaskModelRequest => ({ taskId: "task", requestId: `original-${id}`, roundId: "old-round",
  operationId: `operation-${id}`, state: "unknown", phase: "transport_uncertain", cancelRequested: true, late: false,
  createdAtMs: Date.now(), updatedAtMs: Date.now() });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("late accounting queue keeps original bounds and serves concurrent originals", () => {
  it("settles six originals without needing another external refresh", async () => {
    const observer = createOriginalAccountingReconciler();
    const jobs = Array.from({ length: 6 }, (_, i) => {
      let current = record(i);
      const query = vi.fn(async () => { current = { ...current, state: "completed", late: true }; });
      const job = { request: current, current: () => current, query, refresh: vi.fn(async () => {}) };
      observer.schedule(job); observer.schedule(job);
      return job;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    for (const job of jobs) {
      expect(job.query).toHaveBeenCalledOnce(); expect(job.refresh).toHaveBeenCalledOnce();
      expect(job.current()).toMatchObject({ state: "completed", roundId: "old-round", cancelRequested: true });
    }
  });

  it("releases query slots between polls so an unknown original cannot starve the fifth", async () => {
    const observer = createOriginalAccountingReconciler();
    const queries = Array.from({ length: 5 }, (_, i) => {
      const current = record(i), query = vi.fn(async () => {});
      observer.schedule({ request: current, current: () => current, query, refresh: async () => {} });
      return query;
    });
    await vi.advanceTimersByTimeAsync(1000);
    for (const query of queries) expect(query).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(200_000);
    for (const query of queries) expect(query).toHaveBeenCalledTimes(12);
  });

  it("keeps no more than four queries in flight and advances queued work as slots free", async () => {
    const observer = createOriginalAccountingReconciler();
    let inFlight = 0, peak = 0;
    const release: Array<() => void> = [];
    const queries = Array.from({ length: 7 }, (_, i) => {
      let current = record(i);
      const query = vi.fn(async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise<void>(resolve => release.push(resolve));
        inFlight--; current = { ...current, state: "completed" };
      });
      observer.schedule({ request: current, current: () => current, query, refresh: async () => {} });
      return query;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(queries.filter(query => query.mock.calls.length)).toHaveLength(4);
    release.splice(0).forEach(resolve => resolve());
    await vi.advanceTimersByTimeAsync(1);
    expect(queries.filter(query => query.mock.calls.length)).toHaveLength(7);
    release.splice(0).forEach(resolve => resolve());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(inFlight).toBe(0); expect(peak).toBe(4);
    queries.forEach(query => expect(query).toHaveBeenCalledOnce());
  });

  it.each([86_000, ACCOUNTING_WINDOW_MS + 1])("does not restart the queued window after %sms", async hold => {
    const observer = createOriginalAccountingReconciler(), release: Array<() => void> = [];
    for (let i = 0; i < 4; i++) {
      const current = record(i);
      observer.schedule({ request: current, current: () => current,
        query: () => new Promise<void>(resolve => release.push(resolve)), refresh: async () => {} });
    }
    const current = record(4), query = vi.fn(async () => {});
    const job = { request: current, current: () => current, query, refresh: async () => {} };
    observer.schedule(job);
    await vi.advanceTimersByTimeAsync(hold);
    release.forEach(resolve => resolve());
    await vi.advanceTimersByTimeAsync(200_000);
    observer.schedule(job);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["removed", "connection_changed", "terminal"])("drops a queued original when %s", async reason => {
    const observer = createOriginalAccountingReconciler(), release: Array<() => void> = [];
    for (let i = 0; i < 4; i++) {
      let current = record(i);
      observer.schedule({ request: current, current: () => current,
        query: async () => { await new Promise<void>(resolve => release.push(resolve)); current = { ...current, state: "completed" }; },
        refresh: async () => {} });
    }
    let current: TaskModelRequest | undefined = record(4);
    const query = vi.fn(async () => {});
    observer.schedule({ request: current, current: () => current, query, refresh: async () => {} });
    await vi.advanceTimersByTimeAsync(1);
    current = reason === "terminal" ? { ...current, state: "completed" } : undefined;
    release.forEach(resolve => resolve());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(query).not.toHaveBeenCalled();
  });

  it("ends a failed original without blocking unrelated queued accounting or retrying the failure", async () => {
    const observer = createOriginalAccountingReconciler();
    const queries = Array.from({ length: 6 }, (_, i) => {
      let current = record(i);
      const query = vi.fn(async () => {
        if (i < 4) throw new Error("identity unavailable");
        current = { ...current, state: "completed" };
      });
      observer.schedule({ request: current, current: () => current, query, refresh: async () => {} });
      return query;
    });
    await vi.advanceTimersByTimeAsync(200_000);
    queries.forEach(query => expect(query).toHaveBeenCalledOnce());
  });

  it("rechecks the historical age limit before another poll", async () => {
    const observer = createOriginalAccountingReconciler(), current = record(0);
    current.createdAtMs = Date.now() - 989_000;
    const query = vi.fn(async () => {});
    observer.schedule({ request: current, current: () => current, query, refresh: async () => {} });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(query).toHaveBeenCalledOnce();
  });
});
