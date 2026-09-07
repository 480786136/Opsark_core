import {
  compactReviewText,
  LONG_RUNNING_COMMAND_CONTEXT_LIMIT,
  textFingerprint,
} from "@/features/agent/longRunningReviewOutput";
import type { LongRunningOutputWindow } from "@/features/agent/longRunningReviewOutput";
import {
  compactReviewEvidence,
  compactReviewOutput,
  compactReviewPlanStep,
  compactReviewResult,
  reviewPlanSummary,
} from "@/features/agent/reviewPayload";
import type { OpsTask, PlanStep } from "@/types";
<<<<<<< HEAD
=======
import { modelLogContext } from "./modelLogContext";
>>>>>>> origin/master

const REVIEW_HISTORY_STEP_LIMIT = 6;
const REVIEW_REMAINING_STEP_LIMIT = 6;

interface PeriodicObservation {
  passed: boolean;
  detail: string;
  exitCode?: number;
}

export interface LongRunningProgressStatus {
  workload: "bounded" | "progressive";
  outputFingerprint: string;
  outputChangedSinceLastReview: boolean;
  lastOutputChangeAt: string;
  noProgressSeconds: number;
  noProgressReviewRounds: number;
  consecutiveContinueRounds: number;
  maxConsecutiveContinueRounds: number;
  hardLimitSeconds?: number;
  stalledNotice?: string;
  runtimeActive?: boolean;
  runtimeProcessCount?: number;
  runtimeCpuPercent?: number;
  runtimeIoBytes?: number;
  runtimeIoChanged?: boolean;
  runtimeIdleReviewRounds?: number;
}

function taskSnapshot(task: OpsTask) {
<<<<<<< HEAD
  return { title: task.title, permission: task.permission, status: task.status };
=======
  return { _log: modelLogContext(task), title: task.title, permission: task.permission, status: task.status };
>>>>>>> origin/master
}

function planSnapshot(step: PlanStep) {
  return compactReviewPlanStep(step);
}

function plannedStepSnapshot(step: PlanStep) {
  const { status: _status, ...snapshot } = planSnapshot(step);
  return snapshot;
}

function historySnapshot(step: PlanStep) {
  return {
    ...compactReviewPlanStep(step, { commandLimit: 420, validationLimit: 320 }),
    result: compactReviewResult(step.result, 1_200),
    output: step.status === "failed" || step.result?.executionStatus === "failed"
      ? compactReviewOutput(step.output, 700, 400)
      : undefined,
  };
}

function collectionWindow<T>(items: T[], limit: number, edge: "start" | "end") {
  const selected = edge === "start" ? items.slice(0, limit) : items.slice(-limit);
  return {
    totalItems: items.length,
    includedItems: selected.length,
    omittedItems: Math.max(0, items.length - selected.length),
    items: selected,
  };
}

export function buildPreconditionReviewContext(
  task: OpsTask,
  currentStep: PlanStep,
  blockerStep: PlanStep,
) {
  const stepIndex = task.plan.indexOf(currentStep);
  const history = task.plan.slice(0, stepIndex).map((step) => historySnapshot(step));
  const remaining = task.plan.slice(stepIndex).map(plannedStepSnapshot);
  return {
    trigger: "已发现未解决的阻断条件，即将执行变更操作，需结合用户目标和已有证据决定继续还是调整",
    reviewPolicy: {
      preconditionGate: true,
      unresolvedBlockingSignal: true,
      userMayExplicitlyAuthorizeAttempt: true,
      failureFactsCannotBeRewritten: true,
    },
    executionConstraints: task.executionConstraints,
    task: taskSnapshot(task),
    blockingEvidence: {
      ...compactReviewPlanStep(blockerStep, { commandLimit: 800, validationLimit: 480 }),
      result: compactReviewResult(blockerStep.result, 1_800),
      output: compactReviewOutput(blockerStep.output, 1_200, 600),
      evidence: compactReviewEvidence(blockerStep.evidence, {
        maxItems: 4,
        mainOutputLimit: 0,
        validationOutputLimit: 700,
      }),
    },
    executionHistory: collectionWindow(history, REVIEW_HISTORY_STEP_LIMIT, "end"),
    currentPlannedStep: compactReviewPlanStep(currentStep, {
      commandLimit: 800,
      validationLimit: 600,
      includeStatus: false,
    }),
    remainingSteps: collectionWindow(remaining, REVIEW_REMAINING_STEP_LIMIT, "start"),
    planSummary: reviewPlanSummary(task.plan),
  };
}

