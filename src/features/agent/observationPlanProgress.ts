import type { OpsTask, PlanStep, ServerProfile } from "@/types";
import type { ToolDefinition } from "@/features/tools/types";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { prepareFinalToolArguments } from "@/features/tools/toolExecutor";
import { stableProtocolValue } from "@/services/planProtocolRepair";
import { currentEvidenceSteps, taskAttemptContext } from "./attemptState";
import { enforceToolResult } from "@/features/tools/toolResultContract";
import { executionIntentMatches } from "./planPreparation";

export interface ObservationRefreshGrant {
  /** Supplied by Core after an explicit user request or verified invalidation, never model prose. */
  taskId: string;
  roundId?: string;
  targetContext: string;
  actionIdentity: string;
  previousStepId: string;
  reason: string;
  kind: "bounded_poll" | "evidence_invalidated" | "user_refresh";
  notBefore: number;
  deadlineAt: number;
  /** A polling grant authorizes at most one sample per interval. */
  intervalMs?: number;
}

export interface ObservationPlanProgressOptions {
  refreshGrants?: readonly ObservationRefreshGrant[];
  now?: number;
  /** Bound current endpoint for proposals that have not yet received a prepared intent. */
  target?: Pick<ServerProfile, "id" | "host" | "port" | "username">;
  /** Proposal validation cannot assign live connection generations. Every
   * accepted proposal must still pass the default prepared check before approval. */
  admission?: "proposal" | "prepared";
}

export interface RepeatedObservationIssue {
  code: "duplicate_observation_in_plan" | "observation_already_available";
  stepId: string;
  stepIndex: number;
  previousStepId: string;
  toolId?: string;
  evidenceIds: string[];
}

export class ObservationPlanError extends Error {
  readonly code = "OBSERVATION_PLAN_NO_PROGRESS";
  constructor(readonly issues: RepeatedObservationIssue[]) {
    super(`计划重复读取同一目标且缺少已验证的刷新依据：${issues.map(issue =>
      `第 ${issue.stepIndex + 1} 步重复 ${issue.previousStepId}`).join("；")}。整份候选计划尚未执行；请复用已有证据、修正实际 action，或提供有范围和期限的状态刷新依据。`);
    this.name = "ObservationPlanError";
  }
}

/** Actual invocation identity; titles, explanations, expected prose and step IDs do not change it.
 * Arrays retain order: tools may assign meaning to their argument order. */
export function observationActionIdentity(step: PlanStep, context: string, tools: ToolDefinition[] = defaultToolCatalog,
  fallbackTarget?: ObservationPlanProgressOptions["target"]): string | undefined {
  let serverId: string | undefined;
  try { serverId = JSON.parse(context)?.[0]; } catch { /* Opaque old scope still remains part of the identity. */ }
  const preparedTargets = step.executionIntent?.semantic.targets.filter(target => target.serverId === serverId && target.role !== "interaction");
  const endpoints = preparedTargets?.length ? preparedTargets.map(target => ({ host: target.host.toLowerCase(), port: target.port,
    username: target.username }))
    : fallbackTarget && fallbackTarget.id === serverId ? [{ host: fallbackTarget.host.toLowerCase(), port: fallbackTarget.port, username: fallbackTarget.username }] : undefined;
  const scope = { context, endpoints };
  if (step.action?.type === "tool") {
    const action = step.action;
    const definition = tools.find(tool => tool.id === action.toolId);
    if (!definition || definition.effect !== undefined && definition.effect !== "read"
      || definition.effect === undefined && definition.planMode !== "read_batch") return;
    let arguments_: Record<string, unknown>;
    try { arguments_ = prepareFinalToolArguments(definition, action.arguments); }
    catch { return; } // Historical incompatible calls are not reusable; normal admission still rejects invalid new calls.
    return stableProtocolValue({ scope, action: { type: "tool", toolId: step.action.toolId,
      arguments: arguments_ } });
  }
  // Missing actions are historical records with insufficient invocation identity.
  if (step.action?.type !== "shell" || step.kind !== "observe") return;
  return stableProtocolValue({ scope, action: { type: "shell", command: step.action.command.replace(/\r\n/g, "\n").trim() },
    executionScope: step.executionScope ?? "isolated_exec", sessionContextChange: step.sessionContextChange });
}

function createsBoundary(step: PlanStep, tools: ToolDefinition[]) {
  if (step.action?.type === "tool") {
    const definition = tools.find(tool => step.action?.type === "tool" && tool.id === step.action.toolId);
    return definition?.effect === "change" || definition?.effect === "interaction" || definition?.executionMode === "user-input";
  }
  return step.kind === "change" || Boolean(step.sessionContextChange);
}

