import type {
  OpsTask,
  PlanStep,
  RequirementProcessingResult,
  RequirementRelation,
  TaskExecutionPhase,
  TaskPlanHistory,
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
    .find((message) => message.role === "user" && message.kind === "message")?.content
    || task.title;
}

export function allTaskSteps(task: OpsTask) {
  const steps = [
    ...(task.planHistory ?? []).flatMap((round) => round.plan),
    ...(task.phaseHistory ?? []).flatMap((phase) => phase.plan),
    ...task.plan,
  ];
  const seen = new Set<string>();
  return steps.filter((step) => {
    if (seen.has(step.id)) return false;
    seen.add(step.id);
    return true;
  });
}

export function activeRoundSteps(task: OpsTask) {
  const steps = [
    ...(task.phaseHistory ?? [])
      .filter((phase) => phase.roundId === task.currentRoundId)
      .flatMap((phase) => phase.plan),
    ...task.plan,
  ];
  const seen = new Set<string>();
  return steps.filter((step) => {
    if (seen.has(step.id)) return false;
    seen.add(step.id);
    return true;
  });
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
