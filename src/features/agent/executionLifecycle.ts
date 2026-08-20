import type { RuntimeConnection, RuntimeModel } from "@/services/backend";
import {
  executeStepCommand,
  executeStepValidation,
} from "@/features/agent/executionRunner";
import type {
  ExecutionCommandResult,
  ExecuteStepCommandInput,
  ExecuteStepValidationInput,
  StepValidationResult,
} from "@/features/agent/executionRunner";
import {
  startLongRunningMonitor,
} from "@/features/agent/longRunningMonitor";
import type {
  LongRunningMonitorController,
  LongRunningMonitorState,
  LongRunningReviewAudit,
  StartLongRunningMonitorInput,
} from "@/features/agent/longRunningMonitor";
import { appendTerminalOutput } from "@/utils/terminal";
import type { OpsTask, PlanStep } from "@/types";

type CommandExecutor = (input: ExecuteStepCommandInput) => Promise<ExecutionCommandResult>;
type ValidationExecutor = (input: ExecuteStepValidationInput) => Promise<StepValidationResult>;
type MonitorStarter = (input: StartLongRunningMonitorInput) => LongRunningMonitorController;

export interface RunCommandLifecycleInput {
  task: OpsTask;
  step: PlanStep;
  requirement: string;
  command: string;
  validation: string;
  executionId: string;
  connection?: RuntimeConnection;
  runtimeModel?: RuntimeModel;
  secretValues: Record<string, string>;
  isCancelled(): boolean;
  onExecutionChange(executionId?: string): void;
  onProgress(safeChunk: string, streamedOutput: string): void;
  onHeartbeat(elapsedSeconds: number, progressMessage: string): void;
  onEvent(role: "assistant" | "system", content: string): void;
  onAudit(audit: LongRunningReviewAudit): void;
  onError(title: string, detail: string): void;
  cancelExecution?(): Promise<void> | void;
}

export interface CommandLifecycleResult {
  result: ExecutionCommandResult;
  streamedOutput: string;
  monitorState: LongRunningMonitorState;
}

/**
 * Owns one remote command's monitor and execution ID lifetime. Cleanup always
 * runs, including when the backend executor throws or cancellation races settle.
 */
export async function runCommandLifecycle(
  input: RunCommandLifecycleInput,
  executeCommand: CommandExecutor = executeStepCommand,
  startMonitor: MonitorStarter = startLongRunningMonitor,
): Promise<CommandLifecycleResult> {
  let streamedOutput = "";
  input.onExecutionChange(input.executionId);
  const monitor = startMonitor({
    task: input.task,
    step: input.step,
    requirement: input.requirement,
    validation: input.validation,
    executionId: input.executionId,
    connection: input.connection,
    runtimeModel: input.runtimeModel,
    secretValues: input.secretValues,
    getStreamedOutput: () => streamedOutput,
    isCancelled: input.isCancelled,
    onHeartbeat: input.onHeartbeat,
    onEvent: input.onEvent,
    onAudit: input.onAudit,
    onError: input.onError,
    cancelExecution: input.cancelExecution,
  });

  let result: ExecutionCommandResult;
  try {
    result = await executeCommand({
      command: input.command,
      connection: input.connection,
      approvedHighRisk: input.step.risk === "high",
      executionId: input.executionId,
      secretValues: input.secretValues,
      onProgress: (safeChunk) => {
        streamedOutput = appendTerminalOutput(streamedOutput, safeChunk);
        input.onProgress(safeChunk, streamedOutput);
      },
    });
  } finally {
    monitor.stop();
    input.onExecutionChange(undefined);
  }

  const monitorState = monitor.getState();
  if (
    monitorState.decision?.decision === "complete"
    && monitorState.validationPassed
    && !result.success
    && result.exitCode === 130
  ) {
    result = {
      ...result,
      success: true,
      exitCode: 0,
      output: `${result.output}\n[长任务复核：定期校验已通过，已停止等待并进入正式校验]`,
    };
  }
  return { result, streamedOutput, monitorState };
}

export interface RunValidationLifecycleInput {
  step: PlanStep;
  validation: string;
  initialExecutionId: string;
  createRetryExecutionId(): string;
  connection?: RuntimeConnection;
  secretValues: Record<string, string>;
  isCancelled(): boolean;
  onExecutionChange(executionId?: string): void;
  onProgress(safeChunk: string): void;
  onRetry(firstOutput: string, maxRetries: number): void;
  waitBeforeRetry?(delayMs: number): Promise<void>;
}

export interface ValidationLifecycleResult {
  validation: StepValidationResult;
  retried: boolean;
  firstFailedOutput: string;
  attemptCount: number;
}

export const VALIDATION_STABILIZATION_DELAYS_MS = [500, 1_500, 3_000] as const;

function validationMayStillStabilize(validation: StepValidationResult) {
  return !validation.passed && ![2, 126, 127].includes(validation.exitCode ?? 1);
}

const defaultValidationWait = (delayMs: number) => new Promise<void>((resolve) => {
  globalThis.setTimeout(resolve, delayMs);
});

/**
 * Runs every postcondition through one bounded stabilization window. This covers
 * service readiness, filesystem propagation and other eventual state without
 * treating syntax errors or missing validators as transient races.
 */
export async function runValidationLifecycle(
  input: RunValidationLifecycleInput,
  executeValidation: ValidationExecutor = executeStepValidation,
): Promise<ValidationLifecycleResult> {
  const run = async (executionId: string) => {
    input.onExecutionChange(executionId);
    try {
      return await executeValidation({
        step: { ...input.step, validation: input.validation },
        connection: input.connection,
        executionId,
        secretValues: input.secretValues,
        onProgress: input.onProgress,
      });
    } finally {
      input.onExecutionChange(undefined);
    }
  };

  let validation = await run(input.initialExecutionId);
  let attemptCount = 1;
  if (input.isCancelled() || !validationMayStillStabilize(validation)) {
    return { validation, retried: false, firstFailedOutput: "", attemptCount };
  }

  const firstFailedOutput = validation.output ?? "";
  input.onRetry(firstFailedOutput, VALIDATION_STABILIZATION_DELAYS_MS.length);
  const waitBeforeRetry = input.waitBeforeRetry ?? defaultValidationWait;
  for (const delayMs of VALIDATION_STABILIZATION_DELAYS_MS) {
    await waitBeforeRetry(delayMs);
    if (input.isCancelled()) break;
    validation = await run(input.createRetryExecutionId());
    attemptCount += 1;
    if (validation.passed || !validationMayStillStabilize(validation)) break;
  }
  return { validation, retried: attemptCount > 1, firstFailedOutput, attemptCount };
}