function refreshAuthorized(task: OpsTask, identity: string, previous: PlanStep, options: ObservationPlanProgressOptions) {
  const now = options.now ?? Date.now();
  return options.refreshGrants?.some(grant => grant.taskId === task.id && grant.roundId === task.currentRoundId
    && grant.targetContext === taskAttemptContext(task) && grant.actionIdentity === identity && grant.previousStepId === previous.id
    && ["bounded_poll", "evidence_invalidated", "user_refresh"].includes(grant.kind)
    && Boolean(grant.reason.trim()) && Number.isFinite(grant.notBefore) && Number.isFinite(grant.deadlineAt)
    && grant.notBefore <= now && now < grant.deadlineAt && grant.notBefore < grant.deadlineAt
    && (grant.kind !== "bounded_poll" || Number.isFinite(grant.intervalMs) && grant.intervalMs! > 0
      && Number.isFinite(Date.parse(previous.startedAt ?? ""))
      && now >= Date.parse(previous.startedAt!) + grant.intervalMs!)) ?? false;
}

type ObservationEntry = { step: PlanStep; identity: string; inCandidate: boolean; index: number; count: number };
const scopedAction = (identity: string) => {
  try { return JSON.parse(identity) as { scope: unknown; action: { type: string; toolId?: string; arguments?: Record<string, unknown> } }; }
  catch { return undefined; }
};
const precisePath = (value: unknown): value is string => typeof value === "string" && value.startsWith("/") && !value.includes("//")
  && !value.split("/").some(segment => segment === "." || segment === "..") && !/[\u0000-\u001f\u007f\\$*?\[\]]/.test(value);

/** Completed projections qualify only with their latest applied ledger attempt,
 * unchanged prepared action, full tool receipt and local receipt timing. This
 * admits a read, not reuse of stale/partial bytes or a consistency verdict. */
function completedReceiptTimes(task: OpsTask, entry: ObservationEntry, tools: ToolDefinition[]) {
  const step = entry.step, action = step.action, intent = step.executionIntent;
  if (entry.inCandidate || step.status !== "completed" || step.attemptContext !== taskAttemptContext(task)
    || step.result?.executionStatus !== "success" || step.result.facts.evidenceComplete !== true || !step.result.evidenceIds.length
    || action?.type !== "tool" || !intent || !executionIntentMatches(intent, intent)
    || intent.semantic.taskId !== task.id || intent.semantic.stepId !== step.id || intent.semantic.effect !== "read") return;
  const definition = tools.find(tool => tool.id === action.toolId);
  if (!definition || intent.semantic.action.type !== "tool" || intent.semantic.action.toolId !== action.toolId) return;
  try {
    if (stableProtocolValue(prepareFinalToolArguments(definition, action.arguments))
      !== stableProtocolValue(prepareFinalToolArguments(definition, intent.semantic.action.arguments))) return;
    const refs = step.executionLedgerAttempts?.filter(ref => ref.phase === "tool"), latest = refs?.[refs.length - 1];
    if (!latest || !step.ledgerAppliedAttemptIds?.includes(latest.attemptId)) return;
    const evidence = step.evidence?.find(item => item.source === "main" && step.result!.evidenceIds.includes(item.id)
      && item.scope?.targetId === (task.executionTargetServerId ?? task.serverId) && !item.archive?.capturedPartial);
    const startedAt = Date.parse(step.startedAt ?? ""), completedAt = Date.parse(evidence?.collectedAt ?? "");
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || startedAt > completedAt) return;
    const result = enforceToolResult({ id: latest.executionId, toolId: action.toolId, arguments: action.arguments },
      { callId: latest.executionId, toolId: action.toolId, success: true, data: JSON.parse(step.output ?? "") });
    if (!result.success || result.truncated || !result.data || typeof result.data !== "object") return;
    const data = result.data as Record<string, unknown>;
    if (action.toolId === "files.inspect_manifest") {
      if (data.status !== "complete" || data.coverageComplete !== true || data.truncated !== false || data.observationsRedacted === true) return;
    } else if (action.toolId === "files.read_content") {
      if (data.encoding !== "utf-8" || typeof data.content !== "string" || data.truncated !== false || data.returnedBytes !== data.totalBytes
        || new TextEncoder().encode(data.content).length !== data.returnedBytes || /\[REDACTED\]|•{4,}|\uFFFD|\uFEFF|\u0000/.test(data.content)) return;
    } else return;
    return { startedAt, completedAt };
  } catch { return; }
}

/** One directory-membership revalidation may bracket actual member-content
 * reads. This dependency comes from canonical actions, never titles or claimed
 * purpose, and is intentionally independent of any Nginx/business tool. */
