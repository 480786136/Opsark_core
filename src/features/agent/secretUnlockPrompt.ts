import type { PendingSecretRequest } from "@/features/tools/types";
import type { PlanStep } from "@/types";

const GENERIC_DESCRIPTIONS = new Set(["", "任务执行时请求的敏感变量", "敏感变量"]);

function inferSecretPurpose(step: PlanStep, key: string) {
  const context = `${step.title} ${step.description} ${step.command}`.toLowerCase();
  if (/(mysql|mariadb|postgres|database|数据库|数据源)/.test(context)) {
    return { label: "数据库登录密码", description: `用于“${step.title}”连接项目数据库并执行当前数据库操作。` };
  }
  if (/(ssh|scp|sftp|rsync|远程服务器|跳转|传输)/.test(context)) {
    return { label: "目标服务器 SSH 密码", description: `用于“${step.title}”登录目标服务器，不会作为明文写入命令。` };
  }
  if (/(api|token|令牌|接口)/.test(context) || /(TOKEN|API_KEY)/.test(key)) {
    return { label: "接口访问凭据", description: `用于“${step.title}”访问任务指定的接口或服务。` };
  }
  return { label: "执行所需敏感凭据", description: `用于解锁并继续执行“${step.title}”。` };
}

export function buildSecretUnlockRequest(input: {
  taskId: string;
  step: PlanStep;
  key: string;
  metadataDescription?: string;
}): PendingSecretRequest {
  const inferred = inferSecretPurpose(input.step, input.key);
  const description = input.metadataDescription?.trim() ?? "";
  return {
    taskId: input.taskId,
    stepId: input.step.id,
    key: input.key,
    label: GENERIC_DESCRIPTIONS.has(description) ? inferred.label : description,
    description: GENERIC_DESCRIPTIONS.has(description) ? inferred.description : description,
    unlockDescription: `安全提交后将解锁并继续执行“${input.step.title}”。该值仅在执行时注入，不会发送给模型，也不会显示在命令输出或普通日志中。`,
  };
}
