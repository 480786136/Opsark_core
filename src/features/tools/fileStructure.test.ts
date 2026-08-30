import { describe, expect, it } from "vitest";
import { normalizeFileStructureRequest } from "@/features/tools/fileStructure";

describe("file structure tool", () => {
  it("applies compact project-tree defaults and deduplicates caller exclusions", () => {
    const request = normalizeFileStructureRequest({
      rootPath: "/opt/app/",
      excludeDirectories: ["uploads", "storage/cache", "uploads"],
    });

    expect(request.rootPath).toBe("/opt/app");
    expect(request.excludeDirectories).toEqual(expect.arrayContaining([
      ".git", "node_modules", "vendor", "target", "dist", "build", "uploads", "storage/cache",
    ]));
    expect(request.excludeDirectories.filter((item) => item === "uploads")).toHaveLength(1);
    expect(request.maxDepth).toBe(4);
    expect(request.maxNodes).toBe(600);
  });

  it("rejects unsafe paths and out-of-range limits", () => {
    expect(() => normalizeFileStructureRequest({ rootPath: "opt/app" })).toThrow("绝对目录");
    expect(() => normalizeFileStructureRequest({ rootPath: "/opt/app", excludeDirectories: ["../etc"] })).toThrow("排除目录");
    expect(() => normalizeFileStructureRequest({ rootPath: "/opt/app", excludeDirectories: ["..\\etc"] })).toThrow("排除目录");
    expect(() => normalizeFileStructureRequest({ rootPath: "/opt/app", maxDepth: 21 })).toThrow("遍历深度");
    expect(() => normalizeFileStructureRequest({ rootPath: "/opt/app", maxNodes: 0 })).toThrow("节点数量");
  });

});
