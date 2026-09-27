import { operationsProgressIdentity } from "@/features/tools/operationsObservation";
import type { OpsTask, PlanStep } from "@/types";
import { textFingerprint } from "./longRunningReviewOutput";

export const MAX_AUTOMATIC_PHASES = 12;
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
  const inspection = operationsProgressIdentity(step);
  if (inspection) return textFingerprint(JSON.stringify({ target, inspection }));
  const output = (step.output ?? step.evidence?.map(item => item.rawOutput).join("\n") ?? "")
    .replace(/\[exit:\s*-?\d+\]/g, "").trim().replace(/\r\n/g, "\n");
  return textFingerprint(JSON.stringify({
    target,
    output,
    result: factsWithoutStatistics(step.result?.facts ?? {}),
    status: step.result?.observationStatus,
  }));
}

function isConfirmedUserDecision(step: PlanStep) {
  return step.status === "completed"
    && step.result?.executionStatus === "success"
    && step.result.facts.toolId === "user.request_input"
    && Boolean(step.output);
}

function isDispatchedChangeAttempt(step: PlanStep) {
  return step.kind === "change"
    && Boolean(step.result)
    && step.result?.facts.commandDispatched !== false
    && ["completed", "failed"].includes(step.status);
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
  let automaticPhases = 0;
  const budget = task.automaticPhaseBudget;
  const excluded = new Set(budget?.roundId === task.currentRoundId
    && budget?.serverId === (task.executionTargetServerId ?? task.serverId) ? budget.stepIds : []);
  const reviewed = new Set(budget?.roundId === task.currentRoundId
    && budget?.serverId === (task.executionTargetServerId ?? task.serverId) ? budget.reviewedStepIds ?? [] : []);
  for (const phase of phases) {
    // Local patches carry pending IDs across phase snapshots. A planned step
    // consumes no progress/budget until an actual terminal record exists.
    const steps = phase.filter(step => ["completed", "failed", "skipped"].includes(step.status) && !stepIds.has(step.id));
    steps.forEach(step => stepIds.add(step.id));
    if (!steps.length || steps.every(step => step.status === "skipped"
      || ["terminal_transport", "terminal_recovery", "validation_protocol_exception"].includes(String(step.result?.facts.category)))) continue;
    completedPhases += 1;
    if (steps.some(step => !excluded.has(step.id))) automaticPhases += 1;
    const changed = steps.some(step => step.kind === "change" && step.status === "completed"
      && step.result?.executionStatus === "success");
    const decisionConfirmed = steps.some(isConfirmedUserDecision);
    const changeAttempted = steps.some(isDispatchedChangeAttempt);
    // A confirmed user decision starts a new semantic incident and invalidates
    // the old observation loop. A dispatched (even failed) change breaks a run
    // of observation-only phases, but does not clear evidence identities so a
    // repeated failing change is still caught by the stagnation guard.
    if (changed || decisionConfirmed) seen.clear();
    let added = false;
    for (const step of steps) {
      if (!step.result || !step.output && !step.evidence?.length) continue;
      const identity = observationIdentity(step);
      if (!seen.has(identity)) added = true;
      seen.add(identity);
    }
    stagnantPhases = steps.every(step => reviewed.has(step.id)) || added || changed || decisionConfirmed ? 0 : stagnantPhases + 1;
    observationPhases = changed || decisionConfirmed || changeAttempted ? 0 : observationPhases + 1;
  }
  return { completedPhases, automaticPhases, stagnantPhases, observationPhases,
    evidenceCount: seen.size, rereadEvidence: stagnantPhases > 0 || observationPhases >= 3 };
}

export function automaticContinuationStop(task: OpsTask): { code: "no_progress" | "phase_budget_exhausted"; reason: string } | undefined {
  const progress = workflowProgress(task);
  if (progress.stagnantPhases >= MAX_STAGNANT_PHASES) {
    return { code: "no_progress", reason: "连续阶段没有新增执行事实，已停止自动重复取证。已保留原始证据，请检查已有证据或补充尚未满足的目标条件后继续。" };
  }
  // Read-only business goals may legitimately need many observation phases.
  // Actual repeated facts and the independent finite phase budget still stop loops.
  if (progress.automaticPhases >= MAX_AUTOMATIC_PHASES) {
    return { code: "phase_budget_exhausted", reason: "本轮自动阶段预算已用完，不代表任务没有进展。目标与证据已保留；明确继续后将开启新的自动阶段预算。" };
  }
  return undefined;
}

export function automaticContinuationBlocker(task: OpsTask): string | undefined {
  return automaticContinuationStop(task)?.reason;
}

/** Call only from an explicit user continuation, never a timer/system handoff. */
export function renewAutomaticPhaseBudget(task: OpsTask, renewedAt: string): boolean {
  const progress = workflowProgress(task);
  const exhausted = progress.automaticPhases >= MAX_AUTOMATIC_PHASES;
  // Also release a legacy six-observation stop on an explicit continuation.
  if (!exhausted && progress.stagnantPhases < MAX_STAGNANT_PHASES && task.managedStopReason !== "no_progress") return false;
  const plans = (task.phaseHistory ?? []).filter(phase => phase.roundId === task.currentRoundId).map(phase => phase.plan);
  if (task.plan.every(step => ["completed", "failed", "skipped"].includes(step.status))) plans.push(task.plan);
  const previousBudget = task.automaticPhaseBudget;
  const previousStepIds = previousBudget && previousBudget.roundId === task.currentRoundId
    && previousBudget.serverId === (task.executionTargetServerId ?? task.serverId) ? previousBudget.stepIds : [];
  task.automaticPhaseBudget = { roundId: task.currentRoundId,
    serverId: task.executionTargetServerId ?? task.serverId,
    stepIds: exhausted ? [...new Set(plans.flatMap(plan => plan
      .filter(step => ["completed", "failed", "skipped"].includes(step.status)).map(step => step.id)))] : previousStepIds,
    reviewedStepIds: [...new Set(plans.flatMap(plan => plan
      .filter(step => ["completed", "failed", "skipped"].includes(step.status)).map(step => step.id)))], renewedAt };
  return true;
}
