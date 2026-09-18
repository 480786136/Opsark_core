import type { ToolDefinition } from "@/features/tools/types";
import type { SkillDefinition } from "@/features/skills/types";
import { readExecutionPermissions } from "./executionPermissions";
import { effectiveOfficialTool, officialToolEnabled } from "@/features/support/officialContent";

export interface ModelToolDefinition {
  id: string;
  name: string;
  description: string;
  usageInstructions: string;
  inputSchema: Record<string, unknown>;
  outputDescription: string;
  planMode: NonNullable<ToolDefinition["planMode"]>;
  completionMode: NonNullable<ToolDefinition["completionMode"]>;
  version: number;
  configurationVersion?: number;
}

function createJsonSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function buildToolContext(tools: ToolDefinition[]): ModelToolDefinition[] {
  return tools
    .map(effectiveOfficialTool)
    .filter((tool) => tool.enabled && (tool.modelExposure ?? "planner") === "planner")
    .map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      usageInstructions: tool.usageInstructions,
      // Pinia wraps nested schemas in proxies, which structuredClone cannot clone.
      inputSchema: createJsonSnapshot(tool.inputSchema),
      outputDescription: tool.outputDescription,
      planMode: tool.planMode ?? "regular",
      completionMode: tool.completionMode ?? "continue",
      version: tool.version,
      ...(tool.configurationVersion ? { configurationVersion: tool.configurationVersion } : {}),
    }));
}

/**
 * Applies the trusted Skill-level tool policy before full schemas enter a
 * model request. Legacy/custom Skills without an allow-list deliberately keep
 * the complete planner-visible catalog so an optimization cannot remove an
 * unknown business capability.
 */
export function selectPlanningTools(
  tools: ToolDefinition[],
  skills: SkillDefinition[] = [],
): ToolDefinition[] {
  const forbidden = new Set(skills.filter((skill) => skill.builtIn).flatMap((skill) => skill.forbiddenToolIds ?? []));
  const policySkills = skills.filter((skill) => skill.builtIn);
  const restrictToAllowLists = policySkills.length > 0
    && policySkills.every((skill) => skill.allowedToolIds !== undefined);
  const allowed = restrictToAllowLists
    ? new Set(policySkills.flatMap((skill) => skill.allowedToolIds ?? []))
    : undefined;
  if (skills.some((skill) => skill.planningContract)) allowed?.add("context.expand");
  allowed?.add("evidence.read");
  // Clarification stays available when a Skill omits the basic interaction.
  allowed?.add("user.request_input");
  const granted = new Set(readExecutionPermissions().toolIds);
  return tools.filter((tool) => (
    tool.enabled
    && officialToolEnabled(tool.id)
    && granted.has(tool.id)
    && skills.every(skill => !skill.builtIn || !skill.allowedToolIds || skill.allowedToolIds.includes(tool.id)
      || tool.id === "user.request_input" || tool.id === "evidence.read")
    && (tool.modelExposure ?? "planner") === "planner"
    && !forbidden.has(tool.id)
    && (!allowed || allowed.has(tool.id))
  ));
}

export function buildPlanningToolContext(
  tools: ToolDefinition[],
  skills: SkillDefinition[] = [],
) {
  return buildToolContext(selectPlanningTools(tools, skills));
}
