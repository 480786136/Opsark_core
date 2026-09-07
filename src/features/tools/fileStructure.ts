import type { FileStructureRequest } from "@/features/tools/types";

export const DEFAULT_FILE_STRUCTURE_EXCLUDES = [
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".nuxt",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
  "venv",
] as const;

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
  const rawRootPath = request.rootPath.trim();
  if (!rawRootPath.startsWith("/") || rawRootPath.includes("\\") || rawRootPath.includes("\0")) {
    throw new Error("根路径必须是远端 POSIX 绝对目录路径");
  }
  const rootSegments = rawRootPath.split("/").filter(Boolean);
  if (rootSegments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("远端根路径不能包含 . 或 .. 路径段");
  }
  const rootPath = rootSegments.length ? `/${rootSegments.join("/")}` : "/";

  const customExcludes = (request.excludeDirectories ?? []).flatMap((item) => {
    const normalizedItem = item.trim().replace(/\\/g, "/");
    const value = normalizedItem.replace(/^\/+|\/+$/g, "");
    if (!value) return [];
    if (normalizedItem.startsWith("/")
      || normalizedItem.includes("\0")
      || value.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new Error(`排除目录必须是目录名或根目录下的相对路径：${item}`);
    }
    return [value];
  });
  const maxDepth = Math.trunc(request.maxDepth ?? 4);
  const maxNodes = Math.trunc(request.maxNodes ?? 600);
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
