import { defaultToolCatalog } from "./toolCatalog";
import { officialToolEnabled } from "@/features/support/officialContent";
import { parseToolCommand } from "./toolExecutor";
import { resolveTaskSkills } from "@/features/skills/skillRegistry";
import type { SkillDefinition } from "@/features/skills/types";
import type { OpsTask, PlanStep } from "@/types";

export interface ExecutionPermissions { allowShell: boolean; toolIds: string[] }
export const permissionTools = defaultToolCatalog.filter(t => (t.modelExposure ?? "planner") === "planner");
export const permissionStorageKey = "opsark.executionPermissions";
function productPermissions(): ExecutionPermissions {
  return { allowShell: true, toolIds: permissionTools.map(t => t.id) };
}
export function readExecutionPermissions(): ExecutionPermissions {
  // Execution capabilities are an internal product policy in release builds.
  // End users still approve risky task steps, but cannot disable or reconfigure
  // the tool catalog from the product UI.
  if (!import.meta.env.DEV) return productPermissions();
  try {
    const saved = localStorage.getItem(permissionStorageKey);
    if (saved === null) return productPermissions();
    const raw = JSON.parse(saved);
    if (raw && typeof raw.allowShell === "boolean" && Array.isArray(raw.toolIds)) {
      return { allowShell: raw.allowShell, toolIds: permissionTools.filter(t => raw.toolIds.includes(t.id)).map(t => t.id) };
    }
  } catch { /* Corrupt or unavailable policy must not grant capabilities. */ }
  return { allowShell: false, toolIds: [] };
}
export function saveExecutionPermissions(policy: ExecutionPermissions) {
  if (!import.meta.env.DEV) return;
  localStorage.setItem(permissionStorageKey, JSON.stringify({ allowShell: policy.allowShell,
    toolIds: permissionTools.filter(t => policy.toolIds.includes(t.id)).map(t => t.id) }));
}

export function shellAllowed(task: OpsTask, skills: SkillDefinition[]) {
  return readExecutionPermissions().allowShell
    && resolveTaskSkills(task, skills).every(s => !s.builtIn || s.allowShell !== false);
}

/** The controller calls this again immediately before dispatch, independently of model-visible schemas. */
export function executionCapabilityBlocker(task: OpsTask, step: Pick<PlanStep, "command" | "validation">, skills: SkillDefinition[]): string | undefined {
  const policy = readExecutionPermissions();
  const selected = resolveTaskSkills(task, skills);
  let call;
  try { call = parseToolCommand(step.command, "permission-check"); } catch { return undefined; } // Existing dispatcher records malformed commands as failures without executing them.
  if (!call) return shellAllowed(task, skills) ? undefined : "执行权限禁止 Agent Shell；Skill 不能授予此权限。请调整权限或改用已授权工具。";
  if (!officialToolEnabled(call.toolId)) return `官方工具配置已停用或当前版本不支持：${call.toolId}`;
  if (!policy.toolIds.includes(call.toolId)) return `执行权限未授权工具：${call.toolId}`;
  if (selected.some(s => s.builtIn && s.forbiddenToolIds?.includes(call.toolId))) return `系统工作流禁止工具：${call.toolId}`;
  return undefined;
}
