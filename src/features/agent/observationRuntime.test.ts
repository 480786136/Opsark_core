import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interruptRestoredObservationWindows, runObservationWindow, type ObservationProbeResult, type ObservationRuntimeDependencies,
  type ObservationRuntimeRecord, validateObservationPolicy } from "./observationRuntime";

const epoch = 1_800_000_000_000;
const input = () => ({ binding: { taskId: "task", roundId: "round", workflowEpoch: 2, stepId: "step", executionId: "window-exec" },
  policy: { windowMs: 1000, intervalMs: 250, probeTimeoutMs: 500 }, preparationStartedAt: epoch - 120_000 });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const valid = (index: number, matched = false): ObservationProbeResult => ({ status: "valid", matched, executionId: `probe-${index}`, facts: { httpStatus: matched ? 200 : 503 } });
function harness(overrides: Partial<ObservationRuntimeDependencies> = {}) {
  const saved: ObservationRuntimeRecord[] = [];
  let wallOffset = 0;
  const dependencies: ObservationRuntimeDependencies = { clock: { wallNow: () => Date.now() + wallOffset,
    monotonicNow: () => Date.now() - epoch, sleep }, isCancelled: () => false,
    persist: snapshot => { saved.push(snapshot); },
    probe: async ({ sampleIndex, markStarted }) => { markStarted(); await sleep(10); return valid(sampleIndex); }, ...overrides };
  return { saved, dependencies, setWallOffset: (value: number) => { wallOffset = value; } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(epoch); });
afterEach(() => { vi.useRealTimers(); });

