import type { OpsTask, PlanStep } from "@/types";
import { textFingerprint } from "./longRunningReviewOutput";

/** Archive before projecting a preview; a failed write leaves all content inline. */
export async function archiveToolEvidence(task: OpsTask, step: PlanStep,
  save: (taskId: string, record: Record<string, unknown>) => Promise<string>,
  redact: (text: string) => string,
) {
  if (step.result?.facts.toolId === "evidence.read") return;
  for (const evidence of step.evidence ?? []) {
    if (evidence.archive || evidence.rawOutput.length <= 2_048) continue;
    try {
      const evidenceId = await save(task.id, {
        text: redact(evidence.rawOutput), collectedAt: evidence.collectedAt,
        sourceEvidenceId: evidence.id, stepId: step.id,
        targetContext: step.attemptContext, serverId: task.executionTargetServerId ?? task.serverId,
        capturedPartial: step.result?.facts.truncated === true,
      });
      evidence.archive = { evidenceId, fingerprint: textFingerprint(evidence.rawOutput),
        characters: Array.from(redact(evidence.rawOutput)).length, capturedPartial: step.result?.facts.truncated === true };
    } catch (error) { console.warn("Evidence archive unavailable; retaining inline output", error); }
  }
}
