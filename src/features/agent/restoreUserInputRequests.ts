import { parseToolCommand, parseUserInputArguments } from "@/features/tools/toolExecutor";
import type { PendingUserInput, ToolDefinition } from "@/features/tools/types";
import type { OpsTask } from "@/types";

/** Rebuild unanswered forms from saved plans without restoring entered values or executing tools. */
export function restoreUserInputRequests(
  tasks: OpsTask[],
  tools: ToolDefinition[],
  createCallId: () => string,
): PendingUserInput[] {
  const requests: PendingUserInput[] = [];
  for (const task of tasks) {
    if (task.status !== "awaiting_input" || task.cancelRequested) continue;
    const unfinished = task.plan.filter((step) => !["completed", "failed", "skipped"].includes(step.status));
    if (unfinished.length !== 1 || unfinished[0].status !== "awaiting_input") continue;
    const step = unfinished[0];
    try {
      const call = parseToolCommand(step.command, createCallId(), tools);
      const tool = call && tools.find((item) => item.id === call.toolId);
      if (!call || !tool?.enabled || tool.executionMode !== "user-input") continue;
      const request = parseUserInputArguments(call.arguments);
      requests.push({
        ...request,
        taskId: task.id,
        stepId: step.id,
        callId: call.id,
        roundId: task.currentRoundId,
        workflowEpoch: task.workflowEpoch ?? 0,
        serverId: task.executionTargetServerId ?? task.serverId,
        command: step.command,
      });
    } catch {
      // An invalid saved command must not create a form or resume execution.
    }
  }
  return requests;
}
