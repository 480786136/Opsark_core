import { describe, expect, it } from "vitest";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { buildPlanningToolContext, buildToolContext } from "@/features/tools/toolContext";
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
    expect(tool.inputSchema).toEqual(defaultToolCatalog.find((item) => item.id === "files.get_structure")?.inputSchema);
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
    const tools = resolveToolRegistry([]);
    const context = buildToolContext(tools);

    expect(context.some((tool) => tool.id === "secret.merge_command")).toBe(false);
    expect(context.some((tool) => tool.id === "secret.metadata")).toBe(false);
    expect(context.some((tool) => tool.id === "server.basic_info")).toBe(false);
    expect(context.some((tool) => tool.id === "server.realtime_metrics")).toBe(false);
    expect(context.some((tool) => tool.id === "files.get_structure")).toBe(true);
    expect(context[0]).not.toHaveProperty("implementation");
    expect(context[0]).not.toHaveProperty("builtIn");
  });

  it("limits full tool schemas to the selected built-in Skill policy", () => {
    const tools = resolveToolRegistry([]);
    const softwareSkill = {
      id: "software-installation",
      name: "软件安装",
      category: "environment" as const,
      description: "安装软件",
      version: 1,
      enabled: true,
      builtIn: true,
      matchRules: [],
      instructions: "检查后安装",
      allowedToolIds: ["software.check", "user.request_input"],
      updatedAt: "now",
    };

    expect(buildPlanningToolContext(tools, [softwareSkill]).map(({ id }) => id)).toEqual([
      "user.request_input",
<<<<<<< HEAD
=======
      "evidence.read",
>>>>>>> origin/master
      "software.check",
    ]);
  });

  it("keeps planner-visible tools for legacy custom Skills without a declared policy", () => {
    const tools = resolveToolRegistry([]);
    const legacySkill = {
      id: "skill-legacy",
      name: "Legacy",
      category: "other" as const,
      description: "旧版自定义 Skill",
      version: 1,
      enabled: true,
      builtIn: false,
      matchRules: [],
      instructions: "使用自定义工具完成任务",
      updatedAt: "now",
    };
    const ids = buildPlanningToolContext(tools, [legacySkill]).map(({ id }) => id);

    expect(ids).toContain("files.get_structure");
    expect(ids).toContain("server.connect");
    expect(ids).not.toContain("secret.merge_command");
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
