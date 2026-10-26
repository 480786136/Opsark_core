import probe from "./postgres_inspection_probe.py?raw";
import { databaseInspectionInputSchema, databaseInspectionOutputSchema, DATABASE_INSPECTION_LIMITATIONS } from "./databaseInspectionContracts";
import { fillToolDefaults, validateSchemaValue } from "./toolParameterSchema";

export interface PostgresInspectionRequest {
  clientPath: string; transport: "tcp" | "socket"; host: string; port: number; database: string;
  auth: "password" | "socket_identity"; usernameSecretKey?: string; passwordSecretKey?: string; username?: string; sslRootCertPath?: string;
  tables: Array<{ schema: string; name: string }>; timeoutSeconds: number; maxRowsPerTable: number; maxDataBytes: number;
}
export interface DatabaseInspectionTable {
  schema: string; name: string; status: "complete" | "partial" | "missing" | "unsupported" | "unknown"; reason: string;
  rowCount: number | null; dataSha256: string | null; dataBytes: number;
  columns: Array<{ name: string; type: string; nullable: boolean; default: string | null; identity: string; generated: string; collation: string | null }>;
  constraints: Array<{ name: string; type: string; definition: string; validated: boolean; deferrable: boolean; initiallyDeferred: boolean }>;
  indexes: Array<{ name: string; definition: string; unique: boolean; primary: boolean; valid: boolean; ready: boolean }>;
  structureSha256: string | null;
}
export interface DatabaseInspectionResult {
  version: 1; request: PostgresInspectionRequest; status: "complete" | "partial" | "timeout" | "unsupported" | "error"; reason: string;
  coverageComplete: boolean; truncated: boolean; connectionVerified: boolean;
  connection: null | { requestedHost: string; transport: "tcp" | "socket"; port: number; database: string; sessionUser: string; currentUser: string;
    serverAddress: string | null; tls: boolean; serverVersionNum: number; readOnly: true; isolation: "repeatable read"; snapshot: string; observedAt: string };
  tables: DatabaseInspectionTable[]; snapshotScope: "single_database"; limitations: string[]; readBytes: number; elapsedMs: number; observationsRedacted?: boolean;
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}` : JSON.stringify(value);

export function normalizeDatabaseInspectionRequest(value: Record<string, unknown> | PostgresInspectionRequest): PostgresInspectionRequest {
  const request = fillToolDefaults(databaseInspectionInputSchema, value) as PostgresInspectionRequest;
  validateSchemaValue(databaseInspectionInputSchema, request, "PostgreSQL检查参数", "");
  const cleanPath = (path: string) => path.startsWith("/") && !path.split("/").some(part => part === ".." || part === ".") && !path.includes("//")
    && !/[`$*?\[\]\\\u0000-\u001f\u007f]/.test(path);
  if (!cleanPath(request.clientPath) || !request.clientPath.endsWith("/psql")) throw new Error("必须提供明确的psql绝对路径");
  if (request.transport === "socket") {
    if (!cleanPath(request.host) || request.sslRootCertPath !== undefined) throw new Error("socket必须为明确绝对目录，不能混入TCP证书选项");
  } else if (!/^[A-Za-z0-9_.:-]+$/.test(request.host) || request.host.startsWith("-") || request.host.includes(",")
    || !request.sslRootCertPath || !cleanPath(request.sslRootCertPath)) throw new Error("TCP连接需要单一明确主机及CA证书绝对路径，不允许TLS降级");
  if (/[=]/.test(request.database) || /^postgres(?:ql)?:/i.test(request.database)) throw new Error("数据库名不能是连接串");
  for (const identifier of [request.database, ...request.tables.flatMap(table => [table.schema, table.name]), ...(request.username ? [request.username] : [])]) {
    if (new TextEncoder().encode(identifier).length > 63 || /\$\{secret\./.test(identifier)) throw new Error("数据库标识符必须明确且不超过63个UTF-8字节");
  }
  if (request.auth === "password") {
    if (!request.usernameSecretKey || !request.passwordSecretKey || request.usernameSecretKey === request.passwordSecretKey || request.username !== undefined) throw new Error("密码认证必须提供不同的用户名和密码SecretKey，不能传明文用户名");
  } else if (request.transport !== "socket" || !request.username || request.usernameSecretKey !== undefined || request.passwordSecretKey !== undefined) throw new Error("系统身份认证只允许显式socket账户，不得自动转换TCP或密码认证");
  if (new Set(request.tables.map(table => stable(table))).size !== request.tables.length) throw new Error("不能重复请求同一表");
  return request;
}

