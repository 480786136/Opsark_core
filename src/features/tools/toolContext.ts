import type { ToolDefinition } from "@/features/tools/types";

export interface ModelToolDefinition {
  id: string;
  name: string;
  description: string;
  usageInstructions: string;
  inputSchema: Record<string, unknown>;
  outputDescription: string;
  version: number;
}

function createJsonSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function buildToolContext(tools: ToolDefinition[]): ModelToolDefinition[] {
  return tools
    .filter((tool) => tool.enabled)
    .map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      usageInstructions: tool.usageInstructions,
      // Pinia wraps nested schemas in proxies, which structuredClone cannot clone.
      inputSchema: createJsonSnapshot(tool.inputSchema),
      outputDescription: tool.outputDescription,
      version: tool.version,
    }));
}
