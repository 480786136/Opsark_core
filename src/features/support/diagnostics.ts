import { redactExecutionOutput } from "@/features/agent/secretTool";
import { invoke } from "@tauri-apps/api/core";
import type { AuditEvent, DeveloperLogEntry, OpsTask } from "@/types";
export function redactSupportText(text: string, secrets: Record<string, string>) {
  return redactExecutionOutput(text, secrets, { exactSecretKeys: Object.keys(secrets), marker: "[REDACTED]" })
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\b(?:ouc_|our_|gh[pousr]_)[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{16,}/gi, "[REDACTED]")
    .replace(/\b(password|passwd|api[_-]?key|token)\s*[=:]\s*["']?(?!\$\{)[^\s"',;]+/gi, "$1=[REDACTED]");
}
export function taskDiagnostic(task: OpsTask) {
  return { taskId: task.id, status: task.status, stepCount: task.plan.length,
    completedSteps: task.plan.filter(s => s.status === "completed").length,
    failedSteps: task.plan.filter(s => s.status === "failed").length };
}
function redactValue(value: unknown, secrets: Record<string, string>): unknown {
  if (typeof value === "string") return redactSupportText(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(password|passwd|api[_-]?key|(?:access[_-]?|refresh[_-]?)token|authorization|private[_-]?key)$/i.test(key)
      ? "[REDACTED]" : redactValue(item, secrets)]));
  return value;
}
export async function collectTaskLogs(task: OpsTask, logs: AuditEvent[], developerLogs: DeveloperLogEntry[], secrets: Record<string, string>) {
  if (!("__TAURI_INTERNALS__" in window)) throw new Error("完整任务日志需要在 OpsArk 桌面端读取");
  const disk = await invoke<{ taskId: string; files: { name: string; content: string }[] }>("collect_support_task_logs", { taskId: task.id });
  if (disk.taskId !== task.id) throw new Error("任务日志不匹配，请重新选择任务");
  // Include live entries too: persistence is asynchronous, and older tasks may predate disk logging.
  const result = JSON.stringify(redactValue({ ...disk, live: {
    events: logs.filter(log => log.taskId === task.id),
    developerEvents: developerLogs.filter(log => log.taskId === task.id),
  } }, secrets));
  if (new TextEncoder().encode(result).byteLength > 64 * 1024 * 1024) {
    throw new Error("该任务的完整日志超过 64 MB，请通过联系我们提交；日志不会被截断");
  }
  return result;
}
