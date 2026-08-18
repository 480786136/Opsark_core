import {
  planDiscoveryContinuation,
  summarizeTaskExecution,
} from "@/features/agent/agentService";
import type {
  CompletionSummaryRequest,
  PlanDiscoveryContinuationInput,
  SummarizeTaskExecutionInput,
} from "@/features/agent/agentService";
import type { AuditEventDraft } from "@/features/agent/auditTrail";
import type { ModelProfile } from "@/types";

type ContinuationPlanner = (
  input: PlanDiscoveryContinuationInput,
) => ReturnType<typeof planDiscoveryContinuation>;
type TaskSummarizer = (
  input: SummarizeTaskExecutionInput,
) => ReturnType<typeof summarizeTaskExecution>;

export interface RunDiscoveryRefinementInput
  extends Omit<PlanDiscoveryContinuationInput, "model"> {
  model?: ModelProfile;
  isCancelled(): boolean;
  onStart(): void;
}

/** Resolves discovery continuation outcomes without mutating task or store state. */
export async function runDiscoveryRefinement(
  input: RunDiscoveryRefinementInput,
  planner: ContinuationPlanner = planDiscoveryContinuation,
) {
  if (!input.model || (input.model.provider !== "Built-in" && !input.apiKey)) {
    return {
      kind: "unavailable" as const,
      pauseReason: "发现阶段已完成，但模型不可用，无法依据真实证据生成后续变更计划。",
    };
  }

  try {
    const { isCancelled, onStart, ...planInput } = input;
    if (isCancelled()) return { kind: "cancelled" as const };
    onStart();
    const pending = await planner({ ...planInput, model: input.model });
    if (isCancelled()) return { kind: "cancelled" as const };

    const autoApprove = input.task.permission === "managed";
    const eventMessage = input.task.permission === "managed"
      ? `已根据发现证据生成 ${pending.length} 个后续步骤，完全托管模式自动批准并继续。`
      : `已根据发现证据生成 ${pending.length} 个后续步骤，请审批后继续。`;
    return { kind: "success" as const, pending, autoApprove, eventMessage };
  } catch (error) {
    if (input.isCancelled()) return { kind: "cancelled" as const };
    const pauseReason = `发现后续计划生成失败：${String(error)}`;
    return { kind: "failed" as const, pauseReason, eventMessage: pauseReason };
  }
}

interface TaskAuditScope {
  serverId: string;
  taskId: string;
  isCancelled(): boolean;
}

export interface RunTaskCompletionInput
  extends Omit<SummarizeTaskExecutionInput, "onModelRequest">, TaskAuditScope {}

/** Builds completion summary and audits before the caller commits final task state. */
export async function runTaskCompletion(
  input: RunTaskCompletionInput,
  summarizer: TaskSummarizer = summarizeTaskExecution,
) {
  const audits: AuditEventDraft[] = [];
  const onModelRequest = (request: CompletionSummaryRequest) => {
    audits.push({
      category: "model",
      level: "info",
      title: "提交执行结果总结请求",
      detail: JSON.stringify(request, null, 2),
      serverId: input.serverId,
      taskId: input.taskId,
    });
  };
  const completion = await summarizer({
    task: input.task,
    model: input.model,
    apiKey: input.apiKey,
    onModelRequest,
  });
  if (input.isCancelled()) {
    return { cancelled: true as const, completion, audits };
  }

  if (completion.usedModel) {
    audits.push({
      category: "model",
      level: "success",
      title: "模型执行总结已返回",
      detail: completion.summary,
      serverId: input.serverId,
      taskId: input.taskId,
    });
  }
  audits.push({
    category: "task",
    level: "success",
    title: "智能运维任务完成",
    detail: completion.summary,
    serverId: input.serverId,
    taskId: input.taskId,
  });
  return { cancelled: false as const, completion, audits };
}
