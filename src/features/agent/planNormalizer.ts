import { ensureStepValidator } from "@/services/validation";
import type { PlanStep } from "@/types";

export function normalizeSecretPlaceholders(value: string) {
  return value.replace(/\\+\$\{secret\.([A-Z0-9_]+)\}/g, "\${secret.$1}");
}

export function normalizePlanPreconditions(steps: PlanStep[], requirement = "") {
  const normalized = steps.map((step) => ({
    ...step,
    command: normalizeSecretPlaceholders(step.command),
    validation: normalizeSecretPlaceholders(step.validation),
  }));
  const userExplicitlyRequestedCleanup = /清理|删除|移除|卸载|清空|purge|remove|delete|uninstall/i
    .test(requirement);
  if (requirement && !userExplicitlyRequestedCleanup) {
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      const step = normalized[index];
      const speculativeCleanup = /清理|残留|删除.*(?:安装|目录|文件)|cleanup|remove residual/i
        .test(`${step.title}\n${step.description}`)
        && /\brm\s+-[^\n]*r[^\n]*f|\brm\s+-[^\n]*f[^\n]*r/i.test(step.command);
      if (speculativeCleanup) normalized.splice(index, 1);
    }
  }
  return normalized.map(ensureStepValidator);
}
