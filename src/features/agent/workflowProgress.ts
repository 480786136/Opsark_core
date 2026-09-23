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
  for (const phase of phases) {
    const steps = phase.filter(step => !stepIds.has(step.id));
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
    stagnantPhases = added || changed || decisionConfirmed ? 0 : stagnantPhases + 1;
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
  if (progress.observationPhases >= MAX_OBSERVATION_PHASES) {
    return { code: "no_progress", reason: "连续多个阶段仍停留在取证，已停止自动循环。已有证据已保留并补充到决策上下文，请明确剩余目标或缺少的证据后继续。" };
  }
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
  if (workflowProgress(task).automaticPhases < MAX_AUTOMATIC_PHASES) return false;
  const plans = (task.phaseHistory ?? []).filter(phase => phase.roundId === task.currentRoundId).map(phase => phase.plan);
  if (task.plan.every(step => ["completed", "failed", "skipped"].includes(step.status))) plans.push(task.plan);
  task.automaticPhaseBudget = { roundId: task.currentRoundId,
    serverId: task.executionTargetServerId ?? task.serverId,
    stepIds: [...new Set(plans.flatMap(plan => plan.map(step => step.id)))], renewedAt };
  return true;
}
