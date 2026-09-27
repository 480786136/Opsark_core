import { enforceToolResult } from "@/features/tools/toolResultContract";
import { toolFailure } from "@/features/tools/toolFailure";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import {
  applyToolStepOutcome,
  buildToolStepOutcome,
  type ToolStepOutcome,
} from "@/features/agent/toolStepResult";
import { transitionStep } from "@/features/agent/stepMachine";
import type { PlanStep } from "@/types";
import type { ToolCall, ToolResult } from "@/features/tools/types";
import { ExecutionLedgerError } from "@/services/executionLedger";

type ToolExecutor = () => Promise<ToolResult>;

export interface RunToolStepLifecycleInput {
  step: PlanStep;
  call: ToolCall;
  execute: ToolExecutor;
  createEvidenceId(): string;
  now(): string;
  isCancelled(): boolean;
  onStart(eventMessage: string): void;
  waitBeforeRetry?(delayMs: number): Promise<void>;
  onRetry?(attempt: number): void;
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
    error: toolFailure(error, true),
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
  input.step.progressMessage = "正在调用工具…";
  input.onStart(`调用工具 ${input.call.toolId} ，等待结构化执行结果。`);

  let result: ToolResult;
  const attempts: NonNullable<ToolResult["attempts"]> = [];
  const readOnly = defaultToolCatalog.find(tool => tool.id === input.call.toolId)?.effect === "read";
  // One owner and one budget per actual tool step. Changes never receive automatic replay here.
  for (;;) {
    try { result = enforceToolResult(input.call, await input.execute()); }
    catch (error) {
      // Storage, uncertain dispatch and stale receipts are coordinator states.
      // Converting them to a tool failure would erase known results or retry I/O.
      if (error instanceof ExecutionLedgerError) throw error;
      result = executionFailure(input.call, error);
    }
    attempts.push({ number: attempts.length + 1, code: result.error?.code, category: result.error?.category, dispatchState: result.error?.dispatchState });
    const transient = ["network", "timeout", "rate_limit"].includes(result.error?.category ?? "");
    if (result.success || !readOnly || !transient || attempts.length >= 3 || input.isCancelled()) break;
    const delay = Math.min(30_000, Math.max(attempts.length === 1 ? 500 : 1500, result.error?.retryAfterMs ?? 0));
    input.onRetry?.(attempts.length);
    await (input.waitBeforeRetry ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(delay);
    if (input.isCancelled()) return { cancelled: true };
  }
  result = { ...result, attempts };
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
