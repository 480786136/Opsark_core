import {
  reviewExecutionEvidence,
  reviewExecutionFailure,
  reviewPrecondition,
} from "@/features/agent/reviewService";
import type {
  ReviewEvidenceInput,
  ReviewExecutionFailureInput,
  ReviewPreconditionInput,
} from "@/features/agent/reviewService";
import {
  buildCommandFailureReviewAudit,
  buildEvidenceReviewAudits,
  buildPreconditionReviewAudit,
} from "@/features/agent/reviewAudit";
import {
  applyCommandFailureReview,
  applyExecutionEvidenceReview,
  applyPreconditionReview,
} from "@/features/agent/reviewCoordination";
import type { AuditEventDraft } from "@/features/agent/auditTrail";

type FailureReviewer = (
  input: ReviewExecutionFailureInput,
) => ReturnType<typeof reviewExecutionFailure>;
type EvidenceReviewer = (
  input: ReviewEvidenceInput,
) => ReturnType<typeof reviewExecutionEvidence>;
type PreconditionReviewer = (
  input: ReviewPreconditionInput,
) => ReturnType<typeof reviewPrecondition>;

interface ReviewAuditScope {
  serverId: string;
  taskId: string;
  isCancelled(): boolean;
}

export interface RunCommandFailureReviewInput
  extends ReviewExecutionFailureInput, ReviewAuditScope {}

export interface RunPreconditionReviewInput
  extends ReviewPreconditionInput, ReviewAuditScope {}

/** Runs precondition review without applying stale async results after cancellation. */
export async function runPreconditionReviewPipeline(
  input: RunPreconditionReviewInput,
  reviewBlockedStep: PreconditionReviewer = reviewPrecondition,
) {
  const review = await reviewBlockedStep(input);
  if (input.isCancelled()) {
    return { cancelled: true as const, review, audits: [] as AuditEventDraft[] };
  }
  const audit = buildPreconditionReviewAudit({
    stepTitle: input.step.title,
    allowed: review.allowed,
    context: review.context,
    modelDecision: review.modelDecision,
    finalDecision: review.finalDecision,
    serverId: input.serverId,
    taskId: input.taskId,
  });
  const coordination = applyPreconditionReview(
    input.step,
    review.finalDecision,
    review.allowed,
  );
  return {
    cancelled: false as const,
    review,
    audits: [audit] satisfies AuditEventDraft[],
    coordination,
  };
}

/** Runs failed-command review and returns its audit and state coordination together. */
export async function runCommandFailureReviewPipeline(
  input: RunCommandFailureReviewInput,
  reviewFailure: FailureReviewer = reviewExecutionFailure,
) {
  const review = await reviewFailure(input);
  if (input.isCancelled()) {
    return { cancelled: true as const, review, audits: [] as AuditEventDraft[] };
  }
  const audit = buildCommandFailureReviewAudit({
    stepTitle: input.step.title,
    context: review.context,
    modelDecision: review.modelDecision,
    finalDecision: review.finalDecision,
    diagnosticStep: review.diagnosticStep,
    mutatingStep: review.mutatingStep,
    recoveryStepFound: review.recoveryStepFound,
    serverId: input.serverId,
    taskId: input.taskId,
  });
  const coordination = applyCommandFailureReview(
    input.step,
    review.remainingSteps,
    review.finalDecision,
  );
  return {
    cancelled: false as const,
    review,
    audits: [audit] satisfies AuditEventDraft[],
    coordination,
  };
}

export interface RunEvidenceReviewInput extends ReviewEvidenceInput, ReviewAuditScope {
  blockingFacts: Record<string, unknown>;
}

/** Runs evidence review and returns ordered audits plus the applied state coordination. */
export async function runEvidenceReviewPipeline(
  input: RunEvidenceReviewInput,
  reviewEvidence: EvidenceReviewer = reviewExecutionEvidence,
) {
  const review = await reviewEvidence(input);
  if (input.isCancelled()) {
    return { cancelled: true as const, review, audits: [] as AuditEventDraft[] };
  }
  const audits = buildEvidenceReviewAudits({
    stepTitle: input.step.title,
    reviewRequired: input.reviewRequired,
    postconditionReview: input.postconditionReview,
    context: review.context,
    modelDecision: review.modelDecision,
    finalDecision: review.finalDecision,
    result: input.step.result,
    validationExitCode: input.validationExitCode,
    hardBlocker: review.hardBlocker,
    mutatingStep: review.mutatingStep,
    repairStepFound: review.repairStepFound,
    blockingSignalResolved: review.blockingSignalResolved,
    blockingFacts: input.blockingFacts,
    serverId: input.serverId,
    taskId: input.taskId,
  });
  const coordination = applyExecutionEvidenceReview({
    step: input.step,
    remainingSteps: review.remainingSteps,
    review: review.finalDecision,
    reviewWasRequired: input.reviewRequired,
  });
  return { cancelled: false as const, review, audits, coordination };
}
