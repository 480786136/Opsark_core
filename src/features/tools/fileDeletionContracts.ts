import type { ToolDefinition } from "./types";
import { fullSchemaPattern } from "./toolSchemaPatterns";

const path = { type: "string", minLength: 2, maxLength: 4096, pattern: fullSchemaPattern("/[^\\u0000]+") };
const id = { type: "string", minLength: 1, maxLength: 160, pattern: fullSchemaPattern("[A-Za-z0-9_-]+") };
const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false,
  properties, required: Object.keys(properties) });
export const deletionFileSchema = object({ path, size: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  identity: { type: "array", minItems: 9, maxItems: 9, items: { type: "string", pattern: fullSchemaPattern("[0-9]+") } },
  sha256: { type: "string", pattern: fullSchemaPattern("[0-9a-f]{64}") } });
const files = { type: "array", minItems: 1, maxItems: 100, items: deletionFileSchema };
export const fileDeletionOutputSchemas: Record<string, Record<string, unknown>> = {
  "files.preview_deletion": object({ previewId: id, items: files, expiresAt: { type: "string" } }),
  "files.confirm_deletion": object({ title: { type: "string" }, values: object({ decision: { type: "string", enum: ["confirm", "reject"] }, authorizationId: id }) }),
  "files.delete_confirmed": object({ authorizationId: id, deleted: { type: "array", minItems: 1, maxItems: 100, items: path } }),
};
const common = { planMode: "standalone" as const, completionMode: "refine" as const, refinementScope: "always" as const,
  enabled: true, builtIn: true, version: 1, updatedAt: "2026-10-12T00:00:00.000Z" };
export const fileDeletionToolCatalog: ToolDefinition[] = [
  { ...common, id: "files.preview_deletion", implementation: "previewFileDeletion", effect: "read", executionMode: "local",
    name: "精确文件删除预览", description: "为删除确认只读获取普通文件的路径、大小、身份与SHA-256，生成十分钟内有效的候选快照；不返回文本正文或配置值。",
    usageInstructions: "先依据用户条件发现候选，再传入精确绝对paths清单；不接受目录、链接、路径跳转或通配展开。不会删除。确认后删除需求使用本工具→files.confirm_deletion→files.delete_confirmed；不得改成rm重新扫描目录。需要Python3.6以上、Linux文件系统读租约及不跟随链接能力；单批候选总大小最多128MiB，保护窗口最多5秒，实际还受内核租约时限约束。存在活动写入、能力缺失或无法在限额内取得完整身份与摘要时如实停止，不安装依赖或绕过保护。",
    inputSchema: object({ paths: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: path } }),
    outputDescription: "真实候选元数据、previewId及expiresAt；不含content，不能读取或解析JSON配置，正文读取应使用files.read_content。仅预览，不是删除授权或释放空间证明。" },
  { ...common, id: "files.confirm_deletion", implementation: "confirmFileDeletion", effect: "interaction", executionMode: "user-input",
    requiresTargetChange: true,
    name: "确认精确文件删除", description: "展示Core保存的真实候选清单，请用户确认或拒绝；不执行删除。",
    usageInstructions: "使用当前任务files.preview_deletion返回的previewId，Core生成完整清单和独立确认选项。只能用于用户要求的变更或确认后变更任务；永久只读需求不能使用。拒绝或超时不产生许可；旧确认不得复用到其他任务、需求版本或服务器。",
    inputSchema: object({ previewId: id }), outputDescription: "decision为confirm或reject，authorizationId仅在confirm且范围仍有效时能用于专用删除工具。" },
  { ...common, id: "files.delete_confirmed", implementation: "deleteConfirmedFiles", effect: "change", executionMode: "local",
    requiresTargetChange: true,
    name: "执行已确认文件删除", description: "仅删除用户确认的同一批普通文件，执行前核对全部文件身份；不扫描新文件或跟随链接。",
    usageInstructions: "authorizationId必须来自本任务files.confirm_deletion的confirm结果。执行前核验原文件身份和SHA-256，取得整批Linux读租约后才能隔离和删除；不能处理正在写入或不支持租约的文件。每次许可只派发一次，失败或结果未知不得重复执行；不得用普通用户表单回答、托管模式或旧许可替代。删除后仍需按用户目标验收，不将文件逻辑大小当实际释放空间。",
    inputSchema: object({ authorizationId: id }), outputDescription: "确认标识和本次实际删除的精确路径；失败可能已有部分副作用，交由账本核对。" },
];
