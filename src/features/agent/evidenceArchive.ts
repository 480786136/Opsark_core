import type { OpsTask, PlanStep } from "@/types";
import { textFingerprint } from "./longRunningReviewOutput";
import { isUserInputStep } from "./executionContextEvidence";

/** Archive before projecting a preview; a failed write leaves all content inline. */
export async function archiveToolEvidence(task: OpsTask, step: PlanStep,
  save: (taskId: string, record: Record<string, unknown>) => Promise<string>,
  redact: (text: string) => string,
  origin: { roundId?: string; serverId?: string } = {},
) {
  if (isUserInputStep(step) || step.result?.facts.toolId === "evidence.read") return;
  let context: unknown;
  try { context = JSON.parse(step.attemptContext ?? "null"); } catch { /* Legacy identity remains explicitly unscoped. */ }
  const attempt = Array.isArray(context) && context.length === 5 ? context : undefined;
  for (const evidence of step.evidence ?? []) {
    if (!evidence.rawOutput) continue;
    if (evidence.archive?.fingerprint === textFingerprint(evidence.rawOutput)
      && (!evidence.archive.taskId || evidence.archive.taskId === task.id)
      && (!evidence.archive.stepId || evidence.archive.stepId === step.id)
      && (!evidence.archive.sourceEvidenceId || evidence.archive.sourceEvidenceId === evidence.id)
      && (!evidence.archive.targetContext || evidence.archive.targetContext === step.attemptContext)) {
      evidence.archiveError = undefined;
      continue;
    }
    // A stale reference is never offered after a failed replacement save.
    evidence.archive = undefined;
    const provenance = { taskId: task.id, stepId: step.id, sourceEvidenceId: evidence.id,
      targetContext: step.attemptContext,
      roundId: typeof attempt?.[1] === "string" ? attempt[1] : origin.roundId ?? task.currentRoundId,
      serverId: evidence.scope?.targetId ?? (typeof attempt?.[0] === "string" ? attempt[0] : origin.serverId ?? task.executionTargetServerId ?? task.serverId) };
    const rawOutput = evidence.rawOutput;
    try {
      const text = redact(rawOutput);
      const evidenceId = await save(task.id, {
        ...provenance, text, collectedAt: evidence.collectedAt, scope: evidence.scope,
        executionAttempts: step.executionLedgerAttempts,
        capturedPartial: step.result?.facts.truncated === true,
      });
      if (!/^[a-f\d]{64}$/iu.test(evidenceId)) throw new Error("Invalid evidence archive identity");
      if (evidence.rawOutput !== rawOutput) throw new Error("Evidence changed during archive save");
      evidence.archive = { ...provenance, evidenceId, fingerprint: textFingerprint(rawOutput),
        characters: Array.from(text).length, capturedPartial: step.result?.facts.truncated === true };
      evidence.archiveError = undefined;
    } catch {
      evidence.archiveError = "证据补读归档保存失败；原始执行记录保留，可重试保存，不会重新执行原操作。";
      console.warn("Evidence archive unavailable; retaining inline output");
    }
  }
}
