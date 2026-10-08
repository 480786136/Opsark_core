import { invoke } from "@tauri-apps/api/core";
import type { OpsTask } from "@/types";
import { readTaskProjection } from "@/features/agent/executionLedgerRecovery";

export interface TaskArchiveEntry {
  taskId: string; title: string; serverId: string;
  disposition: "active" | "removed" | "legacy_recovery";
  createdAt?: string;
  status?: OpsTask["status"];
  roundCount?: number;
  snapshot?: OpsTask;
}
export function taskListSummary(task: OpsTask): TaskArchiveEntry {
  return { taskId: task.id, title: task.title, serverId: task.serverId, disposition: "active",
    createdAt: task.createdAt, status: task.status,
    roundCount: (task.planHistory?.length ?? 0)
      + (task.messages.some(message => message.role === "user" && message.kind === "message") ? 1 : 0) };
}
const key = "opsark.taskArchive.v1";
const native = () => "__TAURI_INTERNALS__" in window;
function read(): TaskArchiveEntry[] {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (value.version !== 1 || !Array.isArray(value.entries)
    || value.entries.some((row: TaskArchiveEntry) => !row.taskId || !["active", "removed", "legacy_recovery"].includes(row.disposition)
      || !row.snapshot || row.snapshot.id !== row.taskId || !readTaskProjection([row.snapshot]).compatible)) {
    throw new Error("任务归档无法安全读取，原始记录未修改。");
  }
  return value.entries;
}
function write(entries: TaskArchiveEntry[]) { localStorage.setItem(key, JSON.stringify({ version: 1, entries })); }
export function archiveTasks(tasks: OpsTask[]): Promise<void> {
  if (native()) return invoke("save_task_snapshots", { snapshots: tasks });
  const entries = read();
  for (const task of tasks) {
    const index = entries.findIndex(entry => entry.taskId === task.id);
    if (index >= 0 && entries[index].disposition !== "active") continue;
    const entry: TaskArchiveEntry = { taskId: task.id, title: task.title, serverId: task.serverId, disposition: "active", snapshot: task };
    if (index < 0) entries.push(entry); else entries[index] = entry;
  }
  write(entries);
  return Promise.resolve();
}
export async function listTaskArchives(): Promise<TaskArchiveEntry[]> {
  if (native()) return invoke("list_task_archives");
  return read().map(({ snapshot, ...entry }) => ({ ...taskListSummary(snapshot!), ...entry }));
}
export async function readTaskArchive(taskId: string): Promise<TaskArchiveEntry | undefined> {
  if (native()) return (await invoke<TaskArchiveEntry | null>("read_task_archive", { taskId })) ?? undefined;
  return read().find(entry => entry.taskId === taskId);
}
export async function markTaskArchived(task: OpsTask, disposition: "removed" | "legacy_recovery"): Promise<void> {
  if (native()) return invoke("mark_task_archived", { snapshot: task, disposition });
  const entries = read().filter(entry => entry.taskId !== task.id);
  entries.push({ taskId: task.id, title: task.title, serverId: task.serverId, disposition, snapshot: task });
  write(entries);
}
/** A legacy shell with later user work becomes an ordinary archived task; removed tasks stay removed. */
export async function preserveContinuedLegacyTask(snapshot: OpsTask): Promise<void> {
  if (native()) return invoke("preserve_continued_legacy_task", { snapshot });
  const entries = read(), entry = entries.find(row => row.taskId === snapshot.id);
  if (entry?.disposition !== "legacy_recovery") return;
  Object.assign(entry, { disposition: "active", title: snapshot.title, serverId: snapshot.serverId, snapshot });
  write(entries);
}
