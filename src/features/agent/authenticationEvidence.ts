import type { OpsTask, PlanStep, SecretMetadata } from "@/types";
import { findSecretKeys } from "./secretTool";
import { textFingerprint } from "./longRunningReviewOutput";
import { normalizeAuthenticationTarget } from "./authenticationTarget";
import { sha256Utf8 } from "./planPreparation";

export type AuthenticationOutcome = "connection_failed" | "route_rejected" | "material_missing"
  | "authentication_rejected" | "permission_denied" | "unknown" | "authenticated";
export interface AuthenticationEvidence {
  id: string;
  taskId: string;
  stepId: string;
  serverId: string;
  client: string;
  target?: string;
  transport: "tcp" | "socket" | "ssh" | "unknown";
  credentialKeys: string[];
  accountRef: string;
  materialProvided: boolean;
  outcome: AuthenticationOutcome;
  createdAt: string;
  source: "main" | "validation";
  credentialRevision: number;
  /** v2 is declared client scope, not proof of a server's authentication algorithm. */
  evidenceVersion?: 2;
  database?: string;
  port?: number;
  clientPath?: string;
  authenticationMethod?: "tracked_secret" | "confirmed_socket_identity" | "untracked";
  identityConfirmed?: boolean;
  agentSessionId?: string;
  agentSessionGeneration?: number;
}

/** Errors identify a failed stage, not whether a password is intrinsically wrong. */
export function classifyAuthenticationFailure(output: string): Exclude<AuthenticationOutcome, "authenticated"> | undefined {
  if (/using password:\s*NO|no authentication methods available|terminal prompts disabled/i.test(output)) return "material_missing";
  if (/Host .+ is not allowed to connect|host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|certificate verify failed/i.test(output)) return "route_rejected";
  if (/command denied to user|permission denied for (?:table|schema|database|relation)|insufficient privilege/i.test(output)) return "permission_denied";
  if (/authentication failed|password authentication failed|Access denied for user|Permission denied \((?:publickey|password)|HTTP Basic: Access denied|invalid (?:username|password|credentials?)|仓库认证未通过.*再次请求/i.test(output)) return "authentication_rejected";
  if (/connection refused|connection timed out|could not resolve host|network is unreachable|could not connect/i.test(output)) return "connection_failed";
  return undefined;
}

/** Conservative lexer: no evaluation, pipelines, expansion, redirection or compound scripts. */
function simpleArguments(command: string): string[] | undefined {
  const args: string[] = []; let word = ""; let quote = ""; let started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "$") {
      const placeholder = command.slice(i).match(/^\$\{secret\.[A-Z0-9_]+\}/)?.[0];
      if (!placeholder) return undefined;
      word += placeholder; started = true; i += placeholder.length - 1; continue;
    }
    if (c === "`" || c === "\\") return undefined;
    if (quote) { if (c === quote) quote = ""; else word += c; started = true; continue; }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (/[;|&<>\n\r]/.test(c)) return undefined;
    if (/\s/.test(c)) { if (started) args.push(word); word = ""; started = false; }
    else { word += c; started = true; }
  }
  if (quote) return undefined;
  if (started) args.push(word);
  return args;
}

