import type {
  OpsTask,
  PlanStep,
  RequirementProcessingResult,
  RequirementRelation,
  TaskExecutionPhase,
  TaskPlanHistory,
  TaskMessage,
  TaskRequirementSource,
  TaskStatus,
} from "@/types";
import {
  mergeRoundIntoTaskHistoryCheckpoint,
  refreshTaskHistoryCheckpoint,
} from "@/features/agent/taskHistoryCheckpoint";
import { carryForwardRecoveryBlockers } from "./recoveryContract";

function cloneStep(step: PlanStep): PlanStep {
  return {
    ...step,
    review: step.review ? { ...step.review } : undefined,
    result: step.result ? {
      ...step.result,
      facts: { ...step.result.facts },
      warnings: [...step.result.warnings],
      evidenceIds: [...step.result.evidenceIds],
    } : undefined,
    evidence: step.evidence?.map((item) => ({
      ...item,
      facts: { ...item.facts },
    })),
  };
}

function clonePhase(phase: TaskExecutionPhase): TaskExecutionPhase {
  return {
    ...phase,
    plan: phase.plan.map(cloneStep),
  };
}

export function taskGoal(task: OpsTask) {
  return task.rootGoal?.trim() || [...task.messages]
    .reverse()
    .find((message) => message.role === "user" && message.kind === "message"
      && !["side_question", "continue", "cancel_goal"].includes(message.requirementRelation ?? ""))?.content
    || task.title;
}

export const TASK_REQUIREMENT_INSTRUCTION = "rootGoal 保留任务原始目标；requirements 按用户原文和先后顺序记录当前目标及补充要求，不代表已完成。验收必须同时核对本轮 currentInstruction 和仍有效的前序要求，不能仅因原始目标已有答案就忽略后续补充；用户明确收窄或修订的范围以较新要求为准，不自行扩张授权。continue 只恢复执行，不增加验收项；旁问和取消消息不作为业务要求。完成结论必须由对应真实 result/evidence 支持，历史记录仅在目标、范围和时效仍适用时复用。";

function persistedRequirementSources(task: OpsTask): TaskRequirementSource[] {
  if (task.persistedRequirements?.version !== 1 || !Array.isArray(task.persistedRequirements.sources)) return [];
  return task.persistedRequirements.sources.filter(item => item && typeof item.content === "string" && item.content.trim()
    && ["new_goal", "replace_goal", "supplement"].includes(item.relation)
    && ["user_message", "task_root", "current_instruction"].includes(item.source)).map(item => ({
      content: item.content, relation: item.relation, source: item.source,
      sourceMessageId: typeof item.sourceMessageId === "string" ? item.sourceMessageId : undefined,
      sourceRoundId: typeof item.sourceRoundId === "string" ? item.sourceRoundId : undefined,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
    }));
}

