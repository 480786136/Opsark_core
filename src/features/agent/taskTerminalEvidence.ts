import type { OpsTask, TaskStatus } from "@/types";
import type { ExecutionOperationRecord } from "@/services/executionLedger";
import type { TaskModelRequest } from "@/services/taskModelRequests";

interface RoundBinding { roundId?: string; workflowEpoch: number }
export interface TaskTerminalEvidence {
  version: 1;
  taskId: string;
  cancellations: Array<RoundBinding & { requestedAt: string; reason: "reject" | "terminate"; executionId?: string }>;
  terminals: Array<RoundBinding & { status: "completed" | "failed" | "cancelled"; transitionedAt: string }>;
  remoteAttempts: Array<RoundBinding & {
    operationId: string; attemptId: string; executionId: string; stepId: string;
    state: "pending" | "exit_recorded" | "not_dispatched";
    status: string; cancelRequested: boolean; late: boolean;
    startedAt: number; resultRecordedAt?: number; exitCode?: number; evidenceRefs: string[];
  }>;
  modelRequests: Array<{
    requestId: string; operationId: string; roundId?: string;
    state: TaskModelRequest["state"]; cancelRequested: boolean; late: boolean;
    createdAtMs: number; updatedAtMs: number;
    usageStatus: "reported" | "missing" | "not_dispatched";
    /** Reported usage is not proof that the separate budget settlement committed. */
    usage?: Record<string, number>;
  }>;
}
const terminal = (status: TaskStatus): status is "completed" | "failed" | "cancelled" => ["completed", "failed", "cancelled"].includes(status);
const timestamp = (value: string) => Number.isFinite(Date.parse(value));
const binding = (task: OpsTask): RoundBinding => ({ roundId: task.currentRoundId, workflowEpoch: task.workflowEpoch ?? 0 });

export function taskTerminalEvidenceValid(value: unknown, taskId: string): value is TaskTerminalEvidence {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const text = (value: unknown) => typeof value === "string" && !!value.trim();
  const time = (value: unknown) => typeof value === "string" && timestamp(value);
  const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  const round = (value: Record<string, unknown>) => (value.roundId === undefined || text(value.roundId)) && count(value.workflowEpoch);
  if (!object(value) || value.version !== 1 || value.taskId !== taskId || !Array.isArray(value.cancellations)
    || !Array.isArray(value.terminals) || !Array.isArray(value.remoteAttempts) || !Array.isArray(value.modelRequests)) return false;
  if (!value.cancellations.every(row => object(row) && round(row) && time(row.requestedAt)
    && ["reject", "terminate"].includes(String(row.reason)) && (row.executionId === undefined || text(row.executionId)))) return false;
  if (!value.terminals.every(row => object(row) && round(row) && time(row.transitionedAt)
    && ["completed", "failed", "cancelled"].includes(String(row.status)))) return false;
  const attempts = new Set<string>();
  for (const row of value.remoteAttempts) {
    if (!object(row) || !round(row) || !text(row.operationId) || !text(row.attemptId) || !text(row.executionId) || !text(row.stepId)
      || !["pending", "exit_recorded", "not_dispatched"].includes(String(row.state))
      || !["dispatching", "succeeded", "failed", "unknown", "not_dispatched"].includes(String(row.status))
      || typeof row.cancelRequested !== "boolean" || typeof row.late !== "boolean" || !count(row.startedAt)
      || row.resultRecordedAt !== undefined && (!count(row.resultRecordedAt) || Number(row.resultRecordedAt) < Number(row.startedAt))
      || !Array.isArray(row.evidenceRefs) || !row.evidenceRefs.every(text)
      || row.exitCode !== undefined && !Number.isInteger(row.exitCode)) return false;
    if (row.state === "exit_recorded" && (!Number.isInteger(row.exitCode) || row.resultRecordedAt === undefined
      || !row.evidenceRefs.length || !["succeeded", "failed"].includes(String(row.status)))) return false;
    if (row.state === "not_dispatched" && (row.status !== "not_dispatched" || row.resultRecordedAt === undefined || !row.evidenceRefs.length)) return false;
    if (row.state === "pending" && row.exitCode !== undefined) return false;
    const key = JSON.stringify([row.operationId, row.attemptId]);
    if (attempts.has(key)) return false;
    attempts.add(key);
  }
  const requests = new Set<string>();
  for (const row of value.modelRequests) {
    if (!object(row) || !text(row.requestId) || !text(row.operationId) || row.roundId !== undefined && !text(row.roundId)
      || !["not_dispatched", "dispatching", "accepted", "unknown", "completed", "cancelled"].includes(String(row.state))
      || typeof row.cancelRequested !== "boolean" || typeof row.late !== "boolean" || !count(row.createdAtMs) || !count(row.updatedAtMs)
      || !["reported", "missing", "not_dispatched"].includes(String(row.usageStatus))) return false;
    if (row.usage !== undefined && (!object(row.usage) || !Object.keys(row.usage).length || !Object.entries(row.usage).every(([key, value]) =>
      ["prompt_tokens", "completion_tokens", "input_tokens", "output_tokens", "total_tokens"].includes(key) && count(value)))) return false;
    if (row.usageStatus === "reported" && row.usage === undefined || row.usageStatus === "missing" && row.usage !== undefined
      || row.usageStatus === "not_dispatched" && row.state !== "not_dispatched") return false;
    if (requests.has(String(row.requestId))) return false;
    requests.add(String(row.requestId));
  }
  return true;
}

