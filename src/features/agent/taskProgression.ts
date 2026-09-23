import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import type { ToolDefinition } from "@/features/tools/types";
import type { OpsTask, PlanStep } from "@/types";
import { taskGoal } from "@/features/agent/taskGoal";
import { unresolvedRecoveryBlockers } from "./recoveryContract";

export type TaskProgression =
  | { kind: "wait"; step: PlanStep }
  | { kind: "execute-step"; step: PlanStep }
  | { kind: "complete" };

/** Returns the stable overall goal; follow-up instructions must not silently replace it. */
export function latestTaskRequirement(task: OpsTask) {
  return taskGoal(task);
}

/**
 * Determines the next executor branch without mutating task state. Once the
 * executable queue is exhausted, overall completion or continuation is a model
 * decision; tool metadata must not force Core to invent another business stage.
 */
export function resolveTaskProgression(
  task: OpsTask,
  _tools: ToolDefinition[] = defaultToolCatalog,
): TaskProgression {
  // A pending step is not runnable while another step owns execution or awaits
  // a user decision. Check the entire plan before choosing a pending step so a
  // restored/out-of-order plan cannot start a second execution either. Failed
  // and skipped steps remain terminal: the existing goal review owns their
  // evidence and decides whether a later adjustment is needed.
  const waitingStep = task.plan.find((step) =>
    !["pending", "completed", "failed", "skipped"].includes(step.status),
  );
  if (waitingStep) return { kind: "wait", step: waitingStep };

  const pendingStep = task.plan.find((step) => step.status === "pending");
  if (pendingStep) return { kind: "execute-step", step: pendingStep };

  return { kind: "complete" };
}

/**
 * Preserve the model's continuation proposal verbatim. Business-level decisions
 * such as whether a command is repetitive or still useful belong to the model;
 * callers separately enforce protocol, authorization and safety gates.
 */
export function selectContinuationSteps(_existingPlan: PlanStep[], candidates: PlanStep[], _context?: string) {
  return candidates.slice();
}

/**
 * Preserve a regenerated business proposal as one atomic model decision. The
 * executor may reject the plan at a hard boundary, but must not silently remove
 * steps based on a second business-semantics judgment.
 */
export function selectBusinessReplanSteps(_existingPlan: PlanStep[], candidates: PlanStep[], _context?: string) {
  return candidates.slice();
}

/**
 * Preserve the model's adjustment proposal verbatim. Recovery relations, when
 * provided, remain planning evidence rather than a dispatch gate; authorization
 * and command safety are still validated after this boundary.
 */
export function selectAdjustmentSteps(_existingPlan: PlanStep[], candidates: PlanStep[], _context?: string) {
  return candidates.slice();
}

/** No business step crosses a failed prerequisite until its original contract is rechecked. */
export function findUnresolvedBlockingStep(task: OpsTask, currentStep: PlanStep) {
  const blockers = unresolvedRecoveryBlockers(task, currentStep);
  return blockers.find(step => step.id === currentStep.recovery?.failedStepId) ?? blockers[blockers.length - 1];
}
