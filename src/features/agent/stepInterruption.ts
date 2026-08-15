import { transitionStep } from "@/features/agent/stepMachine";
import type { PlanStep } from "@/types";

export interface StepFailureOutcome {
  pauseReason: string;
  eventMessage: string;
}

/** Marks an active step as cancelled while retaining any evidence already collected. */
export function cancelStep(step: PlanStep, reason: string): void {
  transitionStep(step, "skipped");
  step.progressMessage = reason;
  step.result = {
    executionStatus: "cancelled",
    observationStatus: "unknown",
    facts: { cancelled: true },
    warnings: [],
    evidenceIds: step.evidence?.map((item) => item.id) ?? [],
    failureReason: reason,
  };
}

/** Records a tool protocol parse failure before any remote command is executed. */
export function failToolCommandParsing(step: PlanStep, error: unknown): StepFailureOutcome {
  const detail = String(error);
  const pauseReason = `工具命令解析失败：${detail}`;
  transitionStep(step, "failed");
  step.output = detail;
  step.progressMessage = "工具命令解析失败";
  step.result = {
    executionStatus: "failed",
    observationStatus: "unknown",
    facts: { commandCompleted: false, category: "tool_command_parse" },
    warnings: [],
    evidenceIds: [],
    failureReason: pauseReason,
  };
  return { pauseReason, eventMessage: pauseReason };
}

/** Records an unexpected orchestration failure without discarding existing evidence. */
export function failUnexpectedStep(step: PlanStep, error: unknown): StepFailureOutcome {
  const detail = String(error);
  const pauseReason = `步骤“${step.title}”执行异常：${detail}。任务已暂停，可生成调整计划后继续。`;
  transitionStep(step, "failed");
  step.progressMessage = "步骤执行异常";
  step.result = {
    executionStatus: "failed",
    observationStatus: "unknown",
    facts: { commandCompleted: false, category: "execution_exception" },
    warnings: [],
    evidenceIds: step.evidence?.map((item) => item.id) ?? [],
    failureReason: pauseReason,
  };
  return { pauseReason, eventMessage: pauseReason };
}

/** Moves a step into sensitive-input wait without treating the pause as a failure. */
export function waitForStepSecret(step: PlanStep, key: string): void {
  transitionStep(step, "awaiting_input");
  step.progressMessage = `等待敏感变量 ${key}`;
}

/** Returns a step to the execution queue after its sensitive input is confirmed. */
export function resumeStepAfterSecret(step: PlanStep): void {
  transitionStep(step, "pending");
  step.progressMessage = "敏感变量已确认，准备继续执行";
}

