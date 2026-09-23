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
 * Skills describe workflows, not capabilities. Keep the optional argument for
 * callers carrying legacy Skill snapshots; only live product grants and tool
 * visibility determine the model's capability directory.
 */
export function selectPlanningTools(
  tools: ToolDefinition[],
  _skills: SkillDefinition[] = [],
): ToolDefinition[] {
  const granted = new Set(readExecutionPermissions().toolIds);
  return tools.filter((tool) => (
    tool.enabled
    && officialToolEnabled(tool.id)
    && granted.has(tool.id)
    && (tool.modelExposure ?? "planner") === "planner"
  ));
}

export function buildPlanningToolContext(
  tools: ToolDefinition[],
  skills: SkillDefinition[] = [],
) {
  return buildToolContext(selectPlanningTools(tools, skills));
}
