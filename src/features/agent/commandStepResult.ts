import {
  analyzeCommandFailure,
  classifyStepResult,
  ensureStepValidator,
} from "@/features/agent/evidenceReview";
import { transitionStep } from "@/features/agent/stepMachine";
import type { ExecutionEvidence, PlanStep, StepResult, StepReview } from "@/types";

export interface CommandFailureOutcome {
  result: StepResult;
  evidence: ExecutionEvidence[];
  failure: ReturnType<typeof analyzeCommandFailure>;
}

export interface PeriodicReviewFailureInput {
  review: StepReview;
  output: string;
  exitCode?: number;
  reviewRound: number;
  elapsedSeconds?: number;
  validationPassed: boolean;
  evidenceId: string;
  collectedAt: string;
}

export interface CommandFailureInput {
  output: string;
  exitCode?: number;
  evidenceId: string;
  collectedAt: string;
}

/** Builds the failed result produced when periodic review stops a long command. */
export function buildPeriodicReviewFailure(
  input: PeriodicReviewFailureInput,
): Omit<CommandFailureOutcome, "failure"> & { review: StepReview } {
  const evidence: ExecutionEvidence[] = [{
    id: input.evidenceId,
    type: "command-output",
    source: "main",
    facts: {
      stoppedByPeriodicReview: true,
      elapsedSeconds: input.elapsedSeconds,
      validationPassed: input.validationPassed,
    },
    rawOutput: input.output,
    collectedAt: input.collectedAt,
  }];
  return {
    review: input.review,
    evidence,
    result: {
      executionStatus: "failed",
      observationStatus: "unknown",
      exitCode: input.exitCode,
      facts: {
        commandCompleted: false,
        stoppedByPeriodicReview: true,
        reviewRound: input.reviewRound,
      },
      warnings: [],
      evidenceIds: evidence.map((item) => item.id),
      failureReason: input.review.reason,
    },
  };
}

/** Classifies a failed main command and creates matching command-output evidence. */
export function buildCommandFailure(input: CommandFailureInput): CommandFailureOutcome {
  const failure = analyzeCommandFailure(input.output);
  const evidence: ExecutionEvidence[] = [{
    id: input.evidenceId,
    type: "command-output",
    source: "main",
    facts: { success: false, exitCode: input.exitCode, ...failure.facts },
    rawOutput: input.output,
    collectedAt: input.collectedAt,
  }];
  return {
    failure,
    evidence,
    result: {
      executionStatus: "failed",
      observationStatus: "unknown",
      exitCode: input.exitCode,
      facts: { commandCompleted: false, ...failure.facts },
      warnings: [],
      evidenceIds: evidence.map((item) => item.id),
      failureReason: failure.reason,
    },
  };
}

/** Builds and applies a failed main-command result through the step state machine. */
export function applyCommandFailure(
  step: PlanStep,
  input: CommandFailureInput,
): CommandFailureOutcome {
  const failure = buildCommandFailure(input);
  transitionStep(step, "failed");
  step.result = failure.result;
  step.evidence = failure.evidence;
  return failure;
}

/** Applies an already-classified validation outcome while preserving step identity. */
export function applyValidatedStepResult(
  step: PlanStep,
  classified: ReturnType<typeof classifyStepResult>,
): void {
  step.validator = ensureStepValidator(step).validator;
  step.result = classified.result;
  step.evidence = classified.evidence;
}
