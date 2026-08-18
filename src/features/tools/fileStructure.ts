import type { FileStructureRequest } from "@/features/tools/types";

export const DEFAULT_FILE_STRUCTURE_EXCLUDES = [
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "coverage",
  ".cache",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  "logs",
];

export interface NormalizedFileStructureRequest {
  rootPath: string;
  excludeDirectories: string[];
  maxDepth: number;
  maxNodes: number;
  includeHidden: boolean;
}

export function normalizeFileStructureRequest(
  request: FileStructureRequest,
): NormalizedFileStructureRequest {
  const rootPath = request.rootPath.trim().replace(/\/+$/, "") || "/";
  if (!rootPath.startsWith("/")) throw new Error("根路径必须是远端绝对目录路径");

  const customExcludes = (request.excludeDirectories ?? []).flatMap((item) => {
    const normalizedItem = item.trim().replace(/\\/g, "/");
    const value = normalizedItem.replace(/^\/+|\/+$/g, "");
    if (!value) return [];
    if (normalizedItem.startsWith("/") || value.split("/").includes("..")) {
      throw new Error(`排除目录必须是目录名或根目录下的相对路径：${item}`);
    }
    return [value];
  });
  const maxDepth = Math.trunc(request.maxDepth ?? 6);
  const maxNodes = Math.trunc(request.maxNodes ?? 2000);
  if (maxDepth < 1 || maxDepth > 20) throw new Error("遍历深度必须在 1 到 20 之间");
  if (maxNodes < 1 || maxNodes > 10_000) throw new Error("节点数量必须在 1 到 10000 之间");

  return {
    rootPath,
    excludeDirectories: [...new Set([...DEFAULT_FILE_STRUCTURE_EXCLUDES, ...customExcludes])],
    maxDepth,
    maxNodes,
    includeHidden: request.includeHidden ?? false,
  };
}
