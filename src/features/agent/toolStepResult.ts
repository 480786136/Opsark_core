import { enforceToolResult } from "@/features/tools/toolResultContract";
import type { ExecutionEvidence, PlanStep, StepResult, StepReview } from "@/types";
import type { ToolCall, ToolResult } from "@/features/tools/types";
import { buildToolEvidenceFacts } from "@/features/tools/toolEvidence";

export interface ToolStepOutcome {
  status: "completed" | "failed";
  output: string;
  progressMessage: string;
  result: StepResult;
  evidence?: ExecutionEvidence[];
  review?: StepReview;
  eventMessage: string;
  pauseReason?: string;
}

export interface BuildToolStepOutcomeInput {
  call: ToolCall;
  result: ToolResult;
  completedAt: string;
  evidenceId: string;
}

/** Builds the deterministic step fields produced by a model-invoked tool call. */
function serverConnectPartialFacts(call: ToolCall, result: ToolResult): Record<string, boolean | string> | undefined {
  if (call.toolId !== "server.connect" || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) return undefined;
  const data = result.data as Record<string, unknown>;
  const facts: Record<string, boolean | string> = {};
  for (const key of ["connectionCheckDispatched", "connectionChecked", "directoryUpdated", "connected", "taskTargetUpdated",
    "agentSessionPrepared", "agentSessionDispatched", "agentSessionCreationDispatched", "agentSessionCreated", "agentSessionRegistered",
    "credentialStorageDispatched", "credentialStored"]) {
    if (typeof data[key] === "boolean") facts[key] = data[key];
  }
  if (typeof data.serverId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(data.serverId)) facts.serverId = data.serverId;
  return Object.keys(facts).length ? facts : undefined;
}

export function buildToolStepOutcome(input: BuildToolStepOutcomeInput): ToolStepOutcome {
  const { call, completedAt, evidenceId } = input;
  const result = enforceToolResult(call, input.result);
  if (!result.success) {
    const failureReason = result.error?.message ?? "未知错误";
    const partialEffects = serverConnectPartialFacts(call, result);
    return {
      status: "failed",
      output: result.error?.message ?? "工具调用失败",
      progressMessage: "工具调用失败",
      result: {
        executionStatus: "failed",
        observationStatus: "unknown",
        facts: { toolId: call.toolId, errorCode: result.error?.code, category: result.error?.category,
          dispatchState: result.error?.dispatchState, commandDispatched: result.error?.dispatchState === "not_sent" ? false : undefined,
          argumentPath: result.error?.argumentPath, attempts: result.attempts,
          ...(partialEffects ? { partialEffects } : {}) },
        warnings: [],
        evidenceIds: [],
        failureReason: result.error?.message,
      },
      eventMessage: `工具 ${call.toolId} 调用失败：${failureReason}`,
      pauseReason: `工具 ${call.toolId} 调用失败：${failureReason}`,
    };
  }

  const truncated = result.truncated === true || (result.data !== null && typeof result.data === "object"
    && "truncated" in result.data && result.data.truncated === true);
  const output = JSON.stringify(result.data, null, 2);
  const facts: Record<string, unknown> = {
    toolId: call.toolId,
    attempts: result.attempts,
    truncated,
    ...buildToolEvidenceFacts(call, result),
  };
  const missingPath = facts.evidenceKind === "path_state" && facts.pathExists === false;
  const inspectionMessages: Record<string, string> = {
    complete: truncated ? "检查完成，返回前 N 项或受限输出；请结合范围判断。" : "已完成请求范围内的检查。",
    no_match: "已检查请求范围，未发现符合条件的条目。",
    partial: "检查部分完成，请核对跳过范围和限制。",
    timeout: "检查达到时间限制，已保留取得的部分结果。",
    cancelled: "检查已取消，已取得的结果仅供参考。",
    permission_denied: "检查遇到权限不足，不能据此判断目标不存在或正常。",
    unsupported: "当前环境不支持此检查，请选择已授权的替代方法。",
    error: "检查返回错误，请结合真实退出码和范围处理。",
  };
  const inspectionMessage = facts.evidenceKind === "operations_inspection" ? inspectionMessages[String(facts.inspectionStatus)] : undefined;
  if (call.toolId === "context.expand" && result.data && typeof result.data === "object"
    && "skillId" in result.data && typeof result.data.skillId === "string") {
    Object.assign(facts, { expandedSkillId: result.data.skillId });
  }
  const successSummary = inspectionMessage ?? (missingPath ? "已确认目标路径不存在；这不是目录内容或部署完成证据。" : truncated
    ? "工具已返回部分结构化证据。"
    : "工具已返回结构化证据。");
  return {
    status: "completed",
    output,
    progressMessage: inspectionMessage ?? (missingPath ? "已确认路径不存在" : truncated ? "工具结果已截断" : "工具调用完成"),
    evidence: [{
      id: evidenceId,
      type: "command-output",
      source: "main",
      facts,
      rawOutput: output,
      collectedAt: completedAt,
    }],
    result: {
      executionStatus: "success",
      observationStatus: truncated ? "warning" : "matched",
      facts,
      warnings: truncated ? [inspectionMessage ?? "工具结果达到限制，后续应缩小范围继续获取。"] : [],
      evidenceIds: [evidenceId],
    },
    review: {
      decision: "continue",
      reason: "工具调用成功并返回结构化证据",
      summary: successSummary,
      source: "rules",
    },
    eventMessage: inspectionMessage ? `工具 ${call.toolId}：${inspectionMessage}` : missingPath ? `工具 ${call.toolId} 已确认路径不存在：${facts.evidenceScope}` : truncated
      ? `工具 ${call.toolId} 已返回部分结果，达到处理限制。`
      : `工具 ${call.toolId} 已返回完整结果。`,
  };
}

/** Applies a previously built tool outcome while preserving step object identity. */
export function applyToolStepOutcome(step: PlanStep, outcome: ToolStepOutcome): void {
  step.output = outcome.output;
  step.progressMessage = outcome.progressMessage;
  step.result = outcome.result;
  step.evidence = outcome.evidence;
  step.review = outcome.review;
}