function directoryReadRevalidation(task: OpsTask, previous: ObservationEntry, current: PlanStep, identity: string,
  timeline: ObservationEntry[], tools: ToolDefinition[], options: ObservationPlanProgressOptions) {
  if (previous.count !== 1 || previous.identity !== identity) return false;
  const before = scopedAction(previous.identity), args = before?.action.arguments;
  if (before?.action.type !== "tool" || before.action.toolId !== "files.inspect_manifest" || args?.source !== "directory" || !precisePath(args.path)) return false;
  const directory = args.path;
  const endpoints = (before.scope as { endpoints?: unknown[] } | undefined)?.endpoints;
  if (!Array.isArray(endpoints) || !endpoints.length) return false;
  const beforeTimes = previous.inCandidate ? undefined : completedReceiptTimes(task, previous, tools);
  if (!previous.inCandidate && !beforeTimes) return false;
  const members = timeline.slice(previous.index + 1).filter(entry => {
    const invocation = scopedAction(entry.identity), path = invocation?.action.arguments?.path;
    return invocation?.action.type === "tool" && invocation.action.toolId === "files.read_content"
      && stableProtocolValue(invocation.scope) === stableProtocolValue(before.scope) && precisePath(path)
      && path !== directory && path.startsWith(directory === "/" ? "/" : directory.replace(/\/$/, "") + "/");
  });
  if (!members.length) return false;
  const involved = [previous, ...members, { step: current, inCandidate: true }];
  // Proposal checks compare every bound source but cannot assign a generation
  // to new actions. The store's default prepared check requires all generations
  // and reruns this comparison before approval/dispatch; history is never exempt.
  if (involved.some(entry => entry.step.executionIntent || !entry.inCandidate)) {
    const bound = involved.filter(entry => !(options.admission === "proposal" && entry.inCandidate && !entry.step.executionIntent));
    const generations = bound.map(entry => {
      const targets = entry.step.executionIntent?.semantic.targets.filter(target => target.serverId === (task.executionTargetServerId ?? task.serverId) && target.role !== "interaction");
      if (!targets?.length || targets.some(target => !Number.isSafeInteger(target.connectionGeneration) || target.connectionGeneration! < 0)) return undefined;
      return stableProtocolValue([...new Set(targets.map(target => target.connectionGeneration))].sort());
    });
    if (!generations.length || generations.some(generation => generation === undefined || generation !== generations[0])) return false;
  }
  // A persisted partial read cannot be made complete by a proposed after-scan.
  return members.every(entry => {
    if (entry.inCandidate) return true;
    const times = completedReceiptTimes(task, entry, tools);
    return !!times && !!beforeTimes && times.startedAt >= beforeTimes.completedAt;
  });
}

/** Admission-only: never deduplicates, reorders, grants completion or mutates an atomic proposal.
 * Must run after ordinary tool/action validation. Refresh grants come from the controller.
 * A finite polling loop inside one bounded action remains a single invocation. */
export function assertObservationPlanProgress(task: OpsTask, candidates: PlanStep[], tools: ToolDefinition[] = defaultToolCatalog,
  options: ObservationPlanProgressOptions = {}): void {
  const context = taskAttemptContext(task);
  const seen = new Map<string, ObservationEntry>();
  const timeline: ObservationEntry[] = [];
  const remember = (step: PlanStep, identity: string, inCandidate: boolean) => {
    const entry = { step, identity, inCandidate, index: timeline.length, count: (seen.get(identity)?.count ?? 0) + 1 };
    timeline.push(entry); seen.set(identity, entry);
  };
  for (const step of currentEvidenceSteps(task)) {
    if (createsBoundary(step, tools)) { seen.clear(); timeline.length = 0; continue; }
    const identity = observationActionIdentity(step, context, tools, options.target);
    if (identity) remember(step, identity, false);
  }
  const issues: RepeatedObservationIssue[] = [];
  candidates.forEach((step, stepIndex) => {
    if (!["pending", "awaiting_approval"].includes(step.status)) return;
    if (createsBoundary(step, tools)) { seen.clear(); timeline.length = 0; return; }
    const identity = observationActionIdentity(step, context, tools, options.target);
    if (!identity) return;
    const previous = seen.get(identity);
    if (previous && !directoryReadRevalidation(task, previous, step, identity, timeline, tools, options)
      && (previous.inCandidate || !refreshAuthorized(task, identity, previous.step, options))) {
      issues.push({ code: previous.inCandidate ? "duplicate_observation_in_plan" : "observation_already_available",
        stepId: step.id, stepIndex, previousStepId: previous.step.id,
        ...(step.action?.type === "tool" ? { toolId: step.action.toolId } : {}),
        evidenceIds: previous.step.result?.evidenceIds ?? [] });
    }
    // Even a valid refresh grant cannot authorize an unbounded duplicate list in one plan.
    remember(step, identity, true);
  });
  if (issues.length) throw new ObservationPlanError(issues);
}

export function observationPlanRepairContext(error: ObservationPlanError) {
  return { code: error.code, issues: error.issues,
    instruction: "原候选计划未执行且不会被程序删步。依据当前真实目标与缺失证据重新生成完整计划。以 action 的工具、参数和主机为准，修改标题不能改变动作。已有同范围事实应引用证据 ID；状态变更后可以复查。同参数目录清单可在同主机、同范围成员内容读取前后各采一次，作为成员范围复核；历史读取须完整且已落账，不能堆第三次清单，也不代表原子快照或新增业务进展。其他时序观察使用有间隔、截止和退出条件的受控观察。不要仅为规避重复检查而插入无关变更。" };
}
