import {
  isMutatingStepCommand,
  isReadOnlyDiagnosticStep,
  isReadOnlyStep,
} from "@/features/agent/evidenceReview";
import type { OpsTask, PlanStep } from "@/types";

export type TaskProgression =
  | { kind: "execute-step"; step: PlanStep }
  | { kind: "refine-discovery" }
  | { kind: "complete" };

/** Returns the latest user requirement while ignoring user-triggered event records. */
export function latestTaskRequirement(task: OpsTask) {
  return [...task.messages]
    .reverse()
    .find((message) => message.role === "user" && message.kind === "message")?.content
    ?? task.title;
}

/**
 * Determines the next orchestration branch without mutating task state. A completed
 * read-only discovery round is refined once when the user still expects changes.
 */
export function resolveTaskProgression(task: OpsTask): TaskProgression {
  const pendingStep = task.plan.find((step) => step.status === "pending");
  if (pendingStep) return { kind: "execute-step", step: pendingStep };

  const discoveryOnly = task.plan.length > 0
    && task.plan.every((step) => step.status === "completed" && isReadOnlyDiagnosticStep(step));
  const changeStillExpected = ["requested_changes_only", "allow_necessary_changes"]
    .includes(task.executionConstraints?.changePolicy ?? "");
  if (discoveryOnly && changeStillExpected && !task.discoveryRefined) {
    return { kind: "refine-discovery" };
  }
  return { kind: "complete" };
}

/** Filters repeated commands so completed discovery work is not planned again. */
export function selectContinuationSteps(existingPlan: PlanStep[], candidates: PlanStep[]) {
  const existingCommands = new Set(existingPlan.map((step) => step.command.trim()));
  const selectedCommands = new Set<string>();
  return candidates.filter((step) => {
    const command = step.command.trim();
    if (!command || existingCommands.has(command) || selectedCommands.has(command)) return false;
    selectedCommands.add(command);
    return true;
  });
}

/**
 * Returns the latest unresolved blocking step before a mutating step. A successful
 * intervening mutation clears the blocker only when it did not produce another signal.
 */
export function findUnresolvedBlockingStep(task: OpsTask, currentStep: PlanStep) {
  if (!isMutatingStepCommand(currentStep.command)) return undefined;
  const stepIndex = task.plan.indexOf(currentStep);
  if (stepIndex <= 0) return undefined;

  let blockerIndex = -1;
  for (let index = 0; index < stepIndex; index += 1) {
    const candidate = task.plan[index];
    if (candidate.status === "completed" && candidate.result?.facts.blockingSignal) {
      blockerIndex = index;
    }
  }
  if (blockerIndex < 0) return undefined;

  const blockerResolved = task.plan
    .slice(blockerIndex + 1, stepIndex)
    .some((candidate) =>
      candidate.status === "completed"
      && !isReadOnlyStep(candidate)
      && !candidate.result?.facts.blockingSignal
      && candidate.result?.executionStatus === "success",
    );
  return blockerResolved ? undefined : task.plan[blockerIndex];
}
