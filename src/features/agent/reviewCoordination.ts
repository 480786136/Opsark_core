import { transitionStep } from "@/features/agent/stepMachine";
import {
  buildPeriodicReviewFailure,
  type PeriodicReviewFailureInput,
} from "@/features/agent/commandStepResult";
import type { PlanStep, StepReview } from "@/types";
import { applyFailureDisposition, applySemanticAcceptance, failureDependencyBlocker, releaseAcceptedDependency } from "./failureDisposition";

export interface ReviewCoordinationResult {
  taskStatus: "running" | "needs_adjustment";
  eventMessage: string;
  pauseReason?: string;
  shouldAdvance: boolean;
}

export interface PreconditionCoordinationResult {
  taskStatus: "running" | "needs_adjustment";
  eventMessage: string;
  pauseReason?: string;
  shouldExecute: boolean;
}

/** Applies a reviewed precondition decision before the pending step executes. */
export function applyPreconditionReview(
  step: PlanStep,
  review: StepReview,
  allowed: boolean,
): PreconditionCoordinationResult {
  step.review = review;
  if (!allowed) {
    const pauseReason = `前置条件复核建议调整：${review.reason}`;
    return {
      taskStatus: "needs_adjustment",
      pauseReason,
      eventMessage: `${review.summary}\n${pauseReason}`,
      shouldExecute: false,
    };
  }

  return {
    taskStatus: "running",
    eventMessage: `${review.reason}${review.summary ? ` ${review.summary}` : ""}`,
    shouldExecute: true,
  };
}

/**
 * Applies a periodic-review adjustment to the step and returns the task-level
 * transition data. Persistence and message dispatch remain caller concerns.
 */
export function applyPeriodicReviewAdjustment(
  step: PlanStep,
  input: PeriodicReviewFailureInput,
): ReviewCoordinationResult {
  transitionStep(step, "failed");
  const failure = buildPeriodicReviewFailure(input);
  step.review = failure.review;
  step.result = failure.result;
  step.evidence = failure.evidence;

  const pauseReason = `长任务定期复核建议调整：${input.review.reason}`;
  return {
    taskStatus: "needs_adjustment",
    pauseReason,
    eventMessage: `${input.review.summary}\n${pauseReason}`,
    shouldAdvance: false,
  };
}

/** Applies the final review decision after a failed main command. */
export function applyCommandFailureReview(
  step: PlanStep,
  remainingSteps: PlanStep[],
  review: StepReview,
): ReviewCoordinationResult {
  step.review = review;
  const allowed = applyFailureDisposition(step, remainingSteps, review);
  if (!allowed) {
    const pauseReason = `执行异常需先落实恢复动作或补齐依赖判断：${review.reason}`;
    return {
      taskStatus: "needs_adjustment",
      pauseReason,
      eventMessage: `${review.summary}\n${pauseReason}`,
      shouldAdvance: false,
    };
  }

  return {
    taskStatus: "running",
    eventMessage: `步骤失败已保留；仅继续有明确独立性依据的步骤，遇到依赖阻断将调整。${review.summary}`,
    shouldAdvance: true,
  };
}

export interface ApplyEvidenceReviewInput {
  step: PlanStep;
  remainingSteps: PlanStep[];
  review: StepReview;
  reviewWasRequired: boolean;
}

/** The result remains authoritative even when the model chooses a different next branch. */
function applyEvidenceStatus(step: PlanStep) {
  const failed = step.result?.executionStatus === "failed"
    || step.result?.executionStatus === "blocked"
    || step.result?.facts.validationPassed === false
    || (step.result?.facts.semanticAcceptanceRequired === true
      && step.result.facts.semanticAcceptanceStatus !== "proven");
  transitionStep(step, failed ? "failed" : "completed");
}

/** Applies the final review decision after structured execution evidence is available. */
export function applyExecutionEvidenceReview(
  input: ApplyEvidenceReviewInput,
): ReviewCoordinationResult {
  const { step, remainingSteps, review, reviewWasRequired } = input;
  step.review = review;
  applySemanticAcceptance(step, review);
  applyEvidenceStatus(step);
  if (step.status === "failed") return applyCommandFailureReview(step, remainingSteps, review);
  releaseAcceptedDependency(step, remainingSteps);
  const factMessage = `✓ ${step.title}完成`;
  if (review.decision === "adjust") {
    const pauseReason = `模型复核建议调整：${review.reason}`;
    return {
      taskStatus: "needs_adjustment",
      pauseReason,
      eventMessage: `${review.summary}\n${pauseReason}`,
      shouldAdvance: false,
    };
  }

  if (reviewWasRequired && review.decision === "complete" && !remainingSteps.some(item => failureDependencyBlocker(item))) {
    remainingSteps.forEach((item) => transitionStep(item, "skipped"));
    return {
      taskStatus: "running",
      eventMessage: `${factMessage}；模型判定无需继续剩余 ${remainingSteps.length} 个步骤。${review.summary}`,
      shouldAdvance: true,
    };
  }

  return {
    taskStatus: "running",
    eventMessage: `${factMessage}；${review.summary || "程序证据已记录。"}`,
    shouldAdvance: true,
  };
}
