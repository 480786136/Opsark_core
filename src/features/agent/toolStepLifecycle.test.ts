import { describe, expect, it, vi } from "vitest";
import { cancelStep } from "@/features/agent/stepInterruption";
import { runToolStepLifecycle } from "@/features/agent/toolStepLifecycle";
import type { PlanStep } from "@/types";
import type { ToolCall } from "@/features/tools/types";

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
    command: "opsark-tool files.get_structure {}",
    risk: "low",
    expected: "返回结构",
    validation: "true",
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
        data: { totalNodes: 3 },
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
