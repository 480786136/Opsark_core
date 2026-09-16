import { transitionStep } from "@/features/agent/stepMachine";
import {
  isMutatingReviewStep,
  isReadOnlyDiagnosticStep,
  remainingPlanCanRecoverExecutionFailure,
} from "@/features/agent/evidenceReview";
import {
  buildPeriodicReviewFailure,
  type PeriodicReviewFailureInput,
} from "@/features/agent/commandStepResult";
import { isBlockingFailure } from "./recoveryContract";
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
    eventMessage: `${review.reason}；原阻断等待真实复验。${review.summary}`,
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
  const mutatingStep = isMutatingReviewStep(step);
  const diagnosticStep = isReadOnlyDiagnosticStep(step) && !mutatingStep;
  const recoveryStepFound = remainingPlanCanRecoverExecutionFailure(
    step.result?.facts.category,
    remainingSteps,
    step,
  );
  if (review.decision === "adjust") {
    const pauseReason = `执行异常复核建议调整：${review.reason}`;
    return {
      taskStatus: "needs_adjustment",
      pauseReason,
      eventMessage: `${review.summary}\n${pauseReason}`,
      shouldAdvance: false,
    };
  }

  // Defense in depth: a failed mutation cannot be converted into completion,
  // or skipped past unrelated work, even if an upstream/model decision regresses.
  if (!diagnosticStep && (
    review.decision === "complete"
    || (review.decision === "continue" && !recoveryStepFound)
  )) {
    const reason = review.decision === "complete"
      ? "非诊断步骤执行失败，不能跳过剩余工作并判定目标完成。"
      : "非诊断步骤执行失败，剩余计划没有与该失败严格相关的恢复步骤。";
    const gatedReview: StepReview = {
      decision: "adjust",
      reason,
      summary: "执行失败证据已保留，需要调整计划后再继续。",
      source: "rules",
    };
    step.review = gatedReview;
    const pauseReason = `执行异常复核建议调整：${reason}`;
    return {
      taskStatus: "needs_adjustment",
      pauseReason,
      eventMessage: `${gatedReview.summary}\n${pauseReason}`,
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
  allowRiskAttemptReview?: boolean;
}

/** Applies the final review decision after structured execution evidence is available. */
export function applyExecutionEvidenceReview(
  input: ApplyEvidenceReviewInput,
): ReviewCoordinationResult {
  const { step, remainingSteps, review, reviewWasRequired } = input;
  step.review = review;
  if (review.decision === "adjust") {
    const detectedRisk = step.kind === "observe" && step.result?.executionStatus === "success"
      && step.result.facts.blockingSignal && step.result.facts.validationPassed !== false;
    transitionStep(step, detectedRisk ? "completed" : "failed");
    const pauseReason = `模型复核建议调整：${review.reason}`;
    return {
      taskStatus: "needs_adjustment",
      pauseReason,
      eventMessage: `${review.summary}\n${pauseReason}`,
      shouldAdvance: false,
    };
  }

  if (isBlockingFailure(step)) {
    const detectedRisk = step.kind === "observe" && step.result?.executionStatus === "success"
      && step.result.facts.validationPassed !== false;
    transitionStep(step, detectedRisk ? "completed" : "failed");
    const canRecover = remainingPlanCanRecoverExecutionFailure(step.result?.facts.category, remainingSteps, step)
      || (detectedRisk && input.allowRiskAttemptReview === true && remainingSteps.length > 0);
    return {
      taskStatus: canRecover ? "running" : "needs_adjustment",
      pauseReason: canRecover ? undefined : "当前失败未通过关联复验，下一步骤也不是有效恢复步骤。",
      eventMessage: "当前阻断事实已保留；仅进入关联恢复或明确授权的风险尝试复核，不能直接判定目标完成。",
      shouldAdvance: canRecover,
    };
  }
  transitionStep(step, "completed");
  // Completing a repair/diagnosis proves only that operation ran, not that the
  // original failure or the goal was resolved. Preserve pending verification.
  if (step.recovery) return {
    taskStatus: "running", eventMessage: `✓ ${step.title}执行完成；恢复验收由原失败契约决定。`, shouldAdvance: true,
  };
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
