import type { OpsTask, PlanStep } from "@/types";

/** Local correlation metadata. The transport removes it before sending the prompt. */
export function modelLogContext(task: OpsTask, step?: PlanStep) {
  return { taskId: task.id, roundId: task.currentRoundId, stepId: step?.id,
    serverId: task.executionTargetServerId ?? task.serverId,
    phaseIndex: (task.phaseHistory ?? []).filter(phase => phase.roundId === task.currentRoundId).length };
}
