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
import { executionPolicyBlocker } from "./recoveryContract";

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

/**
 * Legacy precondition review now enforces only the task's hard authorization
 * boundary. Whether a proposed step is the best semantic response to an older
 * failure belongs to planning, not to a second Core decision before dispatch.
 */
export async function reviewPrecondition(
  input: ReviewPreconditionInput,
  _reviewStep: StepReviewer = backend.reviewStep.bind(backend),
) {
  const requirement = latestTaskRequirement(input.task);
  const context = buildPreconditionReviewContext(
    input.task,
    input.step,
    input.blockerStep,
  );
  const policyBlocker = executionPolicyBlocker(input.task, input.step);
  const allowed = !policyBlocker;
  const finalDecision: StepReview = {
    decision: allowed ? "continue" : "adjust",
    reason: policyBlocker
      ?? "当前步骤已通过任务授权边界检查；历史失败作为规划证据保留，不构成执行前的恢复关系门禁。",
    summary: allowed ? "继续交由执行器完成安全、能力和审批检查。" : "当前步骤超出任务授权范围。",
    source: "rules",
  };
  return { requirement, context, modelDecision: finalDecision, finalDecision, allowed };
}

/** Reviews a failed command without allowing Core to replace the model's business decision. */
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

    if (modelDecision.source !== "model") {
      finalDecision = {
        decision: "adjust",
        reason: "执行证据需要语义判断，但模型复核不可用；Core 不会代替模型推断继续或完成。",
        summary: "执行事实已保留，当前进入 blocked/no_action。",
        source: "rules",
      };
    }

    if (input.postconditionReview) {
      hardBlocker = postconditionHasHardBlocker(
        input.step,
        remainingSteps,
        input.validationExitCode,
      );
      mutatingStep = isMutatingReviewStep(input.step);
      repairStepFound = remainingPlanCanRepairPostcondition(remainingSteps, input.step);
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
    continuedForDiagnostics: false,
  };
}
