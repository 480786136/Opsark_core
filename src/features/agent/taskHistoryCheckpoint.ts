import { compactReviewText, textFingerprint } from "@/features/agent/longRunningReviewOutput";
import { decisionOutput } from "./decisionEvidence";
import { bindRecoveryCarryForwards, hasVerifiedRecovery, isBlockingFailure, persistedRecoveryContract } from "./recoveryContract";
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
const CHECKPOINT_PHASE_SUMMARY_LIMIT = 4;
const RECENT_DETAILED_PHASE_COUNT = 2;

function emptyCheckpoint(roundCount = 0): TaskHistoryCheckpoint {
  return {
    version: 2,
    sourceRoundCount: roundCount,
    sourcePhaseCount: 0,
    sourceStepCount: 0,
    statusCounts: {},
    verifiedFacts: [],
    unresolvedIssues: [],
    phaseSummaries: [],
    sourcePhaseFingerprints: {},
    sourceHistoryFingerprint: textFingerprint(""),
    updatedAt: new Date(0).toISOString(),
  };
}

export function isExceptionalTaskStep(step: PlanStep) {
  return step.status === "failed"
    || step.result?.executionStatus === "failed"
    || step.result?.executionStatus === "blocked"
    || ["unhealthy", "warning"].includes(step.result?.observationStatus ?? "")
    || step.result?.facts.blockingSignal === true
    || step.result?.facts.evidenceConflict === true
    || Boolean(step.result?.failureReason?.trim())
    || Boolean(step.result?.warnings?.some((warning) => warning.trim()));
}

/** Distinguishes reused step ids on different targets or execution attempts. */
export function taskStepEvidenceKey(step: PlanStep) {
  const evidenceIds = step.result?.evidenceIds?.length ? step.result.evidenceIds
    : step.evidence?.map(item => item.id) ?? [];
  return textFingerprint(JSON.stringify([
    step.id, step.attemptContext ?? null, textFingerprint(step.command),
    step.startedAt ?? null, evidenceIds,
    // Durable evidence identities survive local output truncation. Legacy
    // records without those identities need the output fingerprint fallback.
    step.startedAt || evidenceIds.length ? null : textFingerprint(step.output ?? ""),
  ]));
}

export function isUserInputEvidenceStep(step: PlanStep) {
  return step.result?.facts.toolId === "user.request_input"
    || /^\s*opsark-tool\s+user\.request_input(?:\s|$)/u.test(step.command);
}

function unresolvedIssueKey(
  issue: Pick<TaskHistoryCheckpoint["unresolvedIssues"][number], "stepId" | "commandFingerprint" | "attemptContext">,
) {
  return issue.attemptContext
    ? `target-command:${JSON.stringify([issue.attemptContext, issue.commandFingerprint])}`
    : `step-command:${JSON.stringify([issue.stepId, issue.commandFingerprint])}`;
}

