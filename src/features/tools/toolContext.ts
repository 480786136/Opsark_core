import type { ToolDefinition } from "@/features/tools/types";
import type { SkillDefinition } from "@/features/skills/types";

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
}

function createJsonSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function buildToolContext(tools: ToolDefinition[]): ModelToolDefinition[] {
  return tools
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
  const forbidden = new Set(skills.flatMap((skill) => skill.forbiddenToolIds ?? []));
  const restrictToAllowLists = skills.length > 0
    && skills.every((skill) => skill.allowedToolIds !== undefined);
  const allowed = restrictToAllowLists
    ? new Set(skills.flatMap((skill) => skill.allowedToolIds ?? []))
    : undefined;
  if (skills.some((skill) => skill.planningContract)) allowed?.add("context.expand");
  allowed?.add("evidence.read");
  return tools.filter((tool) => (
    tool.enabled
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
