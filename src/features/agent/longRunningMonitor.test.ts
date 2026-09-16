import { describe, expect, it, vi } from "vitest";
import {
  acceptsLongRunningDecision,
  classifyLongRunningWorkload,
  startLongRunningMonitor,
} from "@/features/agent/longRunningMonitor";
import type { LongRunningMonitorScheduler, StartLongRunningMonitorInput } from "@/features/agent/longRunningMonitor";
import type { OpsTask, PlanStep, StepReview } from "@/types";

const review = (decision: StepReview["decision"], source: StepReview["source"]): StepReview => ({
  decision,
  source,
  reason: "test",
  summary: "test",
});

function progressiveMonitor(overrides: Partial<StartLongRunningMonitorInput> = {}) {
  let now = 0;
  let tick = () => {};
  const step = { id: "download", title: "download", description: "download", command: "curl -fLO https://example.test/a",
    validation: "test -s a", expected: "artifact", risk: "low", status: "running",
    runtimeClass: "progressive" } satisfies PlanStep;
  const task = { id: "task", serverId: "server", title: "download", status: "running", permission: "safe",
    modelId: "model", messages: [], plan: [step], createdAt: "now", updatedAt: "now" } satisfies OpsTask;
  const input = {
    task, step, requirement: "download", validation: step.validation, executionId: "exec", secretValues: {},
    getStreamedOutput: () => "", isCancelled: () => false, onHeartbeat: vi.fn(), onEvent: vi.fn(),
    onAudit: vi.fn(), onError: vi.fn(), cancelExecution: vi.fn(), reviewStep: vi.fn().mockResolvedValue(review("continue", "model")),
    scheduler: { now: () => now, setInterval: (cb: () => void) => { tick = cb; return 1; }, clearInterval: vi.fn() },
    ...overrides,
  } satisfies StartLongRunningMonitorInput;
  const monitor = startLongRunningMonitor(input);
  return { input, monitor, advance: async (time: number) => {
    now = time;
    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } };
}