/** A read-only projection of classified user requirements, never a semantic completion verdict. */
export function taskRequirementSnapshot(task: OpsTask) {
  const rootGoal = taskGoal(task);
  const byId = new Map<string, TaskMessage>();
  const sourceRounds = new Map<string, string>();
  for (const round of task.planHistory ?? []) {
    for (const message of round.messages ?? []) {
      byId.set(message.id, message);
      if (round.roundId) sourceRounds.set(message.id, round.roundId);
    }
  }
  for (const message of task.messages) byId.set(message.id, message);
  const messages = [...byId.values()].filter(message => message.role === "user" && message.kind === "message");
  // Archived messages may overlap or precede only part of the live conversation.
  // Keep legacy insertion order when timestamps cannot be compared reliably.
  if (messages.every(message => Number.isFinite(Date.parse(message.createdAt)))) {
    messages.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }
  const rootMessage = messages.find(message => message.content.trim() === rootGoal
    && !["side_question", "continue", "cancel_goal"].includes(message.requirementRelation ?? ""));
  const fromMessage = (message: TaskMessage, relation: TaskRequirementSource["relation"]): TaskRequirementSource => ({
    content: message.content,
    relation,
    source: "user_message",
    sourceMessageId: message.id,
    sourceRoundId: sourceRounds.get(message.id),
    createdAt: message.createdAt,
  });
  const sources = persistedRequirementSources(task);
  const mergeSource = (source: TaskRequirementSource) => {
    const index = sources.findIndex(item => source.sourceMessageId && item.sourceMessageId === source.sourceMessageId
      || !item.sourceMessageId && item.content.trim() === source.content.trim() && item.relation === source.relation);
    if (index >= 0) {
      // User message IDs are immutable. Compact conversation copies may contain
      // truncated prose; they must not overwrite the retained original requirement.
      const retained = sources[index];
      sources[index] = { ...retained,
        source: source.source === "user_message" ? source.source : retained.source,
        sourceMessageId: retained.sourceMessageId ?? source.sourceMessageId,
        sourceRoundId: retained.sourceRoundId ?? source.sourceRoundId,
        createdAt: retained.createdAt ?? source.createdAt };
      return;
    }
    const timestamp = Date.parse(source.createdAt ?? "");
    const following = Number.isFinite(timestamp)
      ? sources.findIndex(item => Date.parse(item.createdAt ?? "") > timestamp) : -1;
    if (following >= 0) sources.splice(following, 0, source);
    else sources.push(source);
  };
  for (const message of messages) {
    const relation = message.requirementRelation ?? (message.id === rootMessage?.id ? "new_goal" : undefined);
    if (relation === "new_goal" || relation === "replace_goal" || relation === "supplement") mergeSource(fromMessage(message, relation));
  }
  let requirements: TaskRequirementSource[] = [{ content: rootGoal, relation: "new_goal", source: "task_root" }];
  for (const source of sources) {
    if (source.relation === "new_goal" || source.relation === "replace_goal") requirements = [source];
    else requirements.push(source);
  }
  // Old records may retain the classified instruction without retaining its message.
  // Do not infer new acceptance requirements from unclassified retries or side questions.
  if (task.lastRequirementRelation === "supplement" && task.currentInstruction?.trim()
    && !requirements.some(item => item.content.trim() === task.currentInstruction!.trim())) {
    requirements.push({ content: task.currentInstruction, relation: "supplement", source: "current_instruction",
      sourceRoundId: task.currentRoundId });
  }
  const latest = requirements[requirements.length - 1];
  if (latest && !latest.sourceRoundId && ["new_goal", "replace_goal", "supplement"].includes(task.lastRequirementRelation ?? "")
    && latest.content.trim() === task.currentInstruction?.trim()) latest.sourceRoundId = task.currentRoundId;
  return {
    version: 1,
    rootGoal,
    currentInstruction: task.currentInstruction,
    relation: task.lastRequirementRelation,
    currentRoundId: task.currentRoundId,
    requirements,
    instruction: TASK_REQUIREMENT_INSTRUCTION,
  };
}

/** The outer model prompt must include supplements as well as the stable root goal. */
export function taskAcceptanceRequirement(task: OpsTask) {
  const snapshot = taskRequirementSnapshot(task);
  if (snapshot.requirements.length === 1) return snapshot.requirements[0].content;
  return snapshot.requirements.map((item, index) =>
    `${index === 0 ? "整体目标" : `补充要求 ${index}`}：${item.content}`).join("\n");
}

export function allTaskSteps(task: OpsTask) {
  const steps = [
    ...(task.planHistory ?? []).flatMap((round) => round.plan),
    ...(task.phaseHistory ?? []).flatMap((phase) => phase.plan),
    ...task.plan,
  ];
  return [...new Map(steps.map(step => [step.id, step])).values()];
}

export function activeRoundSteps(task: OpsTask) {
  const steps = [
    ...(task.phaseHistory ?? [])
      .filter((phase) => phase.roundId === task.currentRoundId)
      .flatMap((phase) => phase.plan),
    ...task.plan,
  ];
  return [...new Map(steps.map(step => [step.id, step])).values()];
}

export function archiveActivePhase(
  task: OpsTask,
  reason: TaskExecutionPhase["reason"],
  timestamp = new Date().toISOString(),
  summary = task.pauseReason,
  archivedBeforeMessageId?: string,
) {
  if (!task.plan.length) return;
  task.currentRoundId ||= `round-${task.id}-${Date.parse(timestamp) || Date.now()}`;
  task.phaseHistory ??= [];
  task.phaseHistory.push({
    id: `phase-${task.id}-${Date.now()}-${task.phaseHistory.length}`,
    roundId: task.currentRoundId,
    archivedBeforeMessageId,
    requirement: task.currentInstruction || taskGoal(task),
    reason,
    plan: task.plan.map(cloneStep),
    summary: summary?.trim() || undefined,
    createdAt: task.plan.find((step) => step.startedAt)?.startedAt ?? task.updatedAt,
    completedAt: timestamp,
  });
  refreshTaskHistoryCheckpoint(task);
}

