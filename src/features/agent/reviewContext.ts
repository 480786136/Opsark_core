import { trimEvidence } from "@/features/agent/agentContext";
import {
  compactReviewText,
  LONG_RUNNING_COMMAND_CONTEXT_LIMIT,
  textFingerprint,
} from "@/features/agent/longRunningReviewOutput";
import type { LongRunningOutputWindow } from "@/features/agent/longRunningReviewOutput";
import type { OpsTask, PlanStep } from "@/types";

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
  return { title: task.title, permission: task.permission, status: task.status };
}

function planSnapshot(step: PlanStep) {
  return {
    title: step.title,
    description: step.description,
    command: step.command,
    expected: step.expected,
    validation: step.validation,
    risk: step.risk,
    status: step.status,
  };
}

function plannedStepSnapshot(step: PlanStep) {
  const { status: _status, ...snapshot } = planSnapshot(step);
  return snapshot;
}

function historySnapshot(step: PlanStep, outputLimit = 1800) {
  return {
    title: step.title,
    description: step.description,
    command: step.command,
    expected: step.expected,
    status: step.status,
    result: step.result,
    output: trimEvidence(step.output, outputLimit),
  };
}

function evidenceSnapshot(step: PlanStep, trimRawOutput: boolean) {
  return step.evidence?.map(({ type, source, facts, rawOutput, scope }) => ({
    type,
    source,
    facts,
    scope,
    rawOutput: trimRawOutput ? trimEvidence(rawOutput) : rawOutput,
  }));
}

export function buildPreconditionReviewContext(
  task: OpsTask,
  currentStep: PlanStep,
  blockerStep: PlanStep,
  requirement: string,
) {
  const stepIndex = task.plan.indexOf(currentStep);
  return {
    trigger: "已发现未解决的阻断条件，即将执行变更操作，需结合用户目标和已有证据决定继续还是调整",
    reviewPolicy: {
      preconditionGate: true,
      unresolvedBlockingSignal: true,
      userMayExplicitlyAuthorizeAttempt: true,
      failureFactsCannotBeRewritten: true,
    },
    userRequirement: requirement,
    executionConstraints: task.executionConstraints,
    blockingEvidence: {
      title: blockerStep.title,
      command: blockerStep.command,
      expected: blockerStep.expected,
      result: blockerStep.result,
      evidence: evidenceSnapshot(blockerStep, true),
    },
    executionHistory: task.plan.slice(0, stepIndex).map((step) => historySnapshot(step)),
    currentPlannedStep: plannedStepSnapshot(currentStep),
    fullPlan: task.plan.map(planSnapshot),
    remainingSteps: task.plan.slice(stepIndex).map(plannedStepSnapshot),
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
  requirement: string,
) {
  return {
    trigger: "主命令执行失败，需要判断是否影响用户整体目标和剩余计划",
    reviewPolicy: {
      exceptionalReview: true,
      commandExecutionFailed: true,
      modelMayDecideWorkflow: true,
      modelCannotRewriteFailureAsSuccess: true,
      userConstraintsMustBePreserved: true,
    },
    userRequirement: requirement,
    executionConstraints: task.executionConstraints,
    task: taskSnapshot(task),
    currentStep: {
      ...plannedStepSnapshot(step),
      result: step.result,
      evidence: evidenceSnapshot(step, true),
    },
    executionHistory: task.plan
      .filter((item) => item !== step && item.status !== "pending")
      .map((item) => historySnapshot(item)),
    fullPlan: task.plan.map(planSnapshot),
    remainingSteps: remainingSteps.map(plannedStepSnapshot),
  };
}

export function buildEvidenceReviewContext(
  task: OpsTask,
  step: PlanStep,
  remainingSteps: PlanStep[],
  requirement: string,
  postconditionReview: boolean,
) {
  const validationProtocolIncomplete = Boolean(step.result?.facts.validationProtocolIncomplete);
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
    userRequirement: requirement,
    executionConstraints: task.executionConstraints,
    task: taskSnapshot(task),
    currentStep: {
      title: step.title,
      description: step.description,
      command: step.command,
      expected: step.expected,
      validator: step.validator,
      result: step.result,
      evidence: evidenceSnapshot(step, false),
    },
    completedSteps: task.plan
      .filter((item) => item.status === "completed")
      .map((item) => historySnapshot(item)),
    fullPlan: task.plan.map(planSnapshot),
    remainingSteps: remainingSteps.map(({ title, description, command, expected, risk }) => ({
      title,
      description,
      command,
      expected,
      risk,
    })),
  };
}
