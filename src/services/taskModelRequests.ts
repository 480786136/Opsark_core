import { invoke } from "@tauri-apps/api/core";
import { taskBudgetRegistration } from "@/features/agent/taskModelBudget";
import { ensureModelRecoveryContext } from "./modelRecovery";

type AccountingListener = (taskId: string, roundId: string) => void | Promise<void>;
const accountingListeners = new Set<AccountingListener>();
/** In-process read-only refresh notification; it never retries or consumes a model result. */
export function subscribeTaskModelAccounting(listener: AccountingListener) {
  accountingListeners.add(listener);
  return () => { accountingListeners.delete(listener); };
}

export interface TaskModelRequest {
  requestId: string;
  taskId?: string;
  roundId?: string;
  operationId: string;
  state: "not_dispatched" | "dispatching" | "accepted" | "unknown" | "completed" | "cancelled";
  phase: string;
  cancelRequested: boolean;
  late: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  usage?: Record<string, unknown>;
}

/** Register the frozen policy before the native model command can send any bytes. */
export async function invokeTaskModel<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const prepared = { ...args };
  const owners = new Map<string, string>();
  const adapter = prepared._requestLifecycleAdapter;
  delete prepared._requestLifecycleAdapter;
  for (const key of ["context", "reviewContext", "executionContext"]) {
    if (typeof prepared[key] !== "string") continue;
    // Capture operation start before registration's await, so cancellation also
    // fences requests that have not entered the native request ledger yet.
    let raw = ensureModelRecoveryContext(prepared[key] as string);
    if (adapter) raw = JSON.stringify({ ...JSON.parse(raw), _modelRequestLifecycle: { adapter } });
    prepared[key] = raw;
    const registration = taskBudgetRegistration(raw);
    if (!registration) continue;
    owners.set(registration.taskId, registration.roundId);
    await invoke("register_task_model_budget", { registration });
    prepared[key] = JSON.stringify({ ...JSON.parse(raw), _taskModelBudget: {
      version: 1, taskId: registration.taskId, roundId: registration.roundId,
    } });
  }
  try {
    return await invoke<T>(command, prepared);
  } finally {
    // Native admission/settlement has finished even when the model command
    // rejects. Refresh the durable account before another business stage runs.
    // An observer failure must not replace the original model result or error.
    await Promise.allSettled([...owners].flatMap(([taskId, roundId]) =>
      [...accountingListeners].map(listener => Promise.resolve().then(() => listener(taskId, roundId)))));
  }
}

export function modelRequestStateLabel(request: TaskModelRequest, locale: "zh" | "en" = "zh"): string {
  const zh = locale === "zh";
  const state = (zh
    ? { not_dispatched: "未派发", dispatching: "正在派发", accepted: request.phase === "queued" ? "排队中" : request.phase === "running" ? "模型生成中" : "已受理",
      unknown: "结果待核对", completed: "响应已记录", cancelled: "服务方已确认取消" }
    : { not_dispatched: "not dispatched", dispatching: "dispatching", accepted: request.phase === "queued" ? "queued" : request.phase === "running" ? "model generating" : "accepted",
      unknown: "result awaiting reconciliation", completed: "response recorded", cancelled: "provider confirmed cancellation" })[request.state];
  // Cancellation is an audit fact. A terminal receipt remains terminal even in
  // old ledgers that added cancellation after completion; it is not pending stop.
  const cancel = !request.cancelRequested || request.state === "cancelled" ? ""
    : request.state === "completed" ? (zh ? " · 取消请求已记录" : " · cancellation request recorded")
    : request.state === "not_dispatched" ? (zh ? " · 本地取消已记录" : " · local cancellation recorded")
    : (zh ? " · 已请求取消，未确认停止" : " · cancellation requested; provider confirmation required");
  return `${state}${cancel}${request.late ? (zh ? " · 迟到响应" : " · late response") : ""}`;
}

/** Present current accounting without rewriting the historical workflow stop. */
export function reconciledModelStopMessage(task: { id: string; modelPlanningBlocker?: { error: import("@/types").ModelServiceError }; modelRequests?: TaskModelRequest[] } | undefined | null): string | undefined {
  const error = task?.modelPlanningBlocker?.error;
  if (!task || !error?.requestKey || !["MODEL_DISPATCH_UNKNOWN", "MODEL_REQUEST_UNRESOLVED", "MODEL_RESULT_UNAVAILABLE"].includes(error.code)) return;
  const original = task.modelRequests?.find(item => item.taskId === task.id && item.requestId === error.requestKey);
  if (original?.state === "completed") return "此前等待原模型请求时已停止；原响应现已记录，用量按账本显示。迟到方案未采用，任务没有自动继续；如需继续，请依据当前目标显式重新规划。";
  if (original?.state === "cancelled") return "此前等待原模型请求时已停止；服务方现已确认原请求取消，用量按账本显示。任务没有自动继续。";
}

/** Only an explicit user action can follow a refreshed, terminal original record. */
export function isReconciledModelRequestRetryable(error: import("@/types").ModelServiceError | undefined,
  taskId: string, records: TaskModelRequest[] | undefined): boolean {
  if (!error || error.origin !== "core" || !error.requestKey
    || !["MODEL_DISPATCH_UNKNOWN", "MODEL_RESULT_UNAVAILABLE", "MODEL_REQUEST_UNRESOLVED", "MODEL_REQUEST_REPLAY_BLOCKED",
      "MODEL_ADAPTER_BUSY", "MODEL_REQUEST_NOT_ACCEPTED"].includes(error.code)) return false;
  const original = records?.find(record => record.requestId === error.requestKey && record.taskId === taskId);
  return Boolean(original && ["not_dispatched", "completed", "cancelled"].includes(original.state));
}
