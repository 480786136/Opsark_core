import type { AuditEventDraft } from "@/features/agent/auditTrail";
import type { StepResult, StepReview } from "@/types";

interface AuditScope {
  stepTitle: string;
  serverId: string;
  taskId: string;
}

const detail = (value: Record<string, unknown>) => JSON.stringify(value, null, 2);

export interface PreconditionReviewAuditInput extends AuditScope {
  allowed: boolean;
  context: Record<string, unknown>;
  modelDecision: StepReview;
  finalDecision: StepReview;
}

export function buildPreconditionReviewAudit(
  input: PreconditionReviewAuditInput,
): AuditEventDraft {
  return {
    category: "model",
    level: input.allowed ? "info" : "warning",
    title: `${input.stepTitle} · 前置条件异常复核`,
    detail: detail({
      input: input.context,
      modelDecision: input.modelDecision,
      finalDecision: input.finalDecision,
    }),
    serverId: input.serverId,
    taskId: input.taskId,
  };
}

export interface PeriodicReviewAuditInput extends AuditScope {
  round: number;
  context: Record<string, unknown>;
  modelDecision: StepReview;
  acceptedDecision: boolean;
}

export function buildPeriodicReviewAudit(input: PeriodicReviewAuditInput): AuditEventDraft {
  return {
    category: "model",
    level: input.modelDecision.decision === "adjust" ? "warning" : "info",
    title: `${input.stepTitle} · 长任务定期复核 #${input.round}`,
    detail: detail({
      input: input.context,
      modelDecision: input.modelDecision,
      acceptedDecision: input.acceptedDecision,
    }),
    serverId: input.serverId,
    taskId: input.taskId,
  };
}

export interface CommandFailureReviewAuditInput extends AuditScope {
  context: Record<string, unknown>;
  modelDecision: StepReview;
  finalDecision: StepReview;
  diagnosticStep: boolean;
  mutatingStep: boolean;
  recoveryStepFound: boolean;
}

export function buildCommandFailureReviewAudit(
  input: CommandFailureReviewAuditInput,
): AuditEventDraft {
  return {
    category: "model",
    level: input.finalDecision.decision === "adjust" ? "warning" : "info",
    title: `${input.stepTitle} · 主命令失败异常复核`,
    detail: detail({
      input: input.context,
      modelDecision: input.modelDecision,
      diagnosticStep: input.diagnosticStep,
      mutatingStep: input.mutatingStep,
      recoveryStepFound: input.recoveryStepFound,
      finalDecision: input.finalDecision,
    }),
    serverId: input.serverId,
    taskId: input.taskId,
  };
}

export interface EvidenceReviewAuditInput extends AuditScope {
  reviewRequired: boolean;
  postconditionReview: boolean;
  context?: Record<string, unknown>;
  modelDecision?: StepReview;
  finalDecision: StepReview;
  result?: StepResult;
  validationExitCode?: number;
  hardBlocker?: string;
  mutatingStep: boolean;
  repairStepFound: boolean;
  blockingSignalResolved?: boolean;
  blockingFacts: Record<string, unknown>;
}

/** Builds every audit event derived from one evidence review in deterministic order. */
export function buildEvidenceReviewAudits(
  input: EvidenceReviewAuditInput,
): AuditEventDraft[] {
  const events: AuditEventDraft[] = [];
  if (input.reviewRequired) {
    events.push({
      category: "model",
      level: input.modelDecision?.decision === "adjust" ? "warning" : "success",
      title: input.postconditionReview
        ? `${input.stepTitle} · 后置校验失败异常复核`
        : `${input.stepTitle} · 异常模型复核`,
      detail: detail({
        reason: input.postconditionReview
          ? "主命令执行成功，但独立后置校验未通过"
          : "程序发现证据不可解释或相互冲突",
        input: input.context,
        result: input.modelDecision,
      }),
      serverId: input.serverId,
      taskId: input.taskId,
    });

    if (input.postconditionReview) {
      events.push({
        category: "system",
        level: input.finalDecision.decision === "adjust" ? "warning" : "info",
        title: `${input.stepTitle} · 后置校验最终决策`,
        detail: detail({
          validationPassed: false,
          validationExitCode: input.validationExitCode,
          hardBlocker: input.hardBlocker,
          mutatingStep: input.mutatingStep,
          remainingPlanCanRepair: input.repairStepFound,
          finalDecision: input.finalDecision,
        }),
        serverId: input.serverId,
        taskId: input.taskId,
      });
    }
  } else {
    events.push({
      category: "system",
      level: "info",
      title: `${input.stepTitle} · 确定性规则复核`,
      detail: detail({ result: input.result, modelReviewSkipped: true }),
      serverId: input.serverId,
      taskId: input.taskId,
    });
  }

  if (input.blockingSignalResolved !== undefined) {
    events.push({
      category: "system",
      level: input.blockingSignalResolved ? "info" : "warning",
      title: `${input.stepTitle} · 前置条件门禁`,
      detail: detail({
        blockingFacts: input.blockingFacts,
        remainingPlanResolvesBlocker: input.blockingSignalResolved,
        result: input.finalDecision,
      }),
      serverId: input.serverId,
      taskId: input.taskId,
    });
  }
  return events;
}

