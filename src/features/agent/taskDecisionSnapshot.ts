import { compactReviewText, textFingerprint } from "@/features/agent/longRunningReviewOutput";
import {
  compactReviewEvidence,
  compactReviewPlanStep,
  compactReviewResult,
  reviewPlanSummary,
} from "@/features/agent/reviewPayload";
import {
  initializeTaskHistoryCheckpoint,
  isExceptionalTaskStep,
  isUserInputEvidenceStep,
  taskStepEvidenceKey,
  TASK_DECISION_RECENT_PHASE_LIMIT,
} from "@/features/agent/taskHistoryCheckpoint";
import { taskGoal } from "@/features/agent/taskGoal";
import { modelLogContext } from "./modelLogContext";
import { currentEvidenceSteps } from "@/features/agent/attemptState";
import { decisionOutput, decisionOutputProjector, DECISION_EVIDENCE_INSTRUCTION } from "./decisionEvidence";
import { workflowProgress } from "./workflowProgress";
import { bindRecoveryCarryForwards, hasVerifiedRecovery } from "./recoveryContract";
import type { OpsTask, PlanStep, TaskExecutionPhase } from "@/types";

const CURRENT_PLAN_STEP_LIMIT = 20;
const CURRENT_PLAN_LEADING_LIMIT = 3;
const CURRENT_PLAN_EXCEPTION_LIMIT = 8;
const CURRENT_PLAN_PENDING_LIMIT = 6;
const RECENT_PHASE_STEP_LIMIT = 12;
const UNRESOLVED_DETAIL_LIMIT = 16;

type DecisionProjection = ReturnType<ReturnType<typeof decisionOutputProjector>>;
type ReferencedProjection = (NonNullable<DecisionProjection> & { contentRef?: string }) | undefined;
type StepOutputProjector = (step: PlanStep, limit: number, location: string) => ReferencedProjection;

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

function selectBoundedSteps(steps: PlanStep[], limit: number) {
  if (steps.length <= limit) return steps;
  const ids = new Set(steps.slice(0, CURRENT_PLAN_LEADING_LIMIT).map(({ id }) => id));
  steps.filter(isExceptionalTaskStep).slice(-CURRENT_PLAN_EXCEPTION_LIMIT).forEach(({ id }) => ids.add(id));
  steps.filter((step) => ["pending", "awaiting_approval", "awaiting_input", "running"].includes(step.status))
    .slice(0, CURRENT_PLAN_PENDING_LIMIT)
    .forEach(({ id }) => ids.add(id));
  for (const step of [...steps].reverse()) {
    if (ids.size >= limit) break;
    ids.add(step.id);
  }
  return steps.filter(({ id }) => ids.has(id)).slice(-limit);
}

function compactStep(
  step: PlanStep,
  detail: "current" | "recent",
  project: StepOutputProjector,
  location: string,
) {
  const exceptional = isExceptionalTaskStep(step);
  const needsCommand = exceptional
    || ["pending", "awaiting_approval", "awaiting_input", "running"].includes(step.status);
  const userInput = isUserInputEvidenceStep(step);
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
    result: compactReviewResult(userInput && step.result
      ? { ...step.result, facts: { toolId: "user.request_input" } } : step.result, exceptional ? 1_500 : 800),
    output: project(step, detail === "current" ? 2_048 : 1_024, location),
    targetContext: step.attemptContext,
    executionScope: step.executionScope,
    validationScope: step.validationScope,
    evidence: compactReviewEvidence(userInput ? undefined : step.evidence, {
      maxItems: detail === "current" ? 3 : 2,
      rawOutputLimit: 0,
      factsLimit: detail === "current" ? 600 : 420,
    }),
  };
  return base;
}

