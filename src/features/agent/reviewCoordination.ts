import { transitionStep } from "@/features/agent/stepMachine";
import {
  buildPeriodicReviewFailure,
  type PeriodicReviewFailureInput,
} from "@/features/agent/commandStepResult";
import type { PlanStep, StepReview } from "@/types";

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
    eventMessage: `模型结合用户需求、执行约束、完整计划和执行记录复核后同意继续；当前风险将保留并由后续真实执行结果判断。${review.summary}`,
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
  if (review.decision === "adjust") {
    const pauseReason = `执行异常复核建议调整：${review.reason}`;
    return {
      taskStatus: "needs_adjustment",
      pauseReason,
      eventMessage: `${review.summary}\n${pauseReason}`,
      shouldAdvance: false,
    };
  }

  if (review.decision === "complete") {
    remainingSteps.forEach((item) => transitionStep(item, "skipped"));
    return {
      taskStatus: "running",
      eventMessage: `步骤执行失败已如实保留；模型结合用户目标判定无需继续剩余 ${remainingSteps.length} 个步骤。${review.summary}`,
      shouldAdvance: true,
    };
  }

  return {
    taskStatus: "running",
    eventMessage: `步骤执行失败已如实保留；模型确认剩余计划可以继续处理。${review.summary}`,
    shouldAdvance: true,
  };
}

export interface ApplyEvidenceReviewInput {
  step: PlanStep;
  remainingSteps: PlanStep[];
  review: StepReview;
  reviewWasRequired: boolean;
}

/** Applies the final review decision after structured execution evidence is available. */
export function applyExecutionEvidenceReview(
  input: ApplyEvidenceReviewInput,
): ReviewCoordinationResult {
  const { step, remainingSteps, review, reviewWasRequired } = input;
  step.review = review;
  if (review.decision === "adjust") {
    transitionStep(step, "failed");
    const pauseReason = `模型复核建议调整：${review.reason}`;
    return {
      taskStatus: "needs_adjustment",
      pauseReason,
      eventMessage: `${review.summary}\n${pauseReason}`,
      shouldAdvance: false,
    };
  }

  transitionStep(step, "completed");
  if (reviewWasRequired && review.decision === "complete") {
    remainingSteps.forEach((item) => transitionStep(item, "skipped"));
    return {
      taskStatus: "running",
      eventMessage: `✓ ${step.title}完成；复核判定整体目标已达成，已跳过 ${remainingSteps.length} 个无需继续的步骤。${review.summary}`,
      shouldAdvance: true,
    };
  }

  return {
    taskStatus: "running",
    eventMessage: `✓ ${step.title}完成；${review.summary || "程序证据校验通过。"}`,
    shouldAdvance: true,
  };
}
