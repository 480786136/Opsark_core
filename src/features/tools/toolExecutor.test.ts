import { describe, expect, it, vi } from "vitest";
import { executeToolCall, parseToolCommand } from "@/features/tools/toolExecutor";
import { resolveToolRegistry } from "@/features/tools/toolRegistry";

describe("tool executor", () => {
  it("parses the model-facing tool command protocol", () => {
    expect(parseToolCommand(
      'opsark-tool files.get_structure {"rootPath":"/opt/app","maxDepth":4}',
      "call-1",
    )).toEqual({
      id: "call-1",
      toolId: "files.get_structure",
      arguments: { rootPath: "/opt/app", maxDepth: 4 },
    });
    expect(parseToolCommand("uname -a", "call-2")).toBeUndefined();
    expect(() => parseToolCommand("opsark-tool files.get_structure []", "call-3")).toThrow("JSON 对象");
  });

  it("routes a validated file structure call", async () => {
    const getRemoteFileStructure = vi.fn().mockResolvedValue({
      rootPath: "/opt/app",
      nodes: [],
      excludedDirectories: [],
      totalNodes: 0,
      maxDepthReached: false,
      truncated: false,
      warnings: [],
    });

    const result = await executeToolCall({
      id: "call-1",
      toolId: "files.get_structure",
      arguments: { rootPath: "/opt/app", excludeDirectories: ["uploads"] },
    }, resolveToolRegistry([]), { getRemoteFileStructure });

    expect(result.success).toBe(true);
    expect(getRemoteFileStructure).toHaveBeenCalledWith(expect.objectContaining({
      rootPath: "/opt/app",
      excludeDirectories: expect.arrayContaining(["node_modules", "uploads"]),
    }));
  });

  it("rejects disabled tools and invalid arguments", async () => {
    const dependency = { getRemoteFileStructure: vi.fn() };
    const disabled = resolveToolRegistry([{ id: "files.get_structure", enabled: false }]);
    const disabledResult = await executeToolCall({
      id: "call-2",
      toolId: "files.get_structure",
      arguments: { rootPath: "/opt/app" },
    }, disabled, dependency);
    const invalidResult = await executeToolCall({
      id: "call-3",
      toolId: "files.get_structure",
      arguments: { rootPath: "relative" },
    }, resolveToolRegistry([]), dependency);

    expect(disabledResult.error?.code).toBe("TOOL_DISABLED");
    expect(invalidResult.error?.code).toBe("TOOL_EXECUTION_FAILED");
    expect(dependency.getRemoteFileStructure).not.toHaveBeenCalled();
  });
});