export interface PreviousRoundSnapshot {
  history: TaskPlanHistory;
  roundId?: string;
}

export function capturePreviousRound(task: OpsTask, timestamp = new Date().toISOString()): PreviousRoundSnapshot | undefined {
  const indexed = task.messages
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === "user" && message.kind === "message"
      && !["side_question", "continue", "cancel_goal"].includes(message.requirementRelation ?? ""));
  if (!indexed) return undefined;
  const steps = activeRoundSteps(task);
  const phases = (task.phaseHistory ?? [])
    .filter((phase) => phase.roundId === task.currentRoundId)
    .map(clonePhase);
  return {
    roundId: task.currentRoundId,
    history: {
      id: `round-history-${task.id}-${Date.now()}`,
      roundId: task.currentRoundId,
      requirement: indexed.message.content,
      status: task.status,
      plan: steps.map(cloneStep),
      finalPlan: task.plan.map(cloneStep),
      phases: phases.length ? phases : undefined,
      messages: task.messages
        .slice(indexed.index)
        .filter((message) => message.kind === "message")
        .map((message) => ({ ...message })),
      response: task.messages
        .slice(indexed.index + 1)
        .find((message) => message.role === "assistant" && message.kind === "message"),
      records: task.messages
        .slice(indexed.index + 1)
        .filter((message) => message.kind === "event")
        .map((message) => ({ ...message })),
      summary: task.summary,
      pauseReason: task.pauseReason,
      executionConstraints: task.executionConstraints,
      createdAt: indexed.message.createdAt,
      completedAt: timestamp,
    },
  };
}

export function commitPreviousRound(task: OpsTask, snapshot?: PreviousRoundSnapshot) {
  if (!snapshot) return;
  task.planHistory ??= [];
  task.planHistory.push(snapshot.history);
  mergeRoundIntoTaskHistoryCheckpoint(task, snapshot.history);
  if (snapshot.roundId) {
    task.phaseHistory = (task.phaseHistory ?? []).filter((phase) => phase.roundId !== snapshot.roundId);
  }
}

/** A user supplement changes the requirement round, never the identity of prior failures. */
export function beginRequirementRound(task: OpsTask, roundId: string, snapshot?: PreviousRoundSnapshot) {
  carryForwardRecoveryBlockers(task, roundId);
  commitPreviousRound(task, snapshot);
  task.currentRoundId = roundId;
}

export function normalizeRequirementRelation(
  result: RequirementProcessingResult,
  _content: string,
  _hasRootGoal: boolean,
): RequirementRelation {
  if (!result.relation) {
    throw new Error("需求分类响应缺少 relation；Core 不会代替模型判断业务目标关系。");
  }
  const valid = result.intent === "execute"
    ? ["new_goal", "continue", "supplement", "replace_goal"].includes(result.relation)
    : result.intent === "answer"
      ? ["side_question", "cancel_goal"].includes(result.relation)
      : false;
  if (!valid) {
    throw new Error(`需求分类响应的 intent=${result.intent} 与 relation=${result.relation} 不匹配。`);
  }
  return result.relation;
}

export function mergeTaskSkillIds(
  _current: string[] | undefined,
  selected: string[],
  _relation: RequirementRelation,
) {
  // The requirement model sees currentActiveSkillIds and returns the complete
  // applicable set for this round. Treating its output as a delta would make a
  // stale or previously misrouted Skill impossible to remove, including when
  // the correct result is an empty selection.
  return [...new Set(selected)];
}

export interface TaskWorkflowSnapshot {
  status: TaskStatus;
  updatedAt: string;
  permission: OpsTask["permission"];
  modelId: string;
  cancelRequested?: boolean;
  currentExecutionId?: string;
}

export function captureWorkflowState(task: OpsTask): TaskWorkflowSnapshot {
  return {
    status: task.status,
    updatedAt: task.updatedAt,
    permission: task.permission,
    modelId: task.modelId,
    cancelRequested: task.cancelRequested,
    currentExecutionId: task.currentExecutionId,
  };
}

export function restoreWorkflowState(task: OpsTask, snapshot: TaskWorkflowSnapshot) {
  task.status = snapshot.status;
  task.updatedAt = snapshot.updatedAt;
  task.permission = snapshot.permission;
  task.modelId = snapshot.modelId;
  task.cancelRequested = snapshot.cancelRequested;
  task.currentExecutionId = snapshot.currentExecutionId;
}