function evidence(task: OpsTask): TaskTerminalEvidence {
  if (task.terminalEvidence && !taskTerminalEvidenceValid(task.terminalEvidence, task.id)) {
    throw new Error("任务终态证据版本或归属不兼容，不能覆盖原记录");
  }
  return task.terminalEvidence ??= { version: 1, taskId: task.id, cancellations: [], terminals: [], remoteAttempts: [], modelRequests: [] };
}

/** Call before incrementing workflowEpoch or clearing currentExecutionId. */
export function recordTaskCancellation(task: OpsTask, input: {
  reason: "reject" | "terminate"; requestedAt?: string; executionId?: string;
}): void {
  if (task.status === "cancelled" && !task.currentExecutionId && !input.executionId
    && !task.requirementProcessing && !task.adjustmentInProgress && task.terminalEvidence?.cancellations.length) return;
  const requestedAt = input.requestedAt ?? new Date().toISOString();
  if (!timestamp(requestedAt)) throw new Error("取消请求时间无效");
  const record = evidence(task), current = binding(task);
  const executionId = input.executionId ?? task.currentExecutionId;
  // The same stopped attempt has one earliest cancellation time; repeat UI clicks
  // do not restart its measured cancellation latency.
  if (record.cancellations.some(item => item.roundId === current.roundId && item.workflowEpoch === current.workflowEpoch
    && item.executionId === executionId)) return;
  record.cancellations.push({ ...current, requestedAt, reason: input.reason, ...(executionId ? { executionId } : {}) });
}

/** A real state transition is the only source of task end time. Historic tasks
 * lacking this event remain unknown; updatedAt is never promoted to an end. */
export function recordTaskTerminalTransition(task: OpsTask, previousStatus: TaskStatus,
  nextStatus: TaskStatus, transitionedAt: string): void {
  if (!terminal(nextStatus) || previousStatus === nextStatus) return;
  if (!timestamp(transitionedAt)) throw new Error("任务终态时间无效");
  evidence(task).terminals.push({ ...binding(task), status: nextStatus, transitionedAt });
}

/** Only original ledger receipts can confirm a command exit. A cancel API
 * acknowledgement, missing process, or tool completion is not an exit receipt.
 * This updates facts even for old rounds; it never changes the task's status. */
export function mergeTaskRemoteEvidence(task: OpsTask, operations: ExecutionOperationRecord[]): boolean {
  const record = evidence(task);
  let changed = false;
  for (const operation of operations) {
    if (operation.taskId !== task.id) continue;
    for (const attempt of operation.attempts) {
      if (attempt.operationId !== operation.operationId || !attempt.id || !attempt.executionId) continue;
      const key = record.remoteAttempts.findIndex(item => item.operationId === operation.operationId && item.attemptId === attempt.id);
      const previous = record.remoteAttempts[key];
      if (previous && (previous.executionId !== attempt.executionId || previous.stepId !== operation.stepId
        || previous.roundId !== operation.roundId || previous.workflowEpoch !== operation.workflowEpoch
        || previous.startedAt !== attempt.startedAt)) continue;
      const result = attempt.outcome?.result as { exitCode?: unknown } | undefined;
      const hasReceipt = !!attempt.outcome?.evidenceRefs.length && attempt.outcome.status === attempt.status
        && Number.isFinite(attempt.completedAt) && attempt.completedAt! >= attempt.startedAt;
      const hasExit = hasReceipt && ["succeeded", "failed"].includes(attempt.status) && Number.isInteger(result?.exitCode);
      const state = hasExit ? "exit_recorded" : hasReceipt && attempt.status === "not_dispatched" ? "not_dispatched" : "pending";
      // Structured tools have no Shell exit code and keep state=pending. Their
      // committed receipt must still survive an older dispatching/unknown read.
      // Unknown may be refined by a real late receipt for the original attempt;
      // the native ledger allows this. Only definite terminal results are fixed.
      if (previous?.resultRecordedAt !== undefined && (!hasReceipt || attempt.completedAt! < previous.resultRecordedAt
        || previous.status !== "unknown" && (previous.status !== attempt.status || previous.resultRecordedAt !== attempt.completedAt))) continue;
      // A stale refresh cannot replace an already committed terminal receipt.
      if (previous && previous.state !== "pending" && state !== previous.state) continue;
      if (previous?.state === "exit_recorded" && hasExit && previous.exitCode !== result!.exitCode) continue;
      const next: TaskTerminalEvidence["remoteAttempts"][number] = {
        operationId: operation.operationId, attemptId: attempt.id, executionId: attempt.executionId, stepId: operation.stepId,
        roundId: operation.roundId, workflowEpoch: operation.workflowEpoch, state,
        status: attempt.status, cancelRequested: attempt.cancelRequested || operation.cancelRequested || !!previous?.cancelRequested,
        late: attempt.late || !!previous?.late, startedAt: attempt.startedAt,
        ...(hasReceipt ? { resultRecordedAt: attempt.completedAt, evidenceRefs: [...attempt.outcome!.evidenceRefs] } : { evidenceRefs: [] }),
        ...(hasExit ? { exitCode: result!.exitCode as number } : {}),
      };
      if (JSON.stringify(previous) === JSON.stringify(next)) continue;
      if (key < 0) record.remoteAttempts.push(next); else record.remoteAttempts[key] = next;
      changed = true;
    }
  }
  return changed;
}

