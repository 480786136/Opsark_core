import { compactReviewText, textFingerprint } from "@/features/agent/longRunningReviewOutput";
import {
  compactReviewEvidence,
  compactReviewOutput,
  compactReviewPlanStep,
  compactReviewResult,
  reviewOutputMetadata,
  reviewPlanSummary,
} from "@/features/agent/reviewPayload";
import {
  initializeTaskHistoryCheckpoint,
  TASK_DECISION_RECENT_PHASE_LIMIT,
} from "@/features/agent/taskHistoryCheckpoint";
import { taskGoal } from "@/features/agent/taskGoal";
import { modelLogContext } from "./modelLogContext";
import { currentEvidenceSteps } from "@/features/agent/attemptState";
import { decisionOutputProjector, DECISION_EVIDENCE_INSTRUCTION } from "./decisionEvidence";
import { workflowProgress } from "./workflowProgress";
import type { OpsTask, PlanStep, TaskExecutionPhase } from "@/types";

const CURRENT_PLAN_STEP_LIMIT = 20;
const CURRENT_PLAN_LEADING_LIMIT = 3;
const CURRENT_PLAN_EXCEPTION_LIMIT = 8;
const CURRENT_PLAN_PENDING_LIMIT = 6;
const RECENT_PHASE_STEP_LIMIT = 12;

