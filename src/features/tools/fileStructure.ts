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
    if (normalizedItem.includes("\0")) {
      throw new Error(`排除目录不能包含 NUL 字符：${item}`);
    }
    const absolute = normalizedItem.startsWith("/");
    const segments = normalizedItem.split("/").filter(Boolean);
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw new Error(`排除目录不能包含 . 或 .. 路径段：${item}`);
    }
    if (!segments.length) {
      if (!absolute) return [];
      throw new Error(`排除目录不能与根路径相同：${item}`);
    }

    const value = segments.join("/");
    if (!absolute) return [value];

    const absolutePath = `/${value}`;
    if (absolutePath === rootPath) {
      throw new Error(`排除目录不能与根路径相同：${item}`);
    }
    if (rootPath !== "/" && !absolutePath.startsWith(`${rootPath}/`)) {
      throw new Error(`绝对排除路径必须位于根路径 ${rootPath} 下：${item}`);
    }
    return [absolutePath];
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
