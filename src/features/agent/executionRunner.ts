import { backend } from "@/services/backend";
import type { CommandOutputEvent, RuntimeConnection } from "@/services/backend";
import { redactExecutionOutput } from "@/features/agent/secretTool";
import { sanitizeTerminalOutput } from "@/utils/terminal";
import type { PlanStep } from "@/types";

export interface ExecutionCommandResult {
  output: string;
  success: boolean;
  simulated: boolean;
  exitCode?: number;
  emptyResult?: boolean;
}

export interface ExecuteStepCommandInput {
  command: string;
  connection?: RuntimeConnection;
  approvedHighRisk: boolean;
  executionId: string;
  secretValues: Record<string, string>;
  onProgress?(safeChunk: string, event: CommandOutputEvent): void;
}

type CommandExecutor = typeof backend.executeCommand;
type ValidationExecutor = typeof backend.validateStep;

export interface StepValidationResult {
  passed: boolean;
  detail: string;
  output?: string;
  exitCode?: number;
  emptyResult?: boolean;
}

export interface ExecuteStepValidationInput {
  step: PlanStep;
  connection?: RuntimeConnection;
  executionId: string;
  secretValues: Record<string, string>;
  onProgress?(safeChunk: string, event: CommandOutputEvent): void;
}

export async function executeStepCommand(
  input: ExecuteStepCommandInput,
  executor: CommandExecutor = backend.executeCommand.bind(backend),
): Promise<ExecutionCommandResult> {
  const result = await executor(
    input.command,
    input.connection,
    input.approvedHighRisk,
    {
      executionId: input.executionId,
      onProgress: (event) => {
        const safeChunk = redactExecutionOutput(sanitizeTerminalOutput(event.data), input.secretValues);
        if (safeChunk) input.onProgress?.(safeChunk, event);
      },
    },
  );
  return {
    ...result,
    output: redactExecutionOutput(sanitizeTerminalOutput(result.output), input.secretValues),
  };
}

export async function executeStepValidation(
  input: ExecuteStepValidationInput,
  executor: ValidationExecutor = backend.validateStep.bind(backend),
): Promise<StepValidationResult> {
  const result = await executor(input.step, input.connection, {
    executionId: input.executionId,
    onProgress: (event) => {
      const safeChunk = redactExecutionOutput(sanitizeTerminalOutput(event.data), input.secretValues);
      if (safeChunk) input.onProgress?.(safeChunk, event);
    },
  });
  return {
    ...result,
    output: result.output
      ? redactExecutionOutput(sanitizeTerminalOutput(result.output), input.secretValues)
      : result.output,
  };
}
