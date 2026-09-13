import type { OpsTask } from "@/types";
import { redactDecisionText } from "@/features/agent/decisionEvidence";
import { sanitizeTerminalOutput } from "@/utils/terminal";
import type { KnowledgeRecord } from "./types";

export function redactKnowledgeText(text: string, secrets: string[] = []) {
  let value = redactDecisionText(text);
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a,b)=>b.length-a.length)) {
    value = value.split(secret).join("[已脱敏]");
  }
  return value
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g, "[私钥已移除]")
    .replace(/\b(?:authorization|cookie)\s*:[^\r\n]*/gi, "[鉴权头已移除]")
    .replace(/\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&]+)/gi, "[凭据已移除]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "[令牌已移除]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|okk_[A-Za-z0-9_-]{16,})/g, "[API Key 已移除]")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[鉴权已移除]@")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP 已移除]");
}

/** Keep evidence, not terminal animation. Redact BEFORE selecting any excerpt. */
export function knowledgeExcerpt(text: string, secrets: string[], limit = 2000) {
  const lines = redactKnowledgeText(sanitizeTerminalOutput(text), secrets)
    .split(/\r\n|\r|\n/)
    .filter(line => !/^\s*(?:接收对象中|处理 delta 中|Receiving objects|Resolving deltas):\s*\d+%(?!.*(?:完成|done))/i.test(line));
  const compact = lines.filter((line, i) => line.trim() && line !== lines[i - 1]).join("\n");
  const chars = Array.from(compact);
  if (chars.length <= limit) return compact;
  const marker = "\n…[输出节选，中间内容已省略]…\n";
  const budget = limit - Array.from(marker).length;
  return chars.slice(0, Math.floor(budget / 2)).join("") + marker + chars.slice(-Math.ceil(budget / 2)).join("");
}

export function buildKnowledgeRecord(task: OpsTask, knowledgeBaseId: string, revision: number, secrets: string[], includeCommands = false): KnowledgeRecord {
  const clean = (value: string, limit: number) => Array.from(redactKnowledgeText(value, secrets)).slice(0, limit).join("");
  // A display-only side question has no plan. Export the most recent archived
  // execution round instead of producing an empty 0/0 knowledge record.
  const phases = (task.phaseHistory ?? []).filter(phase => !!task.currentRoundId && phase.roundId === task.currentRoundId);
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
  const steps = selected.map((step, index): KnowledgeRecord["steps"][number] => {
    const result = step.result;
    const linked = (step.evidence ?? []).filter(item => result?.evidenceIds?.includes(item.id));
    const main = [...linked].reverse().find(item => item.source === "main");
    const validation = [...linked].reverse().find(item => item.source === "validation");
    const command = redactKnowledgeText(step.command || "", secrets);
    const commandOmitted = includeCommands && Array.from(command).length > 4000;
    const validationCommand = redactKnowledgeText(step.validation || "", secrets);
    const evidence: KnowledgeRecord["steps"][number]["evidence"] = result ? [{
      evidence_id: `result-${index + 1}`, kind: "command_result",
      summary: clean(`执行状态=${result.executionStatus}；观测状态=${result.observationStatus}；退出码=${result.exitCode ?? "未知"}${main?.archive?.capturedPartial ? "；输出采集不完整" : ""}`, 1000),
      excerpt: knowledgeExcerpt(main?.rawOutput || step.output || "", secrets),
    }] : [];
    let validationStatus: KnowledgeRecord["steps"][number]["validation_status"] = "unknown";
    if (validation) {
      validationStatus = validation.archive?.capturedPartial || result?.facts?.validationProtocolIncomplete ? "unknown"
        : validation.facts.passed === true ? "passed" : validation.facts.passed === false ? "failed" : "unknown";
      evidence.push({ evidence_id: `validation-${index + 1}`, kind: "validation",
        summary: clean(`独立校验：${validationStatus}；退出码=${validation.facts.exitCode ?? "未知"}${includeCommands && validationCommand ? Array.from(validationCommand).length <= 750 ? `；校验命令：${validationCommand}` : "；校验命令过长，未附带命令" : ""}`, 1000),
        excerpt: knowledgeExcerpt(validation.rawOutput, secrets) });
    } else if (step.kind === "observe" && main && result?.executionStatus === "success") {
      // An observation is not an independently executed postcondition check.
      validationStatus = "not_run";
    }
    if (step.expected) evidence.push({ evidence_id: `expected-${index + 1}`, kind: "observation",
      summary: clean(`预期验收标准（不是已验证事实）：${step.expected}`, 1000) });
    if (result?.failureReason || result?.warnings?.length) evidence.push({ evidence_id: `warning-${index + 1}`, kind: "observation",
      summary: clean(`风险与异常：${[result.failureReason, ...(result.warnings ?? [])].filter(Boolean).join("；")}`, 1000) });
    if (commandOmitted) evidence.push({ evidence_id: `omitted-${index + 1}`, kind: "observation",
      summary: "执行命令超过 4000 字符，已省略整条命令，避免上传不可安全复用的截断命令。" });
    return { step_id: `step-${index + 1}`, description: clean([step.title, step.description].filter(Boolean).join("\n"), 2000),
      ...(includeCommands && !commandOmitted ? { command } : {}),
      execution_status: result?.executionStatus === "success" ? "succeeded" : result?.executionStatus === "failed" ? "failed" : result?.executionStatus === "blocked" ? "blocked" : result ? "unknown" : "not_run",
      validation_status: validationStatus, evidence };
  });
  const omitted = allSteps.length > 30 || (!archivedRound && (!!task.planHistory?.length || (task.phaseHistory?.length ?? 0) > phases.length || !!task.historyCheckpoint));
  const success = !omitted && steps.length > 0 && scopeStatus === "completed" && selected.every((step, i) =>
    step.status === "completed" && step.result?.executionStatus === "success" &&
    !step.evidence?.some(e => e.archive?.capturedPartial) &&
    !step.result.facts?.evidenceConflict && !step.result.facts?.blockingSignal &&
    (steps[i].validation_status === "passed" || (step.kind === "observe" &&
      steps[i].validation_status === "not_run" && !step.evidence?.some(e => e.archive?.capturedPartial) &&
      ["matched", "healthy"].includes(step.result.observationStatus))));
  const date = new Date(scopeTimestamp);
  return { schema_version: "1.0", source_record_id: task.id.slice(0,128), source_revision: revision,
    knowledge_base_id: knowledgeBaseId, record_type: "task_result", title: clean(task.title,200) || "任务记录",
    occurred_at: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    problem: clean(scopeRequirement,8000) || "任务记录",
    steps, outcome: {status: success ? "succeeded" : scopeStatus === "failed" ? "failed" : steps.some(step=>step.evidence.length) ? "partial" : "unknown",
      summary: clean(`记录范围：${archivedRound ? "最近一次有执行步骤的已归档轮次" : "当前轮次及其阶段尝试"}，共 ${steps.length}/${allSteps.length} 步。${omitted ? "存在未导出的历史或超限步骤，不认定整体目标成功。" : ""}\n证据判定：${success ? "任务完成且所收集步骤满足校验条件" : "未满足完整成功判定，需结合证据审核"}。\nCore 总结（客户端陈述，需与证据核对）：\n${scopeSummary || "未提供"}`, 4000)},
    redaction: {client_applied:true,ruleset_version:"core-upload-v2"} };
}

export function serializeRecord(record: KnowledgeRecord) {
  const body = JSON.stringify(record);
  if (new TextEncoder().encode(body).length > 256 * 1024) throw new Error("上传内容超过 256 KiB，请取消命令选项或缩减记录");
  return body;
}