function redactCommandSecrets(value: string) {
  return value
    .replace(
      /((?:--?)(?:password|passwd|pwd|token|access[_-]?token|api[_-]?key|secret|credential)(?:=|\s+))(?:("[^"]*")|('[^']*')|([^\s]+))/giu,
      "$1••••••••",
    )
    .replace(
      /([?&](?:password|passwd|pwd|token|access[_-]?token|api[_-]?key|secret|credential)=)[^&#\s]+/giu,
      "$1••••••••",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/'"`:@]+:)[^@\s/'"`]+@/giu, "$1••••••••@");
}

function isExceptional(step: PlanStep) {
  return step.status === "failed"
    || step.result?.executionStatus === "failed"
    || step.result?.executionStatus === "blocked"
    || ["unhealthy", "warning", "unknown"].includes(step.result?.observationStatus ?? "");
}

function selectBoundedSteps(steps: PlanStep[], limit: number) {
  if (steps.length <= limit) return steps;
  const ids = new Set(steps.slice(0, CURRENT_PLAN_LEADING_LIMIT).map(({ id }) => id));
  steps.filter(isExceptional).slice(-CURRENT_PLAN_EXCEPTION_LIMIT).forEach(({ id }) => ids.add(id));
  steps.filter((step) => ["pending", "awaiting_approval", "awaiting_input", "running"].includes(step.status))
    .slice(0, CURRENT_PLAN_PENDING_LIMIT)
    .forEach(({ id }) => ids.add(id));
  for (const step of [...steps].reverse()) {
    if (ids.size >= limit) break;
    ids.add(step.id);
  }
  return steps.filter(({ id }) => ids.has(id)).slice(-limit);
}

function compactStep(step: PlanStep, detail: "current" | "recent", project: ReturnType<typeof decisionOutputProjector>) {
  const exceptional = isExceptional(step);
  const needsCommand = exceptional
    || ["pending", "awaiting_approval", "awaiting_input", "running"].includes(step.status);
  const base = {
    stepId: step.id,
    title: compactReviewText(step.title, 180),
    action: compactReviewText(step.description, detail === "current" ? 300 : 220),
    expected: compactReviewText(step.expected, 300),
    risk: step.risk,
    status: step.status,
    command: needsCommand
      ? compactReviewText(redactCommandSecrets(step.command), detail === "current" ? 900 : 560)
      : undefined,
    commandFingerprint: textFingerprint(step.command),
    result: compactReviewResult(step.result, exceptional ? 1_500 : 800),
    output: typeof step.result?.facts.toolId === "string" && detail === "current"
      ? { ...reviewOutputMetadata(step.output), contentRef: "currentToolResults", stepId: step.id }
      : project(step.output, step.evidence, detail === "current" ? 2_048 : 1_024),
    targetContext: step.attemptContext,
    executionScope: step.executionScope,
    validationScope: step.validationScope,
    evidence: compactReviewEvidence(step.evidence, {
      maxItems: detail === "current" ? 3 : 2,
      rawOutputLimit: 0,
      factsLimit: detail === "current" ? 600 : 420,
    }),
  };
  return base;
}

function currentIncident(step: PlanStep | undefined) {
  if (!step) return undefined;
  return {
    ...compactReviewPlanStep(step, { commandLimit: 1_000, validationLimit: 700 }),
    command: compactReviewText(redactCommandSecrets(step.command), 1_000),
    validation: compactReviewText(redactCommandSecrets(step.validation), 700),
    stepId: step.id,
    result: compactReviewResult(step.result, 2_000),
    review: step.review ? {
      decision: step.review.decision,
      reason: compactReviewText(step.review.reason, 480),
      summary: compactReviewText(step.review.summary, 480),
      source: step.review.source,
    } : undefined,
    output: compactReviewOutput(step.output, 2_200, 900),
    evidence: compactReviewEvidence(step.evidence, {
      maxItems: 4,
      mainOutputLimit: 0,
      validationOutputLimit: 900,
      factsLimit: 700,
    }),
    executionScope: step.executionScope,
    validationScope: step.validationScope,
  };
}

function phaseSnapshot(phase: TaskExecutionPhase, project: ReturnType<typeof decisionOutputProjector>) {
  const selected = selectBoundedSteps(phase.plan, RECENT_PHASE_STEP_LIMIT);
  return {
    phaseId: phase.id,
    reason: phase.reason,
    summary: phase.summary ? compactReviewText(phase.summary, 480) : undefined,
    requirement: compactReviewText(phase.requirement, 480),
    planSummary: {
      ...reviewPlanSummary(phase.plan),
      includedSteps: selected.length,
      omittedSteps: Math.max(0, phase.plan.length - selected.length),
    },
    steps: selected.map((step) => compactStep(step, "recent", project)),
    completedAt: phase.completedAt,
  };
}

export function buildTaskDecisionSnapshot(task: OpsTask, failedStep?: PlanStep, allowArchive = false) {
  const checkpoint = task.historyCheckpoint ?? initializeTaskHistoryCheckpoint(task);
  const incidentStep = failedStep ?? [...task.plan].reverse().find(isExceptional);
  const selectedCurrentPlan = selectBoundedSteps(task.plan, CURRENT_PLAN_STEP_LIMIT);
  const selectedCurrentSteps = selectedCurrentPlan
    .filter(({ id }) => id !== incidentStep?.id);
  const project = decisionOutputProjector(allowArchive);
  // Spend the shared output budget on current evidence before older summaries.
  const currentSteps = [...selectedCurrentSteps].reverse().map((step) => compactStep(step, "current", project)).reverse();
  const currentToolResults = currentEvidenceSteps(task, true)
    .filter((step) => typeof step.result?.facts.toolId === "string" && step.output)
    .slice(-12).map((step) => ({
      stepId: step.id, evidenceIds: step.result?.evidenceIds, toolId: step.result?.facts.toolId,
      truncated: step.result?.facts.truncated, targetContext: step.attemptContext,
      content: project(step.output, step.evidence),
    }));
  const recentPhases = (task.phaseHistory ?? [])
    .filter((phase) => phase.roundId === task.currentRoundId)
    .slice(-TASK_DECISION_RECENT_PHASE_LIMIT)
    .map(phase => phaseSnapshot(phase, project));
  const rootGoal = taskGoal(task);
  const progression = workflowProgress(task);
  // Re-read the locally retained ledger before asking the server again. This
  // uses a separate bounded window, never a model-authored success summary.
  const recoveryProject = decisionOutputProjector(allowArchive, 12_000);
  const recoveredEvidence = progression.rereadEvidence
    ? [...(task.phaseHistory ?? []).filter(phase => phase.roundId === task.currentRoundId).flatMap(phase => phase.plan), ...task.plan]
      .filter(step => step.result && step.output).slice(-3).reverse().map(step => ({
        stepId: step.id, targetContext: step.attemptContext,
        output: recoveryProject(step.output, step.evidence, 6_000),
      })) : undefined;
  const recentDetailedSteps = recentPhases.reduce((total, phase) => total + phase.planSummary.totalSteps, 0);
  const currentProgress = reviewPlanSummary(task.plan);
  const statusCounts = { ...(checkpoint?.statusCounts ?? {}) };
  for (const phase of recentPhases) {
    for (const [status, count] of Object.entries(phase.planSummary.statusCounts)) {
      statusCounts[status] = (statusCounts[status] ?? 0) + count;
    }
  }
  for (const [status, count] of Object.entries(currentProgress.statusCounts)) {
    statusCounts[status] = (statusCounts[status] ?? 0) + count;
  }
  const progress = {
    totalSteps: (checkpoint?.sourceStepCount ?? 0) + recentDetailedSteps + task.plan.length,
    statusCounts,
  };
  const body = {
    version: 1,
    task: {
      title: compactReviewText(task.title, 180),
      status: task.status,
      permission: task.permission,
      currentInstruction: task.currentInstruction?.trim()
        && task.currentInstruction.trim() !== rootGoal.trim()
        ? compactReviewText(task.currentInstruction, 1_000)
        : undefined,
      relation: task.lastRequirementRelation,
    },
    executionConstraints: task.executionConstraints,
    workflowProgress: progression,
    recoveredEvidence,
    progress: {
      ...progress,
      totalRounds: task.planHistory?.length ?? 0,
      archivedPhases: task.phaseHistory?.length ?? 0,
      adjustmentCount: task.adjustmentCount ?? 0,
    },
    currentIncident: currentIncident(incidentStep),
    currentPlan: {
      ...reviewPlanSummary(task.plan),
      includedSteps: selectedCurrentPlan.length,
      incidentIncludedSeparately: Boolean(incidentStep && selectedCurrentPlan.some(({ id }) => id === incidentStep.id)),
      omittedSteps: Math.max(0, task.plan.length - selectedCurrentPlan.length),
      steps: currentSteps,
    },
    recentPhases,
    // Compact step records above carry references, not file contents. Keep the
    // current tool results once so the next decision can actually inspect them.
    currentToolResults,
    historyCheckpoint: checkpoint ? {
      ...checkpoint,
      verifiedFacts: checkpoint.verifiedFacts.slice(-12).map(fact => {
        const original = [...(task.planHistory ?? []).flatMap(round => round.plan),
          ...(task.phaseHistory ?? []).flatMap(phase => phase.plan), ...task.plan]
          .find(step => step.id === fact.stepId);
        return { ...fact, targetContext: original?.attemptContext ?? fact.targetContext,
          output: original ? project(original.output, original.evidence, 800) : fact.output };
      }),
      unresolvedIssues: checkpoint.unresolvedIssues,
      phaseSummaries: checkpoint.phaseSummaries.slice(-4),
    } : undefined,
    omittedHistory: checkpoint ? {
      compactedRounds: checkpoint.sourceRoundCount,
      compactedPhases: checkpoint.sourcePhaseCount,
      compactedSteps: checkpoint.sourceStepCount,
      fingerprint: checkpoint.sourceHistoryFingerprint,
    } : undefined,
    instruction: `recentPhases 是最近两个执行阶段；historyCheckpoint 是更早历史，必须核对目标与时效。只有 result/evidence 支持的内容属于已验证事实，计划描述和阶段总结不等于执行成功。${DECISION_EVIDENCE_INSTRUCTION}`,
  };
  return {
    ...body,
    _log: modelLogContext(task, failedStep),
    snapshotFingerprint: textFingerprint(JSON.stringify(body)),
  };
}

export type TaskDecisionSnapshot = ReturnType<typeof buildTaskDecisionSnapshot>;
