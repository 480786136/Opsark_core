import type { OpsTask, ServerProfile } from "@/types";
import type { ExecutionOperationRecord } from "@/services/executionLedger";
import { restoreArchivedExecutionResult, type ExecutionReceiptReader } from "@/services/executionReceiptArchive";
import { enforceToolResult } from "../tools/toolResultContract";
import { canonicalExecutionJson, executionIntentMatches } from "./planPreparation";

export interface BusinessReceipt<T> { operation: ExecutionOperationRecord; started: number; ended: number; refs: string[]; data: T }
const last = <T>(a: T[]) => a[a.length - 1];
export function businessReceipt<T>(o: ExecutionOperationRecord, task: OpsTask, server: ServerProfile, generation: number,
  tool: string, historical = false): BusinessReceipt<T> | undefined {
  const a = last(o.attempts), s = o.intent.semantic;
  if (o.taskId !== task.id || s.taskId !== task.id || !historical && (o.roundId !== task.currentRoundId || o.workflowEpoch !== (task.workflowEpoch ?? 0))
    || o.phase !== "tool" || o.state !== "succeeded" || o.effect !== "read" || s.effect !== "read" || o.cancelRequested
    || !executionIntentMatches(o.intent, o.intent) || o.intentDigest !== o.intent.digest
    || s.action.type !== "tool" || s.action.toolId !== tool || !s.targets.length
    || !s.targets.every(t => t.serverId === server.id && t.host.toLowerCase() === server.host.toLowerCase() && t.port === server.port
      && t.username === server.username && (historical ? Number.isSafeInteger(t.connectionGeneration) : t.connectionGeneration === generation))
    || !a || a.status !== "succeeded" || a.outcome?.status !== "succeeded" || a.late || a.cancelRequested
    || a.operationId !== o.operationId || !Number.isFinite(a.startedAt) || !Number.isFinite(a.completedAt) || a.completedAt! < a.startedAt
    || !a.outcome.evidenceRefs.length || new Set(a.outcome.evidenceRefs).size !== a.outcome.evidenceRefs.length) return;
  const r = enforceToolResult({ id: a.executionId, toolId: tool, arguments: s.action.arguments }, a.outcome.result);
  if (!r.success || !r.data || (r.data as { observationsRedacted?: boolean }).observationsRedacted) return;
  return { operation: o, started: a.startedAt, ended: a.completedAt!, refs: a.outcome.evidenceRefs, data: r.data as T };
}
export function businessResourceKey(o: ExecutionOperationRecord): string | undefined {
  const a = o.intent.semantic.action; if (a.type !== "tool") return;
  if (["files.inspect_manifest", "files.read_content", "files.inspect"].includes(a.toolId)) return `${a.toolId}:${String(a.arguments.path)}`;
  if (a.toolId === "http.inspect_delivery") { try { return `${a.toolId}:${new URL(String(a.arguments.url)).href}`; } catch { return; } }
  if (a.toolId === "applications.inspect_runtime") return `${a.toolId}:${String(a.arguments.unit)}:${String(a.arguments.listenAddress)}:${String(a.arguments.listenPort)}`;
  if (a.toolId === "applications.prepare_release") return `${a.toolId}:${String(a.arguments.requirementId)}`;
}
export function isLatestBusinessReceipt(r: BusinessReceipt<unknown>, task: OpsTask, server: ServerProfile, generation: number, records: ExecutionOperationRecord[]): boolean {
  const key = businessResourceKey(r.operation); if (!key) return false;
  return !records.some(o => o.operationId !== r.operation.operationId && o.taskId === task.id && o.roundId === task.currentRoundId
    && o.workflowEpoch === (task.workflowEpoch ?? 0) && businessResourceKey(o) === key
    && o.intent.semantic.targets.some(t => t.serverId === server.id && t.host.toLowerCase() === server.host.toLowerCase()
      && t.port === server.port && t.username === server.username && t.connectionGeneration === generation)
    && o.attempts.some(a => a.status !== "not_dispatched" && (!Number.isFinite(a.startedAt) || a.startedAt >= r.started)));
}
export interface BusinessLedgerReader { list: () => Promise<ExecutionOperationRecord[]>; read: ExecutionReceiptReader; assertCurrent: () => void }
export async function readBusinessAcceptanceLedger(task: OpsTask, tools: string[], deps: BusinessLedgerReader): Promise<ExecutionOperationRecord[]> {
  deps.assertCurrent(); const initial = await deps.list(); deps.assertCurrent();
  const restored = new Map<string, ExecutionOperationRecord>(); let bytes = 0;
  for (const operation of initial) {
    const action = operation.intent.semantic.action, attempt = last(operation.attempts);
    if (operation.taskId !== task.id || action.type !== "tool" || !tools.includes(action.toolId) || attempt?.status !== "succeeded" || !attempt.outcome) continue;
    const record = await restoreArchivedExecutionResult(operation, attempt.id, deps.read, deps.assertCurrent);
    bytes += new TextEncoder().encode(JSON.stringify(last(record.attempts)!.outcome!.result)).length;
    if (bytes > 16 * 1024 * 1024) throw new Error("业务验收归档超过16MiB，不能以截断证据完成");
    restored.set(operation.operationId, record);
  }
  const current = await deps.list(); deps.assertCurrent();
  for (const id of restored.keys()) {
    const found = current.filter(o => o.operationId === id);
    if (found.length !== 1 || canonicalExecutionJson(found[0]) !== canonicalExecutionJson(initial.find(o => o.operationId === id))) throw new Error("业务来源在读取期间变化");
  }
  return current.map(o => restored.get(o.operationId) ?? o);
}
