import { compactReviewText, textFingerprint } from "@/features/agent/longRunningReviewOutput";
import {
  compactReviewEvidence,
  compactReviewResult,
  reviewPlanSummary,
} from "@/features/agent/reviewPayload";
import type {
  OpsTask,
  PlanStep,
  TaskExecutionPhase,
  TaskHistoryCheckpoint,
  TaskPlanHistory,
} from "@/types";

const CHECKPOINT_FACT_LIMIT = 12;
const CHECKPOINT_ISSUE_LIMIT = 8;
const CHECKPOINT_PHASE_SUMMARY_LIMIT = 4;
const RECENT_DETAILED_PHASE_COUNT = 2;

function emptyCheckpoint(roundCount = 0): TaskHistoryCheckpoint {
  return {
    version: 1,
    sourceRoundCount: roundCount,
    sourcePhaseCount: 0,
    sourceStepCount: 0,
    statusCounts: {},
    verifiedFacts: [],
    unresolvedIssues: [],
    phaseSummaries: [],
    sourceHistoryFingerprint: textFingerprint(""),
    updatedAt: new Date(0).toISOString(),
  };
}

function isExceptional(step: PlanStep) {
  return step.status === "failed"
    || step.result?.executionStatus === "failed"
    || step.result?.executionStatus === "blocked"
    || ["unhealthy", "warning", "unknown"].includes(step.result?.observationStatus ?? "");
}

function category(step: PlanStep) {
  return typeof step.result?.facts.category === "string"
    ? compactReviewText(step.result.facts.category, 120)
    : undefined;
}

function phaseFingerprint(phase: TaskExecutionPhase) {
  return textFingerprint(JSON.stringify({
    id: phase.id,
    reason: phase.reason,
    steps: phase.plan.map((step) => ({
      id: step.id,
      status: step.status,
      command: textFingerprint(step.command),
      result: step.result ? {
        executionStatus: step.result.executionStatus,
        observationStatus: step.result.observationStatus,
        exitCode: step.result.exitCode,
        category: category(step),
      } : undefined,
    })),
  }));
}

function mergePhase(
  checkpoint: TaskHistoryCheckpoint,
  phase: TaskExecutionPhase,
): TaskHistoryCheckpoint {
  if (checkpoint.throughPhaseId === phase.id) return checkpoint;
  const statusCounts = { ...checkpoint.statusCounts };
  phase.plan.forEach((step) => {
    statusCounts[step.status] = (statusCounts[step.status] ?? 0) + 1;
  });

  const verifiedFacts = [...checkpoint.verifiedFacts];
  for (const step of phase.plan) {
    if (step.status !== "completed" || (!step.result && !step.evidence?.length)) continue;
    const fact = {
      stepId: step.id,
      title: compactReviewText(step.title, 180),
      result: compactReviewResult(step.result, 900) as Record<string, unknown> | undefined,
      evidence: compactReviewEvidence(step.evidence, {
        maxItems: 3,
        rawOutputLimit: 0,
        factsLimit: 480,
      }) as Record<string, unknown> | undefined,
      scopes: step.evidence
        ?.map(({ scope }) => scope)
        .filter((scope): scope is NonNullable<typeof scope> => Boolean(scope))
        .slice(-3),
    };
    const existing = verifiedFacts.findIndex((item) => item.stepId === step.id);
    if (existing >= 0) verifiedFacts.splice(existing, 1);
    verifiedFacts.push(fact);
  }

  let unresolvedIssues = [...checkpoint.unresolvedIssues];
  for (const step of phase.plan) {
    const commandFingerprint = textFingerprint(step.command);
    if (!isExceptional(step)) {
      if (step.status === "completed") {
        unresolvedIssues = unresolvedIssues.filter((item) => item.commandFingerprint !== commandFingerprint);
      }
      continue;
    }
    const existing = unresolvedIssues.find((item) => item.commandFingerprint === commandFingerprint);
    unresolvedIssues = unresolvedIssues.filter((item) => item.commandFingerprint !== commandFingerprint);
    unresolvedIssues.push({
      stepId: step.id,
      title: compactReviewText(step.title, 180),
      category: category(step),
      reason: step.result?.failureReason
        ? compactReviewText(step.result.failureReason, 480)
        : step.review?.reason
          ? compactReviewText(step.review.reason, 480)
          : undefined,
      status: step.status,
      commandFingerprint,
      attemptCount: (existing?.attemptCount ?? 0) + 1,
    });
  }

  const phaseSummary = reviewPlanSummary(phase.plan);
  const phaseSummaries = [
    ...checkpoint.phaseSummaries.filter((item) => item.phaseId !== phase.id),
    {
      phaseId: phase.id,
      reason: phase.reason,
      summary: phase.summary ? compactReviewText(phase.summary, 480) : undefined,
      totalSteps: phaseSummary.totalSteps,
      statusCounts: phaseSummary.statusCounts,
    },
  ].slice(-CHECKPOINT_PHASE_SUMMARY_LIMIT);
  const sourceHistoryFingerprint = textFingerprint(
    `${checkpoint.sourceHistoryFingerprint}\n${phaseFingerprint(phase)}`,
  );
  return {
    ...checkpoint,
    sourcePhaseCount: checkpoint.sourcePhaseCount + 1,
    sourceStepCount: checkpoint.sourceStepCount + phase.plan.length,
    statusCounts,
    verifiedFacts: verifiedFacts.slice(-CHECKPOINT_FACT_LIMIT),
    unresolvedIssues: unresolvedIssues.slice(-CHECKPOINT_ISSUE_LIMIT),
    phaseSummaries,
    throughPhaseId: phase.id,
    sourceHistoryFingerprint,
    updatedAt: phase.completedAt,
  };
}

