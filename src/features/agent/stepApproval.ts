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
  "command" | "validation" | "risk" | "executionScope" | "validationScope" | "sessionContextChange" | "runtimeClass" | "protocolReplanApproval"
>) {
  return {
    risk: step.risk,
    command: step.command,
    validation: step.validation,
    executionScope: step.executionScope,
    validationScope: step.validationScope,
    sessionContextChange: step.sessionContextChange != null
      ? structuredClone(step.sessionContextChange)
      : undefined,
    runtimeClass: step.runtimeClass,
    protocolReplanApproval: step.protocolReplanApproval ? { ...step.protocolReplanApproval } : undefined,
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
    && JSON.stringify(approved.protocolReplanApproval ?? undefined)
      === JSON.stringify(step.protocolReplanApproval ?? undefined)
    && JSON.stringify(approved.sessionContextChange ?? undefined)
      === JSON.stringify(step.sessionContextChange ?? undefined));
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
    eventMessage: step.protocolReplanApproval
      ? `协议修复已转为新的业务调整。步骤“${step.title}”将修改目标状态，请核对已确认决定：${step.protocolReplanApproval.decisionSummary}。本次确认仅授权本步骤展示的具体变更，不撤销任务级禁止事项；如与原决定冲突，请先补充授权或调整方案。`
      : `步骤“${step.title}”为${RISK_LABEL[step.risk]}风险，需要单独确认。`,
  };
}

/** Accepts only a currently waiting step; execution owns its next step transition. */
export function acceptStepApproval(step: PlanStep): AcceptedStepApproval | undefined {
  if (step.status !== "awaiting_approval") return undefined;
  step.safetyApprovalSnapshot = planSafetySnapshot(step);
  step.approvedSafetySnapshot = { ...step.safetyApprovalSnapshot };
  return { taskStatus: "running", shouldExecute: true };
}
