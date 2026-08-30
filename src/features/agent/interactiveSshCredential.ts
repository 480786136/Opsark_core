import { findSecretKeys } from "@/features/agent/secretTool";
import { analyzeCredentialTransport } from "@/features/agent/planSafety";
import { collectServerCredentialGroups } from "@/features/agent/serverCredentialGroup";
import type {
  PlanStep,
  SecretMetadata,
  SubmittedSecretBinding,
  SubmittedTaskInput,
} from "@/types";

// Plans are normally rendered as multi-line shell scripts. Treat a newline as
// a command boundary as well as `;`, `&&` and `||`, otherwise credentials can
// be collected successfully but never attached to a later `git clone` line.
const INTERACTIVE_SSH_COMMAND = /(?:^|[\n;&|]\s*)(?:timeout\s+\S+\s+)?(?:command\s+)?(?:scp|sftp|ssh|rsync)\b/i;
const INTERACTIVE_GIT_COMMAND = /(?:^|[\n;&|]\s*)(?:timeout\s+\S+\s+)?(?:env(?:\s+-\S+)*\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*(?:command\s+)?git\s+(?:(?:-c|-C)\s+(?:'[^']*'|"[^"]*"|\S+)\s+)*(?:clone|fetch|pull|ls-remote|submodule)\b/i;
const HTTPS_URL = /https?:\/\/[^\s'"`<>]+/i;

export interface InteractivePtyCredential {
  kind: "password" | "git-https";
  secret: string;
  username?: string;
  target?: string;
}

export type InteractivePtyCredentialResolution =
  | {
      status: "not-required";
      reason: "not-interactive" | "noninteractive-probe" | "anonymous-git" | "external-auth";
    }
  | {
      status: "resolved";
      credential: InteractivePtyCredential;
    }
  | {
      status: "blocked";
      code:
        | "unsafe-credential-transport"
        | "interactive-prompt-disabled"
        | "credential-group-unresolved"
        | "credential-group-ambiguous"
        | "credential-reference-unresolved"
        | "credential-target-mismatch"
        | "credential-username-missing"
        | "credential-account-mismatch";
      error: string;
    };

export class InteractivePtyCredentialResolutionError extends Error {
  constructor(
    message: string,
    readonly code: Extract<InteractivePtyCredentialResolution, { status: "blocked" }>["code"],
  ) {
    super(message);
    this.name = "InteractivePtyCredentialResolutionError";
  }
}

function notRequired(
  reason: Extract<InteractivePtyCredentialResolution, { status: "not-required" }>["reason"],
): InteractivePtyCredentialResolution {
  return { status: "not-required", reason };
}

function resolved(credential: InteractivePtyCredential): InteractivePtyCredentialResolution {
  return { status: "resolved", credential };
}

function blocked(
  code: Extract<InteractivePtyCredentialResolution, { status: "blocked" }>["code"],
  detail: string,
): InteractivePtyCredentialResolution {
  return {
    status: "blocked",
    code,
    error: `交互认证凭据无法安全绑定：${detail}。命令尚未发送到 PTY`,
  };
}

function httpsAuthority(command: string) {
  const url = command.match(HTTPS_URL)?.[0];
  if (!url) return undefined;
  const authority = url.slice(url.indexOf("://") + 3).split(/[/?#]/, 1)[0] ?? "";
  const separator = authority.lastIndexOf("@");
  const userInfo = separator >= 0 ? authority.slice(0, separator) : "";
  const hostPort = separator >= 0 ? authority.slice(separator + 1) : authority;
  const target = hostPort.replace(/:\d+$/, "").toLocaleLowerCase();
  if (!target) return undefined;
  let username: string | undefined;
  if (userInfo && !userInfo.includes(":")) {
    try {
      username = decodeURIComponent(userInfo);
    } catch {
      username = userInfo;
    }
  }
  return { target, username };
}

function commandTarget(command: string) {
  return httpsAuthority(command)?.target
    ?? command.match(/@([A-Za-z0-9_.:-]+)/)?.[1]?.replace(/:$/, "").toLocaleLowerCase();
}

function sshCommandUsername(command: string, target: string | undefined) {
  if (!target) return undefined;
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return command.match(new RegExp(`(?:^|[\\s'\"])([A-Za-z0-9._-]+)@${escapedTarget}(?=[:\\s'\"]|$)`, "i"))?.[1];
}

function contextTargets(value: string) {
  return (value.toLocaleLowerCase().match(/(?:[a-z0-9-]+\.)+[a-z0-9-]+/g) ?? [])
    .map((item) => item.replace(/\.$/, ""));
}

function contextMatchesTarget(value: string, target: string) {
  return contextTargets(value).includes(target.toLocaleLowerCase());
}

function gitUsernameKeyRank(key: string) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLocaleLowerCase();
  if (/^(?:(?:git|gitee|github|gitlab|repo|repository)(?:user|username|account)|(?:user|username|account)(?:git|gitee|github|gitlab|repo|repository))$/.test(normalized)) return 2;
  if (/^(?:user|username|account|loginuser|loginname)$/.test(normalized)) return 1;
  return 0;
}

function isSafePtyCredentialValue(value: string) {
  return Boolean(value) && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function referencedCredentialGroupIds(value: string) {
  return [...value.matchAll(/server-credential:([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
}

function describesAuthentication(value: string) {
  return /(?:认证|鉴权|登录|凭据|用户名|密码|口令|令牌|私有仓库|auth(?:entication|orization)?|credential|password|passwd|token|log[ -]?in|private\s+(?:git|repo|repository))/i
    .test(value);
}

function submittedGitUsername(
  submittedInputs: Record<string, SubmittedTaskInput> | undefined,
  secretBinding: SubmittedSecretBinding | undefined,
  target: string | undefined,
) {
  // A credential pair must originate from the same request_input form. This
  // prevents a newly entered token from being combined with a stale username.
  if (!submittedInputs || !secretBinding) return undefined;
  const candidates = Object.entries(submittedInputs)
    .filter(([, input]) => typeof input.value === "string" && input.value.trim())
    .filter(([, input]) => input.groupId === secretBinding.groupId)
    .map(([key, input]) => {
      const context = `${key} ${input.label ?? ""} ${input.description ?? ""} ${input.groupTitle ?? ""}`;
      const keyRank = gitUsernameKeyRank(key);
      const repositoryContext = /git|gitee|github|gitlab|仓库|源码/i.test(context);
      const usernameContext = /用户名|登录名|账号|user\s*name|login\s*(?:name|user)|account/i.test(context);
      const mentionedTargets = contextTargets(context);
      if ((!keyRank && !(repositoryContext && usernameContext))
        || (target && mentionedTargets.length > 0 && !mentionedTargets.includes(target))) return undefined;
      return { key, input, rank: keyRank };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
  if (!candidates.length) return undefined;
  const highestRank = Math.max(...candidates.map(({ rank }) => rank));
  const preferred = candidates.filter(({ rank }) => rank === highestRank);
  // Do not guess between multiple equally plausible fields. A fresh form can
  // explicitly name one `gitUsername` field instead.
  if (preferred.length !== 1) return undefined;
  const username = String(preferred[0].input.value).trim();
  return isSafePtyCredentialValue(username) ? username : undefined;
}

/**
 * Resolves a runtime-only credential for a foreground PTY command. Passwords
 * remain in the keychain-backed secret scope; a Git username may come from the
 * URL or from the latest non-sensitive user input. Neither is added to the
 * command when Git can request it interactively.
 */
export function resolveInteractivePtyCredential(
  step: Pick<PlanStep, "command" | "description" | "expected">,
  confirmedSecretKeys: string[],
  scopedSecrets: Record<string, string>,
  metadata: SecretMetadata[],
  submittedInputs?: Record<string, SubmittedTaskInput>,
  submittedSecretBindings?: Record<string, SubmittedSecretBinding>,
): InteractivePtyCredentialResolution {
  const gitCommand = INTERACTIVE_GIT_COMMAND.test(step.command);
  const sshCommand = INTERACTIVE_SSH_COMMAND.test(step.command);
  if (!gitCommand && !sshCommand) return notRequired("not-interactive");

  const commandSecretKeys = [...new Set(findSecretKeys(step.command))];
  const semanticContext = `${step.description}\n${step.expected}`;
  const referencedSecretKeys = [...new Set(findSecretKeys(semanticContext))];
  const groupRefs = [...new Set(referencedCredentialGroupIds(semanticContext))];
  const hasExplicitCredentialBinding = commandSecretKeys.length > 0
    || referencedSecretKeys.length > 0
    || groupRefs.length > 0;
  const credentialExpected = hasExplicitCredentialBinding || describesAuthentication(semanticContext);
  const commandUsesOnlyGroupedSshUsernames = !gitCommand
    && commandSecretKeys.length > 0
    && commandSecretKeys.every((key) => metadata.some((item) => item.key === key
      && item.credentialKind === "ssh-password"
      && item.credentialRole === "username"));

  if (/batchmode\s*=\s*yes|git_terminal_prompt\s*=\s*0/i.test(step.command)) {
    return hasExplicitCredentialBinding
      ? blocked(
        "interactive-prompt-disabled",
        "步骤引用了凭据，但命令明确禁用了交互认证提示",
      )
      : notRequired("noninteractive-probe");
  }
  if (commandSecretKeys.length > 0 && !commandUsesOnlyGroupedSshUsernames) {
    return blocked(
      "unsafe-credential-transport",
      `命令本文直接引用了敏感变量 ${commandSecretKeys.join("、")}，只允许通过独立 PTY 提示通道传入密码或令牌`,
    );
  }
  const transportIssue = analyzeCredentialTransport(step.command, "command");
  if (transportIssue) {
    return blocked("unsafe-credential-transport", transportIssue.reason);
  }

  const https = gitCommand ? httpsAuthority(step.command) : undefined;
  const confirmed = new Set(confirmedSecretKeys);
  const explicitKeys = referencedSecretKeys
    .filter((key) => confirmed.has(key) && Boolean(scopedSecrets[key]));

  const target = commandTarget(step.command);
  if (https) {
    const reusableGroups = collectServerCredentialGroups(metadata)
      .filter((group) => group.kind === "git-https"
        && group.target === https.target
        && isSafePtyCredentialValue(scopedSecrets[group.username.key] ?? "")
        && isSafePtyCredentialValue(scopedSecrets[group.secret.key] ?? ""));
    const explicitlyReferenced = reusableGroups.filter((group) => groupRefs.includes(group.id)
      || referencedSecretKeys.includes(group.username.key)
      || referencedSecretKeys.includes(group.secret.key));
    const urlAccountMatches = https.username
      ? reusableGroups.filter((group) => scopedSecrets[group.username.key] === https.username)
      : [];
    const referencedGroupedKeys = referencedSecretKeys.filter((key) => metadata.some((item) => (
      item.key === key && Boolean(item.credentialGroupId)
    )));
    const hasExplicitGroupBinding = groupRefs.length > 0 || referencedGroupedKeys.length > 0;
    const selectedGroup = explicitlyReferenced.length === 1
      ? explicitlyReferenced[0]
      : hasExplicitGroupBinding
        ? undefined
        : urlAccountMatches.length === 1
          ? urlAccountMatches[0]
          : reusableGroups.length === 1
            ? reusableGroups[0]
            : undefined;
    if (selectedGroup) {
      return resolved({
        kind: "git-https",
        username: scopedSecrets[selectedGroup.username.key],
        secret: scopedSecrets[selectedGroup.secret.key],
        target: https.target,
      });
    }
    if (hasExplicitGroupBinding) {
      return blocked(
        explicitlyReferenced.length > 1 ? "credential-group-ambiguous" : "credential-group-unresolved",
        explicitlyReferenced.length > 1
          ? `步骤同时匹配到 ${explicitlyReferenced.length} 个 ${https.target} Git HTTPS 凭据组`
          : `引用的服务器凭据组不存在、不完整或不属于 ${https.target}`,
      );
    }
    if (urlAccountMatches.length > 1 || (credentialExpected && reusableGroups.length > 1)) {
      return blocked(
        "credential-group-ambiguous",
        `${https.target} 存在多个可用账号，步骤必须显式引用唯一的 server-credential:<group-id>`,
      );
    }
  }
  const sshAuthenticationCommand = sshCommand || (gitCommand && !https && Boolean(target));
  if (sshAuthenticationCommand && target) {
    const allReferencedKeys = [...new Set([...referencedSecretKeys, ...commandSecretKeys])];
    const reusableGroups = collectServerCredentialGroups(metadata)
      .filter((group) => group.kind === "ssh-password"
        && group.target === target
        && /^[A-Za-z0-9._-]+$/.test(scopedSecrets[group.username.key] ?? "")
        && isSafePtyCredentialValue(scopedSecrets[group.secret.key] ?? ""));
    const explicitlyReferenced = reusableGroups.filter((group) => groupRefs.includes(group.id)
      || allReferencedKeys.includes(group.username.key)
      || allReferencedKeys.includes(group.secret.key));
    const commandAccount = sshCommandUsername(step.command, target);
    const commandAccountMatches = commandAccount
      ? reusableGroups.filter((group) => scopedSecrets[group.username.key] === commandAccount)
      : [];
    const referencedGroupedKeys = allReferencedKeys.filter((key) => metadata.some((item) => (
      item.key === key && Boolean(item.credentialGroupId)
    )));
    const hasExplicitGroupBinding = groupRefs.length > 0 || referencedGroupedKeys.length > 0;
    const selectedGroup = explicitlyReferenced.length === 1
      ? explicitlyReferenced[0]
      : hasExplicitGroupBinding
        ? undefined
        : commandAccountMatches.length === 1
          ? commandAccountMatches[0]
          : reusableGroups.length === 1
            ? reusableGroups[0]
            : undefined;
    if (selectedGroup) {
      const selectedUsername = scopedSecrets[selectedGroup.username.key];
      if (commandAccount && commandAccount !== selectedUsername) {
        return blocked(
          "credential-account-mismatch",
          `命令中的 SSH 用户名 ${commandAccount} 与选定凭据组的用户名不一致`,
        );
      }
      if (commandSecretKeys.length > 0
        && !commandSecretKeys.every((key) => key === selectedGroup.username.key)) {
        return blocked(
          "unsafe-credential-transport",
          "SSH 命令中只允许展开所选凭据组的用户名，密码必须由 PTY 提示通道传入",
        );
      }
      return resolved({
        kind: "password",
        secret: scopedSecrets[selectedGroup.secret.key],
        target,
      });
    }
    if (hasExplicitGroupBinding) {
      return blocked(
        explicitlyReferenced.length > 1 ? "credential-group-ambiguous" : "credential-group-unresolved",
        explicitlyReferenced.length > 1
          ? `步骤同时匹配到 ${explicitlyReferenced.length} 个 ${target} SSH 凭据组`
          : `引用的 SSH 凭据组不存在、不完整或不属于 ${target}`,
      );
    }
    if (commandAccountMatches.length > 1 || (credentialExpected && reusableGroups.length > 1)) {
      return blocked(
        "credential-group-ambiguous",
        `${target} 存在多个可用 SSH 账号，步骤必须显式引用唯一的 server-credential:<group-id>`,
      );
    }
  }
  const candidates = metadata.filter((item) => (
    confirmed.has(item.key)
    && isSafePtyCredentialValue(scopedSecrets[item.key] ?? "")
    && /(?:ssh|git|仓库|登录|认证)/i.test(item.description)
    && /(?:密码|口令|令牌|token|password|passwd|credential)/i.test(item.description)
  ));
  let selected: SecretMetadata | undefined;
  if (referencedSecretKeys.length > 0) {
    if (explicitKeys.length !== 1) {
      return blocked(
        "credential-reference-unresolved",
        explicitKeys.length > 1
          ? `步骤引用了多个无法成组的凭据变量：${explicitKeys.join("、")}`
          : `步骤引用的凭据变量未确认、无值或无法用于当前认证：${referencedSecretKeys.join("、")}`,
      );
    }
    selected = candidates.find((item) => item.key === explicitKeys[0]);
    if (!selected) {
      return blocked(
        "credential-reference-unresolved",
        `敏感变量 ${explicitKeys[0]} 的用途或值不符合交互认证要求`,
      );
    }
    if (gitCommand && !/(?:git|gitee|github|gitlab|仓库|源码)/i.test(selected.description)) {
      return blocked(
        "credential-target-mismatch",
        `敏感变量 ${selected.key} 未标记为 Git 仓库凭据`,
      );
    }
    if (target && contextTargets(selected.description).length > 0
      && !contextMatchesTarget(selected.description, target)) {
      return blocked(
        "credential-target-mismatch",
        `敏感变量 ${selected.key} 的保存用途不属于当前目标 ${target}`,
      );
    }
  } else {
    // Repository credentials require an explicit placeholder in prose. This
    // prevents the only saved token from being silently reused for another host.
    if (gitCommand) {
      return credentialExpected
        ? blocked(
          "credential-reference-unresolved",
          `步骤要求仓库认证，但没有唯一可绑定到 ${target ?? "当前目标"} 的凭据组或敏感变量`,
        )
        : notRequired("anonymous-git");
    }
    const targetMatches = target
      ? candidates.filter((item) => contextMatchesTarget(item.description, target))
      : [];
    selected = target
      ? (targetMatches.length === 1 ? targetMatches[0] : undefined)
      : (candidates.length === 1 ? candidates[0] : undefined);
  }
  if (!selected) {
    return credentialExpected
      ? blocked(
        "credential-reference-unresolved",
        `步骤要求交互认证，但没有唯一可绑定到 ${target ?? "当前目标"} 的凭据`,
      )
      : notRequired("external-auth");
  }

  if (https) {
    const username = https.username ?? submittedGitUsername(
      submittedInputs,
      submittedSecretBindings?.[selected.key],
      https.target,
    );
    if (!username) {
      return blocked(
        "credential-username-missing",
        `已选定 ${selected.key}，但未找到与它同表单提交或同服务器凭据组的 Git HTTPS 用户名`,
      );
    }
    if (!isSafePtyCredentialValue(scopedSecrets[selected.key])) {
      return blocked("credential-reference-unresolved", `敏感变量 ${selected.key} 无值或包含终端控制字符`);
    }
    return resolved({
      kind: "git-https",
      username,
      secret: scopedSecrets[selected.key],
      target: https.target,
    });
  }
  return isSafePtyCredentialValue(scopedSecrets[selected.key])
    ? resolved({ kind: "password", secret: scopedSecrets[selected.key], target })
    : blocked("credential-reference-unresolved", `敏感变量 ${selected.key} 无值或包含终端控制字符`);
}

/** Selects a task-confirmed password for an interactive SSH-family PTY prompt without adding it to the command. */
export function resolveInteractiveSshPromptSecret(
  step: Pick<PlanStep, "command" | "description" | "expected">,
  confirmedSecretKeys: string[],
  scopedSecrets: Record<string, string>,
  metadata: SecretMetadata[],
) {
  const resolution = resolveInteractivePtyCredential(
    step,
    confirmedSecretKeys,
    scopedSecrets,
    metadata,
  );
  if (resolution.status === "blocked") {
    throw new InteractivePtyCredentialResolutionError(resolution.error, resolution.code);
  }
  return resolution.status === "resolved" ? resolution.credential.secret : undefined;
}
