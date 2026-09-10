import type { OpsTask, PlanStep } from "@/types";
import { textFingerprint } from "./longRunningReviewOutput";

export const MAX_AUTOMATIC_PHASES = 12;
export const MAX_OBSERVATION_PHASES = 6;
export const MAX_STAGNANT_PHASES = 2;
const STATISTICS = /^(?:id|evidenceIds|executionId|collectedAt|updatedAt|createdAt|timestamp|durationMs|elapsedSeconds|lineCount|found|outputPresent|commandCompleted|validationCompleted|commandDispatched|category|toolId)$/i;

function factsWithoutStatistics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(factsWithoutStatistics);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !STATISTICS.test(key))
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, factsWithoutStatistics(item)]));
}

/** Evidence identity excludes the plan's wording and executor bookkeeping. */
export function observationIdentity(step: PlanStep) {
  let target: unknown = step.attemptContext;
  try {
    const context: unknown = JSON.parse(step.attemptContext ?? "null");
    if (Array.isArray(context)) target = [context[0], context[4]];
  } catch { /* Legacy opaque target identities remain distinct. */ }
  const output = (step.output ?? step.evidence?.map(item => item.rawOutput).join("\n") ?? "")
    .replace(/\[exit:\s*-?\d+\]/g, "").trim().replace(/\r\n/g, "\n");
  return textFingerprint(JSON.stringify({
    target,
    output,
    result: factsWithoutStatistics(step.result?.facts ?? {}),
    status: step.result?.observationStatus,
  }));
}

/** A round-wide guard, independent of per-incident command fingerprints. */
export function workflowProgress(task: OpsTask) {
  const phases = (task.phaseHistory ?? []).filter(phase => phase.roundId === task.currentRoundId).map(phase => phase.plan);
  if (task.plan.length && task.plan.every(step => ["completed", "failed", "skipped"].includes(step.status))) phases.push(task.plan);
  const seen = new Set<string>();
  const stepIds = new Set<string>();
  let stagnantPhases = 0;
  let observationPhases = 0;
  let completedPhases = 0;
  for (const phase of phases) {
    const steps = phase.filter(step => !stepIds.has(step.id));
    steps.forEach(step => stepIds.add(step.id));
    if (!steps.length || steps.every(step => step.status === "skipped"
      || ["terminal_transport", "terminal_recovery", "validation_protocol_exception"].includes(String(step.result?.facts.category)))) continue;
    completedPhases += 1;
    const changed = steps.some(step => step.kind === "change" && step.status === "completed"
      && step.result?.executionStatus === "success");
    if (changed) seen.clear();
    let added = false;
    for (const step of steps) {
      if (!step.result || !step.output && !step.evidence?.length) continue;
      const identity = observationIdentity(step);
      if (!seen.has(identity)) added = true;
      seen.add(identity);
    }
    stagnantPhases = added || changed ? 0 : stagnantPhases + 1;
    observationPhases = changed ? 0 : observationPhases + 1;
  }
  return { completedPhases, stagnantPhases, observationPhases,
    evidenceCount: seen.size, rereadEvidence: stagnantPhases > 0 || observationPhases >= 3 };
}

export function automaticContinuationBlocker(task: OpsTask): string | undefined {
  const progress = workflowProgress(task);
  if (progress.stagnantPhases >= MAX_STAGNANT_PHASES) {
    return "连续阶段没有新增执行事实，已停止自动重复取证。已保留原始证据，请检查已有证据或补充尚未满足的目标条件后继续。";
  }
  if (progress.observationPhases >= MAX_OBSERVATION_PHASES) {
    return "连续多个阶段仍停留在取证，已停止自动循环。已有证据已保留并补充到决策上下文，请明确剩余目标或缺少的证据后继续。";
  }
  if (progress.completedPhases >= MAX_AUTOMATIC_PHASES) {
    return "本轮已达到自动阶段上限，任务与证据已保留；请检查实际进展后明确继续。";
  }
  return undefined;
}
