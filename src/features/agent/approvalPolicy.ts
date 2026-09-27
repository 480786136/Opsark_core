import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { effectiveOfficialTool } from "@/features/support/officialContent";
import type { ToolDefinition } from "@/features/tools/types";
import type { PermissionLevel, PlanStep } from "@/types";

const DESTRUCTIVE_COMMAND = /(rm\s+-rf|mkfs|fdisk|parted|userdel|DROP\s+(?:DATABASE|TABLE)|TRUNCATE\s+TABLE|iptables\s+-F|shutdown|reboot)/i;

/** Migrates removed or invalid persisted modes to the safest practical default. */
export function normalizePermissionLevel(value: unknown): PermissionLevel {
  if (value === "observe" || value === "safe" || value === "managed") return value;
  return "safe";
}

export function requiresStepApproval(
  permission: PermissionLevel,
  step: PlanStep,
  tools: ToolDefinition[] = defaultToolCatalog,
): boolean {
  const toolId = step.action?.type === "tool" ? step.action.toolId : undefined;
  const registered = toolId ? tools.find(tool => tool.id === toolId) : undefined;
  const tool = registered ? effectiveOfficialTool(registered) : undefined;
  const effect = tool?.effect ?? "change";
  // Approval does not make an unavailable capability executable. Fail closed
  // here too so an unknown/disabled tool cannot obtain a policy grant.
  if (toolId && (!tool?.enabled || effect === "change" && step.kind !== "change")) return true;
  if (step.protocolReplanApproval) return true;
  if (DESTRUCTIVE_COMMAND.test(step.command)) return true;
  if (step.risk === "high") return true;
  if (permission === "observe") return true;
  if (permission === "safe") {
    return step.risk === "medium" || Boolean(toolId && effect === "change");
  }
  return false;
}
