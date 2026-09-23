import type { OpsTask, TaskExecutionPhase, TaskMessage, TaskPlanHistory } from "@/types";
import { capturePreviousRound } from "./taskGoal";
import type { AuditEvent } from "@/types";
import { isPlanProgressMessage } from "./taskMessages";

const FOLLOW_UP_RELATIONS = new Set(["continue", "side_question", "cancel_goal"]);

export type CurrentConversationTimelineEntry =
  | { type: "message"; key: string; createdAt: string; sourceIndex: number; message: TaskMessage }
  | { type: "phase"; key: string; createdAt: string; sourceIndex: number; index: number; phase: TaskExecutionPhase };

/**
 * Finds the first message owned by the active requirement round. Continue and
 * side-question messages stay attached to the original requirement instead of
 * replacing it as the visible start of the conversation.
 */
export function currentConversationRoundStartIndex(task: OpsTask) {
  const latestUserIndex = task.messages.reduce((latest, message, index) => (
    message.role === "user" && message.kind === "message" ? index : latest
  ), -1);
  let firstUserIndex = -1;
  let roundStartIndex = -1;
  task.messages.forEach((message, index) => {
    if (message.role !== "user" || message.kind !== "message") return;
    if (firstUserIndex < 0) firstUserIndex = index;
    const isUnclassifiedSubmission = Boolean(task.rootGoal)
      && index === latestUserIndex
      && !message.requirementRelation
      && firstUserIndex !== index;
    if (!FOLLOW_UP_RELATIONS.has(message.requirementRelation ?? "") && !isUnclassifiedSubmission) {
      roundStartIndex = index;
    }
  });
  return roundStartIndex >= 0 ? roundStartIndex : firstUserIndex;
}

function compareTimelineTimestamps(left: string, right: string) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left === right ? 0 : left.localeCompare(right);
}

function buildConversationTimeline(
  messages: Array<{ message: TaskMessage; sourceIndex: number }>,
  phases: TaskExecutionPhase[],
): CurrentConversationTimelineEntry[] {
  let latestPlanProgressIndex = -1;
  messages.forEach(({ message }, index) => {
    if (isPlanProgressMessage(message.content)) latestPlanProgressIndex = index;
  });
  const messageEntries: CurrentConversationTimelineEntry[] = messages
    .filter(({ message }, index) => !isPlanProgressMessage(message.content) || index === latestPlanProgressIndex)
    .map(({ message, sourceIndex }) => ({
      type: "message",
      key: `message:${message.id}`,
      createdAt: message.createdAt,
      sourceIndex,
      message,
    }));
  const sortedPhases = phases
    .map((phase, sourceIndex) => ({ phase, sourceIndex }))
    .sort((left, right) => compareTimelineTimestamps(left.phase.completedAt, right.phase.completedAt)
      || left.sourceIndex - right.sourceIndex);
  const phaseEntries: CurrentConversationTimelineEntry[] = sortedPhases.map(({ phase, sourceIndex }, index) => ({
    type: "phase",
    key: `phase:${phase.id}`,
    createdAt: phase.completedAt,
    sourceIndex,
    index: index + 1,
    phase,
  }));
  const messageIds = new Set(messageEntries.map(entry => entry.type === "message" ? entry.message.id : ""));
  const linkedPhases = new Map<string, CurrentConversationTimelineEntry[]>();
  const unlinkedPhases = phaseEntries.filter((entry) => {
    if (entry.type !== "phase" || !entry.phase.archivedBeforeMessageId
      || !messageIds.has(entry.phase.archivedBeforeMessageId)) return true;
    const linked = linkedPhases.get(entry.phase.archivedBeforeMessageId) ?? [];
    linked.push(entry);
    linkedPhases.set(entry.phase.archivedBeforeMessageId, linked);
    return false;
  });
  const timeline = [...messageEntries, ...unlinkedPhases].sort((left, right) => (
    compareTimelineTimestamps(left.createdAt, right.createdAt)
    // Legacy phases have no explicit message anchor. Preserve the timestamp
    // fallback so old persisted tasks still read old plan -> user -> new plan.
    || (left.type === right.type ? left.sourceIndex - right.sourceIndex : left.type === "phase" ? -1 : 1)
  ));
  return timeline.flatMap(entry => entry.type === "message"
    ? [...(linkedPhases.get(entry.message.id) ?? []), entry]
    : [entry]);
}

/** Builds the active round as one chronological stream without mutating task evidence. */
export function currentConversationTimeline(
  task: OpsTask,
  provisionalPhases: TaskExecutionPhase[] = [],
): CurrentConversationTimelineEntry[] {
  const roundStartIndex = currentConversationRoundStartIndex(task);
  const messages = task.messages
    .map((message, sourceIndex) => ({ message, sourceIndex }))
    .filter(({ message, sourceIndex }) => sourceIndex >= Math.max(0, roundStartIndex)
      && message.kind === "message");
  const phases = [...(task.phaseHistory ?? []), ...provisionalPhases]
    .filter(phase => phase.roundId === task.currentRoundId);
  return buildConversationTimeline(messages, phases);
}

/** New history records retain their full message stream; legacy rounds use the template fallback. */
export function archivedConversationTimeline(round: TaskPlanHistory): CurrentConversationTimelineEntry[] {
  const messages = (round.messages ?? []).map((message, sourceIndex) => ({ message, sourceIndex }));
  return buildConversationTimeline(messages, round.phases ?? []);
}

/** Execution events are already represented by previousExecution/decision evidence. */
export function requirementConversationContext(task: OpsTask) {
  return task.messages.filter(message => message.kind === "message" && message.role !== "system")
    .slice(-24).map(({ role, kind, content }) => ({ role, kind, content }));
}

/** Recover legacy links only from explicit task creation audit records. */
export function restoreConversationLinks(tasks: OpsTask[], events: AuditEvent[]) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const event of [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!["独立目标已创建新任务", "整体目标已替换并创建新任务"].includes(event.title)) continue;
    try {
      const { previousTaskId, newTaskId } = JSON.parse(event.detail);
      const previous = byId.get(previousTaskId);
      const next = byId.get(newTaskId);
      if (previous && next && previous !== next && previous.serverId === next.serverId && !next.conversationId) {
        next.conversationId = previous.conversationId ?? previous.id;
      }
    } catch { /* Malformed legacy audit entries cannot establish a link. */ }
  }
  return tasks;
}

/** Read-only presentation: task evidence and execution state remain separate. */
export function conversationHistoryRounds(tasks: OpsTask[], active: OpsTask) {
  const identity = active.conversationId ?? active.id;
  const prior = tasks.filter(task => task.id !== active.id && task.serverId === active.serverId
    && (task.conversationId ?? task.id) === identity && task.createdAt <= active.createdAt)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  return [...prior.flatMap(task => {
    const latest = capturePreviousRound(task, task.updatedAt)?.history;
    if (latest) latest.id = `current-${task.currentRoundId ?? task.id}`;
    return [...(task.planHistory ?? []), ...(latest ? [latest] : [])]
      .map(round => ({ ...round, id: `${task.id}:${round.id}` }));
  }), ...(active.planHistory ?? [])];
}
