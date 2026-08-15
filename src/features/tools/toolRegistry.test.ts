import { describe, expect, it } from "vitest";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { buildToolContext } from "@/features/tools/toolContext";
import {
  createToolOverrides,
  parseToolOverrides,
  resetToolDefinition,
  resolveToolRegistry,
} from "@/features/tools/toolRegistry";
import { validateToolDefinition } from "@/features/tools/toolValidation";

describe("tool registry", () => {
  it("merges editable overrides without allowing implementation changes", () => {
    const tools = resolveToolRegistry(parseToolOverrides([{
      id: "files.get_structure",
      name: "项目结构读取",
      implementation: "unsafeExecutor",
      inputSchema: { type: "string" },
      enabled: false,
    }]));
    const tool = tools.find((item) => item.id === "files.get_structure")!;

    expect(tool.name).toBe("项目结构读取");
    expect(tool.enabled).toBe(false);
    expect(tool.implementation).toBe("getRemoteFileStructure");
    expect(tool.inputSchema).toEqual(defaultToolCatalog[defaultToolCatalog.length - 1].inputSchema);
  });

  it("persists only fields that differ from the catalog", () => {
    const tools = resolveToolRegistry([]);
    tools[0].description = "新的模型说明";

    expect(createToolOverrides(tools)).toEqual([{
      id: tools[0].id,
      description: "新的模型说明",
    }]);
  });

  it("restores a single tool to its trusted default", () => {
    const tools = resolveToolRegistry([{ id: "files.get_structure", enabled: false }]);
    const restored = resetToolDefinition("files.get_structure", tools);

    expect(restored.find((tool) => tool.id === "files.get_structure")?.enabled).toBe(true);
  });

  it("exposes only enabled and model-safe fields", () => {
    const tools = resolveToolRegistry([{ id: "secret.merge_command", enabled: false }]);
    const context = buildToolContext(tools);

    expect(context.some((tool) => tool.id === "secret.merge_command")).toBe(false);
    expect(context[0]).not.toHaveProperty("implementation");
    expect(context[0]).not.toHaveProperty("builtIn");
  });

  it("reports empty and oversized editable fields", () => {
    const tool = resolveToolRegistry([])[0];
    tool.name = " ";
    tool.description = "x".repeat(1001);

    expect(validateToolDefinition(tool)).toEqual(expect.arrayContaining([
      { field: "name", message: "此字段不能为空" },
      { field: "description", message: "不能超过 1000 个字符" },
    ]));
  });
});
