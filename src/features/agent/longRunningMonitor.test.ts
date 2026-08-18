import { describe, expect, it, vi } from "vitest";
import {
  acceptsLongRunningDecision,
  startLongRunningMonitor,
} from "@/features/agent/longRunningMonitor";
import type { LongRunningMonitorScheduler } from "@/features/agent/longRunningMonitor";
import type { OpsTask, PlanStep, StepReview } from "@/types";

const review = (decision: StepReview["decision"], source: StepReview["source"]): StepReview => ({
  decision,
  source,
  reason: "test",
  summary: "test",
});

describe("longRunningMonitor", () => {
  it("only accepts model completion after independent validation passes", () => {
    expect(acceptsLongRunningDecision(review("continue", "model"), false)).toBe(true);
    expect(acceptsLongRunningDecision(review("adjust", "model"), false)).toBe(true);
    expect(acceptsLongRunningDecision(review("complete", "model"), false)).toBe(false);
    expect(acceptsLongRunningDecision(review("complete", "model"), true)).toBe(true);
    expect(acceptsLongRunningDecision(review("adjust", "rules"), true)).toBe(false);
  });

  it("owns heartbeat timers and reports elapsed progress", () => {
    let currentTime = Date.parse("2026-08-14T00:00:00.000Z");
    let nextTimerId = 0;
    const timers = new Map<number, () => void>();
    const scheduler: LongRunningMonitorScheduler = {
      now: () => currentTime,
      setInterval: (callback) => {
        nextTimerId += 1;
        timers.set(nextTimerId, callback);
        return nextTimerId;
      },
      clearInterval: (timerId) => void timers.delete(timerId),
    };
    const onHeartbeat = vi.fn();
    const step = {
      id: "step-1",
      title: "Deploy",
      description: "Deploy",
      command: "deploy",
      validation: "check",
      expected: "healthy",
      risk: "medium",
      status: "running",
      startedAt: new Date(currentTime).toISOString(),
    } satisfies PlanStep;
    const task = {
      id: "task-1",
      serverId: "server-1",
      title: "Task",
      status: "running",
      permission: "safe",
      modelId: "model-1",
      messages: [],
      plan: [step],
      createdAt: new Date(currentTime).toISOString(),
      updatedAt: new Date(currentTime).toISOString(),
    } satisfies OpsTask;

    const controller = startLongRunningMonitor({
      task,
      step,
      requirement: "Deploy",
      validation: "check",
      executionId: "execution-1",
      secretValues: {},
      getStreamedOutput: () => "",
      isCancelled: () => false,
      onHeartbeat,
      onEvent: vi.fn(),
      onAudit: vi.fn(),
      onError: vi.fn(),
      scheduler,
    });

    currentTime += 11_000;
    timers.get(1)?.();
    expect(onHeartbeat).toHaveBeenCalledWith(11, expect.stringContaining("30 秒"));

    controller.stop();
    expect(timers.size).toBe(0);
  });

  it("任务取消后立即停止心跳消息", () => {
    let cancelled = false;
    let nextTimerId = 0;
    const timers = new Map<number, () => void>();
    const scheduler: LongRunningMonitorScheduler = {
      now: () => Date.now(),
      setInterval: (callback) => { timers.set(++nextTimerId, callback); return nextTimerId; },
      clearInterval: (timerId) => void timers.delete(timerId),
    };
    const onHeartbeat = vi.fn();
    const step = {
      id: "step-1", title: "Check", description: "Check", command: "check", validation: "verify",
      expected: "done", risk: "low", status: "running",
    } satisfies PlanStep;
    const task = {
      id: "task-1", serverId: "server-1", title: "Task", status: "running", permission: "safe",
      modelId: "model-1", messages: [], plan: [step], createdAt: "now", updatedAt: "now",
    } satisfies OpsTask;
    startLongRunningMonitor({
      task, step, requirement: "Check", validation: "verify", executionId: "exec-1", secretValues: {},
      getStreamedOutput: () => "", isCancelled: () => cancelled, onHeartbeat, onEvent: vi.fn(),
      onAudit: vi.fn(), onError: vi.fn(), scheduler,
    });
    cancelled = true;
    timers.get(1)?.();
    expect(onHeartbeat).not.toHaveBeenCalled();
  });
});
