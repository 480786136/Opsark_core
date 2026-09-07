import type { ToolDefinition, ToolValidationIssue } from "@/features/tools/types";

const FIELD_LIMITS = {
  name: 80,
  description: 1000,
  usageInstructions: 2000,
  outputDescription: 1000,
} as const;

type EditableTextField = keyof typeof FIELD_LIMITS;

export function validateToolDefinition(tool: ToolDefinition): ToolValidationIssue[] {
  return (Object.keys(FIELD_LIMITS) as EditableTextField[]).flatMap((field) => {
    const value = tool[field].trim();
    if (!value) return [{ field, message: "此字段不能为空" }];
    const limit = FIELD_LIMITS[field];
    return value.length > limit ? [{ field, message: `不能超过 ${limit} 个字符` }] : [];
  });
}

export function normalizeToolDefinition(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    name: tool.name.trim(),
    description: tool.description.trim(),
    usageInstructions: tool.usageInstructions.trim(),
    outputDescription: tool.outputDescription.trim(),
  };
}
