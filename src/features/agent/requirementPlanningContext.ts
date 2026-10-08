import type { OpsTask, RequirementProcessingResult, TaskRequirementLifecycle } from "@/types";
import { applyTaskRequirementUpdate } from "./taskRequirements";
import { modelTaskRequirementSnapshot } from "./taskGoal";

/** Classification and any local plan repair must use the same updated scope.
 * This is a proposal projection only; the owning store commits after its epoch check. */
export function projectClassifiedRequirementContext(
  context: Record<string, any>,
  result: RequirementProcessingResult,
  requirement: string,
): { context: Record<string, any>; previousLifecycle?: TaskRequirementLifecycle; nextLifecycle?: TaskRequirementLifecycle } {
  if (!result.requirementUpdate) return { context, previousLifecycle: undefined, nextLifecycle: undefined };
  const update = result.requirementUpdate;
  const previous = context.taskGoal ?? context.baseSnapshot?.taskRequirements ?? {};
  const separateGoal = ["new_goal", "replace_goal"].includes(result.relation ?? "");
  const empty: TaskRequirementLifecycle = { version: 1, revision: update.baseRevision, items: [],
    focus: { requirementIds: [] } };
  const state = separateGoal ? empty : context.requirementSubmission?.baseLifecycle ?? previous.lifecycle;
  if (!state) throw new Error("需求更新缺少原始版本，不能用旧范围修复计划。");
  if (result.relation === "continue" && (update.additions.length || update.changes.length)) {
    throw new Error("继续执行只能恢复既有要求；修改需求应归类为 supplement。");
  }
  const submission = context.requirementSubmission;
  const content = submission?.content ?? requirement;
  const task: OpsTask = {
    id: context.baseSnapshot?.task?.id ?? "requirement-projection", serverId: "", modelId: "",
    title: separateGoal ? requirement : previous.rootGoal ?? requirement,
    rootGoal: separateGoal ? requirement : previous.rootGoal,
    currentInstruction: result.relation === "continue" ? previous.currentInstruction : requirement,
    lastRequirementRelation: result.relation, currentRoundId: previous.currentRoundId,
    status: "planning", permission: "safe", messages: [], plan: [], createdAt: "", updatedAt: "",
    requirementLifecycle: state,
  };
  task.requirementLifecycle = applyTaskRequirementUpdate(task, update, { source: {
    content, source: "user_message", relation: separateGoal ? result.relation as "new_goal" | "replace_goal" : "supplement",
    sourceMessageId: submission?.sourceMessageId ?? update.sourceMessageId,
    createdAt: submission?.createdAt,
  }, roundId: task.currentRoundId });
  const taskGoal = modelTaskRequirementSnapshot(task);
  const { baseLifecycle: _localLifecycle, ...publicSubmission } = submission ?? {};
  return { previousLifecycle: state as TaskRequirementLifecycle, nextLifecycle: task.requirementLifecycle,
    context: { ...context, taskGoal, requirementUpdate: update,
    ...(submission ? { requirementSubmission: publicSubmission } : {}),
    ...(context.baseSnapshot ? { baseSnapshot: { ...context.baseSnapshot, taskRequirements: taskGoal,
      ...(context.baseSnapshot.taskGoal ? { taskGoal } : {}) } } : {}) } };
}