/** Public identity descriptor for the existing gate. It must never be executed as the probe. */
export function buildDatabaseAuthenticationCommand(value: Record<string, unknown> | PostgresInspectionRequest): string {
  const request = normalizeDatabaseInspectionRequest(value);
  const username = request.auth === "password" ? `\${secret.${request.usernameSecretKey}}` : request.username!;
  const password = request.auth === "password" ? `PGPASSWORD=\${secret.${request.passwordSecretKey}} ` : "";
  return `${password}${quote(request.clientPath)} -X -w -h ${quote(request.host)} -p ${request.port} -U ${quote(username)} -d ${quote(request.database)} -v ON_ERROR_STOP=1 -c 'BEGIN READ ONLY; SELECT current_database(), session_user; ROLLBACK;'`;
}

/** Private execution text: callers must audit only the public descriptor, never this returned string. */
export function buildDatabaseInspectionCommand(value: Record<string, unknown> | PostgresInspectionRequest, credentials: { username: string; password?: string }): string {
  const request = normalizeDatabaseInspectionRequest(value);
  if (!credentials.username || new TextEncoder().encode(credentials.username).length > 63 || /[\u0000-\u001f\u007f]/.test(credentials.username)
    || (request.auth === "password" && (typeof credentials.password !== "string" || !credentials.password || credentials.password.includes("\0")))
    || (request.auth === "socket_identity" && (credentials.username !== request.username || credentials.password !== undefined))) throw new Error("数据库私有凭据缺失或与已批准身份不一致");
  // JSON contains the public request only. The two private values are safely quoted shell arguments,
  // and are never interpolated into Python source, SQL or the public tool receipt.
  return `python3 -I -B -u -c ${quote(probe)} ${quote(JSON.stringify(request))} ${quote(credentials.username)} ${quote(credentials.password ?? "")}`;
}

export function databaseInspectionResultIssue(value: Record<string, unknown> | PostgresInspectionRequest, result: DatabaseInspectionResult): string | undefined {
  const request = normalizeDatabaseInspectionRequest(value);
  if (stable(result.request) !== stable(request)) return "数据库采集回执与请求范围不一致";
  if (result.readBytes > request.maxDataBytes || result.tables.length > request.tables.length) return "数据库采集超过声明预算";
  if (result.connectionVerified !== Boolean(result.connection)) return "连接验证状态缺少真实身份回执";
  if (result.connection) {
    const connection = result.connection;
    if (connection.requestedHost !== request.host || connection.transport !== request.transport || connection.port !== request.port || connection.database !== request.database
      || !connection.currentUser || connection.currentUser !== connection.sessionUser
      || (request.auth === "socket_identity" && connection.currentUser !== request.username)
      || (request.transport === "tcp" ? !connection.serverAddress || !connection.tls : connection.serverAddress !== null || connection.tls)
      || !connection.snapshot || !Number.isFinite(Date.parse(connection.observedAt))) return "实际连接身份、只读快照或TLS与请求不一致";
  }
  if (result.tables.some((table, i) => table.schema !== request.tables[i].schema || table.name !== request.tables[i].name
    || table.dataBytes > request.maxDataBytes || (table.rowCount !== null && table.rowCount > request.maxRowsPerTable)
    || (table.status === "complete" ? table.rowCount === null || !table.dataSha256 || !table.structureSha256 || !table.columns.length || Boolean(table.reason)
      : table.rowCount !== null || table.dataSha256 !== null || table.structureSha256 !== null))) return "表证据的范围、摘要或完整性矛盾";
  const complete = result.status === "complete";
  if (result.coverageComplete !== complete || result.truncated === complete
    || (complete && (!result.connectionVerified || result.tables.length !== request.tables.length || result.tables.some(table => table.status !== "complete") || result.reason))) return "不完整数据库证据不能声明完整";
  if (DATABASE_INSPECTION_LIMITATIONS.some(limit => !result.limitations.includes(limit))) return "数据库采集缺少必要范围限制";
  return undefined;
}

export function parseDatabaseInspectionOutput(output: string, value: Record<string, unknown> | PostgresInspectionRequest): DatabaseInspectionResult {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith("OPSARK_POSTGRES_RESULT "));
  if (lines.length !== 1 || new TextEncoder().encode(lines[0]).length > 262144) throw new Error("未取得唯一有界PostgreSQL结构化回执");
  let result: DatabaseInspectionResult;
  try { result = JSON.parse(lines[0].slice("OPSARK_POSTGRES_RESULT ".length)); } catch { throw new Error("PostgreSQL回执不是有效JSON"); }
  if (Object.prototype.hasOwnProperty.call(result, "observationsRedacted")) throw new Error("远端不能预先声明Core脱敏状态");
  validateSchemaValue(databaseInspectionOutputSchema, result, "PostgreSQL采集回执", "");
  const issue = databaseInspectionResultIssue(value, result);
  if (issue) throw new Error(issue);
  return result;
}
