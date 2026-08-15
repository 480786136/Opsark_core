import type {
  FileStructureNode,
  FileStructureRequest,
  FileStructureResult,
} from "@/features/tools/types";

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

const demoNodes: FileStructureNode[] = [
  {
    name: "src",
    relativePath: "src",
    kind: "directory",
    children: [
      { name: "components", relativePath: "src/components", kind: "directory", children: [] },
      { name: "services", relativePath: "src/services", kind: "directory", children: [] },
      { name: "main.ts", relativePath: "src/main.ts", kind: "file", size: 640 },
    ],
  },
  { name: "docs", relativePath: "docs", kind: "directory", children: [] },
  { name: "node_modules", relativePath: "node_modules", kind: "directory", children: [] },
  { name: ".env", relativePath: ".env", kind: "file", size: 120 },
  { name: "package.json", relativePath: "package.json", kind: "file", size: 860 },
  { name: "README.md", relativePath: "README.md", kind: "file", size: 2200 },
];

function isExcluded(node: FileStructureNode, excludes: string[]) {
  return excludes.some((exclude) => exclude.includes("/")
    ? node.relativePath === exclude || node.relativePath.startsWith(`${exclude}/`)
    : node.name === exclude);
}

export function buildDemoFileStructure(
  request: NormalizedFileStructureRequest,
): FileStructureResult {
  let totalNodes = 0;
  let truncated = false;
  let maxDepthReached = false;

  const visit = (nodes: FileStructureNode[], depth: number): FileStructureNode[] => {
    const result: FileStructureNode[] = [];
    for (const node of nodes) {
      if (totalNodes >= request.maxNodes) {
        truncated = true;
        break;
      }
      if (isExcluded(node, request.excludeDirectories)) continue;
      if (!request.includeHidden && node.name.startsWith(".")) continue;
      totalNodes += 1;
      const copy = { ...node };
      if (node.kind === "directory") {
        if (depth >= request.maxDepth) {
          maxDepthReached = true;
          copy.children = [];
        } else {
          copy.children = visit(node.children ?? [], depth + 1);
        }
      }
      result.push(copy);
    }
    return result;
  };

  return {
    rootPath: request.rootPath,
    nodes: visit(demoNodes, 1),
    excludedDirectories: request.excludeDirectories,
    totalNodes,
    maxDepthReached,
    truncated,
    warnings: [],
  };
}
