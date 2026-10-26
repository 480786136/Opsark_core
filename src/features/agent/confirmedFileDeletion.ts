import { executionDigest } from "./planPreparation";
import type { OpsTask, PlanStep, ServerProfile } from "@/types";
import type { UserInputRequest } from "@/features/tools/types";
import { compileToolSchema } from "@/features/tools/toolParameterSchema";
import { deletionFileSchema } from "@/features/tools/fileDeletionContracts";
import probe from "@/features/tools/file_deletion.py?raw";

export interface DeletionFile { path: string; size: number; identity: string[]; sha256: string }
export interface FileDeletionAuthorization {
  version: 1;
  id: string;
  taskId: string;
  scope: string;
  target: { serverId: string; host: string; port: number; username: string };
  items: DeletionFile[];
  digest: string;
  expiresAt: number;
  state: "preview" | "approved" | "rejected" | "executing" | "completed" | "unknown" | "revoked";
  decidedAt?: string;
  executionId?: string;
  stepId?: string;
}
const snapshotValidator = compileToolSchema({ type: "array", minItems: 1, maxItems: 100, items: deletionFileSchema });
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export function fileDeletionCommand(input: { mode: "preview"; paths: string[] } | { mode: "execute"; items: DeletionFile[] }) {
  return `python3 -I -B -S -c ${quote(probe)} ${quote(JSON.stringify(input))}`;
}
const deletionFailureReasons: Record<string, string> = {
  INVALID_REQUEST: "候选参数或快照不完整，需重新预览",
  UNSUPPORTED_ENVIRONMENT: "当前环境不支持精确删除所需能力",
  LEASE_CONFLICT: "文件正在被写入，无法取得保护租约",
  LEASE_UNSUPPORTED: "当前文件系统不支持保护租约",
  LEASE_PERMISSION_DENIED: "当前身份无权取得保护租约",
  LEASE_INTERRUPTED: "出现新的写入请求或租约已丢失，已中止删除",
  LEASE_DEADLINE_EXCEEDED: "保护窗口已到期，已中止删除",
  CANDIDATE_CHANGED: "候选身份或内容已变化，需重新预览和确认",
  HASH_LIMIT_EXCEEDED: "候选清单超过完整内容核验限额",
  QUARANTINE_CHANGED: "隔离目录身份或权限已变化，需核对原对象",
  IO_FAILURE: "文件系统操作失败，需核对已保存的回执",
  INTERNAL_ERROR: "删除工具异常，需核对已保存的回执",
};
export function fileDeletionFailureReason(stderr: string | undefined) {
  for (const line of (stderr ?? "").slice(-65536).split("\n")) {
    if (!line.startsWith("OPSARK_DELETE_ERROR ")) continue;
    try {
      const { code } = JSON.parse(line.slice("OPSARK_DELETE_ERROR ".length));
      if (typeof code === "string" && Object.prototype.hasOwnProperty.call(deletionFailureReasons, code)) {
        return `${code}：${deletionFailureReasons[code]}`;
      }
    } catch { /* Never expose arbitrary remote error text in a user decision. */ }
  }
}
/** A pre-move marker is a recovery hint, never proof of a completed move. */
export function deletionCaptureReader(items: DeletionFile[], record: (location: { original: string; quarantine: string }) => void) {
  const allowed = new Set(items.map(item => item.path));
  const seen = new Set<string>();
  let buffer = "";
  let oversized = false;
  const accept = () => {
    if (oversized || !buffer.startsWith("OPSARK_DELETE_CAPTURE ")) return;
    try {
      const value = JSON.parse(buffer.slice("OPSARK_DELETE_CAPTURE ".length));
      if (!allowed.has(value.original) || seen.has(value.original) || typeof value.quarantine !== "string") return;
      const parent = value.original.slice(0, value.original.lastIndexOf("/") + 1);
      if (!value.quarantine.startsWith(parent)
        || !/^\.opsark-delete-[0-9a-f]{32}\/candidate$(?![\s\S])/.test(value.quarantine.slice(parent.length))) return;
      seen.add(value.original);
      record({ original: value.original, quarantine: value.quarantine });
    } catch { /* Ignore arbitrary stderr and malformed markers. */ }
  };
  return (data: string) => {
    let offset = 0;
    while (offset < data.length) {
      const end = data.indexOf("\n", offset);
      const part = data.slice(offset, end < 0 ? data.length : end);
      if (!oversized && buffer.length + part.length <= 65536) buffer += part;
      else { buffer = ""; oversized = true; }
      if (end < 0) break;
      accept();
      buffer = "";
      oversized = false;
      offset = end + 1;
    }
  };
}
export function validateDeletionPaths(paths: unknown): asserts paths is string[] {
  if (!Array.isArray(paths) || !paths.length || paths.length > 100 || new Set(paths).size !== paths.length
    || paths.some(path => typeof path !== "string" || !path.startsWith("/") || path.includes("\0")
      || new TextEncoder().encode(path).length > 4096 || path.slice(1).split("/").some(part => !part || part === "." || part === ".."))) {
    throw new Error("删除候选必须为1至100个不重复的精确绝对文件路径，不能包含路径跳转");
  }
}
export function fileDeletionScope(task: OpsTask) {
  return executionDigest({ id: task.id, round: task.currentRoundId, revision: task.requirementLifecycle?.revision ?? 0,
    goal: task.rootGoal, constraints: task.executionConstraints, requirements: task.persistedRequirements,
    serverId: task.executionTargetServerId ?? task.serverId });
}
function digest(item: FileDeletionAuthorization) {
  return executionDigest({ id: item.id, taskId: item.taskId, scope: item.scope, target: item.target,
    items: item.items, expiresAt: item.expiresAt, version: item.version });
}
export function deletionTarget(server: Pick<ServerProfile, "id" | "host" | "port" | "username">) {
  return { serverId: server.id, host: server.host, port: server.port, username: server.username };
}
export function createDeletionPreview(task: OpsTask, server: ServerProfile, id: string, paths: string[], stdout: string, now = Date.now()) {
  validateDeletionPaths(paths);
  const result = JSON.parse(stdout);
  if (result.mode !== "preview" || !snapshotValidator(result.items) || result.items.length !== paths.length
    || result.items.some((item: DeletionFile, index: number) => item.path !== paths[index])) throw new Error("删除候选结果与原请求不一致");
  const preview: FileDeletionAuthorization = { version: 1, id, taskId: task.id, scope: fileDeletionScope(task),
    target: deletionTarget(server), items: result.items, digest: "", expiresAt: now + 10 * 60_000, state: "preview" };
  preview.digest = digest(preview);
  task.fileDeletionAuthorizations ??= [];
  if (!Array.isArray(task.fileDeletionAuthorizations)) throw new Error("已保存的文件删除记录损坏，不能创建新许可");
  if (task.fileDeletionAuthorizations.some(item => item?.id === id)) throw new Error("删除候选标识重复");
  task.fileDeletionAuthorizations.push(preview);
  return preview;
}
export function currentDeletionAuthorization(task: OpsTask, id: string, now = Date.now()) {
  const matches = Array.isArray(task.fileDeletionAuthorizations) ? task.fileDeletionAuthorizations.filter(item => item?.id === id) : [];
  const item = matches[0];
  if (matches.length !== 1 || !item || item.version !== 1 || item.taskId !== task.id || task.cancelRequested
    || task.status === "cancelled" || task.pendingRequirements?.length || item.scope !== fileDeletionScope(task)
    || !Number.isFinite(item.expiresAt) || item.expiresAt <= now
    || item.target?.serverId !== (task.executionTargetServerId ?? task.serverId)
    || !snapshotValidator(item.items) || item.digest !== digest(item)) throw new Error("文件删除候选或许可已失效，请重新预览和确认");
  return item;
}
export function assertDeletionTarget(item: FileDeletionAuthorization, server: Pick<ServerProfile, "id" | "host" | "port" | "username">) {
  if (executionDigest(item.target) !== executionDigest(deletionTarget(server))) throw new Error("文件删除目标服务器身份已变化");
}
export function deletionConfirmation(task: OpsTask, id: string): UserInputRequest {
  const item = currentDeletionAuthorization(task, id);
  if (!["confirm_changes", "requested_changes_only", "allow_necessary_changes"].includes(task.executionConstraints?.changePolicy ?? "")
    || item.state !== "preview") throw new Error("当前需求未允许文件删除确认，或此候选已处理");
  return { title: "确认删除以下普通文件", description: `服务器：${item.target.host}:${item.target.port}\n${item.items.map(file => `${JSON.stringify(file.path)} — ${file.size} 字节`).join("\n")}\n仅删除上述 ${item.items.length} 个文件；不包含新文件、子目录或链接。许可到期时间：${new Date(item.expiresAt).toISOString()}。`,
    fields: [{ key: "decision", type: "select", label: "是否删除上述文件", description: "确认只授权本次完整清单；拒绝不会删除任何文件。",
      required: true, options: [{ value: "confirm", label: "确认删除上述文件" }, { value: "reject", label: "拒绝删除" }] }] };
}
export function decideDeletion(task: OpsTask, id: string, decision: string) {
  deletionConfirmation(task, id);
  if (!["confirm", "reject"].includes(decision)) throw new Error("必须明确确认或拒绝文件删除");
  const item = currentDeletionAuthorization(task, id);
  item.state = decision === "confirm" ? "approved" : "rejected";
  item.decidedAt = new Date().toISOString();
  return item;
}
export function deletionAuthorizedStep(task: OpsTask, step: PlanStep) {
  if (step.action?.type !== "tool" || step.action.toolId !== "files.delete_confirmed") return false;
  try {
    const item = currentDeletionAuthorization(task, String(step.action.arguments.authorizationId));
    if (item.state !== "approved" && !(item.state === "executing" && item.executionId === task.currentExecutionId && item.stepId === step.id)) return false;
    const target = step.executionIntent?.semantic.targets[0];
    return !target || target.serverId === item.target.serverId && target.host === item.target.host
      && target.port === item.target.port && target.username === item.target.username;
  } catch { return false; }
}
export function deletionAuthorizationContext(task: OpsTask) {
  const values = Array.isArray(task.fileDeletionAuthorizations) ? task.fileDeletionAuthorizations : [];
  const referenced = new Set(task.plan.flatMap(step => step.action?.type === "tool"
    ? [step.action.arguments.previewId, step.action.arguments.authorizationId].filter(value => typeof value === "string") : []));
  const selected = [...values].reverse().sort((left, right) => Number(referenced.has(right?.id)) - Number(referenced.has(left?.id))).slice(0, 8);
  return { total: values.length, omitted: values.length - selected.length, items: selected.map(item => {
    let current = false;
    try { currentDeletionAuthorization(task, item.id); current = true; } catch { /* Invalid storage grants no authority. */ }
    return { id: item?.id, state: item?.state, active: current && item.state === "approved", canConfirm: current && item.state === "preview",
      candidateCount: Array.isArray(item?.items) ? item.items.length : 0, digest: item?.digest,
      expiresAt: Number.isFinite(new Date(item?.expiresAt).getTime()) ? new Date(item.expiresAt).toISOString() : undefined };
  }), instruction: "仅active许可可用files.delete_confirmed执行一次；canConfirm候选用files.confirm_deletion展示Core原清单。普通Shell不继承许可，拒绝/过期/未知/已用记录不能重放；完整清单保留在预览工具证据，不从摘要重建路径。" };
}
export function invalidateDeletionConfirmation(task: OpsTask, step: PlanStep, previewId: string, reason: string) {
  const authorization = Array.isArray(task.fileDeletionAuthorizations) ? task.fileDeletionAuthorizations.find(item => item?.id === previewId) : undefined;
  if (authorization && ["preview", "approved"].includes(authorization.state)) authorization.state = "revoked";
  step.status = "failed";
  step.progressMessage = reason;
  task.status = "needs_adjustment";
  task.pauseReason = reason;
  task.latestGoalReview = undefined;
  task.summary = undefined;
  task.managedStopReason = "workflow_error";
  task.managedAdjustmentPhase = "manual_required";
}
export function revokeUnusedDeletionAuthorizations(task: OpsTask) {
  for (const item of Array.isArray(task.fileDeletionAuthorizations) ? task.fileDeletionAuthorizations : []) {
    if (item && ["preview", "approved"].includes(item.state)) item.state = "revoked";
  }
}
