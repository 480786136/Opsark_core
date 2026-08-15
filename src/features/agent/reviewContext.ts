import { trimEvidence } from "@/features/agent/agentContext";
import type { OpsTask, PlanStep } from "@/types";

interface PeriodicObservation {
  passed: boolean;
  detail: string;
  exitCode?: number;
  output?: string;
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
  return step.evidence?.map(({ type, source, facts, rawOutput }) => ({
    type,
    source,
    facts,
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
  requirement: string;
  reviewRound: number;
  elapsedSeconds: number;
  streamedOutput: string;
  observation: PeriodicObservation;
}) {
  const remainingSteps = input.task.plan
    .filter((step) => step.status === "pending")
    .map(plannedStepSnapshot);
  return {
    trigger: "远程命令长时间未返回，定期获取状态并判断继续等待、停止等待进入正式校验或调整计划",
    reviewPolicy: {
      periodicLongRunningReview: true,
      decisionContinueMeansWait: true,
      decisionCompleteRequiresValidationPassed: true,
      decisionAdjustMeansStopAndPause: true,
      actualExecutionFactsCannotBeRewritten: true,
    },
    reviewRound: input.reviewRound,
    elapsedSeconds: input.elapsedSeconds,
    userRequirement: input.requirement,
    executionConstraints: input.task.executionConstraints,
    currentStep: {
      ...plannedStepSnapshot(input.step),
      streamedOutput: trimEvidence(input.step.output ?? input.streamedOutput, 5000),
    },
    periodicObservation: {
      ...input.observation,
      output: trimEvidence(input.observation.output, 3000),
    },
    executionHistory: input.task.plan
      .filter((step) => step !== input.step && step.status !== "pending")
      .map((step) => historySnapshot(step, 1200)),
    fullPlan: input.task.plan.map(planSnapshot),
    remainingSteps,
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
  return {
    trigger: postconditionReview
      ? "主命令执行成功，但独立后置校验未通过"
      : "程序发现证据不可解释或相互冲突",
    reviewPolicy: postconditionReview ? {
      exceptionalReview: true,
      mainExecutionSucceeded: true,
      postconditionFailed: true,
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
