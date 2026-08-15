import { backend } from "@/services/backend";
import { createRuntimeModel } from "@/features/agent/modelRuntime";
import {
  buildEvidenceReviewContext,
  buildExecutionFailureReviewContext,
  buildPreconditionReviewContext,
} from "@/features/agent/reviewContext";
import {
  isMutatingStepCommand,
  isReadOnlyDiagnosticStep,
  postconditionHasHardBlocker,
  remainingPlanCanRecoverExecutionFailure,
  remainingPlanCanRepairPostcondition,
  remainingPlanResolvesBlockingSignal,
} from "@/features/agent/evidenceReview";
import { latestTaskRequirement } from "@/features/agent/taskProgression";
import type { ModelProfile, OpsTask, PlanStep, StepReview } from "@/types";

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

/** Reviews an unresolved precondition and fails closed without an explicit model approval. */
export async function reviewPrecondition(
  input: ReviewPreconditionInput,
  reviewStep: StepReviewer = backend.reviewStep.bind(backend),
) {
  const requirement = latestTaskRequirement(input.task);
  const context = buildPreconditionReviewContext(
    input.task,
    input.step,
    input.blockerStep,
    requirement,
  );
  const modelDecision = await reviewStep(
    requirement,
    JSON.stringify(context),
    true,
    createRuntimeModel(input.model, input.apiKey, ""),
  );
  const allowed = modelDecision.source === "model" && modelDecision.decision === "continue";
  const finalDecision: StepReview = allowed
    ? modelDecision
    : {
        decision: "adjust",
        reason: modelDecision.source !== "model"
          ? "前置条件尚未满足且模型复核不可用，不能自动继续变更操作。"
          : modelDecision.reason,
        summary: modelDecision.summary,
        source: modelDecision.source === "model" ? "model" : "rules",
      };
  return { requirement, context, modelDecision, finalDecision, allowed };
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
    requirement,
  );
  const modelDecision = await reviewStep(
    requirement,
    JSON.stringify(context),
    remainingSteps.length > 0,
    createRuntimeModel(input.model, input.apiKey, ""),
  );
  const mutatingStep = isMutatingStepCommand(input.step.command);
  const diagnosticStep = isReadOnlyDiagnosticStep(input.step) && !mutatingStep;
  const recoveryStepFound = remainingPlanCanRecoverExecutionFailure(
    input.failureCategory,
    remainingSteps,
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
      requirement,
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
      mutatingStep = isMutatingStepCommand(input.step.command);
      repairStepFound = remainingPlanCanRepairPostcondition(remainingSteps);
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
    finalDecision = blockingSignalResolved
      ? {
          decision: "continue",
          reason: "程序识别到运行时兼容性阻断，但剩余计划包含对应升级或切换步骤。",
          summary: "当前运行时不兼容，继续执行计划中的环境修复步骤。",
          source: "rules",
        }
      : {
          decision: "adjust",
          reason: "程序识别到运行时兼容性阻断，剩余计划没有升级或切换运行时的步骤，禁止继续安装或构建。",
          summary: "当前运行时版本不满足项目要求，计划必须先修复环境。",
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