function currentIncident(step: PlanStep | undefined, project: StepOutputProjector) {
  if (!step) return undefined;
  return {
    ...compactReviewPlanStep(step, { commandLimit: 1_000, validationLimit: 700 }),
    command: compactReviewText(redactCommandSecrets(step.command), 1_000),
    validation: compactReviewText(redactCommandSecrets(step.validation), 700),
    stepId: step.id,
    result: compactReviewResult(isUserInputEvidenceStep(step) && step.result
      ? { ...step.result, facts: { toolId: "user.request_input" } } : step.result, 2_000),
    review: step.review ? {
      decision: step.review.decision,
      reason: compactReviewText(step.review.reason, 480),
      summary: compactReviewText(step.review.summary, 480),
      source: step.review.source,
    } : undefined,
    output: project(step, 3_100, "currentIncident.output"),
    validationEvidence: isUserInputEvidenceStep(step) ? undefined : step.evidence
      ?.filter(item => item.source === "validation" && item.rawOutput).slice(-2)
      .map((item, index) => ({
        sourceEvidenceId: item.id,
        output: project(item.rawOutput === step.output ? step : {
          ...step, command: step.validation, output: item.rawOutput, evidence: [item],
          result: step.result ? { ...step.result, evidenceIds: [item.id] } : undefined,
        }, 900, `currentIncident.validationEvidence[${index}].output`),
      })),
    evidence: compactReviewEvidence(isUserInputEvidenceStep(step) ? undefined : step.evidence, {
      maxItems: 4,
      mainOutputLimit: 0,
      validationOutputLimit: 0,
      factsLimit: 700,
    }),
    executionScope: step.executionScope,
    validationScope: step.validationScope,
  };
}

function phaseSnapshot(
  phase: TaskExecutionPhase,
  project: StepOutputProjector,
  phaseIndex: number,
) {
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
    steps: selected.map((step, index) => compactStep(step, "recent", project, `recentPhases[${phaseIndex}].steps[${index}].output`)),
    completedAt: phase.completedAt,
  };
}

function selectRecoverySteps(task: OpsTask) {
  const ledger = [
    ...(task.phaseHistory ?? [])
      .filter((phase) => phase.roundId === task.currentRoundId)
      .flatMap((phase) => phase.plan),
    ...task.plan,
  ];
  const selected: PlanStep[] = [];
  const seen = new Set<string>();
  for (const step of ledger.reverse()) {
    const key = taskStepEvidenceKey(step);
    if (!step.result || !step.output || seen.has(key)) continue;
    seen.add(key);
    selected.push(step);
    if (selected.length === 3) break;
  }
  return selected;
}

