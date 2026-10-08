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
import { modelLogContext } from "./modelLogContext";
import { authenticationContext } from "./authenticationEvidence";
import { confirmedUserInputsContext } from "./confirmedUserInputs";
import { isUserInputStep, modelContextStep } from "./executionContextEvidence";
import { modelTaskRequirementSnapshot } from "./taskGoal";

const REVIEW_HISTORY_STEP_LIMIT = 6;
const REVIEW_REMAINING_STEP_LIMIT = 6;

interface PeriodicObservation {
  passed: boolean;
  detail: string;
  exitCode?: number;
}

export interface LongRunningProgressStatus {
  workload: "bounded" | "progressive" | "persistent_service";
  outputFingerprint: string;
  outputChangedSinceLastReview: boolean;
  lastOutputChangeAt: string;
  lastProgressAt?: string;
  lastRuntimeProgressAt?: string;
  lastRuntimeSampleAt?: string;
  noOutputSeconds?: number;
  noProgressSeconds: number;
  noProgressReviewRounds: number;
  consecutiveContinueRounds: number;
  maxConsecutiveContinueRounds?: number;
  hardLimitSeconds?: number;
  executionDeadlineAt?: string;
  stalledNotice?: string;
  runtimeActive?: boolean;
  runtimeSampleFresh?: boolean;
  runtimeCpuAvailable?: boolean;
  runtimeIoAvailable?: boolean;
  runtimeProcessCount?: number;
  runtimeCpuPercent?: number;
  runtimeIoBytes?: number;
  runtimeIoChanged?: boolean;
  runtimeIdleReviewRounds?: number;
  runtimeSamplingStatus?: "unavailable" | "healthy" | "failed";
  consecutiveRuntimeSampleFailures?: number;
  advisoryIntervalMs?: number;
}

function taskSnapshot(task: OpsTask) {
  return { _log: modelLogContext(task), title: task.title, ...modelTaskRequirementSnapshot(task),
    permission: task.permission, status: task.status };
}

function planSnapshot(step: PlanStep) {
  return compactReviewPlanStep(modelContextStep(step));
}

function plannedStepSnapshot(step: PlanStep) {
  const { status: _status, ...snapshot } = planSnapshot(step);
  return snapshot;
}

function historySnapshot(step: PlanStep) {
  step = modelContextStep(step);
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
  currentStep = modelContextStep(currentStep);
  blockerStep = modelContextStep(blockerStep);
  return {
    trigger: "历史失败证据仍未验收；仅核对当前步骤是否超出用户授权边界",
    reviewPolicy: {
      authorizationBoundaryOnly: true,
      recoveryRelationIsAdvisory: true,
      unresolvedBlockingSignal: true,
      failureFactsCannotBeRewritten: true,
    },
    executionConstraints: task.executionConstraints,
    authentication: authenticationContext(task),
    confirmedUserInputs: confirmedUserInputsContext(task),
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
  const step = modelContextStep(input.step);
  const userInput = isUserInputStep(input.step);
  const formOutputReference = "历史表单内容请参照 confirmedUserInputs；仅当前作用域内有效的决定可复用。";
  return {
    trigger: "periodic_long_running",
    executionConstraints: input.task.executionConstraints,
    task: taskSnapshot(input.task),
    authentication: authenticationContext(input.task),
    confirmedUserInputs: confirmedUserInputsContext(input.task),
    _log: modelLogContext(input.task, input.step),
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
      title: compactReviewText(step.title, 180),
      description: compactReviewText(step.description, 360),
      command: compactReviewText(step.command, LONG_RUNNING_COMMAND_CONTEXT_LIMIT),
      commandFingerprint: textFingerprint(step.command),
      expected: compactReviewText(step.expected, 360),
      risk: step.risk,
    },
    periodicObservation: {
      passed: input.observation.passed,
      exitCode: input.observation.exitCode,
      detail: userInput ? formOutputReference : compactReviewText(input.observation.detail, 260),
    },
    progress: input.progress,
    salientEvidence: !userInput && input.salientEvidence?.length ? input.salientEvidence : undefined,
    terminalOutput: userInput ? { ...input.outputWindow, content: formOutputReference } : input.outputWindow,
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
  step = modelContextStep(step);
  return {
    trigger: "主命令执行失败，需要判断是否影响用户整体目标和剩余计划",
    failureDisposition: failureDispositionContext(remainingSteps),
    authentication: authenticationContext(task),
    confirmedUserInputs: confirmedUserInputsContext(task),
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
  step = modelContextStep(step);
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
      : step.result?.facts.evidenceConflict === true
        ? "程序发现相互冲突的证据，请核对当前步骤 expected"
        : "当前步骤执行结果已返回，请验收当前 expected 是否得到真实证据支持",
    failureDisposition: failureDispositionContext(remainingSteps),
    acceptanceRequired: step.result?.facts.semanticAcceptanceRequired === true,
    acceptanceScope: {
      kind: "current_step",
      stepId: step.id,
      expected: step.expected,
      instruction: "只判断当前步骤 expected。整体目标尚有后续工作不构成本步骤验收失败；本步骤 complete 不代表整体任务完成，也不能跳过剩余步骤。",
    },
    authentication: authenticationContext(task),
    confirmedUserInputs: confirmedUserInputsContext(task),
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

function failureDispositionContext(steps: PlanStep[]) {
  return {
    remainingStepIds: steps.map(step => step.id),
    instruction: "失败或结果未证实时：repair/retry/replan/request_input 均返回 decision=adjust，交给规划落实动作；只有 continue_independent 可返回 continue，必须逐一列出全部剩余 stepId、relation(independent/dependent/unknown)、reason。未展示详情的步骤标 unknown。dependent/unknown 不执行；独立步骤仅按原顺序推进，不跳过阻断。不能将需要先修复的步骤标 independent。",
    acceptanceInstruction: "acceptanceRequired=true 时必须返回 acceptance={status:proven|not_met|unknown,reason,evidenceIds}。引用当前步骤真实 evidence ID，证明 expected 而不是仅引用退出码；信息不足为 unknown。检查方式错误可以说明并请求修正，不能改写失败事实。",
  };
}
