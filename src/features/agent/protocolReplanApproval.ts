import type { OpsTask, PlanStep } from "@/types";
import { isMutatingStepCommand } from "@/services/validation";
import { activeConfirmedInputEntries, confirmedInputScope } from "./confirmedUserInputs";
import { textFingerprint } from "./longRunningReviewOutput";

const DISPLAY_LIMIT = 2_400;

function currentAuthority(task: OpsTask) {
  return { scope: confirmedInputScope(task, "protocol-replan-approval"), roundId: task.currentRoundId,
    permission: task.permission, executionConstraints: task.executionConstraints };
}

/** All decisions participate in the identity; truncation only affects the UI reminder. */
function decisionReminder(task: OpsTask) {
  const entries = activeConfirmedInputEntries(task).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return undefined;
  const exact = entries.map(([key, input]) => ({ key, ...input }));
  const text = entries.map(([key, input]) => `${input.label || key}：${String(input.value)}`).join("；");
  return {
    inputFingerprint: textFingerprint(JSON.stringify({ authority: currentAuthority(task), inputs: exact })),
    decisionSummary: text.length > DISPLAY_LIMIT
      ? `${text.slice(0, DISPLAY_LIMIT)}…（共 ${entries.length} 项决定，完整内容请核对任务输入记录）`
      : text,
  };
}

/**
 * Only call for fresh steps after an explicit protocol-failure -> business-replan
 * transition. We cannot infer authorization from arbitrary form keys/values, so
 * changes in this narrow transition receive their own concrete-action approval.
 * This does not alter risk, task constraints, or imply that prior refusals expired.
 */
export function markProtocolReplanApprovals(task: OpsTask, steps: PlanStep[]): PlanStep[] {
  const reminder = decisionReminder(task);
  return steps.map(step => ({
    ...step,
    // Discard model-authored or inherited approval state even when no gate is needed.
    safetyApprovalSnapshot: undefined,
    approvedSafetySnapshot: undefined,
    protocolReplanApproval: reminder && (step.kind === "change" || isMutatingStepCommand(step.command))
      ? { ...reminder }
      : undefined,
  }));
}

/** A changed answer must invalidate the old concrete-action approval before dispatch. */
export function refreshProtocolReplanApproval(task: OpsTask, step: PlanStep) {
  if (!step.protocolReplanApproval) return;
  const reminder = decisionReminder(task) ?? {
    inputFingerprint: textFingerprint(JSON.stringify({ authority: currentAuthority(task), inputs: [] })),
    decisionSummary: "原用户决定的任务、目标或服务器范围已变化，请重新核对本步骤的具体授权。",
  };
  if (reminder.inputFingerprint === step.protocolReplanApproval.inputFingerprint) return;
  step.protocolReplanApproval = reminder;
  step.safetyApprovalSnapshot = undefined;
  step.approvedSafetySnapshot = undefined;
}