export function buildLongRunningReviewContext(input: {
  task: OpsTask;
  step: PlanStep;
  reviewRound: number;
  elapsedSeconds: number;
  observation: PeriodicObservation;
  progress: LongRunningProgressStatus;
  outputWindow: LongRunningOutputWindow;
  salientEvidence?: string[];
}) {
  const nextStep = input.task.plan.find((step) => step !== input.step && step.status === "pending");
  return {
    trigger: "periodic_long_running",
<<<<<<< HEAD
=======
    _log: modelLogContext(input.task, input.step),
>>>>>>> origin/master
    reviewPolicy: {
      periodicLongRunningReview: true,
      decisionContinueMeansWait: true,
      decisionCompleteRequiresValidationPassed: true,
      decisionAdjustMeansStopAndPause: true,
      actualExecutionFactsCannotBeRewritten: true,
    },
    reviewRound: input.reviewRound,
    elapsedSeconds: input.elapsedSeconds,
    currentStep: {
      title: compactReviewText(input.step.title, 180),
      description: compactReviewText(input.step.description, 360),
      command: compactReviewText(input.step.command, LONG_RUNNING_COMMAND_CONTEXT_LIMIT),
      commandFingerprint: textFingerprint(input.step.command),
      expected: compactReviewText(input.step.expected, 360),
      risk: input.step.risk,
    },
    periodicObservation: {
      passed: input.observation.passed,
      exitCode: input.observation.exitCode,
      detail: compactReviewText(input.observation.detail, 260),
    },
    progress: input.progress,
    salientEvidence: input.salientEvidence?.length ? input.salientEvidence : undefined,
    terminalOutput: input.outputWindow,
    nextStep: nextStep ? {
      title: compactReviewText(nextStep.title, 180),
      description: compactReviewText(nextStep.description, 280),
      expected: compactReviewText(nextStep.expected, 280),
      risk: nextStep.risk,
      note: "仅供了解执行顺序；不得因存在下一步而把 continue 解释为进入下一步。",
    } : undefined,
  };
}

export function buildExecutionFailureReviewContext(
  task: OpsTask,
  step: PlanStep,
  remainingSteps: PlanStep[],
) {
  const executionHistory = task.plan
    .filter((item) => item !== step && item.status !== "pending")
    .map((item) => historySnapshot(item));
  const remaining = remainingSteps.map(plannedStepSnapshot);
  return {
    trigger: "主命令执行失败，需要判断是否影响用户整体目标和剩余计划",
    reviewPolicy: {
      exceptionalReview: true,
      commandExecutionFailed: true,
      modelMayDecideWorkflow: true,
      modelCannotRewriteFailureAsSuccess: true,
      userConstraintsMustBePreserved: true,
    },
    executionConstraints: task.executionConstraints,
    task: taskSnapshot(task),
    currentStep: {
      ...compactReviewPlanStep(step, { commandLimit: 1_000, validationLimit: 700 }),
      result: compactReviewResult(step.result, 2_000),
      output: compactReviewOutput(step.output, 2_200, 900),
      evidence: compactReviewEvidence(step.evidence, {
        maxItems: 4,
        mainOutputLimit: 0,
        validationOutputLimit: 900,
      }),
    },
    executionHistory: collectionWindow(executionHistory, REVIEW_HISTORY_STEP_LIMIT, "end"),
    remainingSteps: collectionWindow(remaining, REVIEW_REMAINING_STEP_LIMIT, "start"),
    planSummary: reviewPlanSummary(task.plan),
  };
}

export function buildEvidenceReviewContext(
  task: OpsTask,
  step: PlanStep,
  remainingSteps: PlanStep[],
  postconditionReview: boolean,
) {
  const validationProtocolIncomplete = Boolean(step.result?.facts.validationProtocolIncomplete);
  const completed = task.plan
    .filter((item) => item.status === "completed")
    .map((item) => historySnapshot(item));
  const remaining = remainingSteps.map(plannedStepSnapshot);
  return {
    trigger: postconditionReview
      ? validationProtocolIncomplete
        ? "主命令执行成功，但独立后置校验通道未返回真实结束标记"
        : "主命令执行成功，但独立后置校验未通过"
      : "程序发现证据不可解释或相互冲突",
    reviewPolicy: postconditionReview ? {
      exceptionalReview: true,
      mainExecutionSucceeded: true,
      postconditionFailed: true,
      validationProtocolIncomplete,
      modelMayExplainConflict: true,
      hardFactsCannotBeOverridden: true,
      mutationMayContinueOnlyWhenRemainingPlanRepairsPostcondition: true,
    } : undefined,
    executionConstraints: task.executionConstraints,
    task: taskSnapshot(task),
    currentStep: {
      ...compactReviewPlanStep(step, { commandLimit: 1_000, validationLimit: 700 }),
      validator: step.validator,
      result: compactReviewResult(step.result, 2_000),
      output: compactReviewOutput(step.output, 2_200, 900),
      evidence: compactReviewEvidence(step.evidence, {
        maxItems: 4,
        mainOutputLimit: 0,
        validationOutputLimit: 900,
      }),
    },
    completedSteps: collectionWindow(completed, REVIEW_HISTORY_STEP_LIMIT, "end"),
    remainingSteps: collectionWindow(remaining, REVIEW_REMAINING_STEP_LIMIT, "start"),
    planSummary: reviewPlanSummary(task.plan),
  };
}
