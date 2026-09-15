import type { OpsTask, PlanStep, SecretMetadata } from "@/types";
import { findSecretKeys } from "./secretTool";
import { textFingerprint } from "./longRunningReviewOutput";
import { normalizeAuthenticationTarget } from "./authenticationTarget";

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

/** Client protocol adapters, not business-task rules. Unknown scripts never prove authentication. */
export function describeAuthentication(command: string) {
  const args = simpleArguments(command);
  if (!args?.length) return undefined;
  const client = args[0].split("/").slice(-1)[0];
  if (!["mysql", "mariadb", "psql"].includes(client)) return undefined;
  // Defaults files, duplicate flags and protocol overrides can change the
  // effective endpoint/identity. Do not manufacture proof from a partial parse.
  if (args.some(arg => /^--(?:defaults|login-path|service)/.test(arg))) return undefined;
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
  };
}

export const AUTHENTICATION_POLICY = "认证证据只证明记录时间、执行来源和具体连接组合。连接/来源拒绝不等于密码错误；未提交密码不等于已存凭据无效。不得自行改账号、改成免密、扩大权限或跨实例复用。旧成功证据不是永久授权；目标/方式无法核对时询问并等待，同一失败认证组合无新证据不得重试。";

export function authenticationContext(task: OpsTask) {
  return { instruction: AUTHENTICATION_POLICY, attempts: task.authenticationEvidence?.slice(-12) ?? [],
    availableCredentials: task.authenticationCredentials ?? [] };
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
    const opaqueClient = /(?:^|[;|&\n]\s*|\s)(?:\S*\/)?(?:mysql|mariadb|psql)\s+-/.test(step.command)
      && !/^\s*(?:\S*\/)?(?:mysql|mariadb|psql)\s+(?:--version|-V|--help)\s*$/.test(step.command);
    if (usesCredentials || (opaqueClient && (available.length || task.authenticationEvidence?.length))) {
      return "该认证命令包含无法可靠解析的参数或复合脚本，不能核对目标、身份和凭据适用范围。请检查命令并明确确认；不会据此生成认证成功证据。";
    }
    return undefined;
  }
  const prior = (task.authenticationEvidence ?? []).filter(e => e.serverId === serverId && e.client === attempt.client
    && e.credentialRevision === (task.credentialRevision ?? 0)
    && Date.now() >= Date.parse(e.createdAt) && Date.now() - Date.parse(e.createdAt) < 30 * 60_000);
  const stored = available.flatMap(m => m.authenticationEvidence ?? []).filter(e => e.serverId === serverId
    && Date.now() >= Date.parse(e.createdAt) && Date.now() - Date.parse(e.createdAt) < 30 * 60_000);
  const related = [...stored, ...prior].filter(e => e.client === attempt.client && e.target === attempt.target
    && e.transport === attempt.transport && e.accountRef === attempt.accountRef && JSON.stringify(e.credentialKeys) === JSON.stringify(attempt.credentialKeys))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (["authentication_rejected", "route_rejected", "material_missing", "permission_denied"].includes(related.slice(-1)[0]?.outcome ?? "")) {
    return "同一目标和认证组合已被拒绝。没有新凭据或认证证据，不能自动重复尝试；请核对本次目标、身份和方法后明确确认。";
  }
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
    createdAt: new Date().toISOString(), credentialRevision: task.credentialRevision ?? 0,
  };
  task.authenticationEvidence = [...(task.authenticationEvidence ?? []), evidence].slice(-32);
  for (const m of metadata.filter(m => m.serverId === serverId && description.credentialKeys.includes(m.key))) {
    m.authenticationEvidence = [...(m.authenticationEvidence ?? []), evidence].slice(-8);
  }
  return evidence;
}