function roundPhases(round: TaskPlanHistory): TaskExecutionPhase[] {
  const phases = [...(round.phases ?? [])];
  const phaseStepIds = new Set(phases.flatMap((phase) => phase.plan.map(({ id }) => id)));
  const remaining = (round.finalPlan ?? round.plan).filter(({ id }) => !phaseStepIds.has(id));
  if (remaining.length) {
    phases.push({
      id: `round-final:${round.id}`,
      roundId: round.id,
      requirement: round.requirement,
      reason: "replan",
      plan: remaining,
      summary: round.summary ?? round.pauseReason,
      createdAt: round.createdAt,
      completedAt: round.completedAt,
    });
  }
  return phases;
}

/** Creates a checkpoint for legacy tasks that predate rolling compaction. */
export function initializeTaskHistoryCheckpoint(task: OpsTask) {
  if (task.historyCheckpoint) return task.historyCheckpoint;
  let checkpoint = emptyCheckpoint(task.planHistory?.length ?? 0);
  for (const round of task.planHistory ?? []) {
    for (const phase of roundPhases(round)) checkpoint = mergePhase(checkpoint, phase);
  }
  for (const phase of (task.phaseHistory ?? []).slice(0, -RECENT_DETAILED_PHASE_COUNT)) {
    checkpoint = mergePhase(checkpoint, phase);
  }
  if (!checkpoint.sourcePhaseCount) return undefined;
  task.historyCheckpoint = checkpoint;
  return checkpoint;
}

/** Rolls the phase that just left the two-phase detail window into the stored checkpoint. */
export function refreshTaskHistoryCheckpoint(task: OpsTask) {
  let checkpoint = initializeTaskHistoryCheckpoint(task) ?? emptyCheckpoint(task.planHistory?.length ?? 0);
  const compactable = (task.phaseHistory ?? []).slice(0, -RECENT_DETAILED_PHASE_COUNT);
  const throughIndex = compactable.findIndex(({ id }) => id === checkpoint.throughPhaseId);
  const pending = throughIndex >= 0
    ? compactable.slice(throughIndex + 1)
    : compactable.filter(({ id }) => id !== checkpoint.throughPhaseId).slice(-1);
  for (const phase of pending) checkpoint = mergePhase(checkpoint, phase);
  if (checkpoint.sourcePhaseCount) task.historyCheckpoint = checkpoint;
  return task.historyCheckpoint;
}

/** Closes a user round by compacting its two remaining detailed phases and final plan. */
export function mergeRoundIntoTaskHistoryCheckpoint(task: OpsTask, round: TaskPlanHistory) {
  let checkpoint = task.historyCheckpoint ?? emptyCheckpoint(task.planHistory?.length ?? 0);
  const phases = roundPhases(round);
  const throughIndex = phases.findIndex(({ id }) => id === checkpoint.throughPhaseId);
  const pending = throughIndex >= 0 ? phases.slice(throughIndex + 1) : phases;
  for (const phase of pending) checkpoint = mergePhase(checkpoint, phase);
  checkpoint.sourceRoundCount = Math.max(checkpoint.sourceRoundCount, task.planHistory?.length ?? 1);
  task.historyCheckpoint = checkpoint;
  return checkpoint;
}

export const TASK_DECISION_RECENT_PHASE_LIMIT = RECENT_DETAILED_PHASE_COUNT;
