import { backend } from "@/services/backend";
import { createRuntimeModel } from "@/features/agent/modelRuntime";
import {
  buildEvidenceReviewContext,
  buildExecutionFailureReviewContext,
  buildPreconditionReviewContext,
} from "@/features/agent/reviewContext";
import {
  isMutatingReviewStep,
  isReadOnlyDiagnosticStep,
  postconditionHasHardBlocker,
  remainingPlanCanRecoverExecutionFailure,
  remainingPlanCanRepairPostcondition,
  remainingPlanResolvesBlockingSignal,
} from "@/features/agent/evidenceReview";
import { latestTaskRequirement } from "@/features/agent/taskProgression";
import type { ModelProfile, OpsTask, PlanStep, StepReview } from "@/types";
import { attemptAuthorizationFingerprint, authorizeRiskAttempt, executionPolicyBlocker, isRelatedRecoveryStep, permitsBestEffortRiskReview, unresolvedRecoveryBlockers } from "./recoveryContract";
import { taskAttemptContext } from "./attemptState";

type StepReviewer = (
  requirement: string,
  reviewContext: string,
  hasRemainingSteps: boolean,
  runtimeModel?: ReturnType<typeof createRuntimeModel>,
) => Promise<StepReview>;

export interface ReviewStepInput {
  task: OpsTask;
  step: PlanStep;
  model?: ModelProfile;
  apiKey?: string;
}

export interface ReviewPreconditionInput extends ReviewStepInput {
  blockerStep: PlanStep;
}

export interface ReviewExecutionFailureInput extends ReviewStepInput {
  failureReason: string;
  failureCategory?: unknown;
}

export interface ReviewEvidenceInput extends ReviewStepInput {
  reviewRequired: boolean;
  postconditionReview: boolean;
  validationExitCode?: number;
}

/** A model cannot waive an unresolved prerequisite; only its explicit recovery may run. */
export async function reviewPrecondition(
  input: ReviewPreconditionInput,
  reviewStep: StepReviewer = backend.reviewStep.bind(backend),
) {
  const requirement = latestTaskRequirement(input.task);
  const context = buildPreconditionReviewContext(
    input.task,
    input.step,
    input.blockerStep,
  );
  const policyBlocker = executionPolicyBlocker(input.task, input.step);
  let allowed = !policyBlocker && isRelatedRecoveryStep(input.blockerStep, input.step, taskAttemptContext(input.task));
  const mayAttempt = !allowed && input.blockerStep.status === "completed"
    && !policyBlocker && permitsBestEffortRiskReview(input.task, input.blockerStep)
    && unresolvedRecoveryBlockers(input.task, input.step).every(blocker =>
      blocker.status === "completed" && permitsBestEffortRiskReview(input.task, blocker));
  let modelDecision: StepReview | undefined;
  if (mayAttempt) {
    const fingerprint = attemptAuthorizationFingerprint(input.task, input.step, input.blockerStep);
    modelDecision = await reviewStep(requirement, JSON.stringify(context), true,
      createRuntimeModel(input.model, input.apiKey, ""));
    allowed = modelDecision.source === "model" && modelDecision.decision === "continue"
      && fingerprint === attemptAuthorizationFingerprint(input.task, input.step, input.blockerStep);
    if (allowed) authorizeRiskAttempt(input.task, input.step, input.blockerStep);
  }
  const failureDetail = input.blockerStep.result?.failureReason || input.blockerStep.result?.warnings[0]
    || input.blockerStep.title;
  const finalDecision: StepReview = {
    decision: allowed ? "continue" : "adjust",
    reason: allowed ? (mayAttempt ? "用户明确允许 best_effort 尝试，模型已核验当前操作仍在授权范围；风险未解除。"
      : "当前步骤明确关联失败及相同执行上下文，仅允许执行恢复阶段。")
      : policyBlocker ?? `${failureDetail}；前置条件未解决：下一步骤缺少有效恢复关系或原始验收契约，不能由模型批准跳过。`,
    summary: allowed ? "原阻断仍保留，真实执行结果不自动代替原始验收。" : "请生成关联诊断、修复和复验步骤。",
    source: "rules",
  };
  return { requirement, context, modelDecision: modelDecision ?? finalDecision, finalDecision, allowed };
}

