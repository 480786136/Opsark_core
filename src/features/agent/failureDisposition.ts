import type { PlanStep, StepReview } from "@/types";
import { textFingerprint } from "./longRunningReviewOutput";

type DependencyStep = Partial<Pick<PlanStep, "id" | "kind" | "action" | "command" | "validation" | "expected" | "risk" | "executionScope" | "validationScope" | "title" | "failureDependencies">>;

function dependencyFingerprint(step: DependencyStep) {
  return textFingerprint(JSON.stringify([step.id, step.kind, step.action, step.command, step.validation,
    step.expected, step.risk, step.executionScope, step.validationScope]));
}

export function holdFailureDependents(failed: PlanStep, remaining: PlanStep[]) {
  for (const step of remaining) {
    if (!step.failureDependencies?.some(item => item.failedStepId === failed.id)) {
      step.failureDependencies = [...(step.failureDependencies ?? []), {
        failedStepId: failed.id, reason: "等待失败复核与逐步依赖判断。",
      }];
    }
  }
}

export function releaseAcceptedDependency(accepted: PlanStep, remaining: PlanStep[]) {
  for (const step of remaining) {
    step.failureDependencies = step.failureDependencies?.filter(item => item.failedStepId !== accepted.id);
    if (!step.failureDependencies?.length) step.failureDependencies = undefined;
  }
}

/** A review grants permission only for explicitly assessed independent steps. */
export function applyFailureDisposition(failed: PlanStep, remaining: PlanStep[], review: StepReview) {
  const action = review.recoveryAction;
  const entries = action?.steps;
  const ids = new Set(remaining.map(step => step.id));
  const valid = review.source === "model" && review.decision === "continue"
    && action?.kind === "continue_independent" && Boolean(action.reason?.trim())
    && Array.isArray(entries) && entries.length === remaining.length
    && new Set(entries.map(entry => entry.stepId)).size === remaining.length
    && entries.every(entry => ids.has(entry.stepId) && Boolean(entry.reason?.trim())
      && ["independent", "dependent", "unknown"].includes(entry.relation));

  for (const step of remaining) {
    const existing = (step.failureDependencies ?? []).filter(item => item.failedStepId !== failed.id);
    const entry = valid ? entries?.find(item => item.stepId === step.id) : undefined;
    existing.push({ failedStepId: failed.id, relation: entry?.relation ?? "unknown",
      stepFingerprint: dependencyFingerprint(step),
      reason: entry?.reason ?? "失败后的恢复动作或逐步依赖判断不完整，需先调整方案。" });
    step.failureDependencies = existing;
  }
  return Boolean(valid && remaining.length && !failureDependencyBlocker(remaining[0]));
}

export function failureDependencyBlocker(step: DependencyStep): string | undefined {
  const blocker = step.failureDependencies?.find(item => item.relation !== "independent"
    || item.stepFingerprint !== dependencyFingerprint(step));
  const reason = blocker?.relation === "independent" ? "步骤内容已变化，需要重新确认与前置失败的依赖关系。" : blocker?.reason;
  return blocker ? `步骤“${step.title ?? "当前步骤"}”尚不能执行：${reason}（前置失败步骤：${blocker.failedStepId}）` : undefined;
}

/** Missing or fabricated references cannot promote raw command output to acceptance. */
export function applySemanticAcceptance(step: PlanStep, review: StepReview) {
  if (!step.result || step.result.facts.semanticAcceptanceRequired !== true) return;
  const assessment = review.acceptance;
  const evidenceIds = new Set(step.evidence?.map(item => item.id) ?? []);
  const grounded = review.source === "model" && assessment && Boolean(assessment.reason?.trim())
    && Array.isArray(assessment.evidenceIds) && assessment.evidenceIds.length > 0
    && assessment.evidenceIds.every(id => evidenceIds.has(id));
  const proven = Boolean(grounded && assessment.status === "proven"
    && step.result.executionStatus === "success" && step.result.facts.validationPassed !== false);
  step.result.facts.semanticAcceptanceStatus = proven ? "proven"
    : grounded && assessment.status === "not_met" ? "not_met" : "unknown";
  step.result.facts.semanticAcceptanceReason = grounded ? assessment.reason : "缺少有证据引用的结果验收结论。";
}