/** A single psql SQL invocation; never a script, connection string or metacommand. */
function describePostgres(args: string[], password?: string) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const aliases: Record<string, string> = { "-h": "host", "--host": "host", "-p": "port", "--port": "port", "-U": "user", "--username": "user",
    "-d": "database", "--dbname": "database", "-c": "sql", "--command": "sql", "-v": "variable", "--set": "variable", "--variable": "variable", "-P": "printing", "--pset": "printing" };
  const booleans: Record<string, string> = { "--no-psqlrc": "X", "--no-password": "w", "--no-align": "A", "--tuples-only": "t", "--quiet": "q", "--csv": "csv" };
  for (let i = 1; i < args.length; i++) {
    const token = args[i];
    if (booleans[token]) { flags.add(booleans[token]); continue; }
    if (/^-[XwAtq]+$/.test(token)) { [...token.slice(1)].forEach(flag => flags.add(flag)); continue; }
    const long = token.startsWith("--") ? token.split("=", 1)[0] : undefined;
    const option = aliases[token] ? token : long && aliases[long] ? long : aliases[token.slice(0, 2)] ? token.slice(0, 2) : undefined;
    if (!option) return;
    const key = aliases[option];
    const value = token === option ? args[++i] : token.slice(option.length + (option.startsWith("--") ? 1 : 0));
    if (!value || values.has(key)) return;
    if (key === "variable" && value !== "ON_ERROR_STOP=1") return;
    if (key === "printing" && value !== "pager=off") return;
    values.set(key, value);
  }
  const host = values.get("host"), user = values.get("user"), database = values.get("database"), sql = values.get("sql"), rawPort = values.get("port");
  if (!host || !user || !database || !sql || !rawPort || !flags.has("X") || !flags.has("w")
    || !/^[0-9]{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535
    || /[=\u0000-\u001f\u007f]/.test(database) || /^postgres(?:ql)?:/i.test(database)
    || /[\u0000-\u001f\u007f]/.test(user) || /[,\u0000-\u001f\u007f]/.test(host)
    || findSecretKeys(host + database).length || /\\/.test(sql)) return;
  const transport = host.startsWith("/") ? "socket" as const : "tcp" as const;
  let target: string;
  try { target = normalizeAuthenticationTarget("database", transport === "socket" ? host : `${host}:${Number(rawPort)}`); } catch { return; }
  return { client: "psql", clientPath: args[0], target, transport, port: Number(rawPort), database, evidenceVersion: 2 as const,
    credentialKeys: [...new Set(findSecretKeys(`${user} ${password ?? ""}`))].sort(),
    accountRef: findSecretKeys(user)[0] ?? `explicit-sha256:${sha256Utf8(user)}`,
    materialProvided: Boolean(password), authenticationMethod: password ? "tracked_secret" as const : transport === "socket" ? "confirmed_socket_identity" as const : "untracked" as const };
}

/** Client protocol adapters, not business-task rules. Unknown scripts never prove authentication. */
export function describeAuthentication(command: string) {
  const args = simpleArguments(command);
  if (!args?.length) return undefined;
  let password: string | undefined;
  const assignments = new Set<string>();
  while (/^[A-Z_]+=/.test(args[0] ?? "")) {
    const token = args.shift()!; const split = token.indexOf("=");
    const name = token.slice(0, split), value = token.slice(split + 1);
    if (assignments.has(name)) return;
    assignments.add(name);
    if (name === "PGPASSWORD" && /^\$\{secret\.[A-Z0-9_]+\}$/.test(value)) password = value;
    else if (name !== "PGOPTIONS" || !/^-c\s+default_transaction_read_only=(?:on|true|1)$/.test(value)) return;
  }
  if (!args.length) return;
  const client = args[0].split("/").slice(-1)[0];
  if (client === "psql") return describePostgres(args, password);
  if (assignments.size) return;
  if (!["mysql", "mariadb", "psql"].includes(client)) return undefined;
  // Defaults files, duplicate flags and protocol overrides can change the
  // effective endpoint/identity. Do not manufacture proof from a partial parse.
  if (args.some(arg => /^--(?:defaults|login-path|service|print-defaults)/.test(arg))) return undefined;
  for (const [short, long] of [["-h", "--host"], ["-S", "--socket"], ["-P", "--port"],
    ["-u", "--user"], ["-U", "--username"], ["-p", "--password"], ["--protocol", "--protocol"]]) {
    if (args.filter(arg => arg === short || arg === long || arg.startsWith(`${long}=`)
      || (short.length === 2 && arg.startsWith(short) && !arg.startsWith("--"))).length > 1) return undefined;
  }
  const flag = (short: string, long: string) => {
    for (let i = 1; i < args.length; i++) {
      if (args[i] === short || args[i] === long) return args[i + 1];
      if (args[i].startsWith(`${long}=`)) return args[i].slice(long.length + 1);
      if (args[i].startsWith(short) && args[i].length > short.length) return args[i].slice(short.length);
    }
    return undefined;
  };
  const sql = flag(client === "psql" ? "-c" : "-e", "--execute") ?? (client === "psql" ? flag("-c", "--command") : undefined);
  if (!sql || args.some(arg => ["--help", "--version", "-V"].includes(arg))) return undefined;
  const socket = client === "psql" ? undefined : flag("-S", "--socket");
  const protocol = flag("--protocol", "--protocol")?.toUpperCase();
  if (protocol && (socket ? protocol !== "SOCKET" : protocol !== "TCP")) return undefined;
  const host = flag("-h", "--host");
  const port = flag(client === "psql" ? "-p" : "-P", "--port");
  const user = flag(client === "psql" ? "-U" : "-u", "--user");
  const secret = client === "psql" ? undefined : flag("-p", "--password");
  let target: string | undefined;
  try { target = socket ? normalizeAuthenticationTarget("database", socket)
    : host && port ? normalizeAuthenticationTarget("database", `${host}:${port}`) : undefined; } catch { /* unresolved target */ }
  return {
    client: client === "mariadb" ? "mysql" : client,
    target,
    transport: socket ? "socket" as const : host ? "tcp" as const : "unknown" as const,
    credentialKeys: [...new Set(findSecretKeys([user ?? "", secret ?? ""].join(" ")))].sort(),
    accountRef: user ? (findSecretKeys(user)[0] ?? `explicit:${textFingerprint(user)}`) : "implicit-account",
    materialProvided: Boolean(secret && !secret.startsWith("-")),
    evidenceVersion: 2 as const,
    clientPath: args[0],
    authenticationMethod: secret && /^\$\{secret\.[A-Z0-9_]+\}$/.test(secret) ? "tracked_secret" as const : "untracked" as const,
  };
}

