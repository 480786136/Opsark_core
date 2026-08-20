import { describe, expect, it, vi } from "vitest";
import {
  runCommandLifecycle,
  runValidationLifecycle,
} from "@/features/agent/executionLifecycle";
import type { OpsTask, PlanStep } from "@/types";

function createStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "step-1",
    title: "检查页面",
    description: "检查 HTTP 页面",
    command: "curl http://localhost",
    risk: "low",
    expected: "返回页面",
    validation: "curl -fsS http://localhost",
    status: "running",
    ...overrides,
  };
}

function createTask(step: PlanStep): OpsTask {
  return {
    id: "task-1",
    serverId: "server-1",
    title: "检查服务",
    status: "running",
    permission: "safe",
    modelId: "model-1",
    messages: [],
    plan: [step],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

const noop = () => undefined;

describe("execution lifecycle", () => {
  it("stops monitoring, clears the execution ID and accepts verified completion", async () => {
    const step = createStep();
    const executionChanges: Array<string | undefined> = [];
    const stop = vi.fn();
    const result = await runCommandLifecycle({
      task: createTask(step),
      step,
      requirement: "检查服务",
      command: step.command,
      validation: step.validation,
      executionId: "exec-1",
      secretValues: {},
      isCancelled: () => false,
      onExecutionChange: (id) => executionChanges.push(id),
      onProgress: noop,
      onHeartbeat: noop,
      onEvent: noop,
      onAudit: noop,
      onError: noop,
    }, async (input) => {
      input.onProgress?.("50%", { executionId: "exec-1", data: "50%", stream: "stdout" });
      return { output: "stopped\n[exit: 130]", success: false, simulated: false, exitCode: 130 };
    }, () => ({
      stop,
      getState: () => ({
        decision: { decision: "complete", reason: "healthy", summary: "done", source: "model" },
        validationPassed: true,
        reviewRound: 1,
      }),
    }));

    expect(result.result).toMatchObject({ success: true, exitCode: 0 });
    expect(result.streamedOutput).toBe("50%");
    expect(stop).toHaveBeenCalledOnce();
    expect(executionChanges).toEqual(["exec-1", undefined]);
  });

  it("clears command execution state when the executor throws", async () => {
    const step = createStep();
    const executionChanges: Array<string | undefined> = [];
    const stop = vi.fn();
    await expect(runCommandLifecycle({
      task: createTask(step),
      step,
      requirement: "检查服务",
      command: step.command,
      validation: step.validation,
      executionId: "exec-2",
      secretValues: {},
      isCancelled: () => false,
      onExecutionChange: (id) => executionChanges.push(id),
      onProgress: noop,
      onHeartbeat: noop,
      onEvent: noop,
      onAudit: noop,
      onError: noop,
    }, async () => {
      throw new Error("connection closed");
    }, () => ({
      stop,
      getState: () => ({ validationPassed: false, reviewRound: 0 }),
    }))).rejects.toThrow("connection closed");

    expect(stop).toHaveBeenCalledOnce();
    expect(executionChanges).toEqual(["exec-2", undefined]);
  });

  it("对所有可收敛的后置校验进行有界重试", async () => {
    const step = createStep({ status: "validating" });
    const executionChanges: Array<string | undefined> = [];
    const onRetry = vi.fn();
    const execute = vi.fn()
      .mockResolvedValueOnce({ passed: false, detail: "timeout", output: "timeout", exitCode: 28 })
      .mockResolvedValueOnce({ passed: true, detail: "ok", output: "HTTP/1.1 200", exitCode: 0 });

    const result = await runValidationLifecycle({
      step,
      validation: step.validation,
      initialExecutionId: "validation-1",
      createRetryExecutionId: () => "validation-2",
      secretValues: {},
      isCancelled: () => false,
      onExecutionChange: (id) => executionChanges.push(id),
      onProgress: noop,
      onRetry,
      waitBeforeRetry: async () => undefined,
    }, execute);

    expect(result).toMatchObject({ retried: true, firstFailedOutput: "timeout", attemptCount: 2 });
    expect(result.validation.passed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith("timeout", 3);
    expect(executionChanges).toEqual([
      "validation-1", undefined,
      "validation-2", undefined,
    ]);
  });

  it("持续未收敛时最多执行四次而不无限等待", async () => {
    const step = createStep({
      command: "systemctl restart app",
      validation: "systemctl is-active --quiet app",
      status: "validating",
    });
    const execute = vi.fn().mockResolvedValue({
      passed: false,
      detail: "activating",
      output: "activating",
      exitCode: 1,
    });
    const waits: number[] = [];

    const result = await runValidationLifecycle({
      step,
      validation: step.validation,
      initialExecutionId: "validation-1",
      createRetryExecutionId: () => `validation-${execute.mock.calls.length + 1}`,
      secretValues: {},
      isCancelled: () => false,
      onExecutionChange: noop,
      onProgress: noop,
      onRetry: noop,
      waitBeforeRetry: async (delayMs) => { waits.push(delayMs); },
    }, execute);

    expect(result).toMatchObject({ retried: true, attemptCount: 4 });
    expect(execute).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([500, 1_500, 3_000]);
  });

  it("校验命令不可执行时不将确定性失败当成竞态", async () => {
    const step = createStep({ status: "validating" });
    const execute = vi.fn().mockResolvedValue({
      passed: false,
      detail: "command not found",
      output: "command not found",
      exitCode: 127,
    });

    const result = await runValidationLifecycle({
      step,
      validation: step.validation,
      initialExecutionId: "validation-1",
      createRetryExecutionId: () => "unused",
      secretValues: {},
      isCancelled: () => false,
      onExecutionChange: noop,
      onProgress: noop,
      onRetry: noop,
      waitBeforeRetry: async () => undefined,
    }, execute);

    expect(result).toMatchObject({ retried: false, attemptCount: 1 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("clears validation execution state when validation throws", async () => {
    const step = createStep({ status: "validating" });
    const executionChanges: Array<string | undefined> = [];
    await expect(runValidationLifecycle({
      step,
      validation: step.validation,
      initialExecutionId: "validation-error",
      createRetryExecutionId: () => "unused",
      secretValues: {},
      isCancelled: () => false,
      onExecutionChange: (id) => executionChanges.push(id),
      onProgress: noop,
      onRetry: noop,
    }, async () => {
      throw new Error("validation failed");
    })).rejects.toThrow("validation failed");

    expect(executionChanges).toEqual(["validation-error", undefined]);
  });
});
