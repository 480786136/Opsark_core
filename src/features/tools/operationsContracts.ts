import type { ToolDefinition } from "./types";
import { fullSchemaPattern } from "./toolSchemaPatterns";
import { packageInspectionInputSchema, packageInspectionItemSchema, packageInspectionDescription, packageInspectionUsage } from "./packageInspectionContracts";

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
  "packages.inspect": packageInspectionInputSchema,
  "files.inspect": object({ path, hash: { type: "boolean", default: false },
    maxHashBytes: { ...integer(1, 1073741824, 16777216), description: "普通文件每遍 SHA-256 内容字节上限；最多两遍，每遍最多额外读取 1 字节判断 EOF，不返回正文。两遍不一致或超限均不返回摘要。" },
    timeoutSeconds: integer(1, 600, 30),
  }, ["path"]),
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
      maxResponseBytes: { ...integer(0, 32768), description: "仅 health 可用；默认 0 只采集 HTTP 状态。大于 0 时最多返回指定字节的 UTF-8 正文，超限或非文本如实标记不完整。" },
    }, ["check"]),
    allOf: [
      { if: { properties: { check: { enum: ["status", "logs"] } } }, then: { required: ["service"] }, else: { not: { required: ["service"] } } },
      { if: { properties: { check: { const: "health" } } }, then: { required: ["url"] }, else: { not: { required: ["url"] } } },
      { if: { properties: { check: { const: "health" } } }, else: { not: { required: ["maxResponseBytes"] } } },
    ],
  },
};
export const operationsStatuses = ["complete", "no_match", "partial", "timeout", "cancelled", "permission_denied", "unsupported", "error"];
const text = { type: "string", maxLength: 32768 };
const count = integer(0, Number.MAX_SAFE_INTEGER);
const issue = object({ path: text, reason: { type: "string", enum: ["excluded", "filesystem", "symlink", "depth", "entry_limit", "permission_denied", "timeout", "cancelled", "unsupported", "error", "output_limit", "changed"] } });
const nullableCount = { anyOf: [count, { type: "null" }] };
const observation = (kind: string, fields: Record<string, unknown>) => object({ kind: { const: kind }, subject: text, ...fields });
export const servicePropertyKeys = ["Id", "LoadState", "ActiveState", "SubState", "MainPID", "Result", "ExecMainStatus",
  "ActiveEnterTimestamp", "UnitFileState", "ExecStart", "FragmentPath", "ExecMainStartTimestampMonotonic"] as const;
