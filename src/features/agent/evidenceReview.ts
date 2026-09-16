import { isMutatingStepCommand, isReadOnlyStep } from "@/services/validation";
import type { PlanStep } from "@/types";
import { isRelatedRecoveryStep } from "./recoveryContract";

export {
  analyzeCommandFailure,
  classifyStepResult,
  ensureStepValidator,
  isMutatingStepCommand,
} from "@/services/validation";
export { isReadOnlyStep };

/**
 * Treat the authored effect as authoritative while retaining command inference
 * for legacy persisted plans that predate PlanStep.kind.
 */
export function isMutatingReviewStep(step: PlanStep) {
  return step.kind === "change" || isMutatingStepCommand(step.command);
}

export function isReadOnlyDiagnosticStep(step: PlanStep) {
  if (isMutatingReviewStep(step)) return false;
  return step.kind === "observe" || (isReadOnlyStep(step)
    && /检查|查看|查询|诊断|查找|获取|扫描|结构|确认|验证|复查|状态|日志|端口|进程|访问/.test(
      `${step.title} ${step.description}`,
    ));
}

function nextStepCanRecover(remainingSteps: PlanStep[], failedStep?: PlanStep) {
  const next = remainingSteps.find(step => step.status === "pending");
  return Boolean(failedStep && next && isRelatedRecoveryStep(failedStep, next));
}

export function remainingPlanCanRepairPostcondition(
  remainingSteps: PlanStep[],
  failedStep?: PlanStep,
) {
  return nextStepCanRecover(remainingSteps, failedStep);
}

export function remainingPlanResolvesBlockingSignal(
  step: PlanStep,
  remainingSteps: PlanStep[],
) {
  return nextStepCanRecover(remainingSteps, step);
}

export function postconditionHasHardBlocker(
  step: PlanStep,
  remainingSteps: PlanStep[],
  validationExitCode?: number,
) {
  if (step.result?.facts.validationProtocolIncomplete) {
    return "独立后置校验未返回真实结束标记，模型只能诊断原因，不能将该步骤判定为成功。";
  }
  if ([126, 127].includes(validationExitCode ?? -1)) {
    return "独立校验命令不可执行或不存在，不能由模型判定为成功。";
  }
  if (step.result?.facts.platformIncompatible) {
    return "程序已确认平台或 ABI 不兼容，模型不能覆盖该硬性事实。";
  }
  if (step.result?.facts.networkFailure) {
    return "程序已确认网络或下载失败，模型不能把未取得的目标结果判为成功。";
  }
  if (step.result?.facts.blockingSignal && !remainingPlanResolvesBlockingSignal(step, remainingSteps)) {
    return "程序已确认阻断条件，且剩余计划没有对应修复步骤。";
  }
  return undefined;
}

export function remainingPlanCanRecoverExecutionFailure(
  _category: unknown,
  remainingSteps: PlanStep[],
  failedStep?: PlanStep,
) {
  return nextStepCanRecover(remainingSteps, failedStep);
}
