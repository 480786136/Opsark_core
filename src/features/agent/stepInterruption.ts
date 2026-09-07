import { transitionStep } from "@/features/agent/stepMachine";
import type { PlanStep } from "@/types";
import { formatPlanSafetyIssues } from "@/features/agent/planSafety";
import type { PlanSafetyIssue } from "@/features/agent/planSafety";

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

/** Prevents a saved credential from being silently reused for a different service. */
export function failSecretPurposeMismatch(step: PlanStep, key: string, description: string): StepFailureOutcome {
  const pauseReason = `敏感变量 ${key} 的已保存用途为“${description}”，与步骤“${step.title}”所需凭据不一致。系统已阻止复用；请生成调整方案并使用语义明确的新变量收集正确凭据。`;
  transitionStep(step, "failed");
  step.progressMessage = "敏感变量用途不匹配";
  step.result = {
    executionStatus: "failed",
    observationStatus: "unknown",
    facts: { commandCompleted: false, category: "secret_purpose_mismatch", secretKey: key },
    warnings: [],
    evidenceIds: [],
    failureReason: pauseReason,
  };
  return { pauseReason, eventMessage: pauseReason };
}

/** Blocks an interactive command whose credential binding is missing, ambiguous or unsafe. */
export function failInteractiveCredentialResolution(
  step: PlanStep,
  code: string,
  detail: string,
): StepFailureOutcome {
  const pauseReason = `${detail}。已在启动交互终端前阻止执行；请修正凭据组引用或认证方案后重试。`;
  transitionStep(step, "failed");
  step.output = undefined;
  step.progressMessage = "交互凭据绑定失败，未启动 PTY";
  step.result = {
    executionStatus: "blocked",
    observationStatus: "unknown",
    facts: {
      commandCompleted: false,
      validationCompleted: false,
      category: "interactive_credential_resolution",
      credentialResolutionCode: code,
      ptyStarted: false,
    },
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

/** Rejects an unsafe plan before any terminal or remote-execution side effect. */
export function failPlanSafetyCheck(step: PlanStep, findings: PlanSafetyIssue[]): StepFailureOutcome {
  const primary = findings[0];
  const pauseReason = formatPlanSafetyIssues(step.title, findings);
  transitionStep(step, "failed");
  step.output = undefined;
  step.progressMessage = "执行前安全检查未通过，未发送到服务器";
  step.result = {
    executionStatus: "blocked",
    observationStatus: "unknown",
    facts: {
      commandCompleted: false,
      validationCompleted: false,
      category: "plan_safety_rejection",
      field: primary.field,
      ruleId: primary.ruleId,
      reason: primary.reason,
      snippet: primary.snippet,
      repairable: primary.repairable,
      issues: findings,
    },
    warnings: [],
    evidenceIds: [],
    failureReason: pauseReason,
  };
  return { pauseReason, eventMessage: pauseReason };
}

/**
 * Records a postcondition protocol failure after the main command has already
 * returned successfully. The main execution fact is retained, but the step may
 * not be completed without a real validation exit marker.
 */
export function failValidationProtocol(step: PlanStep, error: unknown): StepFailureOutcome {
  const detail = String(error);
  const pauseReason = `步骤“${step.title}”的独立后置校验未能确认真实退出：${detail}`;
  step.progressMessage = "后置校验通道异常，正在进行模型复核";
  step.result = {
    executionStatus: "success",
    observationStatus: "unknown",
    facts: {
      commandCompleted: true,
      validationCompleted: false,
      validationProtocolIncomplete: true,
      category: "validation_protocol_exception",
    },
    warnings: [detail],
    evidenceIds: step.evidence?.map((item) => item.id) ?? [],
    failureReason: pauseReason,
  };
  return {
    pauseReason,
    eventMessage: `${pauseReason}。正在让模型结合主命令输出诊断；在取得真实校验退出码前不会判定步骤成功。`,
  };
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
