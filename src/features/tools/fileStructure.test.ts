import { describe, expect, it } from "vitest";
import {
  buildDemoFileStructure,
  normalizeFileStructureRequest,
} from "@/features/tools/fileStructure";

describe("file structure tool", () => {
  it("merges defaults and normalizes request limits", () => {
    const request = normalizeFileStructureRequest({
      rootPath: "/opt/app/",
      excludeDirectories: ["uploads", "storage/cache", "uploads"],
    });

    expect(request.rootPath).toBe("/opt/app");
    expect(request.excludeDirectories).toEqual(expect.arrayContaining(["node_modules", "uploads", "storage/cache"]));
    expect(request.excludeDirectories.filter((item) => item === "uploads")).toHaveLength(1);
    expect(request.maxDepth).toBe(6);
    expect(request.maxNodes).toBe(2000);
  });

  it("rejects unsafe paths and out-of-range limits", () => {
    expect(() => normalizeFileStructureRequest({ rootPath: "opt/app" })).toThrow("绝对目录");
    expect(() => normalizeFileStructureRequest({ rootPath: "/opt/app", excludeDirectories: ["../etc"] })).toThrow("排除目录");
    expect(() => normalizeFileStructureRequest({ rootPath: "/opt/app", excludeDirectories: ["..\\etc"] })).toThrow("排除目录");
    expect(() => normalizeFileStructureRequest({ rootPath: "/opt/app", maxDepth: 21 })).toThrow("遍历深度");
    expect(() => normalizeFileStructureRequest({ rootPath: "/opt/app", maxNodes: 0 })).toThrow("节点数量");
  });

  it("applies hidden, exclusion, depth and node limits in demo mode", () => {
    const result = buildDemoFileStructure(normalizeFileStructureRequest({
      rootPath: "/opt/app",
      maxDepth: 1,
      maxNodes: 3,
    }));

    expect(result.nodes.some((node) => node.name === "node_modules")).toBe(false);
    expect(result.nodes.some((node) => node.name === ".env")).toBe(false);
    expect(result.maxDepthReached).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.totalNodes).toBe(3);
  });
});
