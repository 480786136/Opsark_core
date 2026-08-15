import {
  applyToolStepOutcome,
  buildToolStepOutcome,
  type ToolStepOutcome,
} from "@/features/agent/toolStepResult";
import { transitionStep } from "@/features/agent/stepMachine";
import type { PlanStep } from "@/types";
import type { ToolCall, ToolResult } from "@/features/tools/types";

type ToolExecutor = () => Promise<ToolResult>;

export interface RunToolStepLifecycleInput {
  step: PlanStep;
  call: ToolCall;
  execute: ToolExecutor;
  createEvidenceId(): string;
  now(): string;
  isCancelled(): boolean;
  onStart(eventMessage: string): void;
}

export interface ToolStepCoordination {
  taskStatus: "running" | "needs_adjustment";
  eventMessage: string;
  pauseReason?: string;
  shouldAdvance: boolean;
  outcome: ToolStepOutcome;
}

function executionFailure(call: ToolCall, error: unknown): ToolResult {
  return {
    callId: call.id,
    toolId: call.toolId,
    success: false,
    error: { code: "TOOL_EXECUTION_FAILED", message: String(error) },
  };
}

/** Runs one tool step and refuses to apply a result after task cancellation. */
export async function runToolStepLifecycle(
  input: RunToolStepLifecycleInput,
): Promise<{ cancelled: true } | ({ cancelled: false } & ToolStepCoordination)> {
  if (input.isCancelled()) return { cancelled: true };
  transitionStep(input.step, "running");
  const startedAt = input.now();
  input.step.startedAt = startedAt;
  input.step.progressMessage = "正在调用只读工具…";
  input.onStart(`调用工具 ${input.call.toolId} 获取执行前证据。`);

  let result: ToolResult;
  try {
    result = await input.execute();
  } catch (error) {
    result = executionFailure(input.call, error);
  }
  if (input.isCancelled()) return { cancelled: true };

  const completedAt = input.now();
  input.step.elapsedSeconds = Math.max(0, Math.floor(
    (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000,
  ));
  const outcome = buildToolStepOutcome({
    call: input.call,
    result,
    completedAt,
    evidenceId: input.createEvidenceId(),
  });
  transitionStep(input.step, outcome.status);
  applyToolStepOutcome(input.step, outcome);

  return {
    cancelled: false,
    taskStatus: outcome.status === "failed" ? "needs_adjustment" : "running",
    eventMessage: outcome.eventMessage,
    pauseReason: outcome.pauseReason,
    shouldAdvance: outcome.status === "completed",
    outcome,
  };
}