function compactUnresolvedIssues(issues: TaskHistoryCheckpoint["unresolvedIssues"]) {
  const latest = new Map<string, TaskHistoryCheckpoint["unresolvedIssues"][number]>();
  for (const issue of issues) {
    const key = unresolvedIssueKey(issue);
    const previous = latest.get(key);
    latest.delete(key);
    latest.set(key, previous
      ? { ...issue, attemptCount: Math.max(previous.attemptCount, issue.attemptCount),
        countedAttemptKeys: [...new Set([...(previous.countedAttemptKeys ?? []), ...(issue.countedAttemptKeys ?? [])])] }
      : issue);
  }
  // Bound expanded model details, never the persisted index of unresolved work.
  return [...latest.values()];
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
  sourcePhases: TaskExecutionPhase[] = [phase],
  task?: OpsTask,
): TaskHistoryCheckpoint {
  if (checkpoint.sourcePhaseFingerprints?.[phase.id]) return checkpoint;
  const statusCounts = { ...checkpoint.statusCounts };
  phase.plan.forEach((step) => {
    statusCounts[step.status] = (statusCounts[step.status] ?? 0) + 1;
  });

  const verifiedFacts = [...checkpoint.verifiedFacts];
  for (const step of phase.plan) {
    if (step.status !== "completed" || (!step.result && !step.evidence?.length)) continue;
    const fact = {
      sourceToolId: isUserInputEvidenceStep(step) ? "user.request_input"
        : typeof step.result?.facts.toolId === "string" ? step.result.facts.toolId : undefined,
      evidenceKey: taskStepEvidenceKey(step),
      sourcePhaseId: phase.id,
      stepId: step.id,
      title: compactReviewText(step.title, 180),
      targetContext: step.attemptContext,
      output: decisionOutput(step.output, step.evidence, 800),
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
    const existing = verifiedFacts.findIndex((item) => item.evidenceKey === fact.evidenceKey);
    if (existing >= 0) verifiedFacts.splice(existing, 1);
    verifiedFacts.push(fact);
  }

  let unresolvedIssues = compactUnresolvedIssues(checkpoint.unresolvedIssues);
  for (const step of phase.plan) {
    const commandFingerprint = textFingerprint(step.command);
    const issueKey = unresolvedIssueKey({
      stepId: step.id,
      commandFingerprint,
      attemptContext: step.attemptContext,
    });
    const sameIssue = (item: TaskHistoryCheckpoint["unresolvedIssues"][number]) =>
      unresolvedIssueKey(item) === issueKey;
    if (!isExceptionalTaskStep(step)) {
      // Conservatively compact only an exact historical verification match.
      // Other methods or replacement routes remain available to goal review;
      // this history index is not an execution or completion gate.
      unresolvedIssues = unresolvedIssues.filter(issue => {
        const source = sourcePhases.find(item => item.id === issue.sourcePhaseId);
        const failed = (source?.plan ?? sourcePhases.flatMap(item => item.plan)).find(candidate =>
          candidate.id === issue.stepId && candidate.attemptContext === issue.attemptContext
          && textFingerprint(candidate.command) === issue.commandFingerprint) ?? issue.recoveryContract?.step;
        return !failed || !hasVerifiedRecovery(task ? bindRecoveryCarryForwards(task, failed) : failed,
          step, sourcePhases.flatMap(item => item.plan));
      });
      if (step.status === "completed" && step.result?.executionStatus === "success"
        && step.result.observationStatus === "matched"
        && step.evidence?.some(item => step.result?.evidenceIds.includes(item.id))) {
        // Resolve only the same target + command incident with independent
        // matched evidence. Step ids may be reused while replanning, so a
        // skipped/pending or unrelated replacement must not erase a failure.
        unresolvedIssues = unresolvedIssues.filter((item) => !sameIssue(item)
          || item.recoveryContract !== undefined || item.blocksExecution !== false);
      }
      continue;
    }
    const existing = unresolvedIssues.find(sameIssue);
    const attemptKey = taskStepEvidenceKey(step);
    if (existing?.countedAttemptKeys?.includes(attemptKey)) continue;
    unresolvedIssues = unresolvedIssues.filter((item) => !sameIssue(item));
    unresolvedIssues.push({
      issueId: textFingerprint(issueKey),
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
      attemptContext: step.attemptContext,
      attemptCount: (existing?.attemptCount ?? 0) + 1,
      countedAttemptKeys: [...(existing?.countedAttemptKeys ?? []), attemptKey],
      sourcePhaseId: phase.id,
      evidenceIds: step.result?.evidenceIds,
      sourceRoundId: phase.roundId,
      blocksExecution: isBlockingFailure(step),
      recoveryContract: persistedRecoveryContract(step, phase.roundId),
      archiveReferences: step.evidence?.flatMap(({ archive, rawOutput }) =>
        archive?.fingerprint === textFingerprint(rawOutput) ? [archive] : []),
      verificationState: "recorded",
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
    unresolvedIssues: compactUnresolvedIssues(unresolvedIssues),
    phaseSummaries,
    throughPhaseId: phase.id,
    sourcePhaseFingerprints: {
      ...checkpoint.sourcePhaseFingerprints,
      [phase.id]: phaseFingerprint(phase),
    },
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
      roundId: round.roundId ?? round.id,
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

function compactablePhases(task: OpsTask) {
  const phases = [
    ...(task.planHistory ?? []).flatMap(roundPhases),
    ...(task.phaseHistory ?? []).slice(0, -RECENT_DETAILED_PHASE_COUNT),
  ];
  const seen = new Set<string>();
  return phases.filter(({ id }) => !seen.has(id) && Boolean(seen.add(id)));
}

function migrateLegacyCheckpoint(task: OpsTask, legacy: TaskHistoryCheckpoint, phases: TaskExecutionPhase[]) {
  const throughIndex = phases.findIndex(({ id }) => id === legacy.throughPhaseId);
  const legacyPhases = legacy.sourcePhaseCount === 0 ? []
    : throughIndex >= 0 ? phases.slice(0, throughIndex + 1) : phases;
  let rebuilt = emptyCheckpoint(task.planHistory?.length ?? 0);
  for (const phase of legacyPhases) rebuilt = mergePhase(rebuilt, phase, legacyPhases, task);
  // Counts alone cannot prove coverage: truncated persistence may retain equally
  // many but different phases. Verify the old chained fingerprint as well.
  const complete = rebuilt.sourcePhaseCount === legacy.sourcePhaseCount
    && rebuilt.sourceStepCount === legacy.sourceStepCount
    && rebuilt.sourceHistoryFingerprint === legacy.sourceHistoryFingerprint
    && (legacy.sourcePhaseCount === 0 || throughIndex >= 0);
  const known = legacyPhases.flatMap(({ plan }) => plan);
  const uncertain = legacy.unresolvedIssues.filter((issue) => {
    if (!complete) return true;
    const matches = known.filter(step => unresolvedIssueKey({
      stepId: step.id,
      commandFingerprint: textFingerprint(step.command),
      attemptContext: step.attemptContext,
    }) === unresolvedIssueKey(issue));
    const last = matches[matches.length - 1];
    // Missing structured evidence is not proof that an old incident was false.
    return !last || (!isExceptionalTaskStep(last) && !last.result);
  }).map(issue => ({
    ...issue,
    issueId: issue.issueId ?? textFingerprint(unresolvedIssueKey(issue)),
    verificationState: "needs_review" as const,
  }));
  if (!complete) {
    rebuilt = {
      ...rebuilt,
      sourceRoundCount: Math.max(legacy.sourceRoundCount, rebuilt.sourceRoundCount),
      sourcePhaseCount: Math.max(legacy.sourcePhaseCount, rebuilt.sourcePhaseCount),
      sourceStepCount: Math.max(legacy.sourceStepCount, rebuilt.sourceStepCount),
      statusCounts: Object.fromEntries([...new Set([
        ...Object.keys(legacy.statusCounts), ...Object.keys(rebuilt.statusCounts),
      ])].map(status => [status, Math.max(legacy.statusCounts[status] ?? 0, rebuilt.statusCounts[status] ?? 0)])),
      verifiedFacts: [...legacy.verifiedFacts.filter(fact =>
        !rebuilt.verifiedFacts.some(rebuiltFact => rebuiltFact.stepId === fact.stepId)), ...rebuilt.verifiedFacts]
        .slice(-CHECKPOINT_FACT_LIMIT),
      sourceHistoryFingerprint: textFingerprint(`${legacy.sourceHistoryFingerprint}\npartial-migration\n${rebuilt.sourceHistoryFingerprint}`),
      throughPhaseId: legacy.throughPhaseId ?? rebuilt.throughPhaseId,
    };
  }
  rebuilt.unresolvedIssues = compactUnresolvedIssues([...uncertain, ...rebuilt.unresolvedIssues]);
  rebuilt.migration = {
    fromVersion: 1,
    ledgerCoverage: complete ? "complete" : "partial",
    missingPhaseCount: Math.max(0, legacy.sourcePhaseCount - legacyPhases.length),
    missingStepCount: Math.max(0, legacy.sourceStepCount - known.length),
    countsExact: complete,
    requiresReview: !complete || uncertain.length > 0,
  };
  for (const phase of phases.slice(legacyPhases.length)) rebuilt = mergePhase(rebuilt, phase, phases, task);
  return rebuilt;
}

/** Migrates version 1 once; missing ledger evidence remains explicitly unresolved. */
export function initializeTaskHistoryCheckpoint(task: OpsTask) {
  if (task.historyCheckpoint?.version === 2) return task.historyCheckpoint;
  const phases = compactablePhases(task);
  if (task.historyCheckpoint) {
    task.historyCheckpoint = migrateLegacyCheckpoint(task, task.historyCheckpoint, phases);
    return task.historyCheckpoint;
  }
  let checkpoint = emptyCheckpoint(task.planHistory?.length ?? 0);
  for (const phase of phases) checkpoint = mergePhase(checkpoint, phase, phases, task);
  if (!checkpoint.sourcePhaseCount) return undefined;
  task.historyCheckpoint = checkpoint;
  return checkpoint;
}

/** Rolls the phase that just left the two-phase detail window into the stored checkpoint. */
export function refreshTaskHistoryCheckpoint(task: OpsTask) {
  let checkpoint = initializeTaskHistoryCheckpoint(task) ?? emptyCheckpoint(task.planHistory?.length ?? 0);
  const compactable = (task.phaseHistory ?? []).slice(0, -RECENT_DETAILED_PHASE_COUNT);
  const sources = compactablePhases(task);
  for (const phase of compactable) checkpoint = mergePhase(checkpoint, phase, sources, task);
  if (checkpoint.sourcePhaseCount) task.historyCheckpoint = checkpoint;
  return task.historyCheckpoint;
}

/** Closes a user round by compacting its two remaining detailed phases and final plan. */
export function mergeRoundIntoTaskHistoryCheckpoint(task: OpsTask, round: TaskPlanHistory) {
  let checkpoint = initializeTaskHistoryCheckpoint(task) ?? emptyCheckpoint(task.planHistory?.length ?? 0);
  const phases = roundPhases(round);
  const sources = [...compactablePhases(task), ...phases];
  for (const phase of phases) checkpoint = mergePhase(checkpoint, phase, sources, task);
  checkpoint.sourceRoundCount = Math.max(checkpoint.sourceRoundCount,
    new Set(task.planHistory?.map(item => item.id) ?? [round.id]).size);
  task.historyCheckpoint = checkpoint;
  return checkpoint;
}

export const TASK_DECISION_RECENT_PHASE_LIMIT = RECENT_DETAILED_PHASE_COUNT;
