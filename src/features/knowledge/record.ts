import type { OpsTask, PlanStep, ServerProfile } from "@/types";
import { redactDecisionText } from "@/features/agent/decisionEvidence";
import { redactExecutionOutput } from "@/features/agent/secretTool";
import { sanitizeTerminalOutput } from "@/utils/terminal";
import type { KnowledgeRecord } from "./types";

export interface KnowledgeRedactionContext {
  secretValues: Record<string, string>;
  redactIpAddresses?: boolean;
}

type KnowledgeRedactionInput = KnowledgeRedactionContext | string[];

function normalizeRedactionContext(input: KnowledgeRedactionInput = []) {
  if (!Array.isArray(input)) return input;
  return {
    secretValues: Object.fromEntries(input.map((value, index) => [`LEGACY_${index}`, value])),
    redactIpAddresses: true,
  } satisfies KnowledgeRedactionContext;
}

export function redactKnowledgeText(
  text: string,
  input: KnowledgeRedactionInput = [],
  exactSecretKeys: Iterable<string> = [],
) {
  const context = normalizeRedactionContext(input);
  let value = redactExecutionOutput(redactDecisionText(text), context.secretValues, {
    exactSecretKeys,
    marker: "[已脱敏]",
  });
  value = value
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g, "[私钥已移除]")
    .replace(/\b(?:authorization|cookie)\s*:[^\r\n]*/gi, "[鉴权头已移除]")
    .replace(
      /(\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|secret)\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&]+)/gi,
      (_match, prefix: string) => `${prefix}[已脱敏]`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "[令牌已移除]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|okk_[A-Za-z0-9_-]{16,})/g, "[API Key 已移除]")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[鉴权已移除]@");
  return context.redactIpAddresses === false
    ? value
    : value.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP 已移除]");
}

/** Keep evidence, not terminal animation. Redact BEFORE selecting any excerpt. */
export function knowledgeExcerpt(
  text: string,
  input: KnowledgeRedactionInput,
  limit = 2000,
  exactSecretKeys: Iterable<string> = [],
) {
  const lines = redactKnowledgeText(sanitizeTerminalOutput(text), input, exactSecretKeys)
    .split(/\r\n|\r|\n/)
    .filter(line => !/^\s*(?:接收对象中|处理 delta 中|Receiving objects|Resolving deltas):\s*\d+%(?!.*(?:完成|done))/i.test(line));
  const compact = lines.filter((line, i) => line.trim() && line !== lines[i - 1]).join("\n");
  const chars = Array.from(compact);
  if (chars.length <= limit) return compact;
  const marker = "\n…[输出节选，中间内容已省略]…\n";
  const budget = limit - Array.from(marker).length;
  return chars.slice(0, Math.floor(budget / 2)).join("") + marker + chars.slice(-Math.ceil(budget / 2)).join("");
}

const DATABASE_SECURITY_METADATA_REQUEST = /(?:show\s+grants?|current_user|\buser\s*\(\s*\)|\bgrants?\b|权限|授权|身份审计)/iu;