/** Reviews a failed command while preserving deterministic failure and recovery rules. */
export async function reviewExecutionFailure(
  input: ReviewExecutionFailureInput,
  reviewStep: StepReviewer = backend.reviewStep.bind(backend),
) {
  const requirement = latestTaskRequirement(input.task);
  const remainingSteps = input.task.plan.filter((step) => step.status === "pending");
  const context = buildExecutionFailureReviewContext(
    input.task,
    input.step,
    remainingSteps,
  );
  const mutatingStep = isMutatingReviewStep(input.step);
  const diagnosticStep = isReadOnlyDiagnosticStep(input.step) && !mutatingStep;
  const recoveryStepFound = remainingPlanCanRecoverExecutionFailure(
    input.failureCategory,
    remainingSteps,
    input.step,
  );
  // Every possible review outcome is already constrained to adjustment here.
  // Send the failure evidence directly to the adjustment planner once instead
  // of asking a model to choose a branch that the local gate must override.
  if (!diagnosticStep && !recoveryStepFound) {
    const finalDecision: StepReview = {
      decision: "adjust",
      reason: `${input.failureReason}；剩余计划没有能够处理该失败原因的明确恢复步骤。`,
      summary: "执行失败证据已保留，下一次规划将直接分析原因并生成恢复步骤。",
      source: "rules",
    };
    return {
      requirement, context, modelDecision: undefined, finalDecision,
      remainingSteps, diagnosticStep, mutatingStep, recoveryStepFound,
    };
  }
  const modelDecision = await reviewStep(
    requirement,
    JSON.stringify(context),
    remainingSteps.length > 0,
    createRuntimeModel(input.model, input.apiKey, ""),
  );
  let finalDecision = modelDecision;
  if (modelDecision.source !== "model") {
    finalDecision = {
      decision: "adjust",
      reason: "主命令执行失败且模型复核不可用，程序不会使用兜底规则继续任务。",
      summary: "当前步骤执行失败，需要调整后再继续。",
      source: "rules",
    };
  } else if (modelDecision.decision === "complete" && !diagnosticStep) {
    finalDecision = {
      decision: "adjust",
      reason: "非诊断步骤执行失败，不能仅依据模型意见判定整个任务完成。",
      summary: "当前操作没有完成，需要修复执行失败。",
      source: "rules",
    };
  } else if (modelDecision.decision === "continue" && !diagnosticStep && !recoveryStepFound) {
    finalDecision = {
      decision: "adjust",
      reason: `${input.failureReason}；剩余计划没有能够处理该失败原因的明确恢复步骤。`,
      summary: "当前计划无法从本次执行失败中安全恢复。",
      source: "rules",
    };
  }
  return {
    requirement,
    context,
    modelDecision,
    finalDecision,
    remainingSteps,
    diagnosticStep,
    mutatingStep,
    recoveryStepFound,
  };
}

