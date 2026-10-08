import type { ExecutionEvidence, NextStageDecision, OpsTask, PlanStep, TaskHistoryIssue } from "@/types";
import { applyTaskRequirementReview } from "./taskRequirements";
import { executionDigest, executionIntentMatches } from "./planPreparation";
import { textFingerprint } from "./longRunningReviewOutput";
import { isRemoteToolObservation, scopedToolEvidence, toolExecutionScope } from "./toolEvidenceScope";
import { commandExecutionScope } from "./commandEvidenceScope";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { isMutatingStepCommand } from "@/services/validation";

export interface TaskIssueResolution {
  taskId: string;
  issueId: string;
  stepId: string;
  targetContext?: string;
  evidenceIds: string[];
  reason: string;
  roundId: string;
  requirementRevision: number;
  recordedAt: string;
  issueFingerprint: string;
  evidenceBindings: Array<{ evidenceId: string; stepId: string; attemptContext: string;
    intentDigest?: string; fingerprint: string }>;
}

export class TaskDecisionError extends Error {}
/** Local receipt defects cannot be repaired by regenerating a model response. */
export class TaskEvidenceError extends Error {}
function fail(message: string): never { throw new TaskDecisionError(message); }

/** Keep receipt identity; step IDs alone can be reused by old archived tasks. */
export function decisionEvidenceSteps(task: OpsTask): PlanStep[] {
  return [...(task.planHistory ?? []).flatMap(round => [...(round.phases ?? []).flatMap(phase => phase.plan), ...round.plan]),
    ...(task.phaseHistory ?? []).flatMap(phase => phase.plan), ...task.plan];
}

function attemptTarget(step: PlanStep): string | undefined {
  try {
    const context: unknown = JSON.parse(step.attemptContext ?? "null");
    return Array.isArray(context) && context.length === 5 && typeof context[0] === "string" && context[0]
      ? context[0] : undefined;
  } catch { return undefined; }
}

function evidenceFingerprint(step: PlanStep, evidence: ExecutionEvidence) {
  return executionDigest({ stepId: step.id, attemptContext: step.attemptContext,
    intentDigest: step.executionIntent?.digest, startedAt: step.startedAt,
    attempts: step.executionLedgerAttempts, id: evidence.id, type: evidence.type, source: evidence.source,
    scope: evidence.scope, facts: evidence.facts, collectedAt: evidence.collectedAt,
    // Durable archive identity survives bounded display-output compaction.
    content: evidence.archive ?? evidence.rawOutput });
}

function issueFingerprint(taskId: string, issue: TaskHistoryIssue) {
  const contract = issue.recoveryContract?.step;
  return executionDigest({ taskId, issueId: issue.issueId, stepId: issue.stepId, commandFingerprint: issue.commandFingerprint,
    attemptContext: issue.attemptContext, evidenceIds: issue.evidenceIds, countedAttemptKeys: issue.countedAttemptKeys,
    contract: contract ? { action: contract.action, command: contract.command, expected: contract.expected,
      validation: contract.validation, executionScope: contract.executionScope, validationScope: contract.validationScope } : undefined });
}

function endpoint(step: PlanStep, target: string) {
  const targets = step.executionIntent?.semantic.targets.filter(item => item.role !== "interaction" && item.serverId === target);
  const endpoints = new Set(targets?.map(item => JSON.stringify([item.host.toLowerCase(), item.port, item.username])));
  return endpoints.size === 1 ? [...endpoints][0] : undefined;
}

/** Facts with conflicting IDs, absent target identity or rejected dispatch cannot certify a requirement. */
function evidenceCatalog(task: OpsTask) {
  const target = task.executionTargetServerId ?? task.serverId;
  const steps = decisionEvidenceSteps(task);
  const catalog = steps.flatMap(step => (step.evidence ?? []).map(evidence => scopedToolEvidence(task.id, step, evidence)).filter(evidence =>
    step.result?.evidenceIds.includes(evidence.id)
    && evidence.scope?.targetId === target
    && attemptTarget(step) === target
    && (!step.executionIntent || executionIntentMatches(step.executionIntent, step.executionIntent)
      && step.executionIntent.semantic.taskId === task.id
      && step.executionIntent.semantic.stepId === step.id
      && step.executionIntent.semantic.targets.some(item => item.serverId === target && item.role !== "interaction"))
    && Number.isFinite(Date.parse(evidence.collectedAt))
    && (!step.startedAt || Date.parse(evidence.collectedAt) >= Date.parse(step.startedAt))
    && !["cancelled", "blocked"].includes(step.result.executionStatus)
    && step.result.facts.commandDispatched !== false
    && !(evidence.source === "validation" && step.result.facts.validationPassed === false))
    .map(evidence => ({ step, evidence })));
  const identities = new Map<string, Set<string>>();
  for (const item of catalog) {
    const set = identities.get(item.evidence.id) ?? new Set<string>();
    set.add(evidenceFingerprint(item.step, item.evidence)); identities.set(item.evidence.id, set);
  }
  return catalog.filter(item => identities.get(item.evidence.id)?.size === 1);
}