/** Deterministic opaque identity, independent of list offsets and source revisions. */
function stableKnowledgeId(kind: string, ...parts: unknown[]) {
  let hash = 0xcbf29ce484222325n;
  for (const character of JSON.stringify(parts)) {
    hash ^= BigInt(character.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${kind}-${hash.toString(16).padStart(16, "0")}`;
}

function knowledgeRuntimeContext(steps: PlanStep[], server: ServerProfile | undefined, input: KnowledgeRedactionInput): KnowledgeRecord["context"] {
  const scopes = steps.flatMap(step => (step.evidence ?? [])
    .filter(item => step.result?.evidenceIds?.includes(item.id) && item.scope)
    .map(item => item.scope!));
  const targetIds = [...new Set(scopes.map(scope => scope.targetId))];
  const runtime: NonNullable<KnowledgeRecord["context"]>["runtime"] = {};
  const bounded = (value: string) => Array.from(redactKnowledgeText(value, input)).slice(0, 200).join("");
  const shells = [...new Set(scopes.map(scope => scope.shell).filter((shell): shell is string => Boolean(shell)))];
  if (shells.length === 1 && scopes.every(scope => scope.shell === shells[0])) runtime.shell = bounded(shells[0]);
  const scopeNames = [...new Set(scopes.map(scope => scope.scope))];
  if (scopeNames.length) runtime.scope = bounded(scopeNames.join(", "));
  const doesNotProve = [...new Set(scopes.flatMap(scope => scope.doesNotProve ?? []))];
  if (doesNotProve.length) runtime.visibility = bounded(doesNotProve.join("；"));
  // A profile belongs to this export only when actual evidence identifies that target.
  const matchingServer = server && targetIds.length === 1 && targetIds[0] === server.id ? server : undefined;
  if (matchingServer?.info.os && !/^(?:unknown|未知|未采集|待连接|[-—]+)$/i.test(matchingServer.info.os.trim())) {
    runtime.os = bounded(matchingServer.info.os);
  }
  const software = (matchingServer?.environment ?? []).flatMap(value => {
    const match = /^([A-Za-z0-9][A-Za-z0-9_.+-]{0,39})\s+v?(\d[\w.+-]{0,99})$/.exec(value.trim());
    return match ? [{ name: redactKnowledgeText(match[1], input), version: redactKnowledgeText(match[2], input) }] : [];
  }).filter(item => item.name && Array.from(item.name).length <= 40 && Array.from(item.version).length <= 100).slice(0, 20);
  return Object.keys(runtime).length || software.length ? {
    ...(targetIds.length === 1 ? { server_ref: stableKnowledgeId("server", targetIds[0]) } : {}),
    ...(Object.keys(runtime).length ? { runtime } : {}),
    ...(software.length ? { software } : {}),
  } : undefined;
}

/** Do not publish unrelated database identities or grants from an over-broad prior query. */
function omitUnrequestedDatabaseSecurityMetadata(text: string, requirement: string) {
  if (DATABASE_SECURITY_METADATA_REQUEST.test(requirement)) return text;
  const lines = text.split(/\r\n|\r|\n/);
  const kept: string[] = [];
  let omitNextIdentityRow = false;
  let marked = false;
  const mark = () => {
    if (marked) return;
    kept.push("[数据库身份与授权明细已省略：原需求未要求权限审计]");
    marked = true;
  };
  for (const line of lines) {
    if (/^\s*CURRENT_USER\(\)\s+USER\(\)\s*$/iu.test(line)) {
      mark();
      omitNextIdentityRow = true;
      continue;
    }
    if (omitNextIdentityRow) {
      omitNextIdentityRow = false;
      continue;
    }
    if (/^\s*(?:Grants for\b|GRANT\b)/iu.test(line)) {
      mark();
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

export function buildKnowledgeRecord(
  task: OpsTask,
  knowledgeBaseId: string,
  revision: number,
  input: KnowledgeRedactionInput,
  includeCommands = false,
  server?: ServerProfile,
): KnowledgeRecord {
  const truncate = (value: string, limit: number) => Array.from(value).slice(0, limit).join("");
  const clean = (value: string, limit: number) =>
    truncate(redactKnowledgeText(value, input), limit);

  // A display-only side question has no plan. Export the most recent archived
  // execution round instead of producing an empty 0/0 knowledge record.
  const phases = (task.phaseHistory ?? [])
    .filter(phase => !!task.currentRoundId && phase.roundId === task.currentRoundId);
  const currentSteps = [...phases.flatMap(phase => phase.plan), ...task.plan];
  const archivedRound = currentSteps.length ? undefined : [...(task.planHistory ?? [])]
    .reverse()
    .find(round => round.plan.length > 0);
  const allSteps = archivedRound?.plan ?? currentSteps;
  const scopeStatus = archivedRound?.status ?? task.status;
  const scopeSummary = archivedRound?.summary ?? task.summary;
  const scopeRequirement = archivedRound?.requirement ?? task.rootGoal ?? task.title;
  const scopeTimestamp = archivedRound?.completedAt ?? task.updatedAt;
  const selected = allSteps.slice(-30);
  const identityCounts = new Map<string, number>();
  const identities = allSteps.map(step => {
    const identity = stableKnowledgeId("attempt", task.id, step.id ?? "legacy", step.startedAt ?? "", [...(step.result?.evidenceIds ?? [])].sort());
    const occurrence = identityCounts.get(identity) ?? 0;
    identityCounts.set(identity, occurrence + 1);
    return stableKnowledgeId("step", identity, occurrence);
  }).slice(-30);
  const evidenceText = (value: string) =>
    omitUnrequestedDatabaseSecurityMetadata(value, scopeRequirement);
  const steps = selected.map((step, index): KnowledgeRecord["steps"][number] => {
    const result = step.result;
    const stepId = identities[index];
    const linked = (step.evidence ?? []).filter(item => result?.evidenceIds?.includes(item.id));
    const main = [...linked].reverse().find(item => item.source === "main");
    const validation = [...linked].reverse().find(item => item.source === "validation");
    const command = redactKnowledgeText(step.command || "", input);
    const commandOmitted = includeCommands && Array.from(command).length > 4000;
    const validationCommand = redactKnowledgeText(step.validation || "", input);
    const evidence: KnowledgeRecord["steps"][number]["evidence"] = result ? [{
      evidence_id: stableKnowledgeId("result", stepId, main?.id),
      kind: "command_result",
      // These values come from typed execution state, not remote/user text.
      summary: truncate(
        `执行状态=${result.executionStatus}；观测状态=${result.observationStatus}；退出码=${result.exitCode ?? "未知"}${main?.archive?.capturedPartial ? "；输出采集不完整" : ""}${main?.scope ? `；采集范围=${main.scope.scope}${main.scope.shell ? `；Shell=${clean(main.scope.shell, 100)}` : ""}` : ""}`,
        1000,
      ),
      excerpt: knowledgeExcerpt(
        evidenceText(main?.rawOutput || step.output || ""),
        input,
        2000,
      ),
    }] : [];

    let validationStatus: KnowledgeRecord["steps"][number]["validation_status"] = "unknown";
    if (validation) {
      validationStatus = validation.archive?.capturedPartial || result?.facts?.validationProtocolIncomplete
        ? "unknown"
        : validation.facts.passed === true
          ? "passed"
          : validation.facts.passed === false ? "failed" : "unknown";
      const validationCommandSummary = includeCommands && validationCommand
        ? Array.from(validationCommand).length <= 750
          ? `；校验命令：${validationCommand}`
          : "；校验命令过长，未附带命令"
        : "";
      evidence.push({
        evidence_id: stableKnowledgeId("validation", stepId, validation.id),
        kind: "validation",
        summary: truncate(
          `独立校验：${validationStatus}；退出码=${validation.facts.exitCode ?? "未知"}${validationCommandSummary}`,
          1000,
        ),
        excerpt: knowledgeExcerpt(evidenceText(validation.rawOutput), input),
      });
    } else if (step.kind === "observe" && main && result?.executionStatus === "success") {
      // An observation is not an independently executed postcondition check.
      validationStatus = "not_run";
    }
    if (step.expected) {
      evidence.push({
        evidence_id: stableKnowledgeId("expected", stepId),
        kind: "expectation",
        summary: truncate(
          `预期验收标准（不是已验证事实）：${clean(step.expected, 900)}`,
          1000,
        ),
      });
    }
    if (result?.failureReason || result?.warnings?.length) {
      const warning = [result.failureReason, ...(result.warnings ?? [])].filter(Boolean).join("；");
      evidence.push({
        evidence_id: stableKnowledgeId("warning", stepId),
        kind: "observation",
        summary: truncate(`风险与异常：${clean(warning, 900)}`, 1000),
      });
    }
    if (commandOmitted) {
      evidence.push({
        evidence_id: stableKnowledgeId("omitted", stepId),
        kind: "observation",
        summary: "执行命令超过 4000 字符，已省略整条命令，避免上传不可安全复用的截断命令。",
      });
    }
    return {
      step_id: stepId,
      description: clean(
        [step.title, step.description].filter(Boolean).join("\n"),
        2000,
      ),
      ...(includeCommands && !commandOmitted ? { command } : {}),
      execution_status: result?.executionStatus === "success"
        ? "succeeded"
        : result?.executionStatus === "failed"
          ? "failed"
          : result?.executionStatus === "blocked" ? "blocked" : result ? "unknown" : "not_run",
      validation_status: validationStatus,
      evidence,
    };
  });

  const omitted = allSteps.length > 30 || (!archivedRound && (
    !!task.planHistory?.length
    || (task.phaseHistory?.length ?? 0) > phases.length
    || !!task.historyCheckpoint
  ));
  const success = !omitted && steps.length > 0 && scopeStatus === "completed" && selected.every((step, i) =>
    step.status === "completed" && step.result?.executionStatus === "success"
    && !step.evidence?.some(e => e.archive?.capturedPartial)
    && !step.result.facts?.evidenceConflict && !step.result.facts?.blockingSignal
    && (steps[i].validation_status === "passed" || (step.kind === "observe"
      && steps[i].validation_status === "not_run"
      && !step.evidence?.some(e => e.archive?.capturedPartial)
      && ["matched", "healthy"].includes(step.result.observationStatus))));
  const date = new Date(scopeTimestamp);
  const scopeLabel = archivedRound
    ? "最近一次有执行步骤的已归档轮次"
    : "当前轮次及其阶段尝试";
  const safeCoreSummary = clean(scopeSummary || "未提供", 3000);
  const scopeStatement = `记录范围：${scopeLabel}，共 ${steps.length}/${allSteps.length} 步。${omitted ? "存在未导出的历史或超限步骤，不认定整体目标成功。" : ""}`;
  const evidenceStatement = `证据判定：${success ? "任务完成且所收集步骤满足校验条件" : "未满足完整成功判定，需结合证据审核"}。`;
  return {
    schema_version: "1.0",
    source_record_id: task.id.slice(0, 128),
    source_revision: revision,
    knowledge_base_id: knowledgeBaseId,
    record_type: "task_result",
    title: clean(task.title, 200) || "任务记录",
    occurred_at: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    context: knowledgeRuntimeContext(selected, server, input),
    problem: clean(scopeRequirement, 8000) || "任务记录",
    steps,
    outcome: {
      status: success
        ? "succeeded"
        : scopeStatus === "failed"
          ? "failed"
          : steps.some(step => step.evidence.length) ? "partial" : "unknown",
      summary: truncate(
        `${scopeStatement}\n${evidenceStatement}\nCore 总结（客户端陈述，需与证据核对）：\n${safeCoreSummary}`,
        4000,
      ),
    },
    redaction: { client_applied: true, ruleset_version: "core-upload-v3" },
  };
}

export function serializeRecord(record: KnowledgeRecord) {
  const body = JSON.stringify(record);
  if (new TextEncoder().encode(body).length > 256 * 1024) throw new Error("上传内容超过 256 KiB，请取消命令选项或缩减记录");
  return body;
}
