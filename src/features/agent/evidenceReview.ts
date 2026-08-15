import { isReadOnlyStep } from "@/services/validation";
import type { PlanStep } from "@/types";

export {
  analyzeCommandFailure,
  classifyStepResult,
  ensureStepValidator,
  isMutatingStepCommand,
} from "@/services/validation";
export { isReadOnlyStep };

export function isReadOnlyDiagnosticStep(step: PlanStep) {
  return isReadOnlyStep(step)
    && /检查|查看|查询|诊断|查找|获取|扫描|结构|确认|验证|复查|状态|日志|端口|进程|访问/.test(
      `${step.title} ${step.description}`,
    );
}

export function requiresReadOnlyDiagnosis(requirement: string) {
  const asksForChange = /修复|解决|处理掉|重启|重新加载|启动|停止|部署|安装|卸载|升级|修改|配置|创建|删除|切换|执行|帮我.*(?:部署|安装|修复|重启)/.test(requirement);
  const reportsOrChecksSymptom = /检查|查看.*(?:状态|情况)|运行情况|空白|白屏|打不开|无法访问|访问失败|超时|报错|异常|为什么/.test(requirement);
  return reportsOrChecksSymptom && !asksForChange;
}

export function remainingPlanCanRepairPostcondition(remainingSteps: PlanStep[]) {
  return remainingSteps.some((item) =>
    /修复|解决|恢复|替代|调整|准备|应用|变更|重试|重新|安装|升级|创建|配置|设置|授权|启动|部署|加载/.test(
      `${item.title}\n${item.description}`,
    ),
  );
}

export function remainingPlanResolvesBlockingSignal(
  _step: PlanStep,
  remainingSteps: PlanStep[],
) {
  return remainingPlanCanRepairPostcondition(remainingSteps);
}

export function postconditionHasHardBlocker(
  step: PlanStep,
  remainingSteps: PlanStep[],
  validationExitCode?: number,
) {
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
) {
  return remainingPlanCanRepairPostcondition(remainingSteps);
}
