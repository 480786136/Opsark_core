import type { AuditEventDraft } from "@/features/agent/auditTrail";
import type { StepResult, StepValidator } from "@/types";

interface ExecutionAuditScope {
  stepTitle: string;
  serverId: string;
  taskId: string;
}

export interface CommandResultAuditInput extends ExecutionAuditScope {
  commandTemplate: string;
  output: string;
  success: boolean;
}

/** Builds command audit from placeholder-safe command text and redacted output only. */
export function buildCommandResultAudit(input: CommandResultAuditInput): AuditEventDraft {
  return {
    category: "command",
    level: input.success ? "success" : "error",
    title: input.stepTitle,
    detail: `${input.commandTemplate}\n${input.output}`,
    serverId: input.serverId,
    taskId: input.taskId,
  };
}

export interface ValidationResultAuditInput extends ExecutionAuditScope {
  accepted: boolean;
  validator?: StepValidator;
  result: StepResult;
  validationTemplate: string;
  validationOutput: string;
}

/** Builds the deterministic program-evidence audit after independent validation. */
export function buildValidationResultAudit(
  input: ValidationResultAuditInput,
): AuditEventDraft {
  const warning = ["warning", "unhealthy"].includes(input.result.observationStatus);
  return {
    category: "command",
    level: input.accepted ? (warning ? "warning" : "success") : "error",
    title: `${input.stepTitle} · 程序证据校验`,
    detail: JSON.stringify({
      validator: input.validator,
      result: input.result,
      validationCommand: input.validationTemplate,
      validationOutput: input.validationOutput,
    }, null, 2),
    serverId: input.serverId,
    taskId: input.taskId,
  };
}

