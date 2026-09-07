import type { OpsTask } from "@/types";
import type { KnowledgeRecord } from "./types";

export function redactKnowledgeText(text: string, secrets: string[] = []) {
  let value = text;
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

export function buildKnowledgeRecord(task: OpsTask, knowledgeBaseId: string, revision: number, secrets: string[], includeCommands = false): KnowledgeRecord {
  const clean = (value: string, limit: number) => Array.from(redactKnowledgeText(value, secrets)).slice(0, limit).join("");
  // Explicit allowlist: no rawOutput, arbitrary facts, model trace, SSH identity or credentials.
  const steps = task.plan.slice(0, 30).map((step, index): KnowledgeRecord["steps"][number] => {
    const result = step.result;
    const evidence = result ? [{ evidence_id: `result-${index + 1}`, kind: "command_result" as const,
      summary: `执行状态=${result.executionStatus}；观测状态=${result.observationStatus}；退出码=${result.exitCode ?? "未知"}` }] : [];
    return { step_id: `step-${index + 1}`, description: clean(step.title, 2000),
      ...(includeCommands ? { command: clean(step.command, 4000) } : {}),
      execution_status: result?.executionStatus === "success" ? "succeeded" : result?.executionStatus === "failed" ? "failed" : result?.executionStatus === "blocked" ? "blocked" : result ? "unknown" : "not_run",
      validation_status: "unknown", evidence };
  });
  const date = new Date(task.updatedAt);
  return { schema_version: "1.0", source_record_id: task.id.slice(0,128), source_revision: revision,
    knowledge_base_id: knowledgeBaseId, record_type: "task_result", title: clean(task.title,200) || "任务记录",
    occurred_at: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    problem: clean(task.rootGoal || task.title,8000) || "任务记录",
    steps, outcome: {status: steps.some(step=>step.evidence.length) ? "partial" : "unknown",
      summary:`当前计划快照：任务状态=${task.status}；包含 ${steps.length}/${task.plan.length} 步。未包含历史阶段或独立验证输出，不据此认定整体目标成功。`},
    redaction: {client_applied:true,ruleset_version:"core-upload-v1"} };
}

export function serializeRecord(record: KnowledgeRecord) {
  const body = JSON.stringify(record);
  if (new TextEncoder().encode(body).length > 256 * 1024) throw new Error("上传内容超过 256 KiB，请取消命令选项或缩减记录");
  return body;
}