describe("longRunningMonitor", () => {
  it("distinguishes bounded checks from downloads, builds and installs", () => {
    const classify = (command: string) => classifyLongRunningWorkload({
      title: "step",
      description: "step",
      command,
    });

    expect(classify("java -version; npm --version; docker --version")).toBe("bounded");
    expect(classify("curl -fL https://example.test/archive -o /tmp/archive")).toBe("progressive");
    expect(classify("mvn clean package")).toBe("progressive");
    expect(classify("dnf install -y git")).toBe("progressive");
  });

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
    expect(onHeartbeat).toHaveBeenCalledWith(11, expect.stringContaining("完成后才会进行后置校验"));
    expect(onHeartbeat).toHaveBeenCalledWith(11, expect.stringContaining("暂未收到实时输出"));

    controller.stop();
    expect(timers.size).toBe(0);
  });

  it("invokes an advisory model review at 30 seconds without accepting premature completion", async () => {
    let currentTime = Date.parse("2026-08-14T00:00:00.000Z");
    let nextTimerId = 0;
    const timers = new Map<number, () => void>();
    const scheduler: LongRunningMonitorScheduler = {
      now: () => currentTime,
      setInterval: (callback) => { timers.set(++nextTimerId, callback); return nextTimerId; },
      clearInterval: (timerId) => void timers.delete(timerId),
    };
    const step = {
      id: "step-1", title: "Download", description: "Download", command: "download", validation: "test -f artifact",
      expected: "artifact exists", risk: "low", status: "running", startedAt: new Date(currentTime).toISOString(),
    } satisfies PlanStep;
    const task = {
      id: "task-1", serverId: "server-1", title: "Task", status: "running", permission: "safe",
      modelId: "model-1", messages: [], plan: [step], createdAt: "now", updatedAt: "now",
    } satisfies OpsTask;
    const reviewStep = vi.fn().mockResolvedValue(review("complete", "model"));
    const cancelExecution = vi.fn();
    const onAudit = vi.fn();
    const onEvent = vi.fn();
    const controller = startLongRunningMonitor({
      task, step, requirement: "Download", validation: step.validation, executionId: "exec-1",
      secretValues: {}, getStreamedOutput: () => "50%", isCancelled: () => false,
      onHeartbeat: vi.fn(), onEvent, onAudit, onError: vi.fn(), cancelExecution, reviewStep, scheduler,
    });

    currentTime += 30_000;
    timers.get(1)?.();
    await vi.waitFor(() => expect(reviewStep).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onAudit).toHaveBeenCalledWith(expect.objectContaining({
      round: 1,
      acceptedDecision: false,
    })));

    const periodicContext = JSON.parse(vi.mocked(reviewStep).mock.calls[0][1]);
    expect(periodicContext).not.toHaveProperty("fullPlan");
    expect(periodicContext).not.toHaveProperty("executionHistory");
    expect(periodicContext.terminalOutput).toMatchObject({ mode: "initial", content: "50%" });

    expect(cancelExecution).not.toHaveBeenCalled();
    expect(controller.getState().decision).toBeUndefined();
    expect(onEvent).toHaveBeenCalledWith("system", expect.stringContaining("继续等待后再正式校验"));
    controller.stop();
  });

  it("accepts a model adjustment at 30 seconds and cancels only the current execution", async () => {
    let currentTime = Date.parse("2026-08-14T00:00:00.000Z");
    let nextTimerId = 0;
    const timers = new Map<number, () => void>();
    const scheduler: LongRunningMonitorScheduler = {
      now: () => currentTime,
      setInterval: (callback) => { timers.set(++nextTimerId, callback); return nextTimerId; },
      clearInterval: (timerId) => void timers.delete(timerId),
    };
    const step = {
      id: "step-1", title: "Connect", description: "Connect", command: "ssh target", validation: "true",
      expected: "connected", risk: "medium", status: "running", startedAt: new Date(currentTime).toISOString(),
    } satisfies PlanStep;
    const task = {
      id: "task-1", serverId: "server-1", title: "Task", status: "running", permission: "safe",
      modelId: "model-1", messages: [], plan: [step], createdAt: "now", updatedAt: "now",
    } satisfies OpsTask;
    const cancelExecution = vi.fn();
    const onHeartbeat = vi.fn();
    const controller = startLongRunningMonitor({
      task, step, requirement: "Connect", validation: step.validation, executionId: "exec-1",
      secretValues: {}, getStreamedOutput: () => "password prompt", isCancelled: () => false,
      onHeartbeat, onEvent: vi.fn(), onAudit: vi.fn(), onError: vi.fn(), cancelExecution,
      reviewStep: vi.fn().mockResolvedValue(review("adjust", "model")), scheduler,
    });

    currentTime += 30_000;
    timers.get(1)?.();
    await vi.waitFor(() => expect(cancelExecution).toHaveBeenCalledTimes(1));

    expect(controller.getState().decision?.decision).toBe("adjust");
    expect(onHeartbeat).toHaveBeenLastCalledWith(30, expect.stringContaining("正在中断当前命令"));
    const heartbeatCallsAfterAdjustment = onHeartbeat.mock.calls.length;
    currentTime += 60_000;
    timers.get(1)?.();
    expect(onHeartbeat).toHaveBeenCalledTimes(heartbeatCallsAfterAdjustment);
    controller.stop();
  });

  it("reports 60 seconds without progress and stops after bounded continue reaches its limit", async () => {
    let currentTime = Date.parse("2026-08-14T00:00:00.000Z");
    let nextTimerId = 0;
    const timers = new Map<number, () => void>();
    const scheduler: LongRunningMonitorScheduler = {
      now: () => currentTime,
      setInterval: (callback) => { timers.set(++nextTimerId, callback); return nextTimerId; },
      clearInterval: (timerId) => void timers.delete(timerId),
    };
    const step = {
      id: "step-1", title: "检查环境", description: "检查版本", command: "java -version; npm --version",
      validation: "true", expected: "返回版本", risk: "low", status: "running",
      startedAt: new Date(currentTime).toISOString(),
    } satisfies PlanStep;
    const task = {
      id: "task-1", serverId: "server-1", title: "Task", status: "running", permission: "safe",
      modelId: "model-1", messages: [], plan: [step], createdAt: "now", updatedAt: "now",
    } satisfies OpsTask;
    const reviewStep = vi.fn().mockResolvedValue(review("continue", "model"));
    const cancelExecution = vi.fn();
    const controller = startLongRunningMonitor({
      task, step, requirement: "检查环境", validation: "true", executionId: "exec-1", secretValues: {},
      getStreamedOutput: () => "node v22", isCancelled: () => false, onHeartbeat: vi.fn(),
      onEvent: vi.fn(), onAudit: vi.fn(), onError: vi.fn(), cancelExecution, reviewStep, scheduler,
    });

    currentTime += 30_000;
    timers.get(1)?.();
    await vi.waitFor(() => expect(reviewStep).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    currentTime += 30_000;
    timers.get(1)?.();
    await vi.waitFor(() => expect(reviewStep).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(cancelExecution).toHaveBeenCalledOnce());

    const secondContext = JSON.parse(vi.mocked(reviewStep).mock.calls[1][1]);
    expect(secondContext.progress).toMatchObject({
      workload: "bounded",
      noProgressSeconds: 60,
      noProgressReviewRounds: 2,
    });
    expect(secondContext.progress.stalledNotice).toContain("已连续 60 秒无进展");
    expect(controller.getState().decision).toMatchObject({ decision: "adjust", source: "rules" });
    controller.stop();
  });

  it("lets progressive work continue while output changes", async () => {
    let currentTime = Date.parse("2026-08-14T00:00:00.000Z");
    let nextTimerId = 0;
    const timers = new Map<number, () => void>();
    const scheduler: LongRunningMonitorScheduler = {
      now: () => currentTime,
      setInterval: (callback) => { timers.set(++nextTimerId, callback); return nextTimerId; },
      clearInterval: (timerId) => void timers.delete(timerId),
    };
    const step = {
      id: "step-1", title: "下载依赖", description: "下载安装包", command: "curl -fL URL -o /tmp/pkg",
      validation: "test -s /tmp/pkg", expected: "下载完成", risk: "low", status: "running",
      startedAt: new Date(currentTime).toISOString(),
    } satisfies PlanStep;
    const task = {
      id: "task-1", serverId: "server-1", title: "Task", status: "running", permission: "safe",
      modelId: "model-1", messages: [], plan: [step], createdAt: "now", updatedAt: "now",
    } satisfies OpsTask;
    let output = "0%";
    const reviewStep = vi.fn().mockResolvedValue(review("continue", "model"));
    const cancelExecution = vi.fn();
    const controller = startLongRunningMonitor({
      task, step, requirement: "下载依赖", validation: step.validation, executionId: "exec-1", secretValues: {},
      getStreamedOutput: () => output, isCancelled: () => false, onHeartbeat: vi.fn(), onEvent: vi.fn(),
      onAudit: vi.fn(), onError: vi.fn(), cancelExecution, reviewStep, scheduler,
    });

    for (const [index, progress] of ["25%", "50%", "75%", "90%", "95%"].entries()) {
      output += `\n${progress}`;
      currentTime += 30_000;
      timers.get(1)?.();
      await vi.waitFor(() => expect(reviewStep).toHaveBeenCalledTimes(index + 1));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(cancelExecution).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({
      workload: "progressive",
      noProgressReviewRounds: 0,
      consecutiveContinueRounds: 0,
    });
    const contexts = vi.mocked(reviewStep).mock.calls.map((call) => JSON.parse(call[1]));
    expect(contexts[0].terminalOutput.mode).toBe("initial");
    expect(contexts.slice(1).every((context) => context.terminalOutput.mode === "delta")).toBe(true);
    expect(contexts[contexts.length - 1].terminalOutput.content).toBe("95%");
    controller.stop();
  });

  it("enforces the 90 second hard limit even when a model review is still pending", async () => {
    let currentTime = Date.parse("2026-08-14T00:00:00.000Z");
    let nextTimerId = 0;
    const timers = new Map<number, () => void>();
    const scheduler: LongRunningMonitorScheduler = {
      now: () => currentTime,
      setInterval: (callback) => { timers.set(++nextTimerId, callback); return nextTimerId; },
      clearInterval: (timerId) => void timers.delete(timerId),
    };
    const step = {
      id: "step-1", title: "检查环境", description: "检查版本", command: "npm --version",
      validation: "true", expected: "返回版本", risk: "low", status: "running",
      startedAt: new Date(currentTime).toISOString(),
    } satisfies PlanStep;
    const task = {
      id: "task-1", serverId: "server-1", title: "Task", status: "running", permission: "safe",
      modelId: "model-1", messages: [], plan: [step], createdAt: "now", updatedAt: "now",
    } satisfies OpsTask;
    const cancelExecution = vi.fn();
    const controller = startLongRunningMonitor({
      task, step, requirement: "检查环境", validation: "true", executionId: "exec-1", secretValues: {},
      getStreamedOutput: () => "", isCancelled: () => false, onHeartbeat: vi.fn(), onEvent: vi.fn(),
      onAudit: vi.fn(), onError: vi.fn(), cancelExecution,
      reviewStep: vi.fn().mockImplementation(() => new Promise(() => undefined)), scheduler,
    });

    currentTime += 30_000;
    timers.get(1)?.();
    currentTime += 60_000;
    timers.get(1)?.();
    await vi.waitFor(() => expect(cancelExecution).toHaveBeenCalledOnce());

    expect(controller.getState().decision).toMatchObject({ decision: "adjust", source: "rules" });
    expect(controller.getState().decision?.summary).toContain("不会被判定为成功");
    controller.stop();
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

  it("samples active builds locally, reviews periodically, and escalates new errors without waiting", async () => {
    let currentTime = Date.parse("2026-08-14T00:00:00.000Z");
    const timers = new Map<number, () => void>();
    const scheduler: LongRunningMonitorScheduler = {
      now: () => currentTime,
      setInterval: (callback) => { timers.set(1, callback); return 1; },
      clearInterval: () => timers.clear(),
    };
    const step = {
      id: "step-progress", title: "构建", description: "构建项目", command: "npm run build",
      validation: "test -d dist", expected: "dist exists", risk: "medium", status: "running",
      runtimeClass: "progressive", startedAt: new Date(currentTime).toISOString(),
    } satisfies PlanStep;
    const task = {
      id: "task-progress", serverId: "server-1", title: "Task", status: "running", permission: "safe",
      modelId: "model-1", messages: [], plan: [step], createdAt: "now", updatedAt: "now",
    } satisfies OpsTask;
    const cancelExecution = vi.fn();
    const onAudit = vi.fn();
    let output = "";
    const reviewStep = vi.fn().mockResolvedValue(review("continue", "model"));
    const controller = startLongRunningMonitor({
      task, step, requirement: "构建项目", validation: step.validation, executionId: "exec-progress", secretValues: {},
      getStreamedOutput: () => output, isCancelled: () => false, onHeartbeat: vi.fn(), onEvent: vi.fn(),
      onAudit, onError: vi.fn(), cancelExecution, scheduler,
      sampleRuntimeProgress: vi.fn().mockResolvedValue({ active: true, processCount: 3, cpuPercent: 42, ioBytes: 8192 }),
      reviewStep,
    });

    currentTime += 30_000;
    timers.get(1)?.();
    await vi.waitFor(() => expect(controller.getState().skippedModelReviewCount).toBe(1));
    expect(reviewStep).not.toHaveBeenCalled();
    currentTime += 90_000;
    timers.get(1)?.();
    await vi.waitFor(() => expect(onAudit).toHaveBeenCalledOnce());
    output = "Error: build dependency missing";
    currentTime += 30_000;
    timers.get(1)?.();
    await vi.waitFor(() => expect(reviewStep).toHaveBeenCalledTimes(2));
    expect(JSON.parse(reviewStep.mock.calls[1][1]).terminalOutput.content).toContain("dependency missing");
    expect(cancelExecution).not.toHaveBeenCalled();
    expect(controller.getState().runtimeProgress).toMatchObject({ active: true, processCount: 3 });
    controller.stop();
  });

  it("reviews idle child processes but rejects a stop based only on idle telemetry", async () => {
    let now = 0;
    let tick: () => void = () => {};
    const step = { id: "idle", title: "build", description: "build", command: "npm run build",
      validation: "test -d dist", expected: "artifact", risk: "low", status: "running" } satisfies PlanStep;
    const task = { id: "task", serverId: "server", title: "build", status: "running", permission: "safe",
      modelId: "model", messages: [], plan: [step], createdAt: "now", updatedAt: "now" } satisfies OpsTask;
    const reviewer = vi.fn().mockResolvedValue(review("adjust", "model"));
    const cancelExecution = vi.fn();
    const monitor = startLongRunningMonitor({ task, step, requirement: "build", validation: step.validation,
      executionId: "exec", secretValues: {}, getStreamedOutput: () => "", isCancelled: () => false,
      onHeartbeat: vi.fn(), onEvent: vi.fn(), onAudit: vi.fn(), onError: vi.fn(), reviewStep: reviewer,
      cancelExecution,
      sampleRuntimeProgress: async () => ({ active: true, processCount: 5, cpuPercent: 0, ioBytes: 10 }),
      scheduler: { now: () => now, setInterval: cb => { tick = cb; return 1; }, clearInterval: vi.fn() },
    });
    now = 30_000;
    tick();
    await vi.waitFor(() => expect(reviewer).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelExecution).not.toHaveBeenCalled();
    expect(monitor.getState().skippedModelReviewCount).toBe(0);
    monitor.stop();
  });

  it("keeps an idle progressive process alive and backs off identical model reviews", async () => {
    let now = 0;
    let tick: () => void = () => {};
    const step = { id: "idle-stalled", title: "pull images", description: "pull images",
      command: "kubeadm config images pull", validation: "crictl images", expected: "images", risk: "medium",
      status: "running", runtimeClass: "progressive" } satisfies PlanStep;
    const task = { id: "task", serverId: "server", title: "pull", status: "running", permission: "safe",
      modelId: "model", messages: [], plan: [step], createdAt: "now", updatedAt: "now" } satisfies OpsTask;
    const reviewer = vi.fn().mockResolvedValue(review("continue", "model"));
    const cancelExecution = vi.fn();
    const monitor = startLongRunningMonitor({ task, step, requirement: "pull", validation: step.validation,
      executionId: "exec", secretValues: {}, getStreamedOutput: () => "", isCancelled: () => false,
      onHeartbeat: vi.fn(), onEvent: vi.fn(), onAudit: vi.fn(), onError: vi.fn(),
      reviewStep: reviewer, cancelExecution,
      sampleRuntimeProgress: async () => ({ active: true, processCount: 3, cpuPercent: 0, ioBytes: 0 }),
      scheduler: { now: () => now, setInterval: cb => { tick = cb; return 1; }, clearInterval: vi.fn() },
    });

    now = 30_000;
    tick();
    await vi.waitFor(() => expect(reviewer).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));

    now = 60_000;
    tick();
    await vi.waitFor(() => expect(monitor.getState().skippedModelReviewCount).toBe(1));
    now = 90_000;
    tick();
    await vi.waitFor(() => expect(monitor.getState().skippedModelReviewCount).toBe(2));
    now = 120_000;
    tick();
    await vi.waitFor(() => expect(monitor.getState().skippedModelReviewCount).toBe(3));

    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(cancelExecution).not.toHaveBeenCalled();
    expect(monitor.getState().decision).toMatchObject({ decision: "continue", source: "model" });
    monitor.stop();
  });

  it("does not confuse one failed sample after three busy rounds with stalled work", async () => {
    const sampleRuntimeProgress = vi.fn()
      .mockResolvedValueOnce({ active: true, processCount: 2, cpuPercent: 4, ioBytes: 100 })
      .mockResolvedValueOnce({ active: true, processCount: 2, cpuPercent: 4, ioBytes: 200 })
      .mockResolvedValueOnce({ active: true, processCount: 2, cpuPercent: 4, ioBytes: 300 })
      .mockRejectedValueOnce(new Error("sampling transport unavailable"))
      .mockResolvedValue({ active: true, processCount: 2, cpuPercent: 0, ioBytes: 500 });
    const { input, monitor, advance } = progressiveMonitor({ sampleRuntimeProgress,
      reviewStep: vi.fn().mockResolvedValue(review("adjust", "model")) });
    for (const elapsed of [30_000, 60_000, 90_000, 120_000]) await advance(elapsed);
    expect(input.cancelExecution).not.toHaveBeenCalled();
    expect(monitor.getState()).toMatchObject({
      noOutputSeconds: 120, noProgressSeconds: 30, noProgressReviewRounds: 0,
      runtimeSamplingStatus: "failed", consecutiveRuntimeSampleFailures: 1,
      lastRuntimeProgressAt: new Date(90_000).toISOString(),
    });
    expect(input.onAudit).toHaveBeenCalledWith(expect.objectContaining({ acceptedDecision: false }));
    await advance(150_000);
    expect(monitor.getState()).toMatchObject({ runtimeSamplingStatus: "healthy",
      noProgressSeconds: 0, noProgressReviewRounds: 0, consecutiveRuntimeSampleFailures: 0 });
    expect(input.cancelExecution).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("separates monitoring failures from business failure and retries with backoff", async () => {
    const sampleRuntimeProgress = vi.fn().mockRejectedValue(new Error("monitor unavailable"));
    const { input, monitor, advance } = progressiveMonitor({ sampleRuntimeProgress });
    for (let elapsed = 30_000; elapsed <= 600_000; elapsed += 30_000) await advance(elapsed);
    expect(sampleRuntimeProgress.mock.calls.length).toBeLessThan(10);
    expect(vi.mocked(input.reviewStep).mock.calls.length).toBeLessThanOrEqual(4);
    expect(input.cancelExecution).not.toHaveBeenCalled();
    expect(monitor.getState()).toMatchObject({ runtimeSamplingStatus: "failed", validationPassed: false,
      noProgressReviewRounds: 0, runtimeIdleReviewRounds: 0 });
    expect(input.onEvent).toHaveBeenCalledWith("system", expect.stringContaining("采样失败，正在退避重试"));
    monitor.stop();
  });

  it("does not impose a progressive deadline when runtime sampling is unavailable", async () => {
    const { input, monitor, advance } = progressiveMonitor();
    for (let elapsed = 30_000; elapsed <= 900_000; elapsed += 30_000) await advance(elapsed);
    expect(input.cancelExecution).not.toHaveBeenCalled();
    expect(vi.mocked(input.reviewStep).mock.calls.length).toBeLessThanOrEqual(4);
    expect(monitor.getState().runtimeSamplingStatus).toBe("unavailable");
    monitor.stop();
  });

  it("resets idle and continue budgets on intermittent I/O even when no model review runs", async () => {
    let ioBytes = 0;
    const { input, monitor, advance } = progressiveMonitor({
      sampleRuntimeProgress: async () => ({ active: true, processCount: 2, cpuPercent: 0, ioBytes }),
    });
    for (const elapsed of [30_000, 60_000, 90_000]) await advance(elapsed);
    expect(monitor.getState()).toMatchObject({ noProgressReviewRounds: 3, consecutiveContinueRounds: 1 });
    ioBytes = 100;
    await advance(120_000);
    expect(monitor.getState()).toMatchObject({ noProgressSeconds: 0, noProgressReviewRounds: 0,
      runtimeIdleReviewRounds: 0, consecutiveContinueRounds: 0 });
    expect(input.cancelExecution).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("honors a frozen caller deadline once even with a pending review", async () => {
    const { input, monitor, advance } = progressiveMonitor({ executionDeadlineAt: 180_000,
      reviewStep: vi.fn().mockImplementation(() => new Promise(() => undefined)) });
    await advance(30_000);
    input.executionDeadlineAt = 600_000;
    await advance(180_000);
    await advance(240_000);
    expect(input.cancelExecution).toHaveBeenCalledOnce();
    expect(monitor.getState()).toMatchObject({ decision: { decision: "adjust", source: "rules" }, validationPassed: false });
    monitor.stop();
  });

  it("can still stop a progressive command with concrete new error evidence", async () => {
    const { input, monitor, advance } = progressiveMonitor({
      getStreamedOutput: () => "Error: unable to open output: Permission denied",
      reviewStep: vi.fn().mockResolvedValue(review("adjust", "model")),
      sampleRuntimeProgress: async () => ({ active: true, processCount: 2, cpuPercent: 2, ioBytes: 100 }),
    });
    await advance(30_000);
    expect(input.cancelExecution).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it("does not mistake a persistent service's quiet or handed-off process for a stuck download", async () => {
    const step = { id: "service", title: "start service", description: "start service", command: "node server.js",
      validation: "curl -fsS http://localhost/health", expected: "healthy", risk: "low", status: "running",
      runtimeClass: "persistent_service" } satisfies PlanStep;
    const { input, monitor, advance } = progressiveMonitor({ step,
      sampleRuntimeProgress: async () => ({ active: false, processCount: 0, cpuPercent: 0, ioBytes: 0 }),
      reviewStep: vi.fn().mockResolvedValue(review("adjust", "model")),
    });
    for (let elapsed = 30_000; elapsed <= 300_000; elapsed += 30_000) await advance(elapsed);
    expect(input.cancelExecution).not.toHaveBeenCalled();
    expect(monitor.getState()).toMatchObject({ workload: "persistent_service", validationPassed: false });
    monitor.stop();
  });

  it("keeps a quiet progressive task alive when intermittent I/O proves progress", async () => {
    let now = 0;
    let tick: () => void = () => {};
    const step = { id: "intermittent", title: "download", description: "download", command: "curl -fLO https://example.test/a",
      validation: "test -s a", expected: "artifact", risk: "low", status: "running",
      runtimeClass: "progressive" } satisfies PlanStep;
    const task = { id: "task", serverId: "server", title: "download", status: "running", permission: "safe",
      modelId: "model", messages: [], plan: [step], createdAt: "now", updatedAt: "now" } satisfies OpsTask;
    const reviewer = vi.fn().mockResolvedValue(review("continue", "model"));
    const cancelExecution = vi.fn();
    const ioSamples = [100, 200, 200, 300];
    const monitor = startLongRunningMonitor({ task, step, requirement: "download", validation: step.validation,
      executionId: "exec", secretValues: {}, getStreamedOutput: () => "", isCancelled: () => false,
      onHeartbeat: vi.fn(), onEvent: vi.fn(), onAudit: vi.fn(), onError: vi.fn(),
      reviewStep: reviewer, cancelExecution,
      sampleRuntimeProgress: async () => ({ active: true, processCount: 2, cpuPercent: 0,
        ioBytes: ioSamples.shift() ?? 300 }),
      scheduler: { now: () => now, setInterval: cb => { tick = cb; return 1; }, clearInterval: vi.fn() },
    });

    for (const elapsed of [30_000, 60_000, 90_000, 120_000]) {
      now = elapsed;
      tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(cancelExecution).not.toHaveBeenCalled();
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(monitor.getState()).toMatchObject({ runtimeIdleReviewRounds: 0, modelReviewCount: 1 });
    monitor.stop();
  });

  it("progressive executionId 的进程组消失时确定性停止等待", async () => {
    let currentTime = Date.parse("2026-08-14T00:00:00.000Z");
    const timers = new Map<number, () => void>();
    const scheduler: LongRunningMonitorScheduler = {
      now: () => currentTime,
      setInterval: (callback) => { timers.set(1, callback); return 1; },
      clearInterval: () => timers.clear(),
    };
    const step = {
      id: "step-download", title: "下载", description: "下载依赖", command: "curl -fL https://example.test/a",
      validation: "test -s /tmp/a", expected: "downloaded", risk: "low", status: "running",
      runtimeClass: "progressive", startedAt: new Date(currentTime).toISOString(),
    } satisfies PlanStep;
    const task = {
      id: "task-download", serverId: "server-1", title: "Task", status: "running", permission: "safe",
      modelId: "model-1", messages: [], plan: [step], createdAt: "now", updatedAt: "now",
    } satisfies OpsTask;
    const cancelExecution = vi.fn();
    const controller = startLongRunningMonitor({
      task, step, requirement: "下载", validation: step.validation, executionId: "exec-download", secretValues: {},
      getStreamedOutput: () => "", isCancelled: () => false, onHeartbeat: vi.fn(), onEvent: vi.fn(),
      onAudit: vi.fn(), onError: vi.fn(), cancelExecution, scheduler,
      sampleRuntimeProgress: vi.fn().mockResolvedValue({ active: false, processCount: 0, cpuPercent: 0, ioBytes: 0 }),
      reviewStep: vi.fn(),
    });

    currentTime += 30_000;
    timers.get(1)?.();
    await vi.waitFor(() => expect(cancelExecution).toHaveBeenCalledOnce());
    expect(controller.getState().decision).toMatchObject({ decision: "adjust", source: "rules" });
    controller.stop();
  });
});
