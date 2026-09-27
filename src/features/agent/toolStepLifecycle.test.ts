import { describe, expect, it, vi } from "vitest";
import { cancelStep } from "@/features/agent/stepInterruption";
import { runToolStepLifecycle } from "@/features/agent/toolStepLifecycle";
import type { PlanStep } from "@/types";
import type { ToolCall } from "@/features/tools/types";
import { ExecutionLedgerError, type ExecutionLedgerStage } from "@/services/executionLedger";

const call: ToolCall = {
  id: "call-1",
  toolId: "files.get_structure",
  arguments: { rootPath: "/opt/app" },
};

function step(): PlanStep {
  return {
    id: "step-1",
    title: "读取结构",
    description: "读取目录结构",
    command: "", action: { type: "tool" as const, toolId: "files.get_structure", arguments: {} },
    risk: "low",
    expected: "返回结构",
    validation: "",
    status: "pending",
  };
}

describe("tool step lifecycle", () => {
  it("does not start a tool for an already cancelled task", async () => {
    const currentStep = step();
    const execute = vi.fn();
    const onStart = vi.fn();
    const result = await runToolStepLifecycle({
      step: currentStep,
      call,
      execute,
      createEvidenceId: () => "unused",
      now: () => "2026-08-14T01:00:00.000Z",
      isCancelled: () => true,
      onStart,
    });

    expect(result).toEqual({ cancelled: true });
    expect(currentStep.status).toBe("pending");
    expect(execute).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("applies a successful result and calculates elapsed time", async () => {
    const currentStep = step();
    const onStart = vi.fn();
    const times = ["2026-08-14T01:00:00.000Z", "2026-08-14T01:00:03.500Z"];
    const result = await runToolStepLifecycle({
      step: currentStep,
      call,
      execute: vi.fn().mockResolvedValue({
        callId: call.id,
        toolId: call.toolId,
        success: true,
        data: { rootPath: "/opt/app", tree: "/opt/app/", truncated: false, warnings: [] },
      }),
      createEvidenceId: () => "evidence-1",
      now: () => times.shift() ?? "",
      isCancelled: () => false,
      onStart,
    });

    expect(result).toMatchObject({ cancelled: false, taskStatus: "running", shouldAdvance: true });
    expect(currentStep.status).toBe("completed");
    expect(currentStep.elapsedSeconds).toBe(3);
    expect(currentStep.evidence?.[0].id).toBe("evidence-1");
    expect(onStart).toHaveBeenCalledWith(expect.stringContaining(call.toolId));
  });

  it("converts an execution-boundary exception into a tool failure", async () => {
    const currentStep = step();
    const result = await runToolStepLifecycle({
      step: currentStep,
      call,
      execute: vi.fn().mockRejectedValue(new Error("请先连接真实服务器")),
      createEvidenceId: () => "unused",
      now: vi.fn()
        .mockReturnValueOnce("2026-08-14T01:00:00.000Z")
        .mockReturnValueOnce("2026-08-14T01:00:01.000Z"),
      isCancelled: () => false,
      onStart: vi.fn(),
    });

    expect(result).toMatchObject({
      cancelled: false,
      taskStatus: "needs_adjustment",
      shouldAdvance: false,
    });
    expect(currentStep.status).toBe("failed");
    expect(currentStep.result).toMatchObject({
      facts: { errorCode: "TOOL_EXECUTION_FAILED" },
    });
  });

  it("does not overwrite the cancelled step with a late tool result", async () => {
    const currentStep = step();
    let cancelled = false;
    const result = await runToolStepLifecycle({
      step: currentStep,
      call,
      execute: vi.fn().mockImplementation(async () => {
        cancelStep(currentStep, "用户终止");
        cancelled = true;
        return { callId: call.id, toolId: call.toolId, success: true, data: {} };
      }),
      createEvidenceId: () => "unused",
      now: () => "2026-08-14T01:00:00.000Z",
      isCancelled: () => cancelled,
      onStart: vi.fn(),
    });

    expect(result).toEqual({ cancelled: true });
    expect(currentStep.status).toBe("skipped");
    expect(currentStep.result?.executionStatus).toBe("cancelled");
    expect(currentStep.evidence).toBeUndefined();
  });
});


describe("bounded tool recovery", () => {
  it.each<ExecutionLedgerStage>(["prepare", "begin", "result_commit", "stale_result"])("preserves %s as a ledger incident without replay or fabricated remote failure", async stage => {
    const currentStep = step();
    const error = new ExecutionLedgerError("执行记录提交待恢复", stage, stage === "result_commit", "operation-a", "attempt-a");
    const execute = vi.fn().mockRejectedValue(error), waitBeforeRetry = vi.fn();
    await expect(runToolStepLifecycle({ step: currentStep, call, execute, waitBeforeRetry,
      createEvidenceId: () => "unused", now: () => "2026-09-26T00:00:00Z", isCancelled: () => false,
      onStart: vi.fn() })).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(waitBeforeRetry).not.toHaveBeenCalled();
    expect(currentStep.result).toBeUndefined();
    expect(currentStep.evidence).toBeUndefined();
    expect(currentStep.status).not.toBe("failed");
  });
  async function run(toolId: string, category: string, cancelDuringWait = false) {
    let cancelled = false;
    const currentStep = step();
    const execute = vi.fn().mockResolvedValue({ callId: call.id, toolId, success: false,
      error: { code: "TEST_FAILURE", category, dispatchState: "unknown", message: "temporary failure" } });
    const waitBeforeRetry = vi.fn(async (_delay: number) => { cancelled = cancelDuringWait; });
    const result = await runToolStepLifecycle({ step: currentStep, call: { ...call, toolId }, execute,
      createEvidenceId: () => "evidence", now: () => "2026-09-26T00:00:00Z", isCancelled: () => cancelled,
      onStart: vi.fn(), waitBeforeRetry });
    return { result, execute, waitBeforeRetry, currentStep };
  }
  it("stops read-only transient failures after three attempts and never advances", async () => {
    const { result, execute, waitBeforeRetry, currentStep } = await run("files.read_content", "timeout");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(waitBeforeRetry.mock.calls).toEqual([[500], [1500]]);
    expect(result).toMatchObject({ cancelled: false, taskStatus: "needs_adjustment", shouldAdvance: false });
    expect(currentStep.status).toBe("failed");
    expect(currentStep.result?.facts.attempts).toHaveLength(3);
  });
  it.each(["arguments", "authentication", "permission", "business"])("does not retry %s", async category => {
    const { execute, waitBeforeRetry } = await run("files.read_content", category);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(waitBeforeRetry).not.toHaveBeenCalled();
  });
  it.each(["files.get_structure", "files.transfer_between_servers"])("rejects malformed success without retry, evidence or progression: %s", async toolId => {
    const currentStep = step();
    const execute = vi.fn().mockResolvedValue({ callId: call.id, toolId, success: true, data: {} });
    const waitBeforeRetry = vi.fn();
    const result = await runToolStepLifecycle({ step: currentStep, call: { ...call, toolId }, execute,
      createEvidenceId: () => "unused", now: () => "2026-09-26T00:00:00Z", isCancelled: () => false,
      onStart: vi.fn(), waitBeforeRetry });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(waitBeforeRetry).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cancelled: false, taskStatus: "needs_adjustment", shouldAdvance: false });
    expect(currentStep.evidence).toBeUndefined();
    expect(currentStep.result?.facts).toMatchObject({ errorCode: "TOOL_OUTPUT_INVALID", dispatchState: "unknown" });
  });
  it("never replays a change with uncertain dispatch", async () => {
    const { execute } = await run("files.transfer_between_servers", "network");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("honors cancellation between attempts", async () => {
    const { result, execute } = await run("files.read_content", "rate_limit", true);
    expect(result).toEqual({ cancelled: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