export function buildTaskDecisionSnapshot(task: OpsTask, failedStep?: PlanStep, allowArchive = false) {
  const checkpoint = initializeTaskHistoryCheckpoint(task);
  const incidentStep = failedStep ?? [...task.plan].reverse().find(isExceptionalTaskStep);
  const selectedCurrentPlan = selectBoundedSteps(task.plan, CURRENT_PLAN_STEP_LIMIT);
  const selectedCurrentSteps = selectedCurrentPlan
    .filter(step => !incidentStep || taskStepEvidenceKey(step) !== taskStepEvidenceKey(incidentStep));
  const rootGoal = taskGoal(task);
  const progression = workflowProgress(task);
  const allLedgerSteps = [
    ...(task.planHistory ?? []).flatMap(round => [
      ...(round.phases ?? []).flatMap(phase => phase.plan), ...round.plan, ...(round.finalPlan ?? []),
    ]),
    ...(task.phaseHistory ?? []).flatMap(phase => phase.plan), ...task.plan,
  ];
  const bestOutputSource = new Map<string, PlanStep>();
  for (const step of allLedgerSteps) {
    const key = taskStepEvidenceKey(step);
    const previous = bestOutputSource.get(key);
    if (!previous || (step.output?.length ?? 0) > (previous.output?.length ?? 0)
      || ((step.output?.length ?? 0) === (previous.output?.length ?? 0)
        && step.evidence?.some(item => item.archive))) bestOutputSource.set(key, step);
  }

  const recoverySteps = progression.rereadEvidence ? selectRecoverySteps(task) : [];
  const recoveryKeys = new Set(recoverySteps.map(taskStepEvidenceKey));
  const project = decisionOutputProjector(allowArchive);
  const canonicalOutputRefs = new Map<string, string>();
  const projectStep: StepOutputProjector = (step, limit, location) => {
    if (isUserInputEvidenceStep(step)) {
      return { content: undefined, contentState: "omitted", totalCharacters: 0, omittedCharacters: 0,
        fingerprint: textFingerprint(step.output ?? ""), contentRef: "confirmedUserInputs",
        references: undefined, instruction: "仅使用 confirmedUserInputs 中当前目标/服务器有效的输入；历史表单值不在本区重发。" };
    }
    const key = taskStepEvidenceKey(step);
    const source = bestOutputSource.get(key) ?? step;
    const existing = canonicalOutputRefs.get(key);
    if (existing) {
      const metadata = decisionOutput(source.output, [], 0);
      return metadata ? { ...metadata, contentRef: existing,
        instruction: "同一执行证据正文已在 contentRef 展示；无需再次执行。" } : undefined;
    }
    if (source.output) canonicalOutputRefs.set(key, location);
    return project(source.output, source.evidence, recoveryKeys.has(key) ? 6_000 : limit);
  };
  // Incident, current plan, recent phases and recovered/history outputs all
  // spend the same budget. Repeated executions have references, not more text.
  const incident = currentIncident(incidentStep, projectStep);
  const currentSteps = [...selectedCurrentSteps].reverse()
    .map((step, index) => compactStep(step, "current", projectStep,
      `currentPlan.steps[${selectedCurrentSteps.length - index - 1}].output`))
    .reverse();
  const recentPhases = (task.phaseHistory ?? [])
    .filter((phase) => phase.roundId === task.currentRoundId)
    .slice(-TASK_DECISION_RECENT_PHASE_LIMIT)
    .map((phase, index) => phaseSnapshot(phase, projectStep, index));
  const currentToolResults = currentEvidenceSteps(task, true)
    .filter((step) => typeof step.result?.facts.toolId === "string" && step.output)
    .slice(-12).map((step, index) => ({
      stepId: step.id, evidenceIds: step.result?.evidenceIds, toolId: step.result?.facts.toolId,
      truncated: step.result?.facts.truncated, targetContext: step.attemptContext,
      content: projectStep(step, 2_048, `currentToolResults[${index}].content`),
    }));
  const unrepresentedRecovery = recoverySteps.filter(step => !canonicalOutputRefs.has(taskStepEvidenceKey(step)));
  const recoveredEvidence = unrepresentedRecovery.length
    ? unrepresentedRecovery.map((step, index) => ({
      stepId: step.id,
      targetContext: step.attemptContext,
      output: projectStep(step, 6_000, `recoveredEvidence[${index}].output`),
    }))
    : undefined;
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
  const resolvedByRecentEvidence: {
    issueId?: string; stepId: string; verifiedByStepId: string; targetContext?: string; evidenceRef?: string;
  }[] = [];
  const issues = (checkpoint?.unresolvedIssues ?? []).filter(issue => {
    const sourcePhase = [...(task.planHistory ?? []).flatMap(round => round.phases ?? []),
      ...(task.phaseHistory ?? [])].find(phase => phase.id === issue.sourcePhaseId);
    const matches = (sourcePhase?.plan ?? allLedgerSteps).filter(step => step.id === issue.stepId
      && step.attemptContext === issue.attemptContext && textFingerprint(step.command) === issue.commandFingerprint);
    if (!sourcePhase && new Set(matches.map(taskStepEvidenceKey)).size > 1) return true;
    const failed = matches[0] ?? issue.recoveryContract?.step;
    if (!failed) return true;
    const sourceIndex = allLedgerSteps.findIndex(step => taskStepEvidenceKey(step) === taskStepEvidenceKey(failed));
    const verified = allLedgerSteps.slice(sourceIndex + 1).find(candidate =>
      hasVerifiedRecovery(bindRecoveryCarryForwards(task, failed), candidate, allLedgerSteps));
    if (!verified) return true;
    resolvedByRecentEvidence.push({ issueId: issue.issueId, stepId: issue.stepId,
      verifiedByStepId: verified.id, targetContext: verified.attemptContext,
      evidenceRef: canonicalOutputRefs.get(taskStepEvidenceKey(verified)) });
    return false;
  });
  const relatedIssues = incidentStep ? issues.filter(issue => issue.stepId === incidentStep.id
    && issue.attemptContext === incidentStep.attemptContext
    || Boolean(incidentStep.attemptContext && issue.attemptContext === incidentStep.attemptContext
      && issue.commandFingerprint === textFingerprint(incidentStep.command))) : [];
  const detailSet = new Set(relatedIssues.slice(-UNRESOLVED_DETAIL_LIMIT));
  for (const issue of [...issues].reverse()) {
    if (detailSet.size >= UNRESOLVED_DETAIL_LIMIT) break;
    detailSet.add(issue);
  }
  const expandedIssues = issues.filter(issue => detailSet.has(issue));
  const checkpointProjection = checkpoint ? {
    ...checkpoint,
    // This persisted replay index grows with the audit ledger, but contains no
    // model-relevant information and must not consume the model token budget.
    sourcePhaseFingerprints: undefined,
    verifiedFacts: checkpoint.verifiedFacts.slice(-12).map((fact, index) => {
      const original = allLedgerSteps.find(step => fact.evidenceKey
        ? taskStepEvidenceKey(step) === fact.evidenceKey
        : step.id === fact.stepId && step.attemptContext === fact.targetContext
          && decisionOutput(step.output, [], 0)?.fingerprint === fact.output?.fingerprint);
      const factFields = fact.result?.facts as Record<string, unknown> | undefined;
      if (fact.sourceToolId === "user.request_input" || factFields?.toolId === "user.request_input"
        || (original && isUserInputEvidenceStep(original))) {
        return { ...fact,
          result: fact.result ? { executionStatus: fact.result.executionStatus,
            observationStatus: fact.result.observationStatus, sourceToolId: "user.request_input" } : undefined,
          evidence: undefined,
          output: { contentRef: "confirmedUserInputs", sourceStepId: fact.stepId },
        };
      }
      if (original) return { ...fact,
        targetContext: original.attemptContext ?? fact.targetContext,
        output: projectStep(original, 800, `historyCheckpoint.verifiedFacts[${index}].output`),
      };
      const storedText = typeof fact.output?.content === "string" ? fact.output.content : undefined;
      const bounded = project(storedText, [], 800);
      return { ...fact, output: fact.output ? {
        ...fact.output,
        content: bounded?.content,
        contentState: bounded?.contentState === "complete" ? fact.output.contentState : bounded?.contentState ?? "omitted",
        omittedCharacters: Math.max(0, Number(fact.output.totalCharacters ?? 0) - (bounded?.content?.length ?? 0)),
        instruction: bounded?.instruction ?? fact.output.instruction,
      } : undefined };
    }),
    unresolvedIssues: expandedIssues.map(issue => ({ ...issue, recoveryContract: undefined, countedAttemptKeys: undefined })),
    resolvedByRecentEvidence: resolvedByRecentEvidence.length ? resolvedByRecentEvidence : undefined,
    totalUnresolvedIssues: issues.length,
    omittedUnresolvedDetails: issues.length - expandedIssues.length,
    unresolvedIssueIndexComplete: true,
    unresolvedIssueIndex: issues.map(issue => {
      const detailIndex = expandedIssues.indexOf(issue);
      const sourceAvailable = allLedgerSteps.some(step => step.id === issue.stepId
        && step.attemptContext === issue.attemptContext
        && textFingerprint(step.command) === issue.commandFingerprint);
      return {
        issueId: issue.issueId,
        stepId: issue.stepId,
        targetContext: issue.attemptContext,
        sourceRoundId: issue.sourceRoundId,
        blocksExecution: issue.blocksExecution,
        category: issue.category,
        status: issue.status,
        attemptCount: issue.attemptCount,
        verificationState: issue.verificationState,
        detailsRef: detailIndex >= 0 ? `historyCheckpoint.unresolvedIssues[${detailIndex}]` : undefined,
        ledgerRef: { taskId: task.id, phaseId: issue.sourcePhaseId, stepId: issue.stepId, available: sourceAvailable },
        archiveReferences: issue.archiveReferences?.map(reference => ({
          ...reference, readTool: allowArchive ? "evidence.read" : undefined,
        })),
      };
    }),
    phaseSummaries: checkpoint.phaseSummaries.slice(-4),
  } : undefined;
  const body = {
    version: 1,
    rootGoal,
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
    currentIncident: incident,
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
    historyCheckpoint: checkpointProjection,
    omittedHistory: checkpoint ? {
      compactedRounds: checkpoint.sourceRoundCount,
      compactedPhases: checkpoint.sourcePhaseCount,
      compactedSteps: checkpoint.sourceStepCount,
      fingerprint: checkpoint.sourceHistoryFingerprint,
    } : undefined,
    instruction: `recentPhases 是最近两个执行阶段；historyCheckpoint 是更早历史，必须核对目标与时效。unresolvedIssueIndex 是完整未解决问题索引；unresolvedIssues 只展开相关或最近 16 条详情，正文省略不代表阻断已解决。ledgerRef 指向本地审计记录，只有标有 readTool 的 archiveReferences 可通过工具补读；migration.requiresReview 或 verificationState=needs_review 表示原始证据缺失，不能当作已解决。contentRef 指向同一证据唯一正文。只有 result/evidence 支持的内容属于已验证事实，计划描述和阶段总结不等于执行成功。${progression.rereadEvidence ? "本次补读内容已优先并入同 step 的 output；recoveredEvidence 仅列未在上述区域展示的旧 step。" : ""}${DECISION_EVIDENCE_INSTRUCTION}`,
  };
  return {
    ...body,
    _log: modelLogContext(task, failedStep),
    snapshotFingerprint: textFingerprint(JSON.stringify(body)),
  };
}

export type TaskDecisionSnapshot = ReturnType<typeof buildTaskDecisionSnapshot>;
