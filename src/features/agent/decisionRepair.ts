import type { NextStageDecision, PlanStep } from "@/types";
import { stableProtocolValue } from "@/services/planProtocolRepair";
import { ExecutionPolicyError } from "./recoveryContract";

function executionFields(step: PlanStep) {
  return {
    action: step.action, command: step.command, kind: step.kind, risk: step.risk,
    expected: step.expected, validation: step.validation, validator: step.validator,
    executionScope: step.executionScope, validationScope: step.validationScope,
    runtimeClass: step.runtimeClass, sessionContextChange: step.sessionContextChange,
    recovery: step.recovery, retryBasis: step.retryBasis, retryAfterStepId: step.retryAfterStepId,
    failureDependencies: step.failureDependencies,
  };
}

/** IDs and display prose may be regenerated; executable content and order may not. */
export function decisionRepairFingerprint(decision: NextStageDecision) {
  return stableProtocolValue({ steps: decision.steps.map(executionFields), planUpdate: decision.planUpdate,
    reconciliation: decision.reconciliation });
}

export function assertDecisionRepairPreserved(original: string, repaired: NextStageDecision) {
  if (decisionRepairFingerprint(repaired) !== original) {
    throw new ExecutionPolicyError("验收字段修复改变了原方案的执行动作，已拒绝新动作；请保留原步骤，仅修正验收、阻断或历史问题引用。新增业务动作必须重新规划和审核。");
  }
}

export function decisionRepairContext(decision: NextStageDecision) {
  return { responseMode: "metadata_fields", decision: decision.decision,
    reason: decision.reason, summary: decision.summary,
    requirementReview: decision.requirementReview, blocking: decision.blocking, issueResolutions: decision.issueResolutions,
    steps: decision.steps.map(step => ({ ...executionFields(step), title: step.title, description: step.description })),
    planUpdate: decision.planUpdate, reconciliation: decision.reconciliation,
    instruction: "这是尚未执行的候选方案，仅用于修复，不能作为执行事实或授权。保留步骤数量、顺序和执行字段，仅修正指出的 decision、requirementReview、blocking、issueResolutions 或决策说明；不得新增工具、Shell、用户提问或改变业务动作。只有整体完成可用 complete；本轮完成但整体 pending 时，使用 adjust、steps=[] 交付本轮结果。所有引用仍须来自当前真实证据。若证据无法支持完成，应保持未完成，不能伪造验收。" };
}
