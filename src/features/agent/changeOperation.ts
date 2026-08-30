import type { PlanStep, RiskLevel } from "@/types";

export type ChangeOperation =
  | "package_install"
  | "package_remove"
  | "account_delete"
  | "service_change"
  | "service_disable"
  | "resource_delete"
  | "network_policy_change"
  | "file_replace";

export function classifyChangeOperations(command: string): ChangeOperation[] {
  const operations = new Set<ChangeOperation>();
  if (/\b(?:apt(?:-get)?|dnf|yum|zypper|pacman)\s+(?:install|add|update|upgrade)\b/i.test(command)) operations.add("package_install");
  if (/\b(?:apt(?:-get)?|dnf|yum|zypper|pacman)\s+(?:remove|erase|purge|autoremove)\b|\b(?:npm|pip)\s+uninstall\b/i.test(command)) operations.add("package_remove");
  if (/\b(?:userdel|deluser)\b/i.test(command)) operations.add("account_delete");
  if (/\bsystemctl\s+(?:disable|mask)\b/i.test(command)) operations.add("service_disable");
  else if (/\bsystemctl\s+(?:start|stop|restart|reload)\b/i.test(command)) operations.add("service_change");
  if (/\brm\s|\bdocker\s+rm\b|\bkubectl\s+delete\b/i.test(command)) operations.add("resource_delete");
  if (/\b(?:iptables|nft|ufw|firewall-cmd)\b/i.test(command)) operations.add("network_policy_change");
  if (/\bsed\s+-i\b|\btruncate\b|\btee\b|(?:^|[;\n])[^\n]*>\s*\/?[^&]/i.test(command)) operations.add("file_replace");
  return [...operations];
}

export function semanticRiskForCommand(command: string): RiskLevel {
  const operations = classifyChangeOperations(command);
  if (
    operations.includes("account_delete")
    || operations.includes("network_policy_change")
    || /\brm\s+-[^\n]*r[^\n]*f|\b(?:mkfs|fdisk)\b|\bdrop\s+table\b/i.test(command)
    || (operations.includes("package_remove") && /\b(?:node|npm|python|openssh|systemd|kernel)\b/i.test(command))
    || (operations.includes("service_disable") && /\b(?:ssh|network|firewalld)\b/i.test(command))
  ) return "high";
  return operations.length || /\b(?:chmod|chown)\b/i.test(command) ? "medium" : "low";
}

export function validateAuthorizedChangeOperations(steps: PlanStep[], requirement: string) {
  const authorizedDestruction = /(?:卸载|移除|删除|清理|禁用|关闭|替换|uninstall|remove|delete|purge|disable|replace)/i.test(requirement);
  const destructive = steps.flatMap((step) => classifyChangeOperations(step.command)
    .filter((operation) => ["package_remove", "account_delete", "service_disable", "resource_delete"].includes(operation))
    .filter((operation) => operation !== "resource_delete"
      || (!/\bmktemp\b|\btrap\b[\s\S]*\brm\b|\brm\s+-f\s+\/?tmp\//i.test(step.command)
        && semanticRiskForCommand(step.command) === "high"))
    .map((operation) => ({ step, operation })));
  if (!authorizedDestruction && destructive.length) {
    const first = destructive[0];
    throw new Error(`计划扩大了用户授权范围：步骤“${first.step.title}”包含 ${first.operation}，但用户未要求删除、卸载或禁用`);
  }
}
