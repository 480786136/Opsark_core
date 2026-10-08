import type { OpsTask } from "@/types";
import { activeRoundSteps } from "./taskGoal";
import { executionContextEvidence, modelContextStep } from "./executionContextEvidence";
import { compactReviewEvidence, compactReviewResult } from "./reviewPayload";
import { compactReviewText } from "./longRunningReviewOutput";
import { DECISION_EVIDENCE_INSTRUCTION } from "./decisionEvidence";

/** Historical context for a new submission; original steps and evidence remain local. */
export function requirementExecutionContext(task: OpsTask, requirement: string) {
  const all = activeRoundSteps(task);
  const chosen = new Set([
    ...all.filter(step => ["failed", "awaiting_input", "awaiting_approval"].includes(step.status)).slice(-8),
    ...all.slice(-12),
  ]);
  const selected = all.filter(step => chosen.has(step));
  let remainingOutput = 12_000;
  const projected = new Map<string, string>();
  const projectOutput = (value: string | undefined) => {
    if (!value) return value;
    const existing = projected.get(value);
    if (existing !== undefined) return existing;
    const limit = Math.min(2_048, remainingOutput);
    const result = limit ? compactReviewText(value, limit) : "[正文已省略，原执行证据仍保留]";
    remainingOutput = Math.max(0, remainingOutput - result.length);
    projected.set(value, result);
    return result;
  };
  return {
    requirement: compactReviewText(requirement, 800),
    status: task.status,
    summary: task.summary ? compactReviewText(task.summary, 1_600) : undefined,
    executionConstraints: task.executionConstraints,
    totalSteps: all.length, omittedSteps: all.length - selected.length,
    instruction: `这是本任务上一轮的有界历史参考；有效要求以 taskGoal.requirementContext 为准。${DECISION_EVIDENCE_INSTRUCTION}`,
    steps: selected.map(original => {
      const step = modelContextStep(original);
      const compactResult = Boolean(step.result && JSON.stringify(step.result).length > 1_600);
      const evidence = executionContextEvidence({ ...step, evidence: step.evidence?.slice(-3) }, projectOutput);
      return {
        stepId: step.id, title: compactReviewText(step.title, 180), command: compactReviewText(step.command, 900),
        expected: compactReviewText(step.expected, 320), status: step.status,
        targetContext: step.attemptContext,
        review: step.review ? { decision: step.review.decision, reason: compactReviewText(step.review.reason, 480),
          summary: compactReviewText(step.review.summary, 480), source: step.review.source } : undefined,
        result: compactResult ? { ...compactReviewResult(step.result, 1_200), evidenceIds: step.result!.evidenceIds } : step.result,
        output: evidence.output,
        evidence: compactResult || JSON.stringify(evidence.evidence ?? []).length > 2_400
          ? compactReviewEvidence(step.evidence, { maxItems: 3, factsLimit: 480, rawOutputLimit: 0 }) : evidence.evidence,
      };
    }),
  };
}
