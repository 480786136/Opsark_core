import type { PermissionLevel, PlanStep } from "@/types";

const DESTRUCTIVE_COMMAND = /(rm\s+-rf|mkfs|fdisk|parted|userdel|DROP\s+(?:DATABASE|TABLE)|TRUNCATE\s+TABLE|iptables\s+-F|shutdown|reboot)/i;

/** Migrates removed or invalid persisted modes to the safest practical default. */
export function normalizePermissionLevel(value: unknown): PermissionLevel {
  if (value === "observe" || value === "safe" || value === "managed") return value;
  return "safe";
}

export function requiresStepApproval(permission: PermissionLevel, step: PlanStep): boolean {
  if (DESTRUCTIVE_COMMAND.test(step.command)) return true;
  if (step.risk === "high") return true;
  if (permission === "observe") return true;
  if (permission === "safe") return step.risk === "medium";
  return false;
}
