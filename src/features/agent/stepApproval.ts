import { requiresStepApproval } from "@/features/agent/approvalPolicy";
import { transitionStep } from "@/features/agent/stepMachine";
import type { PermissionLevel, PlanStep } from "@/types";

export interface StepApprovalRequest {
  taskStatus: "awaiting_step_approval";
  eventMessage: string;
}

export interface AcceptedStepApproval {
  taskStatus: "running";
  shouldExecute: true;
}

const RISK_LABEL: Record<PlanStep["risk"], string> = {
  low: "低",
  medium: "中",
  high: "高",
};

export function planSafetySnapshot(step: Pick<PlanStep,
  "command" | "validation" | "risk" | "executionScope" | "validationScope" | "sessionContextChange" | "runtimeClass"
>) {
  return {
    risk: step.risk,
    command: step.command,
    validation: step.validation,
    executionScope: step.executionScope,
    validationScope: step.validationScope,
    sessionContextChange: step.sessionContextChange
      ? structuredClone(step.sessionContextChange)
      : undefined,
    runtimeClass: step.runtimeClass,
  } satisfies NonNullable<PlanStep["safetyApprovalSnapshot"]>;
}

export function hasCurrentStepApproval(step: PlanStep) {
  const approved = step.approvedSafetySnapshot;
  return Boolean(approved
    && approved.risk === step.risk
    && approved.command === step.command
    && approved.validation === step.validation
    && approved.executionScope === step.executionScope
    && approved.validationScope === step.validationScope
    && approved.runtimeClass === step.runtimeClass
    && JSON.stringify(approved.sessionContextChange) === JSON.stringify(step.sessionContextChange));
}

/** Moves a pending step into approval wait and provides its user-facing event. */
export function requestStepApproval(
  permission: PermissionLevel,
  step: PlanStep,
): StepApprovalRequest | undefined {
  if (!requiresStepApproval(permission, step)) return undefined;

  transitionStep(step, "awaiting_approval");
  step.safetyApprovalSnapshot = planSafetySnapshot(step);
  step.approvedSafetySnapshot = undefined;
  return {
    taskStatus: "awaiting_step_approval",
    eventMessage: `步骤“${step.title}”为${RISK_LABEL[step.risk]}风险，需要单独确认。`,
  };
}

/** Accepts only a currently waiting step; execution owns its next step transition. */
export function acceptStepApproval(step: PlanStep): AcceptedStepApproval | undefined {
  if (step.status !== "awaiting_approval") return undefined;
  step.safetyApprovalSnapshot = planSafetySnapshot(step);
  step.approvedSafetySnapshot = { ...step.safetyApprovalSnapshot };
  return { taskStatus: "running", shouldExecute: true };
}
