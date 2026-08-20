import { ensureStepValidator } from "@/services/validation";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { parseToolCommand } from "@/features/tools/toolExecutor";
import type { ToolDefinition } from "@/features/tools/types";
import type { PlanStep } from "@/types";

export function normalizeSecretPlaceholders(value: string) {
  return value.replace(/\\+\$\{secret\.([A-Z0-9_]+)\}/g, "\${secret.$1}");
}

const PACKAGE_MANAGER_COMMAND = /^\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?:sudo(?:\s+-\S+)*\s+)?(?:dnf|yum|apt-get|apt|zypper|pacman)\b/;
const BUFFERING_TAIL_PIPE = /\s+(2>&1\s*)?\|\s*tail\s+(?:-\d+|-n\s*\d+|--lines(?:=|\s+)\d+)\s*$/;

/** 包管理器的整段 tail 管道会吞掉实时输出并遮蔽真实退出码。 */
export function normalizeLongRunningCommandOutput(command: string) {
  return command
    .split("\n")
    .map((line) => {
      if (!PACKAGE_MANAGER_COMMAND.test(line) || !BUFFERING_TAIL_PIPE.test(line)) return line;
      return line.replace(BUFFERING_TAIL_PIPE, (_match, redirect: string | undefined) => (
        redirect ? ` ${redirect.trim()}` : ""
      ));
    })
    .join("\n");
}

export function normalizePlanPreconditions(
  steps: PlanStep[],
  requirement = "",
  tools: ToolDefinition[] = defaultToolCatalog,
) {
  let normalized = steps.map((step) => ({
    ...step,
    command: normalizeLongRunningCommandOutput(normalizeSecretPlaceholders(step.command)),
    validation: normalizeSecretPlaceholders(step.validation),
  }));
  const toolById = new Map(tools.map((tool) => [tool.id, tool]));
  const standaloneStep = normalized.find((step, index) => {
    if (step.status !== "pending") return false;
    try {
      const call = parseToolCommand(step.command, `normalize-${index}`);
      return Boolean(call && toolById.get(call.toolId)?.planMode === "standalone");
    } catch {
      return false;
    }
  });
  if (standaloneStep) {
    normalized = [
      ...normalized.filter((step) => step.status !== "pending"),
      standaloneStep,
    ];
  }
  const userExplicitlyRequestedCleanup = /清理|删除|移除|卸载|清空|purge|remove|delete|uninstall/i
    .test(requirement);
  if (requirement && !userExplicitlyRequestedCleanup) {
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      const step = normalized[index];
      if (step.status !== "pending") continue;
      const speculativeCleanup = /清理|残留|删除.*(?:安装|目录|文件)|cleanup|remove residual/i
        .test(`${step.title}\n${step.description}`)
        && /\brm\s+-[^\n]*r[^\n]*f|\brm\s+-[^\n]*f[^\n]*r/i.test(step.command);
      if (speculativeCleanup) normalized.splice(index, 1);
    }
  }
  return normalized.map(ensureStepValidator);
}