/** Only explicit resource identities establish invalidation; unrelated changes
 * on the same server do not discard a completed deployment or other goal. */
function resourcePaths(step: PlanStep): string[] {
  const action = step.executionIntent?.semantic.action ?? step.action;
  const values: unknown[] = step.executionIntent?.semantic.targets.map(item => item.path) ?? [];
  if (action?.type === "tool") {
    for (const key of ["path", "rootPath", "sourcePath", "targetPath", "directory", "workingDirectory"]) values.push(action.arguments[key]);
  }
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.startsWith("/")
    && !value.split("/").includes("..") && !/[\r\n\0]/.test(value)).map(value => value.replace(/\/+$/, "") || "/"))];
}

function pathsOverlap(left: string, right: string) {
  return left === right || left === "/" || right === "/" || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function currentEvidenceCatalog(task: OpsTask, catalog: ReturnType<typeof evidenceCatalog>) {
  const target = task.executionTargetServerId ?? task.serverId;
  const steps = decisionEvidenceSteps(task);
  const latestEndpoint = [...steps].reverse().map(step => endpoint(step, target)).find(Boolean);
  return catalog.filter(item => {
    const originalEndpoint = endpoint(item.step, target);
    if (originalEndpoint && latestEndpoint && originalEndpoint !== latestEndpoint) return false;
    const paths = resourcePaths(item.step);
    return !steps.some(step => step !== item.step && attemptTarget(step) === target
      && (step.executionIntent?.semantic.effect === "change" || step.kind === "change")
      && ["completed", "failed"].includes(step.status) && step.result
      && step.result.executionStatus !== "blocked" && step.result.facts.commandDispatched !== false
      && (step.evidence ?? []).some(evidence => Date.parse(evidence.collectedAt) > Date.parse(item.evidence.collectedAt))
      && resourcePaths(step).some(path => paths.some(original => pathsOverlap(original, path))));
  });
}

/** The prompt and admission gate share one set of admissible receipt identities. */
export function taskDecisionEvidenceIds(task: OpsTask): string[] {
  return taskDecisionEvidenceIndex(task).availableIds;
}

function acceptsCompletion(item: { step: PlanStep; evidence: ExecutionEvidence }) {
  return item.step.result?.executionStatus === "success" && item.step.status !== "failed"
    && item.step.result.facts.validationPassed !== false
    && !(item.step.result.facts.semanticAcceptanceRequired === true && item.step.result.facts.semanticAcceptanceStatus !== "proven");
}

function untrustedDiagnosticCatalog(task: OpsTask) {
  const target = task.executionTargetServerId ?? task.serverId;
  const candidates = decisionEvidenceSteps(task).flatMap(step => {
    const identity = step.action?.type === "tool" ? toolExecutionScope(step, step.action.toolId, task.id)
      : commandExecutionScope(step, task.id);
    if (identity?.targetId !== target || step.result?.executionStatus !== "failed"
      || step.result.facts.commandDispatched === false || !Number.isFinite(Date.parse(step.startedAt ?? ""))) return [];
    return (step.evidence ?? []).filter(evidence => !evidence.scope && evidence.source === "main"
      && step.result!.evidenceIds.includes(evidence.id) && Date.parse(evidence.collectedAt) >= Date.parse(step.startedAt!))
      .map(evidence => ({ step, evidence }));
  });
  const identities = new Map<string, Set<string>>();
  for (const item of candidates) {
    const set = identities.get(item.evidence.id) ?? new Set<string>();
    set.add(evidenceFingerprint(item.step, item.evidence)); identities.set(item.evidence.id, set);
  }
  return currentEvidenceCatalog(task, candidates).filter(item => identities.get(item.evidence.id)?.size === 1);
}

export function taskDecisionEvidenceIndex(task: OpsTask) {
  const current = currentEvidenceCatalog(task, evidenceCatalog(task));
  return {
    availableIds: [...new Set(current.filter(acceptsCompletion).map(item => item.evidence.id))],
    diagnosticIds: [...new Set(current.map(item => item.evidence.id))],
    untrustedDiagnosticIds: [...new Set(untrustedDiagnosticCatalog(task).map(item => item.evidence.id))],
  };
}

/** Proposal classification only: execution still requires ordinary admission,
 * target checks and approval. Diagnostic references never grant retry authority. */
function onlyDiagnosticReads(decision: NextStageDecision) {
  return decision.decision !== "complete" && decision.steps.length > 0 && decision.steps.every(step => {
    if (step.retryBasis || step.retryAfterStepId || step.recovery || step.protocolReplanApproval) return false;
    const semantic = step.executionIntent?.semantic;
    if (step.sessionContextChange || semantic?.sessionContextChange || semantic?.effect === "change"
      || [step.executionScope, step.validationScope, semantic?.executionScope, semantic?.validationScope].includes("user_action")) return false;
    const action = step.action;
    const commands = [step.command, action?.type === "shell" ? action.command : "", step.validation, step.validator?.command,
      semantic?.action.type === "shell" ? semantic.action.command : "", semantic?.validation, semantic?.validator?.command];
    if (commands.some(command => typeof command === "string" && isMutatingStepCommand(command))) return false;
    if (action?.type === "tool") return defaultToolCatalog.find(tool => tool.id === action.toolId)?.effect === "read";
    return step.kind === "observe" && step.risk === "low";
  });
}

function failedIssueStep(task: OpsTask, issue: TaskHistoryIssue) {
  const matches = (step: PlanStep) => step.id === issue.stepId && step.attemptContext === issue.attemptContext
    && textFingerprint(step.command) === issue.commandFingerprint;
  return decisionEvidenceSteps(task).find(matches)
    ?? (issue.recoveryContract?.step && matches(issue.recoveryContract.step) ? issue.recoveryContract.step : undefined);
}

function supportsIssueResolution(task: OpsTask, issue: TaskHistoryIssue, ids: string[], catalog = evidenceCatalog(task)) {
  const failed = failedIssueStep(task, issue);
  const oldTimes = (failed?.evidence ?? []).map(item => Date.parse(item.collectedAt)).filter(Number.isFinite);
  if (!failed || !oldTimes.length || !ids.length || new Set(ids).size !== ids.length) return false;
  const paths = resourcePaths(failed);
  const target = task.executionTargetServerId ?? task.serverId;
  return ids.every(id => catalog.some(item => item.evidence.id === id && item.step.id !== issue.stepId
    && acceptsCompletion(item)
    && ((item.step.executionIntent ? item.step.executionIntent.semantic.effect === "read" : item.step.kind === "observe")
      || item.evidence.source === "validation")
    && (failed.validationScope !== "agent_session" || item.evidence.scope?.scope === "agent_session"
      && item.evidence.scope.sessionId === failed.evidence?.find(original => original.source === "validation")?.scope?.sessionId)
    && (!endpoint(failed, target) || !endpoint(item.step, target)
      || endpoint(failed, target) === endpoint(item.step, target))
    && (!paths.length || !resourcePaths(item.step).length
      || resourcePaths(item.step).some(path => paths.some(original => pathsOverlap(original, path))))
    && Date.parse(item.evidence.collectedAt) > Math.max(...oldTimes)));
}

/** A historical resolution does not rewrite the failed attempt or certify today's remote state. */
export function resolvedTaskIssue(task: OpsTask, issue: { issueId?: string; stepId: string; attemptContext?: string }) {
  const original = task.historyCheckpoint?.unresolvedIssues.find(candidate => candidate.issueId === issue.issueId
    && candidate.stepId === issue.stepId && candidate.attemptContext === issue.attemptContext);
  if (!original || !original.issueId) return undefined;
  const catalog = evidenceCatalog(task);
  return task.issueResolutions?.find(resolution => resolution.taskId === task.id && resolution.issueId === issue.issueId
    && resolution.stepId === issue.stepId && resolution.targetContext === issue.attemptContext
    && typeof resolution.reason === "string" && resolution.reason.trim()
    && Array.isArray(resolution.evidenceIds) && resolution.issueFingerprint === issueFingerprint(task.id, original)
    && Array.isArray(resolution.evidenceBindings) && resolution.evidenceBindings.length === resolution.evidenceIds.length
    && supportsIssueResolution(task, original, resolution.evidenceIds, catalog)
    && resolution.evidenceIds.every(id => resolution.evidenceBindings.some(binding => binding.evidenceId === id
      && catalog.some(item => item.evidence.id === id && item.step.id === binding.stepId
        && item.step.attemptContext === binding.attemptContext && item.step.executionIntent?.digest === binding.intentDigest
        && evidenceFingerprint(item.step, item.evidence) === binding.fingerprint))));
}

export function stepHasResolvedIssue(task: OpsTask, step: PlanStep) {
  return (task.historyCheckpoint?.unresolvedIssues ?? []).some(issue => issue.stepId === step.id
    && issue.attemptContext === step.attemptContext && resolvedTaskIssue(task, issue));
}

/** Validate first; caller commits all projections only after the entire proposal is accepted. */
export function prepareTaskDecision(task: OpsTask, decision: NextStageDecision) {
  const evidence = evidenceCatalog(task);
  const currentEvidence = currentEvidenceCatalog(task, evidence);
  const acceptanceEvidence = currentEvidence.filter(acceptsCompletion);
  const untrustedIds = untrustedDiagnosticCatalog(task).map(item => item.evidence.id);
  const referencedIds = new Set([
    ...(decision.requirementReview?.items.filter(item => item.outcome === "satisfied").flatMap(item => item.evidenceIds) ?? []),
    ...(decision.issueResolutions?.flatMap(item => item.evidenceIds) ?? []),
  ]);
  for (const step of decisionEvidenceSteps(task)) {
    for (const receipt of step.evidence ?? []) {
      if (referencedIds.has(receipt.id) && step.result?.evidenceIds.includes(receipt.id)
        && (step.action?.type !== "tool" || isRemoteToolObservation(step.action.toolId))
        && !scopedToolEvidence(task.id, step, receipt).scope) {
        throw new TaskEvidenceError(`执行证据 ${receipt.id} 缺少可核对的目标归属，无法用于验收；请补充同目标只读检查。重新生成格式不能修复本地执行记录。`);
      }
    }
  }
  let requirementLifecycle = task.requirementLifecycle;
  if (decision.requirementReview) {
    if (decision.requirementReview.items.some(item => item.evidenceIds.some(id => untrustedIds.includes(id)))
      && !onlyDiagnosticReads(decision)) fail("未核实的失败记录仅可用于 unknown 和同目标只读诊断，不能据此重试、变更或解除执行阻断。");
    for (const assessment of decision.requirementReview.items) {
      if (assessment.outcome !== "satisfied") continue;
      const requirement = task.requirementLifecycle?.items.find(item => item.id === assessment.requirementId);
      const boundary = Date.parse(requirement?.lastChangedAt ?? requirement?.source.createdAt
        ?? task.messages.find(message => message.id === requirement?.source.sourceMessageId)?.createdAt ?? "");
      if (Number.isFinite(boundary) && assessment.evidenceIds.some(id => !acceptanceEvidence.some(item => item.evidence.id === id
        && Date.parse(item.evidence.collectedAt) >= boundary))) {
        fail("需求完成必须引用该要求提出或重新激活后、仍适用于当前资源的真实证据；历史成功仅作参考。");
      }
    }
    try {
      requirementLifecycle = applyTaskRequirementReview(task, decision.requirementReview,
        { evidenceIds: acceptanceEvidence.map(item => item.evidence.id),
          diagnosticEvidenceIds: currentEvidence.map(item => item.evidence.id), unknownOnlyEvidenceIds: untrustedIds,
          roundId: task.currentRoundId });
    } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    if (decision.requirementReview.focusOutcome === "completed") {
      for (const id of requirementLifecycle.focus.requirementIds) {
        const requirement = requirementLifecycle.items.find(item => item.id === id)!;
        const boundary = Date.parse(requirement.lastChangedAt ?? requirement.source.createdAt
          ?? task.messages.find(message => message.id === requirement.source.sourceMessageId)?.createdAt ?? "");
        if (Number.isFinite(boundary) && requirement.evidenceIds.some(evidenceId => !acceptanceEvidence.some(item => item.evidence.id === evidenceId
          && Date.parse(item.evidence.collectedAt) >= boundary))) fail("本轮需求发生变化后必须重新验收，不能沿用修改前的完成标记。");
      }
    }
    if (decision.decision === "complete" && decision.requirementReview.overallOutcome !== "completed") {
      fail("整体目标仍未完成，不能使用 complete；本轮完成请使用 decision=adjust、steps=[] 交付本轮结果，并保留 overallOutcome=pending 和其他未完成要求。");
    }
  } else if ((task.requirementLifecycle?.revision ?? 0) > 0) {
    fail("当前采用需求版本协议，阶段决策缺少 requirementReview，不能丢失本轮与整体的验收范围。");
  }
  const focusComplete = decision.requirementReview?.focusOutcome === "completed";
  const hasQuestion = decision.steps.some(step => step.action?.type === "tool" && step.action.toolId === "user.request_input");
  const waitingQuestion = task.plan.some(step => step.status === "awaiting_input"
    && step.action?.type === "tool" && step.action.toolId === "user.request_input");
  if (decision.blocking) {
    if (!["external", "user_input"].includes(decision.blocking.kind) || !decision.blocking.reason?.trim()
      || !Array.isArray(decision.blocking.requirementIds)
      || decision.blocking.requirementIds.some(id => !requirementLifecycle?.items.some(item => item.id === id
        && ["active", "deferred"].includes(item.status)))) fail("阻断必须说明真实原因并引用当前有效要求。");
    if (decision.blocking.kind === "user_input" && !hasQuestion && !waitingQuestion) {
      fail("等待用户必须提供唯一 user.request_input 步骤或引用现有待答问题；不能只在摘要中声明等待。");
    }
  }
  if (decision.decision === "adjust" && !decision.steps.length && !focusComplete && !decision.blocking) {
    fail("空调整计划必须提供具体 blocking；若本轮已完成，应提供 requirementReview 并交付结果。");
  }
  if (focusComplete && decision.requirementReview?.overallOutcome === "pending" && decision.steps.length) {
    fail("本轮已完成时先交付结果，不自动启动其他未完成目标；若仍有本轮必要工作，请修正 focusOutcome。");
  }
  const issueResolutions = [...(task.issueResolutions ?? [])];
  const seen = new Set<string>();
  for (const resolution of decision.issueResolutions ?? []) {
    const issue = task.historyCheckpoint?.unresolvedIssues.find(item => item.issueId === resolution.issueId);
    if (!issue || seen.has(resolution.issueId) || !resolution.reason?.trim()
      || !Array.isArray(resolution.evidenceIds) || !resolution.evidenceIds.length
      || new Set(resolution.evidenceIds).size !== resolution.evidenceIds.length) fail("历史问题处理缺少真实问题、唯一证据或处理依据。");
    seen.add(resolution.issueId);
    if (!supportsIssueResolution(task, issue, resolution.evidenceIds, acceptanceEvidence)) {
      fail("解决历史问题必须引用同目标和资源、晚于原失败的真实只读验收证据；原记录缺失时先补读证据。");
    }
    issueResolutions.push({ ...resolution, taskId: task.id, stepId: issue.stepId, targetContext: issue.attemptContext,
      roundId: task.currentRoundId ?? "", requirementRevision: requirementLifecycle?.revision ?? 0,
      recordedAt: new Date().toISOString(), issueFingerprint: issueFingerprint(task.id, issue), evidenceBindings: resolution.evidenceIds.map(id => {
        const item = evidence.find(candidate => candidate.evidence.id === id)!;
        return { evidenceId: id, stepId: item.step.id, attemptContext: item.step.attemptContext!,
          intentDigest: item.step.executionIntent?.digest, fingerprint: evidenceFingerprint(item.step, item.evidence) };
      }) });
  }
  return { requirementLifecycle, issueResolutions, currentRequestReview: decision.requirementReview ? {
    roundId: task.currentRoundId!, requirementRevision: requirementLifecycle!.revision,
    summary: decision.summary, completed: Boolean(focusComplete),
    remainingRequirementIds: requirementLifecycle!.items.filter(item => item.kind === "goal"
      && ["active", "deferred"].includes(item.status)).map(item => item.id),
  } : undefined };
}

export function currentRequestCompleted(task: OpsTask) {
  const review = task.currentRequestReview;
  return review?.completed === true && review.roundId === task.currentRoundId
    && review.requirementRevision === task.requirementLifecycle?.revision;
}
