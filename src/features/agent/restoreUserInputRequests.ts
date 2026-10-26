import { parseToolAction, parseUserInputArguments } from "@/features/tools/toolExecutor";
import type { PendingUserInput, ToolDefinition } from "@/features/tools/types";
import type { OpsTask } from "@/types";
import { deletionConfirmation, invalidateDeletionConfirmation } from "./confirmedFileDeletion";

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
      if (step.command || step.validation) continue;
      const call = parseToolAction(step.action, createCallId(), tools);
      const tool = call && tools.find((item) => item.id === call.toolId);
      if (!call || !tool?.enabled || tool.executionMode !== "user-input") continue;
      const deletionPreviewId = call.toolId === "files.confirm_deletion" ? String(call.arguments.previewId) : undefined;
      const request = deletionPreviewId ? deletionConfirmation(task, deletionPreviewId) : parseUserInputArguments(call.arguments);
      requests.push({
        ...request,
        taskId: task.id,
        stepId: step.id,
        callId: call.id,
        toolId: call.toolId,
        deletionPreviewId,
        roundId: task.currentRoundId,
        workflowEpoch: task.workflowEpoch ?? 0,
        serverId: task.executionTargetServerId ?? task.serverId,
        command: JSON.stringify(step.action),
      });
    } catch (error) {
      if (step.action?.type === "tool" && step.action.toolId === "files.confirm_deletion") {
        invalidateDeletionConfirmation(task, step, String(step.action.arguments.previewId),
          `已保存的文件删除确认已失效，需要重新预览：${error instanceof Error ? error.message : String(error)}`);
      }
      // An invalid saved command must not create a form or resume execution.
    }
  }
  return requests;
}
