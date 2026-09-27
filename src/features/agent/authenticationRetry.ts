import type { OpsTask, PlanStep } from "@/types";
import { gitAuthenticationOperation } from "./interactiveSshCredential";
import { activeConfirmedInputEntries } from "./confirmedUserInputs";

export function authenticationChannelFailure(output: string) {
  return /PTY_AUTH_CHANNEL_UNAVAILABLE|(?:could not read (?:Username|Password)[^\n]*(?:No such device|没有那个设备|cannot open|无法打开))|cannot open[^\n]*\/dev\/tty/i.test(output);
}

export function gitAuthenticationFailure(step: PlanStep) {
  if (step.status !== "failed" || step.result?.facts.commandDispatched === false) return undefined;
  const output = step.evidence?.filter(item => item.source === "main").map(item => item.rawOutput).join("\n") || step.output || "";
  if (authenticationChannelFailure(output)) {
    // An anonymous/noninteractive probe has not attempted credential injection.
    // Its missing /dev/tty is missing material, not proof that the bound PTY broke.
    return step.authenticationAttempt?.channel === "noninteractive"
      && !output.includes("PTY_AUTH_CHANNEL_UNAVAILABLE") ? "material" : "channel";
  }
  if (/terminal prompts disabled/i.test(output)) return "material";
  if (/Authentication failed|HTTP Basic: Access denied|invalid (?:username|password|credentials?)/i.test(output)) return "rejected";
  return undefined;
}

function sameServer(task: OpsTask, step: PlanStep) {
  try { return JSON.parse(step.attemptContext ?? "null")?.[0] === (task.executionTargetServerId ?? task.serverId); }
  catch { return false; }
}

/** Receives authoritative history from the caller; never trusts a retry reason. */
export function gitAuthenticationRetryBlocker(task: OpsTask, step: PlanStep, history: PlanStep[], resolvedChannel?: boolean) {
  const candidate = gitAuthenticationOperation(step.command);
  if (!candidate) return undefined;
  const prior = [...history].reverse().find(item => item.id !== step.id && sameServer(task, item)
    && ["failed", "completed"].includes(item.status)
    && item.result?.facts.commandDispatched !== false && item.result?.executionStatus !== "blocked"
    && JSON.stringify(gitAuthenticationOperation(item.command)) === JSON.stringify(candidate));
  if (!prior) return undefined;
  const cause = gitAuthenticationFailure(prior);
  if (!cause) return undefined;
  if (cause === "channel") {
    // A legacy failure may try the genuinely new foreground implementation
    // once. Any failure on that implementation requires a real channel repair,
    // not another credential revision, new wording, or a generic read check.
    if (prior.authenticationAttempt?.channel !== "foreground-pty-v2"
      && resolvedChannel !== false && !/git_terminal_prompt\s*=\s*0/i.test(step.command)) return undefined;
    return "AUTH_CHANNEL_UNAVAILABLE：同一 Git 操作的认证终端不可用；需要修复认证通道后验证，修改提示文案或重复输入凭据不构成新进展。";
  }
  if (cause === "material" && resolvedChannel !== false && !/git_terminal_prompt\s*=\s*0/i.test(step.command)
    && prior.authenticationAttempt?.channel !== "foreground-pty-v2") return undefined;
  if (cause === "rejected") {
    let oldRevision: number | undefined = prior.authenticationAttempt?.credentialRevision;
    try { oldRevision ??= JSON.parse(prior.attemptContext ?? "null")?.[4]; } catch { /* unknown is not proof */ }
    if (oldRevision !== undefined && (task.credentialRevision ?? 0) > oldRevision) return undefined;
  }
  return "AUTH_RETRY_NO_PROGRESS：同一 Git 认证阻断尚未改变；请复用已确认的授权，补齐有效认证通道或处理明确的认证拒绝，不得换文案重复执行。";
}

export function repeatedAuthenticationInputBlocker(task: OpsTask, step: PlanStep, history: PlanStep[]) {
  if (step.action?.type !== "tool" || step.action.toolId !== "user.request_input") return undefined;
  try {
    const form = step.action.arguments;
    if (!Array.isArray(form.fields) || !form.fields.length) return undefined;
    const active = new Map(activeConfirmedInputEntries(task));
    if (form.fields.every((field: { key: string; type: string; options?: { value: string }[] }) => {
      const input = active.get(field.key);
      return field.type === "select" && input?.type === "select"
        && field.options?.some(option => option.value === input.value);
    })) return "USER_DECISION_ALREADY_CONFIRMED：这些选择已在当前目标和服务器下确认，请复用 confirmedUserInputs，不再重复提问。";
    const context = JSON.stringify(form);
    const latest = [...history].reverse().find(item => sameServer(task, item)
      && item.result?.facts.commandDispatched !== false && item.result?.executionStatus !== "blocked"
      && gitAuthenticationOperation(item.command) && ["completed", "failed"].includes(item.status));
    const failed = latest && gitAuthenticationFailure(latest) === "channel" ? latest : undefined;
    const operation = failed && gitAuthenticationOperation(failed.command);
    const boundCredential = failed?.authenticationAttempt?.channel === "foreground-pty-v2"
      || operation && task.authenticationCredentials?.some(credential => credential.kind === "git-https"
        && credential.target === new URL(operation.target).host);
    if (operation && boundCredential && form.fields.some((field: { type?: string }) => field.type === "password")
      && context.toLowerCase().includes(new URL(operation.target).host.toLowerCase())) {
      return "AUTH_CHANNEL_UNAVAILABLE：该目标失败在认证通道，尚无凭据被拒绝的证据；不要再次索取同一份密码或令牌。";
    }
  } catch { /* malformed forms are handled by protocol validation */ }
  return undefined;
}
