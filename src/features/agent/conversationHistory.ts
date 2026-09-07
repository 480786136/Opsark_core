import type { OpsTask } from "@/types";
import { capturePreviousRound } from "./taskGoal";
import type { AuditEvent } from "@/types";

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
