import type { ToolDefinition } from "./types";
import { fullSchemaPattern } from "./toolSchemaPatterns";

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER, fallback?: number) => ({ type: "integer", minimum, maximum, ...(fallback === undefined ? {} : { default: fallback }) });
const text = { type: "string", maxLength: 4096 };
const enumeration = (...values: string[]) => ({ type: "string", enum: values });
const nullable = (value: unknown) => ({ anyOf: [value, { type: "null" }] });
const sha = { type: "string", pattern: fullSchemaPattern("[a-f0-9]{64}") };
const digits = { type: "string", maxLength: 32, pattern: fullSchemaPattern("[0-9]+") };
const flag = { type: "boolean" };
export const FILE_MANIFEST_OUTPUT_LIMIT = 1048576;
export const FILE_MANIFEST_LIMITATIONS = ["sampled_non_atomic", "symlink_targets_not_read", "metadata_not_acl_xattr", "not_backup_or_deployment_authorization", "explicit_root_only"] as const;
export const fileManifestInputSchema = object({
  path: { ...text, minLength: 1, pattern: fullSchemaPattern("/[^\\u0000-\\u001f\\u007f]*") },
  source: enumeration("directory", "tar", "tar_gzip"), maxEntries: integer(1, 4096, 1024), maxDepth: integer(1, 64, 16),
  maxFileBytes: integer(1, 67108864, 16777216), maxTotalBytes: integer(1, 268435456, 67108864),
  maxArchiveBytes: integer(1024, 67108864, 16777216), maxExpandedBytes: integer(1024, 268435456, 67108864), timeoutSeconds: integer(1, 120, 30),
}, ["path", "source"]);
const identity = object({ device: digits, inode: digits, sizeBytes: integer(), mode: { type: "string", pattern: fullSchemaPattern("[0-7]{4}") },
  uid: integer(0, 4294967295), gid: integer(0, 4294967295), mtimeNs: { type: "string", maxLength: 32, pattern: fullSchemaPattern("-?[0-9]+") }, ctimeNs: { type: "string", maxLength: 32, pattern: fullSchemaPattern("-?[0-9]+") } });
const entry = object({ path: { ...text, minLength: 1 }, kind: enumeration("regular", "directory", "symlink", "hardlink", "other"),
  status: enumeration("complete", "partial"), reason: { type: "string", maxLength: 256 }, sizeBytes: integer(),
  mode: { type: "string", pattern: fullSchemaPattern("[0-7]{4}") }, uid: integer(0, 4294967295), gid: integer(0, 4294967295),
  sha256: sha, linkTarget: text, identity,
}, ["path", "kind", "status", "reason", "sizeBytes", "mode", "uid", "gid"]);
export const fileManifestOutputSchema = object({
  request: { ...fileManifestInputSchema, required: Object.keys(fileManifestInputSchema.properties) },
  status: enumeration("complete", "partial", "timeout", "unsupported"), coverageComplete: flag, truncated: flag, safeForDeployment: flag,
  rootIdentity: nullable(identity), entries: { type: "array", maxItems: 4096, items: entry },
  issues: { type: "array", maxItems: 128, items: object({ path: text, reason: { type: "string", minLength: 1, maxLength: 256 } }) },
  issueCount: integer(), scannedEntries: integer(0, 4096), contentBytes: integer(0, 268435456), readBytes: integer(0, 536879105),
  archiveReadBytes: integer(0, 134217730), expandedBytes: integer(0, 268435457),
  manifestSha256: nullable(sha), archiveSha256: nullable(sha), sampledAt: nullable(text), finishedAt: nullable(text), elapsedMs: integer(),
  consistency: { const: "sampled_non_atomic" },
  limitations: { type: "array", minItems: FILE_MANIFEST_LIMITATIONS.length, maxItems: FILE_MANIFEST_LIMITATIONS.length, uniqueItems: true, items: enumeration(...FILE_MANIFEST_LIMITATIONS) },
  observationsRedacted: flag,
}, ["request", "status", "coverageComplete", "truncated", "safeForDeployment", "rootIdentity", "entries", "issues", "issueCount", "scannedEntries", "contentBytes", "readBytes", "archiveReadBytes", "expandedBytes", "manifestSha256", "archiveSha256", "sampledAt", "finishedAt", "elapsedMs", "consistency", "limitations"]);

export const fileManifestTool: ToolDefinition = {
  id: "files.inspect_manifest", implementation: "inspectFileManifest", effect: "read", executionMode: "local", planMode: "read_batch", completionMode: "continue",
  name: "文件树与归档清单检查", description: "有界只读采集精确目录或tar/tar.gz归档成员的内容摘要、类型和基本属性，为发布、备份及保护范围比较提供真实清单。",
  usageInstructions: "先从用户或真实交接确定唯一根路径和directory/tar/tar_gzip类型。不会解压写盘或跟随用户路径链接；目录中的链接只记录本体，不证明目标内容已备份。归档危险/重复成员、链接、未支持格式、权限错误、变化和限额均保持不完整。压缩输入和展开字节独立受限；目录普通文件最多读两遍，物理读取上限2*maxTotalBytes+2*maxEntries。完整清单仅证明声明范围的非原子采样，未覆盖ACL/xattr，不等于备份可恢复或获准部署。比较两端相对路径/类型/内容及所需属性，不能要求备份inode相同。完整结果最多1MiB并应作为本地证据附件保留，模型侧使用摘要/引用，不丢失附件后仍声称完整。",
  inputSchema: fileManifestInputSchema, outputSchema: fileManifestOutputSchema,
  outputDescription: "原请求与根身份、有限成员清单/内容SHA-256、完整清单SHA-256及归档SHA-256、已读字节、覆盖/部署适用性、跳过原因和非原子限制；无正文、无解压和写入。",
  enabled: true, builtIn: true, version: 1, updatedAt: "2026-10-12T00:00:00.000Z",
};
