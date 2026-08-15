import type { ExecutionEvidence, PlanStep, StepResult, StepReview } from "@/types";
import type { ToolCall, ToolResult } from "@/features/tools/types";

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
export function buildToolStepOutcome(input: BuildToolStepOutcomeInput): ToolStepOutcome {
  const { call, result, completedAt, evidenceId } = input;
  if (!result.success) {
    const failureReason = result.error?.message ?? "未知错误";
    return {
      status: "failed",
      output: result.error?.message ?? "工具调用失败",
      progressMessage: "工具调用失败",
      result: {
        executionStatus: "failed",
        observationStatus: "unknown",
        facts: { toolId: call.toolId, errorCode: result.error?.code },
        warnings: [],
        evidenceIds: [],
        failureReason: result.error?.message,
      },
      eventMessage: `工具 ${call.toolId} 调用失败：${failureReason}`,
      pauseReason: `工具 ${call.toolId} 调用失败：${failureReason}`,
    };
  }

  const truncated = result.truncated === true;
  const output = JSON.stringify(result.data, null, 2);
  const facts = { toolId: call.toolId, truncated };
  return {
    status: "completed",
    output,
    progressMessage: truncated ? "工具结果已截断" : "工具调用完成",
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
      warnings: truncated ? ["工具结果达到限制，后续应缩小范围继续获取。"] : [],
      evidenceIds: [evidenceId],
    },
    review: {
      decision: "continue",
      reason: "工具调用成功并返回结构化证据",
      summary: truncated ? "已获得部分目录结构。" : "已获得目录结构。",
      source: "rules",
    },
    eventMessage: truncated
      ? `工具 ${call.toolId} 已返回部分结果，达到遍历限制。`
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

