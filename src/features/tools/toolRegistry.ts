import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { normalizeToolDefinition } from "@/features/tools/toolValidation";
import type { ToolDefinition, ToolOverride } from "@/features/tools/types";

const EDITABLE_FIELDS = [
  "name",
  "description",
  "usageInstructions",
  "outputDescription",
  "enabled",
  "updatedAt",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseToolOverrides(value: unknown): ToolOverride[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string") return [];
    const override: ToolOverride = { id: item.id };
    for (const field of EDITABLE_FIELDS) {
      const fieldValue = item[field];
      if (field === "enabled") {
        if (typeof fieldValue === "boolean") override.enabled = fieldValue;
      } else if (typeof fieldValue === "string") {
        override[field] = fieldValue;
      }
    }
    return [override];
  });
}

export function resolveToolRegistry(
  overrides: ToolOverride[],
  catalog: ToolDefinition[] = defaultToolCatalog,
): ToolDefinition[] {
  const overrideById = new Map(overrides.map((item) => [item.id, item]));
  return catalog.map((definition) => {
    const override = overrideById.get(definition.id);
    if (!override) return structuredClone(definition);
    return normalizeToolDefinition({
      ...structuredClone(definition),
      ...override,
      // Security-sensitive fields always come from the trusted catalog.
      id: definition.id,
      implementation: definition.implementation,
      inputSchema: structuredClone(definition.inputSchema),
      planMode: definition.planMode,
      completionMode: definition.completionMode,
      refinementScope: definition.refinementScope,
      executionMode: definition.executionMode,
      builtIn: definition.builtIn,
      version: definition.version,
    });
  });
}

export function createToolOverrides(
  tools: ToolDefinition[],
  catalog: ToolDefinition[] = defaultToolCatalog,
): ToolOverride[] {
  const defaults = new Map(catalog.map((tool) => [tool.id, tool]));
  return tools.flatMap((tool) => {
    const defaultTool = defaults.get(tool.id);
    if (!defaultTool) return [];
    const override: ToolOverride = { id: tool.id };
    for (const field of EDITABLE_FIELDS) {
      if (tool[field] !== defaultTool[field]) {
        if (field === "enabled") override.enabled = tool.enabled;
        else override[field] = tool[field];
      }
    }
    return Object.keys(override).length > 1 ? [override] : [];
  });
}

export function resetToolDefinition(toolId: string, tools: ToolDefinition[]): ToolDefinition[] {
  const defaultTool = defaultToolCatalog.find((tool) => tool.id === toolId);
  if (!defaultTool) return tools;
  return tools.map((tool) => tool.id === toolId ? structuredClone(defaultTool) : tool);
}
