import type { ToolDefinition } from "./types";
import { fullSchemaPattern } from "./toolSchemaPatterns";

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const integer = (minimum: number, maximum: number, defaultValue?: number) => ({ type: "integer", minimum, maximum, ...(defaultValue === undefined ? {} : { default: defaultValue }) });
const path = { type: "string", minLength: 1, maxLength: 4096, pattern: fullSchemaPattern("/[^\\u0000]*") };
const scan = {
  path,
  timeoutSeconds: integer(1, 600, 60),
  maxEntries: integer(1, 1000000, 100000),
  maxResults: integer(1, 200, 50),
  maxDepth: { ...integer(1, 64, 16), description: "实际递归扫描深度上限，不是结果展示层级。达到此深度的子目录不继续扫描，结果仅覆盖已扫描范围。" },
  sameFilesystem: { type: "boolean", default: true },
  excludePaths: { type: "array", maxItems: 100, uniqueItems: true, items: path, default: ["/proc", "/sys", "/dev", "/run"] },
};
export const operationsInputSchemas: Record<string, Record<string, unknown>> = {
  "disk.inspect": object({ ...scan, reportDepth: { ...integer(1, 8, 1), description: "目录结果汇总展示层级，默认仅展示根与一级子项；统计仍递归至 maxDepth/时间/条目限制。多个展示层级的父子汇总不可相加。" }, check: { type: "string", enum: ["capacity", "directory", "deleted", "docker"], default: "capacity" } }, ["path"]),
  "files.find_large": object({ ...scan, minBytes: integer(0, Number.MAX_SAFE_INTEGER, 104857600) }, ["path"]),
  "services.inspect": {
    ...object({
      check: { type: "string", enum: ["status", "ports", "logs", "health"] },
      service: { type: "string", minLength: 1, maxLength: 255, pattern: fullSchemaPattern("[A-Za-z0-9_][A-Za-z0-9_.@:-]*") },
      url: { type: "string", minLength: 1, maxLength: 2048, pattern: "^https?://" },
      timeoutSeconds: integer(1, 60, 15),
      logLines: integer(1, 200, 50),
      sinceMinutes: integer(1, 1440, 30),
    }, ["check"]),
    allOf: [
      { if: { properties: { check: { enum: ["status", "logs"] } } }, then: { required: ["service"] }, else: { not: { required: ["service"] } } },
      { if: { properties: { check: { const: "health" } } }, then: { required: ["url"] }, else: { not: { required: ["url"] } } },
    ],
  },
};
export const operationsStatuses = ["complete", "no_match", "partial", "timeout", "cancelled", "permission_denied", "unsupported", "error"];
const text = { type: "string", maxLength: 32768 };
const count = integer(0, Number.MAX_SAFE_INTEGER);
const issue = object({ path: text, reason: { type: "string", enum: ["excluded", "filesystem", "symlink", "depth", "entry_limit", "permission_denied", "timeout", "cancelled", "unsupported", "error", "output_limit"] } });
const nullableCount = { anyOf: [count, { type: "null" }] };
const observation = (kind: string, fields: Record<string, unknown>) => object({ kind: { const: kind }, subject: text, ...fields });
const itemSchemas = [
  observation("filesystem", { totalBytes: count, freeBytes: count, availableBytes: count, usedBytes: count, inodeTotal: nullableCount, inodeFree: nullableCount }),
  observation("directory", { allocatedBytes: count }),
  observation("file", { sizeBytes: count, allocatedBytes: count, modifiedAt: { type: "number" } }),
  observation("deleted_file", { sizeBytes: count, allocatedBytes: count }),
  ...["docker", "service", "ports", "logs"].map(kind => observation(kind, { text, exitCode: { type: "integer" } })),
  observation("health", { httpStatus: integer(100, 599) }),
] as Array<Record<string, any>>;
const outputKinds: Record<string, string[]> = {
  "disk.inspect": ["filesystem", "directory", "deleted_file", "docker"],
  "files.find_large": ["file"],
  "services.inspect": ["service", "ports", "logs", "health"],
};
export const operationsOutputSchemas = Object.fromEntries(Object.entries(operationsInputSchemas).map(([id, input]) => [id, {
  ...object({
    request: input,
    status: { type: "string", enum: operationsStatuses },
    items: { type: "array", maxItems: 200, items: { anyOf: itemSchemas.filter(schema => outputKinds[id].includes(schema.properties.kind.const)) } },
    scannedEntries: count, matchedEntries: count,
    skippedCount: count, skipped: { type: "array", maxItems: 100, items: issue },
    coverageComplete: { type: "boolean" }, truncated: { type: "boolean" },
    elapsedMs: count, finishedAt: { type: "string", minLength: 1, maxLength: 40 },
  }),
}]));

export const operationsToolCatalog: ToolDefinition[] = [
  ["disk.inspect", "磁盘空间检查", "capacity 检查指定路径所在分区容量和 inode；directory 递归统计后按 reportDepth 汇总展示分配空间；deleted 检查 Linux /proc 中已删除仍打开的文件；docker 查询本机默认 /var/run/docker.sock 的 Docker 空间统计，不使用远程 Docker context。deleted/docker 是服务器范围，path 仅用于 capacity/directory。"],
  ["files.find_large", "大文件定位", "在指定绝对目录内按 minBytes 筛选文件，按逻辑大小降序返回前 maxResults 项，附分配空间和修改时间。"],
  ["services.inspect", "服务只读检查", "status 查询指定 systemd 服务状态和主进程；ports 获取当前服务器监听端口；logs 读取指定服务的有限近期日志；health 对用户明确指定的 HTTP(S) 地址发起一次 GET，不跟随重定向。"],
].map(([id, name, description]) => ({
  id, name, description, implementation: "inspectOperations", effect: "read",
  usageInstructions: (id === "disk.inspect" ? "查看一级目录占用使用 reportDepth=1，maxDepth 是实际扫描上限，不能设为 1 来表示只展示一级。" : "")
    + "一次调用只检查一个 path/service/url，步骤描述必须与参数对应，不得声称一次检查多个未传入的目录。优先用于匹配的只读检查。只使用已确认的服务器、路径、服务和健康地址；在受管 SSH 连接的独立命令中运行，不继承交互终端状态。扫描不跟随符号链接。先小范围检查，按证据扩大范围。coverageComplete 仅代表请求范围遍历结束；排除项、跨文件系统、深度、权限、时间和数量限制必须向用户说明。coverageComplete=false 的目录大小是下限，大文件排行仅代表已扫描部分；truncated=true 还可能表示只返回前 N 项。unsupported 时由模型选择已授权的替代方法，不自动安装依赖或提权。工具调用完成不代表业务目标完成。",
  inputSchema: operationsInputSchemas[id], outputSchema: operationsOutputSchemas[id],
  outputDescription: "返回请求范围、状态、观测项、扫描/匹配数量、跳过范围、完整性、截断状态和采集时间；明确区分无匹配、权限不足、不支持、超时和部分完成。",
  planMode: "read_batch", completionMode: "continue", executionMode: "local",
  enabled: true, builtIn: true, version: id === "disk.inspect" ? 2 : 1, updatedAt: "2026-09-27T00:00:00.000Z",
}));
