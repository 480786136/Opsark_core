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

/** Moves a pending step into approval wait and provides its user-facing event. */
export function requestStepApproval(
  permission: PermissionLevel,
  step: PlanStep,
): StepApprovalRequest | undefined {
  if (!requiresStepApproval(permission, step)) return undefined;

  transitionStep(step, "awaiting_approval");
  return {
    taskStatus: "awaiting_step_approval",
    eventMessage: `步骤“${step.title}”为${RISK_LABEL[step.risk]}风险，需要单独确认。`,
  };
}

/** Accepts only a currently waiting step; execution owns its next step transition. */
export function acceptStepApproval(step: PlanStep): AcceptedStepApproval | undefined {
  if (step.status !== "awaiting_approval") return undefined;
  return { taskStatus: "running", shouldExecute: true };
}
