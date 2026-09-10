import type { OpsTask, PlanStep } from "@/types";

import { taskReplyLanguage } from "./replyLanguage";

/** Transport metadata: language becomes a shared output rule; IDs remain local. */
export function modelLogContext(task: OpsTask, step?: PlanStep) {
  return { taskId: task.id, roundId: task.currentRoundId, stepId: step?.id,
    replyLanguage: taskReplyLanguage(task),
    serverId: task.executionTargetServerId ?? task.serverId,
    phaseIndex: (task.phaseHistory ?? []).filter(phase => phase.roundId === task.currentRoundId).length };
}
