import type {
  OpsTask,
  PlanStep,
  RequirementProcessingResult,
  RequirementRelation,
  TaskExecutionPhase,
  TaskPlanHistory,
  TaskStatus,
} from "@/types";

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
) {
  if (!task.plan.length) return;
  task.currentRoundId ||= `round-${task.id}-${Date.parse(timestamp) || Date.now()}`;
  task.phaseHistory ??= [];
  task.phaseHistory.push({
    id: `phase-${task.id}-${Date.now()}-${task.phaseHistory.length}`,
    roundId: task.currentRoundId,
    requirement: task.currentInstruction || taskGoal(task),
    reason,
    plan: task.plan.map(cloneStep),
    createdAt: task.plan.find((step) => step.startedAt)?.startedAt ?? task.updatedAt,
    completedAt: timestamp,
  });
}

export interface PreviousRoundSnapshot {
  history: TaskPlanHistory;
  roundId?: string;
}

export function capturePreviousRound(task: OpsTask, timestamp = new Date().toISOString()): PreviousRoundSnapshot | undefined {
  const indexed = task.messages
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === "user" && message.kind === "message");
  if (!indexed) return undefined;
  const steps = activeRoundSteps(task);
  return {
    roundId: task.currentRoundId,
    history: {
      id: `round-history-${task.id}-${Date.now()}`,
      requirement: indexed.message.content,
      status: task.status,
      plan: steps.map(cloneStep),
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
  if (snapshot.roundId) {
    task.phaseHistory = (task.phaseHistory ?? []).filter((phase) => phase.roundId !== snapshot.roundId);
  }
}

export function normalizeRequirementRelation(
  result: RequirementProcessingResult,
  content: string,
  hasRootGoal: boolean,
): RequirementRelation {
  if (result.relation) return result.relation;
  const normalized = content.trim().replace(/[。！!]+$/u, "");
  if (!hasRootGoal) return "new_goal";
  if (/^(?:请)?(?:继续执行|继续处理|继续部署|继续|重试|再试一次)/iu.test(normalized)) {
    return "continue";
  }
  if (/^(?:取消|终止|放弃)(?:当前|这个)?(?:任务|目标)?$/iu.test(normalized)) return "cancel_goal";
  return result.intent === "answer" ? "side_question" : "new_goal";
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
}

export function captureWorkflowState(task: OpsTask): TaskWorkflowSnapshot {
  return {
    status: task.status,
    updatedAt: task.updatedAt,
    permission: task.permission,
    modelId: task.modelId,
  };
}

export function restoreWorkflowState(task: OpsTask, snapshot: TaskWorkflowSnapshot) {
  task.status = snapshot.status;
  task.updatedAt = snapshot.updatedAt;
  task.permission = snapshot.permission;
  task.modelId = snapshot.modelId;
}
