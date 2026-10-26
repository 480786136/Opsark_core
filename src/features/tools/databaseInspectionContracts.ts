import type { ToolDefinition } from "./types";
import { fullSchemaPattern } from "./toolSchemaPatterns";

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const text = { type: "string", maxLength: 32768 };
const identifier = { type: "string", minLength: 1, maxLength: 63, pattern: fullSchemaPattern("[^\\u0000-\\u001f\\u007f\\\\]+") };
const path = { type: "string", minLength: 2, maxLength: 4096, pattern: fullSchemaPattern("/[^\\u0000-\\u001f\\u007f\\\\]+") };
const key = { type: "string", pattern: fullSchemaPattern("[A-Z][A-Z0-9_]{0,79}") };
const integer = (minimum: number, maximum: number, fallback?: number) => ({ type: "integer", minimum, maximum, ...(fallback === undefined ? {} : { default: fallback }) });
const enumeration = (...values: string[]) => ({ type: "string", enum: values });
const array = (items: unknown, maxItems: number) => ({ type: "array", items, maxItems });
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });
const sha256 = { type: "string", pattern: fullSchemaPattern("[0-9a-f]{64}") };
export const databaseInspectionInputSchema = { ...object({
  clientPath: { ...path, description: "已确认的psql绝对路径，不自动安装客户端。" },
  transport: enumeration("tcp", "socket"), host: { ...text, minLength: 1, maxLength: 4096 },
  port: integer(1, 65535), database: identifier, auth: enumeration("password", "socket_identity"),
  usernameSecretKey: key, passwordSecretKey: key, username: identifier, sslRootCertPath: path,
  tables: { ...array(object({ schema: identifier, name: identifier }), 8), minItems: 1, uniqueItems: true },
  timeoutSeconds: integer(1, 120, 30), maxRowsPerTable: integer(1, 10000, 1000),
  maxDataBytes: { ...integer(1024, 16777216, 1048576), description: "整个连接实际读取的JSON协议字节预算，超限保留未知，不能当完整内容摘要。" },
}, ["clientPath", "transport", "host", "port", "database", "auth", "tables"]),
  allOf: [
    { if: { properties: { auth: { const: "password" } } }, then: { required: ["usernameSecretKey", "passwordSecretKey"], not: { required: ["username"] } },
      else: { required: ["username"], properties: { transport: { const: "socket" } }, not: { anyOf: [{ required: ["usernameSecretKey"] }, { required: ["passwordSecretKey"] }] } } },
    { if: { properties: { transport: { const: "tcp" } } }, then: { required: ["sslRootCertPath"] }, else: { not: { required: ["sslRootCertPath"] } } },
  ],
};

const table = object({ schema: identifier, name: identifier,
  status: enumeration("complete", "partial", "missing", "unsupported", "unknown"), reason: text,
  rowCount: nullable(integer(0, 10000)), dataSha256: nullable(sha256), dataBytes: integer(0, 16777216),
  columns: array(object({ name: identifier, type: text, nullable: { type: "boolean" }, default: nullable(text), identity: text, generated: text, collation: nullable(text) }), 256),
  constraints: array(object({ name: identifier, type: text, definition: text, validated: { type: "boolean" }, deferrable: { type: "boolean" }, initiallyDeferred: { type: "boolean" } }), 256),
  indexes: array(object({ name: identifier, definition: text, unique: { type: "boolean" }, primary: { type: "boolean" }, valid: { type: "boolean" }, ready: { type: "boolean" } }), 256),
  structureSha256: nullable(sha256),
});
export const DATABASE_INSPECTION_LIMITATIONS = ["single_database_snapshot", "explicit_ordinary_heap_tables_only", "builtin_scalar_types_only",
  "logical_json_content_not_physical_backup", "no_sequences_triggers_privileges_or_extensions", "not_cross_database_atomic", "not_restore_acceptance"] as const;
export const databaseInspectionOutputSchema = object({
  version: { const: 1 }, request: databaseInspectionInputSchema,
  status: enumeration("complete", "partial", "timeout", "unsupported", "error"), reason: text,
  coverageComplete: { type: "boolean" }, truncated: { type: "boolean" }, connectionVerified: { type: "boolean" },
  connection: nullable(object({ requestedHost: text, transport: enumeration("tcp", "socket"), port: integer(1, 65535), database: identifier,
    sessionUser: text, currentUser: text, serverAddress: nullable(text), tls: { type: "boolean" }, serverVersionNum: integer(120000, 999999),
    readOnly: { const: true }, isolation: { const: "repeatable read" }, snapshot: text, observedAt: text })),
  tables: array(table, 8), snapshotScope: { const: "single_database" },
  limitations: { ...array(enumeration(...DATABASE_INSPECTION_LIMITATIONS), DATABASE_INSPECTION_LIMITATIONS.length), minItems: DATABASE_INSPECTION_LIMITATIONS.length, uniqueItems: true },
  readBytes: integer(0, 16777216), elapsedMs: integer(0, Number.MAX_SAFE_INTEGER),
  observationsRedacted: { type: "boolean" },
}, ["version", "request", "status", "reason", "coverageComplete", "truncated", "connectionVerified", "connection", "tables", "snapshotScope", "limitations", "readBytes", "elapsedMs"]);

export const databaseInspectionToolCatalog: ToolDefinition[] = [{
  id: "database.inspect_postgres", implementation: "inspectPostgres", effect: "read", executionMode: "local", planMode: "read_batch", completionMode: "continue",
  name: "PostgreSQL指定表只读证据采集", description: "同一明确连接、同一只读可重复读快照中，核实数据库身份并采集指定普通表的逻辑内容摘要、列、约束和索引。",
  usageInstructions: "只用于用户已要求的指定表检查或备份恢复验收证据；先确认精确端点、库、账户与客户端，Core仍执行现有认证确认。password模式必须传已收集的用户名/密码SecretKey，不传明文；socket_identity需明确账户且首次确认，不能自动转免密。TCP必须指定CA证书并使用verify-full，失败不能降级。不接受SQL、自动安装、写库或恢复。complete仅表示本次指定普通表在单库快照中完整采集，必须比较源/目标的内容与结构摘要并保留逐项结果；跨库快照非原子，不证明源库之后未变。行数相等不是内容等价；未知、缺表、超限或不支持不得当恢复成功。不覆盖序列状态、触发器、权限、扩展及整个数据库。",
  inputSchema: databaseInspectionInputSchema, outputDescription: "真实连接身份及每表内容SHA-256、行数、列/约束/索引与结构SHA-256；完整性、范围和限制显式返回，原始数据行不进入结果。",
  outputSchema: databaseInspectionOutputSchema, enabled: true, builtIn: true, version: 1, updatedAt: "2026-10-12T00:00:00.000Z",
}];
