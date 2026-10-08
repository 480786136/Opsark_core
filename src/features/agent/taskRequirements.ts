import type {
  ExecutionConstraints,
  OpsTask,
  RequirementRelation,
  TaskRequirementItem,
  TaskRequirementLifecycle,
  TaskRequirementReview,
  TaskRequirementSource,
  TaskRequirementUpdate,
} from "@/types";

export class TaskRequirementError extends Error {
  constructor(message: string) {
    super(`REQUIREMENT_CONTRACT_INVALID: ${message}`);
    this.name = "TaskRequirementError";
  }
}

function fail(message: string): never { throw new TaskRequirementError(message); }
const nonempty = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const unique = (values: string[]) => new Set(values).size === values.length;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const effective = (item: TaskRequirementItem) => item.status === "active" || item.status === "satisfied";

function sameSource(left: TaskRequirementSource, right: TaskRequirementSource) {
  if (left.sourceMessageId && right.sourceMessageId) return left.sourceMessageId === right.sourceMessageId;
  return left.content === right.content && left.relation === right.relation;
}

function sourceId(source: TaskRequirementSource) {
  // Deterministic IDs survive persistence and do not need a model-generated identifier.
  const text = source.sourceMessageId || `${source.relation}:${source.content}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `requirement-legacy-${(hash >>> 0).toString(16)}`;
}

function legacyItem(source: TaskRequirementSource, existing: TaskRequirementItem[]): TaskRequirementItem {
  const base = sourceId(source);
  let id = base;
  for (let index = 1; existing.some(item => item.id === id); index += 1) id = `${base}-${index}`;
  // A legacy sentence can contain goals and constraints. Retain it verbatim as
  // an unresolved goal until an explicit, source-grounded update splits it.
  return { id, kind: "goal", content: source.content, source: clone(source), lastChangedAt: source.createdAt,
    status: "active", evidenceIds: [] };
}

function fallbackSources(task: OpsTask): TaskRequirementSource[] {
  if (Array.isArray(task.persistedRequirements?.sources) && task.persistedRequirements.sources.length) return task.persistedRequirements.sources;
  const content = task.rootGoal?.trim() || task.title;
  const message = task.messages.find(item => item.role === "user" && item.kind === "message" && item.content === content);
  return [{ content, relation: "new_goal", source: message ? "user_message" : "task_root",
    sourceMessageId: message?.id, createdAt: message?.createdAt }];
}

function validLifecycle(value: TaskRequirementLifecycle): boolean {
  const validSource = (source: TaskRequirementSource) => source && nonempty(source.content)
    && ["new_goal", "replace_goal", "supplement"].includes(source.relation)
    && ["user_message", "task_root", "current_instruction"].includes(source.source);
  if (!Number.isInteger(value.revision) || value.revision < 0 || !Array.isArray(value.items)
    || !value.focus || !Array.isArray(value.focus.requirementIds)) return false;
  if (!value.items.every(item => item && nonempty(item.id) && nonempty(item.content) && validSource(item.source)
    && ["goal", "constraint"].includes(item.kind)
    && ["active", "satisfied", "deferred", "superseded", "cancelled"].includes(item.status)
    && Array.isArray(item.evidenceIds) && item.evidenceIds.every(nonempty)
    && (!item.lastReview || ["satisfied", "unmet", "unknown"].includes(item.lastReview.outcome)
      && nonempty(item.lastReview.reason) && Array.isArray(item.lastReview.evidenceIds)
      && item.lastReview.evidenceIds.every(nonempty) && Number.isInteger(item.lastReview.revision)
      && item.lastReview.revision <= value.revision))) return false;
  return unique(value.items.map(item => item.id)) && unique(value.focus.requirementIds)
    && value.focus.requirementIds.every(id => value.items.some(item => item.id === id));
}

/** Read-only migration. A legacy completed task is not proof that every requirement is satisfied. */
export function ensureTaskRequirementLifecycle(task: OpsTask, sources = fallbackSources(task)): TaskRequirementLifecycle {
  if (task.requirementLifecycle?.version === 1 && validLifecycle(task.requirementLifecycle)) return clone(task.requirementLifecycle);
  const items: TaskRequirementItem[] = [];
  for (const source of sources) {
    if (source && nonempty(source.content) && !items.some(item => sameSource(item.source, source))) items.push(legacyItem(source, items));
  }
  const latest = sources[sources.length - 1];
  return { version: 1, revision: 0, items,
    focus: { roundId: task.currentRoundId, sourceMessageId: latest?.sourceMessageId,
      requirementIds: items.filter(item => latest && sameSource(item.source, latest)).map(item => item.id) } };
}

/** Explicitly retrying initial planning keeps the original task and user request.
 * Enable mandatory review without classifying another message or granting success. */
export function activateRequirementReviewForRetry(task: OpsTask): TaskRequirementLifecycle {
  const existing = task.requirementLifecycle;
  if (existing && existing.revision > 0) {
    if (existing.version !== 1 || !validLifecycle(existing)) fail("已有需求版本无法安全读取，不能以重试覆盖原要求。");
    return clone(existing);
  }
  if (!nonempty(task.currentRoundId)) fail("重试原规划前必须保留或恢复当前轮次标识。");
  if (existing?.items?.length && (existing.version !== 1 || !validLifecycle(existing))) {
    fail("已有需求条目无法安全读取，不能以重试覆盖原要求。");
  }
  if (existing?.version === 1 && validLifecycle(existing) && existing.items.length) {
    const state = clone(existing);
    state.revision = 1;
    state.lastReview = undefined;
    state.focus = { ...state.focus, roundId: task.currentRoundId,
      requirementIds: state.focus.requirementIds.length ? state.focus.requirementIds
        : state.items.filter(effective).map(item => item.id) };
    return state;
  }

  const byId = new Map((task.planHistory ?? []).flatMap(round => round.messages ?? []).map(message => [message.id, message]));
  for (const message of task.messages) byId.set(message.id, message);
  const messages = [...byId.values()].filter(message => message.role === "user" && message.kind === "message"
    && nonempty(message.content) && !["side_question", "continue", "cancel_goal"].includes(message.requirementRelation ?? ""));
  if (messages.every(message => Number.isFinite(Date.parse(message.createdAt)))) {
    messages.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }
  const lastDeclaredGoal = [...messages].reverse().find(message => ["new_goal", "replace_goal"].includes(message.requirementRelation ?? ""));
  const content = task.rootGoal?.trim() || lastDeclaredGoal?.content || messages[messages.length - 1]?.content;
  const rootMessage = messages.find(message => message.content.trim() === content?.trim());
  const rootRelation = rootMessage?.requirementRelation;
  const sources: TaskRequirementSource[] = content ? [{ content,
    relation: rootRelation === "replace_goal" || rootRelation === "supplement" ? rootRelation : "new_goal",
    source: rootMessage ? "user_message" : "task_root", sourceMessageId: rootMessage?.id,
    createdAt: rootMessage?.createdAt ?? task.createdAt }] : [];
  const retain = (source: TaskRequirementSource, persisted = false) => {
    if (!nonempty(source?.content) || !["new_goal", "replace_goal", "supplement"].includes(source.relation)
      || !["user_message", "task_root", "current_instruction"].includes(source.source)) return;
    const index = sources.findIndex(previous => sameSource(previous, source)
      || previous.content.trim() === source.content.trim() && previous.relation === source.relation);
    if (index < 0) sources.push(clone(source));
    else if (persisted) sources[index] = clone(source);
  };
  if (task.persistedRequirements?.version === 1) for (const source of task.persistedRequirements.sources ?? []) retain(source, true);
  for (const message of messages) {
    const relation = message.requirementRelation;
    if (relation === "new_goal" || relation === "replace_goal" || relation === "supplement") retain({ content: message.content,
      relation, source: "user_message", sourceMessageId: message.id, createdAt: message.createdAt });
  }
  if (sources.every(source => Number.isFinite(Date.parse(source.createdAt ?? "")))) {
    sources.sort((left, right) => Date.parse(left.createdAt!) - Date.parse(right.createdAt!));
  }
  let current: TaskRequirementSource[] = [];
  for (const source of sources) {
    if (source.relation === "new_goal" || source.relation === "replace_goal") current = [source];
    else current.push(source);
  }
  if (!current.length) fail("未找到原始用户要求，不能把任务标题或空清单当作重试目标。");
  // A valid but empty revision-zero projection must not suppress the original sources.
  const state = ensureTaskRequirementLifecycle({ ...task, requirementLifecycle: undefined }, current);
  state.revision = 1;
  state.focus.requirementIds = state.items.map(item => item.id);
  return state;
}

/** Optional-protocol compatibility: keep a new classified requirement without guessing semantic completion. */
export function appendLegacyTaskRequirement(
  task: OpsTask,
  source: TaskRequirementSource,
  roundId = task.currentRoundId,
): TaskRequirementLifecycle {
  const state = ensureTaskRequirementLifecycle(task);
  const existing = state.items.filter(item => sameSource(item.source, source) && effective(item));
  if (!existing.length) state.items.push(legacyItem(source, state.items));
  state.focus = { roundId, sourceMessageId: source.sourceMessageId,
    requirementIds: state.items.filter(item => sameSource(item.source, source) && effective(item)).map(item => item.id) };
  if (state.revision > 0) state.revision += 1;
  state.lastReview = undefined;
  return state;
}

function checkRevision(state: TaskRequirementLifecycle, revision: number) {
  if (!Number.isInteger(revision) || revision !== state.revision) fail("需求版本已变化，旧决策不能覆盖当前要求。");
}

/** Applies an atomic user-grounded delta; no omitted item is deleted or implicitly satisfied. */
export function applyTaskRequirementUpdate(
  task: OpsTask,
  update: TaskRequirementUpdate,
  context: { source: TaskRequirementSource; roundId?: string },
): TaskRequirementLifecycle {
  const state = ensureTaskRequirementLifecycle(task);
  checkRevision(state, update.baseRevision);
  const { source } = context;
  if (!source.sourceMessageId || update.sourceMessageId !== source.sourceMessageId) fail("需求更新必须引用当前用户消息。");
  if (!["new_goal", "replace_goal", "supplement"].includes(source.relation)) fail("只有目标或补充需求可以修改需求清单。");
  const assertQuote = (quote: string) => {
    if (!nonempty(quote) || !source.content.includes(quote)) fail("需求变更缺少当前用户原文依据。");
  };
  if (!Array.isArray(update.additions) || !Array.isArray(update.changes) || !Array.isArray(update.focusIds)) fail("需求更新列表不完整。");
  const ids = state.items.map(item => item.id);
  const replaceable = new Set(state.items.filter(item => effective(item) || item.status === "deferred").map(item => item.id));
  if (!unique(update.additions.map(item => item.id)) || update.additions.some(item => !nonempty(item.id) || ids.includes(item.id))) {
    fail("新增需求标识重复或复用了历史需求标识。");
  }
  const touched = new Set<string>();
  for (const addition of update.additions) {
    assertQuote(addition.sourceQuote);
    if (!["goal", "constraint"].includes(addition.kind) || !nonempty(addition.content)) fail("新增需求缺少有效内容或类型。");
    if (!Array.isArray(addition.supersedes) || !unique(addition.supersedes)) fail("被替代需求标识不合法。");
    for (const id of addition.supersedes) {
      const previous = state.items.find(item => item.id === id);
      // Explicit splitting can replace the same legacy source once with several
      // additions, but the source list and the superseding relationships remain.
      if (!previous || !replaceable.has(id)) fail("只能替代现有有效或暂缓需求。");
      touched.add(id);
      previous.status = "superseded";
      previous.supersededBy ||= addition.id;
    }
    state.items.push({ id: addition.id, kind: addition.kind, content: addition.content, source: clone(source), lastChangedAt: source.createdAt,
      status: "active", supersedes: [...addition.supersedes], evidenceIds: [] });
  }
  for (const change of update.changes) {
    assertQuote(change.sourceQuote);
    if (!["active", "deferred", "cancelled"].includes(change.status) || !nonempty(change.reason)) fail("分类不能授予需求完成状态。");
    const item = state.items.find(candidate => candidate.id === change.id);
    if (!item || touched.has(change.id) || !ids.includes(change.id) || ["superseded", "cancelled"].includes(item.status)) {
      fail("需求状态变更引用了不可修改的条目。");
    }
    touched.add(change.id);
    item.status = change.status;
    if (change.status === "active") {
      item.evidenceIds = []; item.lastReview = undefined; item.lastChangedAt = source.createdAt;
    }
  }
  if (!unique(update.focusIds) || !update.focusIds.length || update.focusIds.some(id => !state.items.some(item => item.id === id && effective(item)))) {
    fail("本轮处理范围必须引用有效需求。");
  }
  if (update.additions.some(item => !update.focusIds.includes(item.id))) fail("新增要求必须纳入本轮处理范围。");
  state.revision += 1;
  state.focus = { roundId: context.roundId ?? task.currentRoundId, sourceMessageId: source.sourceMessageId,
    requirementIds: [...update.focusIds] };
  state.lastReview = undefined;
  return state;
}

/** The caller supplies evidence IDs already checked for task, resource, scope and freshness. */
export function applyTaskRequirementReview(
  task: OpsTask,
  review: TaskRequirementReview,
  context: { evidenceIds: string[]; diagnosticEvidenceIds?: string[]; unknownOnlyEvidenceIds?: string[]; roundId?: string },
): TaskRequirementLifecycle {
  const state = ensureTaskRequirementLifecycle(task);
  checkRevision(state, review.baseRevision);
  const roundId = context.roundId ?? task.currentRoundId;
  if (!nonempty(review.roundId) || review.roundId !== roundId || (state.focus.roundId && state.focus.roundId !== roundId)) {
    fail("需求复核不属于当前轮次。");
  }
  if (!["completed", "pending"].includes(review.focusOutcome) || !["completed", "pending"].includes(review.overallOutcome)
    || !Array.isArray(review.items) || !unique(review.items.map(item => item.requirementId))) fail("需求复核结果不完整或存在重复条目。");
  const knownEvidence = new Set(context.evidenceIds);
  const diagnosticEvidence = new Set(context.diagnosticEvidenceIds ?? context.evidenceIds);
  const unknownOnlyEvidence = new Set(context.unknownOnlyEvidenceIds ?? []);
  for (const assessment of review.items) {
    const item = state.items.find(candidate => candidate.id === assessment.requirementId);
    if (!item || !effective(item)) fail("需求复核引用了无效或已退出当前范围的条目。");
    if (!["satisfied", "unmet", "unknown"].includes(assessment.outcome) || !nonempty(assessment.reason)
      || !Array.isArray(assessment.evidenceIds) || !unique(assessment.evidenceIds)
      || assessment.evidenceIds.some(id => !nonempty(id) || (assessment.outcome === "satisfied"
        ? !knownEvidence.has(id) : !diagnosticEvidence.has(id) && !(assessment.outcome === "unknown" && unknownOnlyEvidence.has(id))))) {
      fail("需求复核引用了未知证据或无效结论；失败诊断不能证明完成，未核实记录仅能支持 unknown。");
    }
    if (assessment.outcome === "satisfied" && assessment.evidenceIds.length === 0) fail("需求完成必须有真实证据。");
    item.evidenceIds = [...assessment.evidenceIds];
    item.lastReview = { outcome: assessment.outcome, reason: assessment.reason, evidenceIds: [...assessment.evidenceIds],
      revision: state.revision + 1, roundId };
    // A satisfied constraint remains binding on future requests.
    item.status = item.kind === "constraint" || assessment.outcome !== "satisfied" ? "active" : "satisfied";
  }
  const satisfied = (item: TaskRequirementItem) => item.evidenceIds.length > 0
    && item.evidenceIds.every(id => knownEvidence.has(id))
    && (item.kind === "constraint" ? item.lastReview?.outcome === "satisfied" : item.status === "satisfied");
  const focus = state.focus.requirementIds.map(id => state.items.find(item => item.id === id)).filter((item): item is TaskRequirementItem => Boolean(item));
  if (review.focusOutcome === "completed" && (!focus.length || focus.some(item => !effective(item) || !satisfied(item)))) {
    fail("本轮仍有未满足的要求，不能声明本轮完成。");
  }
  if (review.focusOutcome === "completed" && state.items.some(item => item.kind === "constraint" && effective(item) && !satisfied(item))) {
    fail("仍生效的约束尚未证明得到遵守，不能声明本轮完成。");
  }
  if (review.overallOutcome === "completed" && (review.focusOutcome !== "completed"
    || state.items.some(item => item.status === "deferred" || (effective(item) && !satisfied(item))))) {
    fail("整体仍有未满足或暂缓的要求，不能声明全部完成。");
  }
  state.revision += 1;
  state.lastReview = { revision: state.revision, roundId, focusOutcome: review.focusOutcome, overallOutcome: review.overallOutcome };
  return state;
}

/** Exact current obligations and focus, compactable historical results, never one undifferentiated checklist. */
export function projectRequirementsContext(state: TaskRequirementLifecycle) {
  const focusIds = new Set(state.focus.requirementIds);
  const historical = state.items.filter(item => !effective(item) && item.status !== "deferred"
    || item.kind === "goal" && item.status === "satisfied" && !focusIds.has(item.id));
  return {
    revision: state.revision,
    focus: state.items.filter(item => focusIds.has(item.id) && effective(item)),
    activeGoals: state.items.filter(item => item.kind === "goal" && item.status === "active"),
    activeConstraints: state.items.filter(item => item.kind === "constraint" && effective(item)),
    deferred: state.items.filter(item => item.status === "deferred"),
    historicalCount: historical.length,
    omittedHistoricalCount: Math.max(0, historical.length - 24),
    historical: historical.slice(-24).map(item => ({
      id: item.id, kind: item.kind, status: item.status,
      summary: item.content.length > 160 ? `${item.content.slice(0, 160)}…` : item.content,
      sourceMessageId: item.source.sourceMessageId, evidenceIds: [...item.evidenceIds],
    })),
    lastReview: state.lastReview,
  };
}

/** Retire only exact, source-bound requirements. Unmapped legacy prose remains
 * effective until explicitly represented; Core never guesses that two phrases
 * describe the same port, permission or prohibition. */
export function mergeRequirementExecutionConstraints(input: {
  previous?: ExecutionConstraints;
  classified?: ExecutionConstraints;
  relation?: RequirementRelation;
  previousLifecycle?: TaskRequirementLifecycle;
  nextLifecycle?: TaskRequirementLifecycle;
}): ExecutionConstraints | undefined {
  const related = input.relation === "supplement" || input.relation === "continue";
  const previous = related ? input.previous : undefined;
  if (input.relation === "continue" && previous) return clone(previous);
  if (!input.classified) return previous ? clone(previous) : undefined;
  const next = input.nextLifecycle;
  const managed = Boolean(next && next.revision > 0);
  const effectiveContent = new Set((next?.items ?? []).filter(effective).map(item => item.content));
  const retiredContent = new Set(managed && related ? (input.previousLifecycle?.items ?? [])
    .filter(item => effective(item) && next?.items.some(candidate => candidate.id === item.id
      && ["superseded", "cancelled", "deferred"].includes(candidate.status)) && !effectiveContent.has(item.content))
    .map(item => item.content) : []);
  const merge = (field: "userDirectives" | "prohibitedActions" | "requiredConditions") => [...new Set([
    ...(previous?.[field] ?? []), ...(input.classified?.[field] ?? []),
    ...(managed && field === "requiredConditions" ? next!.items
      .filter(item => item.kind === "constraint" && effective(item)).map(item => item.content) : []),
  ])].filter(content => !retiredContent.has(content));
  return {
    ...input.classified,
    ...(managed && previous ? {
      environmentPolicy: input.classified.environmentPolicy === "unspecified"
        ? previous.environmentPolicy : input.classified.environmentPolicy,
      failurePolicy: input.classified.failurePolicy === "unspecified"
        ? previous.failurePolicy : input.classified.failurePolicy,
    } : {}),
    userDirectives: merge("userDirectives"), prohibitedActions: merge("prohibitedActions"), requiredConditions: merge("requiredConditions"),
  };
}