export const AUTHENTICATION_POLICY = "认证证据只证明记录时间、执行来源和具体连接组合。连接/来源拒绝不等于密码错误；未提交密码不等于已存凭据无效。不得自行改账号、改成免密、扩大权限或跨实例复用。旧成功证据不是永久授权；目标/方式无法核对时询问并等待，同一失败认证组合无新证据不得重试。";

export function authenticationContext(task: OpsTask) {
  const attempts = task.authenticationEvidence?.slice(-12) ?? [];
  return { instruction: AUTHENTICATION_POLICY + "读取连接说明只提供线索，不证明已连接。已确认的socket身份不等于证明服务端使用peer算法；仅在同一任务、执行会话、端点、端口、数据库、账户和凭据版本内复用真实新鲜成功，不能据此省略恢复后的数据/结构/约束验收。",
    attempts,
    reusableConnections: attempts.filter(e => reusableEvidence(task, e) && e.outcome === "authenticated"
      && e.identityConfirmed && !attempts.some(later => sameConnection(e, later) && Date.parse(later.createdAt) >= Date.parse(e.createdAt) && later.id !== e.id && later.outcome !== "authenticated")),
    availableCredentials: task.authenticationCredentials ?? [] };
}

function reusableEvidence(task: OpsTask, evidence: AuthenticationEvidence) {
  const age = Date.now() - Date.parse(evidence.createdAt);
  return evidence.evidenceVersion === 2 && evidence.taskId === task.id
    && typeof task.agentSessionId === "string" && task.agentSessionId.length > 0
    && Number.isSafeInteger(task.agentSessionGeneration) && Number(task.agentSessionGeneration) >= 0
    && evidence.serverId === (task.executionTargetServerId || task.serverId)
    && evidence.credentialRevision === (task.credentialRevision ?? 0)
    && evidence.agentSessionId === task.agentSessionId && evidence.agentSessionGeneration === task.agentSessionGeneration
    && age >= 0 && age < 30 * 60_000;
}
function sameConnection(first: Pick<AuthenticationEvidence, "client" | "target" | "transport" | "accountRef" | "credentialKeys" | "database" | "port" | "clientPath" | "authenticationMethod">,
  second: typeof first) {
  return first.client === second.client && first.target === second.target && first.transport === second.transport
    && first.accountRef === second.accountRef && JSON.stringify(first.credentialKeys) === JSON.stringify(second.credentialKeys)
    && first.database === second.database && first.port === second.port && first.clientPath === second.clientPath
    && first.authenticationMethod === second.authenticationMethod;
}

export function authenticationFingerprint(task: OpsTask, step: PlanStep) {
  return JSON.stringify([task.currentRoundId, task.executionTargetServerId || task.serverId,
    task.agentSessionId, task.agentSessionGeneration, task.credentialRevision ?? 0, step.command, step.validation]);
}