function numericUsage(raw: TaskModelRequest["usage"]): Record<string, number> | undefined {
  if (!raw) return undefined;
  const usage: Record<string, number> = {};
  for (const key of ["prompt_tokens", "completion_tokens", "input_tokens", "output_tokens", "total_tokens"]) {
    const value = raw[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) usage[key] = value;
  }
  return Object.keys(usage).length ? usage : undefined;
}

export function mergeTaskModelEvidence(task: OpsTask, requests: TaskModelRequest[]): void {
  const record = evidence(task);
  for (const request of requests) {
    if (request.taskId !== task.id || !request.requestId || !request.operationId) continue;
    const key = record.modelRequests.findIndex(item => item.requestId === request.requestId);
    const previous = record.modelRequests[key];
    if (previous && (previous.operationId !== request.operationId || previous.roundId !== request.roundId
      || request.updatedAtMs < previous.updatedAtMs)) continue;
    if (previous && ["completed", "cancelled"].includes(previous.state) && !["completed", "cancelled"].includes(request.state)) continue;
    const usage = numericUsage(request.usage) ?? previous?.usage;
    const next: TaskTerminalEvidence["modelRequests"][number] = {
      requestId: request.requestId, operationId: request.operationId, roundId: request.roundId, state: request.state,
      cancelRequested: request.cancelRequested, late: request.late, createdAtMs: request.createdAtMs, updatedAtMs: request.updatedAtMs,
      usageStatus: request.state === "not_dispatched" ? "not_dispatched" : usage ? "reported" : "missing", ...(usage ? { usage } : {}),
    };
    if (key < 0) record.modelRequests.push(next); else record.modelRequests[key] = next;
  }
}

export function taskTerminalEvidenceSummary(task: OpsTask) {
  const record = task.terminalEvidence;
  const lastTerminal = record?.terminals[record.terminals.length - 1];
  const cancellation = record?.cancellations[record.cancellations.length - 1];
  const remote = cancellation?.executionId ? record?.remoteAttempts.filter(item => item.executionId === cancellation.executionId
    && item.roundId === cancellation.roundId && item.workflowEpoch === cancellation.workflowEpoch) : undefined;
  const exited = remote?.find(item => item.state === "exit_recorded");
  const notDispatched = remote?.find(item => item.state === "not_dispatched");
  return {
    // An older round's terminal event is history, not an end for a resumed task.
    terminalAt: terminal(task.status) && lastTerminal?.status === task.status
      && lastTerminal.roundId === task.currentRoundId && lastTerminal.workflowEpoch === (task.workflowEpoch ?? 0)
      ? lastTerminal.transitionedAt : undefined,
    cancelRequestedAt: cancellation?.requestedAt,
    remoteState: !cancellation ? "not_requested" : !cancellation.executionId ? "no_active_execution_recorded"
      : exited ? "exit_recorded" : notDispatched ? "not_dispatched" : "pending",
    exitCode: exited?.exitCode,
    exitRecordedAt: exited?.resultRecordedAt,
    // A receipt time is an upper bound on exit latency, never an exact exit time.
    exitReceiptDelayMs: exited?.resultRecordedAt !== undefined && cancellation
      && exited.resultRecordedAt >= Date.parse(cancellation.requestedAt)
      ? exited.resultRecordedAt - Date.parse(cancellation.requestedAt) : undefined,
    modelRequestsWithMissingUsage: record?.modelRequests.filter(item => item.usageStatus === "missing").length ?? 0,
  };
}