const serviceIdentity = {
  ...object({ status: { enum: ["stable", "changed", "unknown", "not_running"] }, service: { type: "string", minLength: 1, maxLength: 255 },
    sampleStartedAt: { type: "string", minLength: 1, maxLength: 40 }, sampleFinishedAt: { type: "string", minLength: 1, maxLength: 40 },
    consistency: { const: "sampled_non_atomic" }, pid: count,
    verificationExitCode: { type: "integer" },
    bootId: { type: "string", pattern: fullSchemaPattern("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}") },
    startTimeTicks: { type: "string", pattern: fullSchemaPattern("[1-9][0-9]*") },
    reason: { enum: ["properties_unavailable", "missing_main_pid", "invalid_main_pid", "main_pid_changed", "properties_changed",
      "boot_changed", "process_changed", "proc_unavailable", "no_main_process", "collection_incomplete"] },
  }, ["status", "service", "sampleStartedAt", "sampleFinishedAt", "consistency"]),
  allOf: [
    { if: { properties: { status: { const: "stable" } } }, then: { required: ["pid", "bootId", "startTimeTicks", "verificationExitCode"], properties: { pid: integer(1, Number.MAX_SAFE_INTEGER), verificationExitCode: { const: 0 } }, not: { required: ["reason"] } },
      else: { required: ["reason"], not: { anyOf: [{ required: ["bootId"] }, { required: ["startTimeTicks"] }] } } },
    { if: { properties: { status: { const: "not_running" } } }, then: { required: ["pid", "verificationExitCode"], properties: { pid: { const: 0 }, verificationExitCode: { const: 0 }, reason: { const: "no_main_process" } } } },
  ],
};
const itemSchemas = [
  packageInspectionItemSchema,
  {
    ...object({ kind: { const: "file_metadata" }, subject: text,
      fileType: { enum: ["regular", "directory", "symlink", "other", "missing"] }, exists: { type: "boolean" },
      metadata: object({ device: { type: "string", pattern: fullSchemaPattern("[0-9]+") },
        inode: { type: "string", pattern: fullSchemaPattern("[0-9]+") }, mode: { type: "string", pattern: fullSchemaPattern("[0-7]{4}") },
        uid: count, gid: count, sizeBytes: count,
        modifiedAtNs: { type: "string", pattern: fullSchemaPattern("-?[0-9]+") }, changedAtNs: { type: "string", pattern: fullSchemaPattern("-?[0-9]+") } }),
      linkTarget: { type: "string", maxLength: 32768 }, linkTargetRedacted: { type: "boolean" },
      stability: { enum: ["stable", "changed", "unknown"] },
      sampleStartedAt: { type: "string", minLength: 1, maxLength: 40 }, sampleFinishedAt: { type: "string", minLength: 1, maxLength: 40 },
      consistency: { enum: ["metadata_checked", "single_observation", "unverified"] },
      limitations: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { enum: ["non_atomic_sample", "self_metadata_only", "target_not_followed", "absence_at_sample"] } },
      hashStatus: { enum: ["not_requested", "complete", "not_applicable", "limit_exceeded", "changed", "unavailable"] },
      hashedBytes: count, verifiedReadPasses: integer(0, 2), sha256: { type: "string", pattern: fullSchemaPattern("[a-f0-9]{64}") },
    }, ["kind", "subject", "fileType", "exists", "stability", "hashStatus", "hashedBytes", "verifiedReadPasses", "sampleStartedAt", "sampleFinishedAt", "consistency", "limitations"]),
    allOf: [
      { if: { properties: { exists: { const: true } } }, then: { required: ["metadata"], properties: { fileType: { enum: ["regular", "directory", "symlink", "other"] } } },
        else: { properties: { fileType: { const: "missing" }, stability: { const: "stable" }, hashStatus: { const: "not_applicable" }, hashedBytes: { const: 0 } }, not: { anyOf: [{ required: ["metadata"] }, { required: ["linkTarget"] }, { required: ["sha256"] }] } } },
      { if: { properties: { fileType: { const: "symlink" } } }, then: { required: ["linkTarget"] }, else: { not: { anyOf: [{ required: ["linkTarget"] }, { required: ["linkTargetRedacted"] }] } } },
      { if: { properties: { hashStatus: { const: "complete" } } }, then: { required: ["sha256"], properties: { fileType: { const: "regular" }, stability: { const: "stable" }, verifiedReadPasses: { const: 2 } } }, else: { not: { required: ["sha256"] } } },
    ],
  },
  observation("filesystem", { totalBytes: count, freeBytes: count, availableBytes: count, usedBytes: count, inodeTotal: nullableCount, inodeFree: nullableCount }),
  observation("directory", { allocatedBytes: count }),
  observation("file", { sizeBytes: count, allocatedBytes: count, modifiedAt: { type: "number" } }),
  observation("deleted_file", { sizeBytes: count, allocatedBytes: count }),
  ...["docker", "ports", "logs"].map(kind => observation(kind, { text, exitCode: { type: "integer" } })),
  object({ kind: { const: "service" }, subject: text, text, exitCode: { type: "integer" },
    properties: object(Object.fromEntries(servicePropertyKeys.map(key => [key, text])), []),
    processIdentity: serviceIdentity, observationsRedacted: { type: "boolean" },
    compatibilityAttempt: object({ originalExitCode: { const: 1 }, reason: { const: "missing_requested_properties" },
      missingProperties: { type: "array", minItems: 1, maxItems: 7, uniqueItems: true,
        items: { enum: servicePropertyKeys.filter(key => !["Id", "LoadState", "ActiveState", "SubState", "MainPID"].includes(key)) } },
    }),
  }, ["kind", "subject", "text", "exitCode"]),
  {
    ...object({ kind: { const: "health" }, subject: text, httpStatus: integer(100, 599),
      body: text, returnedBytes: integer(0, 32768), bodyTruncated: { type: "boolean" },
      bodyEncoding: { enum: ["utf-8", "unavailable"] },
      bodyRedacted: { type: "boolean" },
    }, ["kind", "subject", "httpStatus"]),
    dependencies: Object.fromEntries(["body", "returnedBytes", "bodyTruncated", "bodyEncoding", "bodyRedacted"].map(key =>
      [key, ["body", "returnedBytes", "bodyTruncated", "bodyEncoding"].filter(other => other !== key)])),
  },
] as Array<Record<string, any>>;
const outputKinds: Record<string, string[]> = {
  "packages.inspect": ["package_environment"],
  "files.inspect": ["file_metadata"],
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
  ["packages.inspect", "包管理能力与事务检查", packageInspectionDescription],
  ["files.inspect", "精确文件身份与摘要", "只读采集单个已确认绝对路径的类型、设备/inode、权限、属主、大小及纳秒时间；符号链接仅返回原始链接文本，路径各级均不跟随链接。hash=true 仅为普通文件两遍计算有界 SHA-256并核对一致，不返回正文；目录不递归、不生成目录摘要。文件不存在返回明确 missing；权限、超限、变化或超时均不伪报完整。"],
  ["disk.inspect", "磁盘空间检查", "capacity 检查指定路径所在分区容量和 inode；directory 递归统计后按 reportDepth 汇总展示分配空间；deleted 检查 Linux /proc 中已删除仍打开的文件；docker 查询本机默认 /var/run/docker.sock 的 Docker 空间统计，不使用远程 Docker context。deleted/docker 是服务器范围，path 仅用于 capacity/directory。"],
  ["files.find_large", "大文件定位", "在指定绝对目录内按 minBytes 筛选文件，按逻辑大小降序返回前 maxResults 项，附分配空间和修改时间。"],
  ["services.inspect", "服务只读检查", "status 查询指定 systemd 服务状态和主进程；ports 获取当前服务器监听端口；logs 读取指定服务的有限近期日志；health 对用户明确指定的 HTTP(S) 地址发起一次 GET，不跟随重定向、不使用代理。默认只返回 HTTP 状态，maxResponseBytes>0 可采集有界 UTF-8 正文；截断、非文本和失败不能作为完整正文证据，HTTP 状态或采集 complete 均不等于业务验收通过。"],
].map<ToolDefinition>(([id, name, description]) => ({
  id, name, description, implementation: "inspectOperations", effect: "read",
  usageInstructions: (id === "files.inspect" ? "部署/升级前后需要文件身份和摘要时使用本工具，每次只检查一个精确路径。先检查 current 等链接本身，再按授权范围用确认的真实路径检查目标文件，不能传含链接祖先的路径绕过不跟随策略。SHA-256 仅 hashStatus=complete 时为完整文件摘要；stability=stable 仅代表采集前后元数据及路径身份一致，不是文件系统事务快照，也不能证明采集后未变化。missing 只证明采样时对象不存在；目录的 coverageComplete 只覆盖该目录自身元数据，不能证明其子树/备份完整。hash=false 不采集内容；特殊文件不读取。" : id === "disk.inspect" ? "查看一级目录占用使用 reportDepth=1，maxDepth 是实际扫描上限，不能设为 1 来表示只展示一级。" : "")
    + "一次调用只检查一个 path/service/url，步骤描述必须与参数对应，不得声称一次检查多个未传入的目录。优先用于匹配的只读检查。只使用已确认的服务器、路径、服务和健康地址；在受管 SSH 连接的独立命令中运行，不继承交互终端状态。扫描不跟随符号链接。先小范围检查，按证据扩大范围。coverageComplete 仅代表请求范围遍历结束；排除项、跨文件系统、深度、权限、时间和数量限制必须向用户说明。coverageComplete=false 的目录大小是下限，大文件排行仅代表已扫描部分；truncated=true 还可能表示只返回前 N 项。unsupported 时由模型选择已授权的替代方法，不自动安装依赖或提权。工具调用完成不代表业务目标完成。",
  inputSchema: operationsInputSchemas[id], outputSchema: operationsOutputSchemas[id],
  outputDescription: "返回请求范围、状态、观测项、扫描/匹配数量、跳过范围、完整性、截断状态和采集时间；明确区分无匹配、权限不足、不支持、超时和部分完成。",
  planMode: "read_batch", completionMode: "continue", executionMode: "local",
  enabled: true, builtIn: true, version: ["disk.inspect", "services.inspect"].includes(id) ? 2 : 1, updatedAt: "2026-09-27T00:00:00.000Z",
})).map(tool => tool.id === "packages.inspect" ? { ...tool, usageInstructions: packageInspectionUsage } : tool);