describe("executor observation window", () => {
  it("separates two-minute preparation and SSH startup from a full runtime window", async () => {
    const test = harness({ probe: async ({ sampleIndex, markStarted }) => {
      if (sampleIndex === 0) await sleep(200);
      markStarted(); await sleep(10); return valid(sampleIndex);
    } });
    const running = runObservationWindow(input(), test.dependencies);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await running;
    expect(result.firstValidProbeAt).toBe(epoch + 200);
    expect(result.preparationElapsedMs).toBe(120_200);
    expect(result.observationElapsedMs).toBe(1000);
    expect(result.maxSampleGapMs).toBe(250);
    expect(result.samples).toHaveLength(4);
    expect(result.samples.map(sample => sample.startedOffsetMs)).toEqual([0, 250, 500, 750]);
    expect(result.state).toBe("window_elapsed");
    expect(result.windowSatisfied).toBe(true);
    expect(test.saved[0].state).toBe("preparing");
  });

  it("observes delayed readiness without modifying the required window", async () => {
    const test = harness({ probe: async ({ sampleIndex, markStarted }) => {
      markStarted(); await sleep(10); return valid(sampleIndex, sampleIndex === 2);
    } });
    const running = runObservationWindow(input(), test.dependencies);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await running;
    expect(result.state).toBe("matched");
    expect(result.observationElapsedMs).toBe(510);
    expect(result.policy.windowMs).toBe(1000);
    expect(result.windowSatisfied).toBe(false);
    expect(result.samples.map(sample => sample.matched)).toEqual([false, false, true]);
  });

  it("does not issue a probe after an explicit absolute task deadline", async () => {
    const probe = vi.fn(); const test = harness({ probe });
    const result = await runObservationWindow({ ...input(), policy: { ...input().policy, absoluteDeadlineAt: epoch - 1 } }, test.dependencies);
    expect(probe).not.toHaveBeenCalled();
    expect(result.state).toBe("absolute_deadline");
    expect(result.firstValidProbeAt).toBeUndefined();
    expect(result.observationElapsedMs).toBe(0);
    expect(result.windowSatisfied).toBe(false);
  });

  it("keeps an earlier absolute deadline separate from the unfulfilled observation request", async () => {
    const test = harness();
    const running = runObservationWindow({ ...input(), policy: { ...input().policy, absoluteDeadlineAt: epoch + 400 } }, test.dependencies);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await running;
    expect(result.state).toBe("absolute_deadline");
    expect(result.observationElapsedMs).toBe(400);
    expect(result.policy.windowMs).toBe(1000);
    expect(result.windowSatisfied).toBe(false);
  });

  it.each(["unsupported", "invalid"] as const)("does not count %s or an empty protocol as a sample", async status => {
    const test = harness({ probe: async ({ markStarted }) => { markStarted(); return { status, matched: true, executionId: "probe" }; } });
    const result = await runObservationWindow(input(), test.dependencies);
    expect(result.state).toBe(status);
    expect(result.samples[0].matched).toBe(false);
    expect(result.firstValidProbeAt).toBeUndefined();
    expect(result.windowSatisfied).toBe(false);
  });

  it("does not treat text claiming a valid result as a probe without an executor start marker", async () => {
    const result = await runObservationWindow(input(), harness({ probe: async () => valid(0, true) }).dependencies);
    expect(result.state).toBe("invalid");
    expect(result.firstValidProbeAt).toBeUndefined();
  });

  it("counts a confirmed connection refusal as a real negative sample", async () => {
    const test = harness({ probe: async ({ sampleIndex, markStarted }) => {
      markStarted(); return { ...valid(sampleIndex), facts: { curlExitCode: 7, httpStatus: 0 } };
    } });
    const running = runObservationWindow(input(), test.dependencies);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await running;
    expect(result.state).toBe("window_elapsed"); expect(result.windowSatisfied).toBe(true);
    expect(result.samples).toHaveLength(4);
  });

  it("does not extend either deadline when the wall clock moves backwards", async () => {
    const test = harness();
    const running = runObservationWindow({ ...input(), policy: { ...input().policy, absoluteDeadlineAt: epoch + 700 } }, test.dependencies);
    await vi.advanceTimersByTimeAsync(100); test.setWallOffset(-3600_000);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await running;
    expect(result.state).toBe("absolute_deadline");
    expect(result.observationElapsedMs).toBe(700);
    expect(result.windowSatisfied).toBe(false);
  });

  it("stops and preserves late original evidence without reviving a cancelled window", async () => {
    let resolve!: (result: ObservationProbeResult) => void, cancelled = false;
    let signal!: AbortSignal;
    const test = harness({ isCancelled: () => cancelled, probe: async context => {
      signal = context.signal; context.markStarted(); return new Promise<ObservationProbeResult>(done => { resolve = done; });
    } });
    const running = runObservationWindow(input(), test.dependencies);
    await vi.advanceTimersByTimeAsync(20); cancelled = true;
    await vi.advanceTimersByTimeAsync(100);
    const result = await running, finishedAt = result.finishedAt;
    expect(result.state).toBe("cancelled"); expect(signal.aborted).toBe(true);
    expect(result.samples).toHaveLength(0);
    resolve(valid(0, true)); await vi.advanceTimersByTimeAsync(200);
    expect(result.state).toBe("cancelled"); expect(result.finishedAt).toBe(finishedAt);
    expect(result.observationElapsedMs).toBe(0);
    expect(result.samples[0]).toMatchObject({ executionId: "probe-0", late: true, status: "valid" });
    expect(result.windowSatisfied).toBe(false);
    expect(test.saved[test.saved.length - 1].samples).toHaveLength(1);
  });

  it("records probe timeout as incomplete and aborts only that original probe", async () => {
    let signal!: AbortSignal;
    const test = harness({ probe: context => { signal = context.signal; context.markStarted(); return new Promise(() => {}); } });
    const running = runObservationWindow(input(), test.dependencies);
    await vi.advanceTimersByTimeAsync(600);
    const result = await running;
    expect(result.state).toBe("probe_timeout"); expect(signal.aborted).toBe(true);
    expect(result.firstValidProbeAt).toBeUndefined(); expect(result.windowSatisfied).toBe(false);
  });

  it("fails closed before dispatch when the preparation snapshot cannot be saved", async () => {
    const probe = vi.fn();
    await expect(runObservationWindow(input(), harness({ persist: () => { throw new Error("storage unavailable"); }, probe }).dependencies)).rejects.toThrow("storage unavailable");
    expect(probe).not.toHaveBeenCalled();
  });

  it("rechecks cancellation and deadlines after durable preparation saves", async () => {
    let cancelled = false;
    const probe = vi.fn();
    const test = harness({ isCancelled: () => cancelled, probe, persist: async () => { await sleep(200); cancelled = true; } });
    const running = runObservationWindow(input(), test.dependencies);
    await vi.advanceTimersByTimeAsync(500);
    expect((await running).state).toBe("cancelled");
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not call sparse slow samples continuous coverage or hide their actual gaps", async () => {
    const test = harness({ probe: async ({ sampleIndex, markStarted }) => {
      markStarted(); await sleep(400); return valid(sampleIndex);
    } });
    const running = runObservationWindow(input(), test.dependencies);
    await vi.advanceTimersByTimeAsync(1800);
    const result = await running;
    expect(result.state).toBe("window_elapsed");
    expect(result.maxSampleGapMs).toBe(400);
    expect(result.windowSatisfied).toBe(false);
    expect(result.samples.filter(sample => !sample.late)).toHaveLength(2);
  });

  it("does not reinterpret a slow first probe as a fulfilled short window", async () => {
    const test = harness({ probe: async ({ markStarted }) => {
      markStarted(); await sleep(300); return valid(0, true);
    } });
    const running = runObservationWindow({ ...input(), policy: { windowMs: 100, intervalMs: 50, probeTimeoutMs: 500 } }, test.dependencies);
    await vi.advanceTimersByTimeAsync(600);
    const result = await running;
    expect(result.state).toBe("window_elapsed");
    expect(result.windowSatisfied).toBe(false);
  });

  it("rejects an unsupported sample count instead of silently shortening observation", () => {
    expect(() => validateObservationPolicy({ windowMs: 10000, intervalMs: 1, probeTimeoutMs: 100 })).toThrow("1000");
    expect(() => validateObservationPolicy({ windowMs: 1000, intervalMs: 2000, probeTimeoutMs: 100 })).toThrow();
  });

  it("marks a restored active window interrupted without inventing original completion time", async () => {
    const test = harness({ probe: async ({ markStarted }) => { markStarted(); return { status: "unsupported", matched: false, executionId: "probe" }; } });
    const completed = await runObservationWindow(input(), test.dependencies);
    const preparing = { ...test.saved[0] };
    const observing = { ...preparing, state: "observing" as const, observationElapsedMs: 100 };
    const task = { observationWindows: [preparing, observing, completed] };
    expect(interruptRestoredObservationWindows(task, epoch + 5000)).toBe(2);
    expect(preparing.state).toBe("interrupted");
    expect(preparing.interruptedAt).toBe(epoch + 5000);
    expect(preparing.finishedAt).toBeUndefined();
    expect(observing.observationElapsedMs).toBe(100);
    expect(completed.state).toBe("unsupported");
    expect(interruptRestoredObservationWindows(task, epoch + 6000)).toBe(0);
  });
});
