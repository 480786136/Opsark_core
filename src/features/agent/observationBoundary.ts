import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import type { ToolDefinition } from "@/features/tools/types";
import { isMutatingStepCommand } from "@/services/validation";
import type { OpsTask, PlanStep } from "@/types";
import { taskDecisionEvidenceIds } from "./taskDecisionResolution";
import { isRemoteToolObservation } from "./toolEvidenceScope";

export interface ObservationBoundary {
  nextStepId: string;
  observedStepIds: string[];
  evidenceIds: string[];
  pendingStepIds: string[];
  instruction: string;
}

const waiting = (step: PlanStep) => ["pending", "awaiting_approval"].includes(step.status);

function changesState(step: PlanStep, tools: ToolDefinition[]) {
  if (step.sessionContextChange || step.executionIntent?.semantic.effect === "change") return true;
  if (step.action?.type === "tool") {
    const toolId = step.action.toolId;
    const effect = tools.find(tool => tool.id === toolId)?.effect;
    // Questions and local context reads retain their own coordination paths.
    return effect ? effect === "change" : step.kind !== "observe";
  }
  return step.kind !== "observe" || isMutatingStepCommand(step.command);
}

function remoteObservation(step: PlanStep) {
  if (step.kind !== "observe" || step.status !== "completed" || step.sessionContextChange
    || step.result?.executionStatus !== "success" || step.result.facts.commandDispatched === false) return false;
  return step.action?.type === "tool" ? isRemoteToolObservation(step.action.toolId)
    : step.executionScope !== "user_action" && !isMutatingStepCommand(step.command);
}

/** A successful discovery proves that the observation ran, not that the next
 * write's prerequisites hold. Review once at the read-to-change boundary of
 * the current proposal. The existing stage replacement archives those reads,
 * so the accepted replacement does not need a second approval marker.
 *
 * Never interpret expected/description, rewrite commands, or discard pending
 * work here. Actual results remain in the normal decision snapshot. Independent
 * reads keep executing together; observations from older phases do not create
 * another boundary for an already-generated replacement plan. */
export function observationBoundary(
  task: OpsTask,
  nextStep: PlanStep | undefined = task.plan.find(waiting),
  tools: ToolDefinition[] = defaultToolCatalog,
): ObservationBoundary | undefined {
  if (!nextStep || !waiting(nextStep) || !changesState(nextStep, tools)) return undefined;
  const nextIndex = task.plan.findIndex(step => step.id === nextStep.id);
  if (nextIndex <= 0) return undefined;
  const available = new Set(taskDecisionEvidenceIds(task));
  const observations = task.plan.slice(0, nextIndex).filter(remoteObservation).map(step => ({
    stepId: step.id,
    evidenceIds: (step.evidence ?? []).filter(evidence => evidence.source === "main"
      && step.result!.evidenceIds.includes(evidence.id) && available.has(evidence.id)).map(evidence => evidence.id),
  })).filter(item => item.evidenceIds.length);
  if (!observations.length) return undefined;
  return {
    nextStepId: nextStep.id,
    observedStepIds: observations.map(item => item.stepId),
    evidenceIds: [...new Set(observations.flatMap(item => item.evidenceIds))],
    pendingStepIds: task.plan.slice(nextIndex).filter(waiting).map(step => step.id),
    instruction: "当前计划中的只读发现已有真实结果，后续变更尚未执行。先根据这些结果判断原变更前提是否成立，再生成剩余计划；检查执行成功不等于端口空闲、目录可覆盖或服务可替换。复用仍适用的已完成观察，不重复同一批检查；独立只读检查可合并。不得凭描述猜测未知结果，也不得删除、停止或覆盖归属未确认的资源。需要变更时保持当前授权，执行命令内再次检查会发生竞态的前提，检查失败立即退出，再独立验收实际目标。",
  };
}