export function authenticationBlocker(task: OpsTask, step: PlanStep, metadata: SecretMetadata[]): string | undefined {
  const attempt = describeAuthentication(step.command);
  const serverId = task.executionTargetServerId || task.serverId;
  const available = metadata.filter(m => m.serverId === serverId && m.credentialKind === "database");
  if (!attempt) {
    const keys = findSecretKeys(step.command);
    const usesCredentials = metadata.some(m => m.serverId === serverId && m.credentialKind && keys.includes(m.key));
    const opaqueClient = /(?:^|[;|&\n]\s*|\s)['"]?(?:[^\s'"]*\/)?(?:mysql|mariadb|psql)['"]?\s+/.test(step.command)
      && !/^\s*['"]?(?:[^\s'"]*\/)?(?:mysql|mariadb|psql)['"]?\s+(?:--version|-V|--help)\s*$/.test(step.command);
    if (usesCredentials || opaqueClient) {
      return "该认证命令包含无法可靠解析的参数或复合脚本，不能核对目标、身份和凭据适用范围。请检查命令并明确确认；不会据此生成认证成功证据。";
    }
    return undefined;
  }
  const prior = (task.authenticationEvidence ?? []).filter(e => reusableEvidence(task, e) && e.client === attempt.client);
  const stored = available.flatMap(m => m.authenticationEvidence ?? []).filter(e => reusableEvidence(task, e));
  const related = [...stored, ...prior].filter(e => sameConnection(e, attempt))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (["authentication_rejected", "route_rejected", "material_missing", "permission_denied"].includes(related.slice(-1)[0]?.outcome ?? "")) {
    return "同一目标和认证组合已被拒绝。没有新凭据或认证证据，不能自动重复尝试；请核对本次目标、身份和方法后明确确认。";
  }
  const latest = related.slice(-1)[0];
  if (attempt.authenticationMethod === "confirmed_socket_identity" && latest?.outcome === "authenticated" && latest.identityConfirmed) return undefined;
  if (!attempt.materialProvided || !attempt.credentialKeys.length || attempt.accountRef === "implicit-account") {
    return "本步骤没有使用可追踪的密码引用，或正在尝试隐式/免密认证。现有证据不足以支持该认证组合，请明确确认本次身份和认证方式。";
  }
  if (prior.length && !prior.some(e => e.accountRef === attempt.accountRef)) {
    return "本步骤更换了认证身份，未发现该身份的适用认证证据，需要用户明确确认。";
  }
  const referenced = available.filter(m => attempt.credentialKeys.includes(m.key));
  if (referenced.length && related.slice(-1)[0]?.outcome !== "authenticated"
    && (!attempt.target || referenced.some(m => m.credentialTarget !== attempt.target))) {
    return "凭据目标与本次连接端点不同或尚不明确（可能是 TCP/socket 切换）。不能仅凭同一服务器认定同一实例，请确认适用范围。";
  }
  return undefined;
}

export function recordAuthentication(task: OpsTask, step: PlanStep, metadata: SecretMetadata[],
  result: { output: string; success: boolean; exitCode?: number }, source: "main" | "validation", executionId: string) {
  const description = describeAuthentication(source === "main" ? step.command : step.validation);
  if (!description) return;
  const serverId = task.executionTargetServerId || task.serverId;
  const evidence: AuthenticationEvidence = {
    ...description, id: executionId, taskId: task.id, stepId: step.id, serverId, source,
    outcome: classifyAuthenticationFailure(result.output)
      ?? (result.success && result.exitCode === 0 ? "authenticated" : "unknown"),
    createdAt: new Date().toISOString(), credentialRevision: step.authenticationAttempt?.credentialRevision ?? task.credentialRevision ?? 0,
    agentSessionId: task.agentSessionId, agentSessionGeneration: task.agentSessionGeneration,
    identityConfirmed: description.authenticationMethod === "tracked_secret"
      || Boolean(step.authenticationGate?.approved && step.authenticationGate.fingerprint === authenticationFingerprint(task, step))
      || Boolean((task.authenticationEvidence ?? []).some(prior => reusableEvidence(task, prior) && sameConnection(prior, description) && prior.identityConfirmed && prior.outcome === "authenticated")),
  };
  task.authenticationEvidence = [...(task.authenticationEvidence ?? []), evidence].slice(-32);
  for (const m of metadata.filter(m => m.serverId === serverId && description.credentialKeys.includes(m.key))) {
    m.authenticationEvidence = [...(m.authenticationEvidence ?? []), evidence].slice(-8);
  }
  return evidence;
}