/** Resolves model and rule decisions for postcondition failures or conflicting evidence. */
export async function reviewExecutionEvidence(
  input: ReviewEvidenceInput,
  reviewStep: StepReviewer = backend.reviewStep.bind(backend),
) {
  const requirement = latestTaskRequirement(input.task);
  const remainingSteps = input.task.plan.filter((step) => step.status === "pending");
  let context: ReturnType<typeof buildEvidenceReviewContext> | undefined;
  let modelDecision: StepReview | undefined;
  let finalDecision: StepReview;
  let hardBlocker: string | undefined;
  let mutatingStep = false;
  let repairStepFound = false;

  if (input.reviewRequired) {
    context = buildEvidenceReviewContext(
      input.task,
      input.step,
      remainingSteps,
      input.postconditionReview,
    );
    modelDecision = await reviewStep(
      requirement,
      JSON.stringify(context),
      remainingSteps.length > 0,
      createRuntimeModel(input.model, input.apiKey, ""),
    );
    finalDecision = modelDecision;

    if (input.postconditionReview) {
      hardBlocker = postconditionHasHardBlocker(
        input.step,
        remainingSteps,
        input.validationExitCode,
      );
      mutatingStep = isMutatingReviewStep(input.step);
      repairStepFound = remainingPlanCanRepairPostcondition(remainingSteps, input.step);
      if (modelDecision.source !== "model") {
        finalDecision = {
          decision: "adjust",
          reason: "后置校验未通过且模型复核不可用，程序不会使用兜底规则把该步骤判为成功。",
          summary: "主命令已执行，但结果尚未得到可靠确认。",
          source: "rules",
        };
      } else if (hardBlocker) {
        finalDecision = {
          decision: "adjust",
          reason: hardBlocker,
          summary: "模型已完成复核，但程序安全门禁要求先处理确定性阻断。",
          source: "rules",
        };
      } else if (modelDecision.decision === "complete" && mutatingStep) {
        finalDecision = {
          decision: "adjust",
          reason: "变更步骤的后置条件尚未满足，不能仅依据模型意见直接判定整个任务完成。",
          summary: "变更命令已执行，但目标状态仍需修复或重新验证。",
          source: "rules",
        };
      } else if (modelDecision.decision === "continue" && mutatingStep && !repairStepFound) {
        finalDecision = {
          decision: "adjust",
          reason: "变更步骤的后置条件尚未满足，剩余计划也没有明确的修复步骤。",
          summary: "需要先调整计划以修复或重新验证目标状态。",
          source: "rules",
        };
      }
    }
  } else {
    finalDecision = {
      decision: remainingSteps.length ? "continue" : "complete",
      reason: "主命令和结构化程序证据一致，无需调用模型复核。",
      summary: input.step.result?.warnings[0] ?? "程序证据校验通过。",
      source: "rules",
    };
  }

  let blockingSignalResolved: boolean | undefined;
  if (input.step.result?.facts.blockingSignal && !input.postconditionReview) {
    blockingSignalResolved = remainingPlanResolvesBlockingSignal(input.step, remainingSteps);
    finalDecision = blockingSignalResolved || (remainingSteps.length > 0 && permitsBestEffortRiskReview(input.task, input.step))
      ? {
          decision: "continue",
          reason: "程序识别到阻断，下一步骤已显式关联当前失败与执行上下文。",
          summary: "仅继续关联恢复阶段，阻断仍需真实复验解除。",
          source: "rules",
        }
      : {
          decision: "adjust",
          reason: "程序识别到阻断，下一步骤没有有效的关联恢复关系，禁止继续业务。",
          summary: "计划必须先诊断、修复并复验阻断条件。",
          source: "rules",
        };
  }

  let continuedForDiagnostics = false;
  const nextStep = remainingSteps[0];
  if (
    finalDecision.decision === "adjust"
    && !input.postconditionReview
    && isReadOnlyDiagnosticStep(input.step)
    && nextStep
    && isReadOnlyDiagnosticStep(nextStep)
  ) {
    continuedForDiagnostics = true;
    finalDecision = {
      decision: "continue",
      reason: "异常模型建议调整，但当前与下一步骤均为只读诊断；继续收集证据后再判断。",
      summary: "继续完成剩余只读诊断。",
      source: "rules",
    };
  }

  return {
    requirement,
    context,
    modelDecision,
    finalDecision,
    remainingSteps,
    hardBlocker,
    mutatingStep,
    repairStepFound,
    blockingSignalResolved,
    continuedForDiagnostics,
  };
}
