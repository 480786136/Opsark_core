import type { ExecutionIntentSnapshot, ExecutionTargetRef, OpsTask, ServerProfile } from "@/types";
import type { ExecutionOperationRecord } from "@/services/executionLedger";
import { executionIntentMatches } from "./planPreparation";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);

/** Projection parsing never prepares steps, acquires approval, or changes historical facts. */
export function readTaskProjection(value: unknown): { tasks: OpsTask[]; issues: string[]; compatible: boolean } {
  if (value === undefined || value === null) return { tasks: [], issues: [], compatible: true };
  let rows: unknown = value;
  if (!Array.isArray(value)) {
    if (!object(value) || value.version !== 1 || value.contractVersion !== "task-projection@1") {
      return { tasks: [], issues: ["任务缓存版本无法识别，已保留原始记录并停止覆盖；请使用兼容版本读取。"], compatible: false };
    }
    rows = value.tasks;
  }
  if (!Array.isArray(rows)) return { tasks: [], issues: ["任务缓存缺少有效任务列表，原始记录未修改。"], compatible: false };
  const issues: string[] = [], tasks: OpsTask[] = [], ids = new Set<string>();
  rows.forEach((row, index) => {
    if (!object(row) || !text(row.id) || !text(row.serverId) || !text(row.status)
      || !Array.isArray(row.plan) || !Array.isArray(row.messages) || ids.has(row.id)
      || !row.plan.every(step => object(step) && text(step.id) && text(step.status))) {
      issues.push(`第 ${index + 1} 条任务缓存无法安全读取，原始记录未修改。`);
      return;
    }
    ids.add(row.id);
    // Return independent JSON data, so runtime recovery cannot mutate the caller's historical input.
    tasks.push(JSON.parse(JSON.stringify(row)) as OpsTask);
  });
  return { tasks, issues, compatible: !issues.length };
}

/** Native records are versioned individually. Invalid/new records never become an empty successful read. */
export function readExecutionLedger(value: unknown): { operations: ExecutionOperationRecord[]; issues: string[]; compatible: boolean } {
  if (!Array.isArray(value)) return { operations: [], issues: ["执行台账不是有效记录列表，变更派发已暂停。"], compatible: false };
  const operations: ExecutionOperationRecord[] = [], issues: string[] = [], ids = new Set<string>(), attemptIds = new Set<string>();
  value.forEach((row, index) => {
    try {
      if (!object(row) || row.version !== 1 || !text(row.operationId) || ids.has(row.operationId)
        || !text(row.taskId) || !text(row.stepId) || !integer(row.workflowEpoch) || !integer(row.planRevision)
        || !integer(row.stepRevision) || !text(row.intentDigest) || !object(row.intent)
        || !["command", "validation", "tool", "framework"].includes(String(row.phase))
        || !["read", "change", "interaction"].includes(String(row.effect)) || !stringArray(row.resourceKeys)
        || !["prepared", "dispatching", "succeeded", "failed", "unknown", "not_dispatched"].includes(String(row.state))
        || typeof row.cancelRequested !== "boolean" || !integer(row.createdAt) || !integer(row.updatedAt) || !Array.isArray(row.attempts)) throw new Error();
      const intent = row.intent as unknown as ExecutionIntentSnapshot;
      if (!executionIntentMatches(intent, intent) || intent.digest !== row.intentDigest
        || intent.semantic.taskId !== row.taskId || intent.semantic.stepId !== row.stepId) throw new Error();
      for (const attempt of row.attempts) {
        if (!object(attempt) || attempt.version !== 1 || !text(attempt.id) || attemptIds.has(attempt.id)
          || attempt.operationId !== row.operationId || !text(attempt.executionId) || !text(attempt.bootId)
          || typeof attempt.cancelRequested !== "boolean" || typeof attempt.late !== "boolean" || !integer(attempt.startedAt)
          || !["dispatching", "succeeded", "failed", "unknown", "not_dispatched"].includes(String(attempt.status))
          || (attempt.completedAt !== undefined && !integer(attempt.completedAt))) throw new Error();
        if (attempt.projectionAppliedAt !== undefined && !integer(attempt.projectionAppliedAt)
          || attempt.reviewCompletedAt !== undefined && (!integer(attempt.reviewCompletedAt)
            || attempt.projectionAppliedAt === undefined || attempt.status !== "succeeded" || attempt.late)) throw new Error();
        if (attempt.outcome !== undefined && (!object(attempt.outcome)
          || attempt.outcome.status !== attempt.status || !stringArray(attempt.outcome.evidenceRefs))) throw new Error();
        if (["succeeded", "failed", "not_dispatched"].includes(attempt.status as string) && !attempt.outcome) throw new Error();
        attemptIds.add(attempt.id);
      }
      if (row.reconciliation !== undefined) {
        const resolution = row.reconciliation;
        if (!object(resolution) || resolution.version !== 1 || resolution.status !== "completed"
          || resolution.reason !== "current_state_verified" || !text(resolution.attemptId)
          || !row.attempts.some(attempt => object(attempt) && attempt.id === resolution.attemptId)
          || !["file_transfer", "service"].includes(String(resolution.kind)) || !integer(resolution.resolvedAt)
          || !stringArray(resolution.evidenceRefs) || !resolution.evidenceRefs.length
          || !stringArray(resolution.readOperationIds) || !resolution.readOperationIds.length
          || resolution.readOperationId !== resolution.readOperationIds[0]) throw new Error();
      }
      ids.add(row.operationId);
      operations.push(JSON.parse(JSON.stringify(row)) as ExecutionOperationRecord);
    } catch { issues.push(`第 ${index + 1} 条执行记录的版本、身份或快照校验失败；原记录保留，禁止自动重放。`); }
  });
  return { operations, issues, compatible: !issues.length };
}

export type ExecutionLedgerRecoveryAction = "reconcile" | "verify" | "retry_storage" | "none";
export interface ExecutionLedgerRecoveryItem {
  kind: "uncertain" | "recorded_result" | "storage_failed" | "incompatible";
  operationId: string;
  attemptId?: string;
  stepId?: string;
  summary: string;
  knownFacts: string[];
  action: ExecutionLedgerRecoveryAction;
  /** A local cancellation request never proves that the remote process stopped. */
  cancelRequested?: boolean;
  late?: boolean;
  title?: string;
  recordedAt?: number;
}
export interface ExecutionLedgerRecovery {
  version: "execution-ledger-recovery@1";
  items: ExecutionLedgerRecoveryItem[];
  recordedReads?: RecordedReadReceipt[];
  busyAttemptId?: string;
  error?: string;
}

/** Historical receipts are evidence, never an automatic task-completion decision. */
export interface RecordedReadReceipt {
  operationId: string; attemptId: string; stepId: string; title: string;
  toolId?: string; status: string; recordedAt?: number; late: boolean; evidenceRefs: string[];
}

export function executionReceiptSteps(task: OpsTask) {
  return [...task.plan, ...(task.phaseHistory ?? []).flatMap(p => p.plan),
    ...(task.planHistory ?? []).flatMap(r => [...r.plan, ...(r.finalPlan ?? []), ...(r.phases ?? []).flatMap(p => p.plan)]),
    ...(task.historyCheckpoint?.unresolvedIssues ?? []).flatMap(i => i.recoveryContract ? [i.recoveryContract.step] : [])];
}

function supportsReconciliation(operation: ExecutionOperationRecord) {
  const semantic = operation.intent.semantic;
  return semantic.action.type === "tool" && semantic.action.toolId === "files.transfer_between_servers"
    || semantic.action.type === "shell" && semantic.runtimeClass === "persistent_service"
      && isReadOnlyServiceValidator(semantic.validator?.command ?? semantic.validation ?? "");
}

export function projectExecutionLedgerRecovery(operations: readonly ExecutionOperationRecord[], options: {
  appliedAttemptIds?: readonly string[];
  verifiedAttemptIds?: readonly string[];
  storageFailures?: readonly ExecutionLedgerRecoveryItem[];
  issues?: readonly string[];
  servers?: readonly ServerProfile[];
} = {}): ExecutionLedgerRecovery {
  const applied = new Set(options.appliedAttemptIds ?? []), verified = new Set(options.verifiedAttemptIds ?? []);
  const pendingCommits = new Set((options.storageFailures ?? []).flatMap(item => item.attemptId ? [item.attemptId] : []));
  const verifiedReadOperations = new Set(operations.flatMap(operation => operation.reconciliation?.readOperationIds ?? []));
  const items: ExecutionLedgerRecoveryItem[] = [];
  const recordedReads: RecordedReadReceipt[] = [];
  for (const operation of operations) for (const attempt of operation.attempts) {
    // Saving the captured receipt takes precedence over reconciling its still-dispatching row.
    if (pendingCommits.has(attempt.id)) continue;
    // These successful reads are native-verified reconciliation evidence, even
    // when their original step was compacted out of the display cache.
    if (operation.effect === "read" && attempt.status === "succeeded" && verifiedReadOperations.has(operation.operationId)) continue;
    if (operation.reconciliation?.status === "completed" && operation.reconciliation.attemptId === attempt.id) continue;
    const acknowledged = applied.has(attempt.id) || attempt.projectionAppliedAt !== undefined;
    const reviewed = !attempt.late && (verified.has(attempt.id) || attempt.reviewCompletedAt !== undefined);
    const semantic = operation.intent.semantic;
    const action = semantic.action;
    const inspectionNames: Record<string, string> = { "disk.inspect": "磁盘检查", "files.find_large": "大文件检查", "services.inspect": "服务检查" };
    const inspectionName = action.type === "tool" ? inspectionNames[action.toolId] : undefined;
    const subject = action.type === "tool" ? action.arguments.service ?? action.arguments.path : undefined;
    const title = inspectionName ? `${inspectionName}${typeof subject === "string" ? ` · ${subject.slice(0, 180)}` : ""}`
      : semantic.expected?.trim().slice(0, 180) || (action.type === "tool" ? action.toolId : "远端操作");
    if (operation.effect === "read" && ["succeeded", "failed"].includes(attempt.status) && attempt.outcome) {
      recordedReads.push({ operationId: operation.operationId, attemptId: attempt.id, stepId: operation.stepId,
        title, toolId: semantic.action.type === "tool" ? semantic.action.toolId : undefined,
        status: attempt.status, recordedAt: attempt.completedAt, late: attempt.late,
        evidenceRefs: [...attempt.outcome.evidenceRefs] });
      continue;
    }
    let supported = supportsReconciliation(operation) && attempt.status !== "dispatching"
      && operation.attempts[operation.attempts.length - 1]?.id === attempt.id;
    if (supported && options.servers) {
      try { buildReadOnlyReconciliation(operation, { id: operation.taskId }, options.servers); }
      catch { supported = false; }
    }
    const guidance = supported ? [] : ["此操作暂不支持自动核对；请在任务中查看已有证据并安排只读排查。"];
    const base = { title, recordedAt: attempt.completedAt, operationId: operation.operationId, attemptId: attempt.id, stepId: operation.stepId,
      cancelRequested: attempt.cancelRequested || operation.cancelRequested, late: attempt.late };
    if (["dispatching", "unknown"].includes(attempt.status)) {
      items.push({ ...base, kind: "uncertain", action: supported ? "reconcile" : "none",
        summary: "先前操作已进入派发阶段，远端是否完成仍待核对。",
        knownFacts: [...guidance, "已登记派发尝试；没有足够证据证明未执行。", ...(base.cancelRequested ? ["已请求取消，尚未确认远端停止。"] : [])] });
    } else if (attempt.status === "succeeded" && (!acknowledged || !reviewed)) {
      items.push({ ...base, kind: "recorded_result", action: supported ? "verify" : "none",
        summary: operation.phase === "command" ? "主命令成功已记录，继续复核或只读验收，不重复执行主命令。" : "执行结果已记录，等待当前任务核验结果。",
        knownFacts: [...guidance, "成功结果已保存；是否满足业务目标仍需结合任务证据确认。",
          ...(attempt.late ? ["结果在原任务所有权结束后返回，保存在原尝试中。"] : [])] });
    } else if (attempt.status === "failed" && !acknowledged) {
      items.push({ ...base, kind: "recorded_result", action: supported ? "verify" : "none", summary: "已记录失败结果，先核对已发生的部分效果与后续处理。",
        knownFacts: [...guidance, "失败结果属于该次尝试；不能推定远端没有发生变更。"] });
    }
  }
  items.push(...(options.storageFailures ?? []));
  items.push(...(options.issues ?? []).map(summary => ({ kind: "incompatible" as const, operationId: "", summary, knownFacts: ["原始记录已保留。"], action: "none" as const })));
  return { version: "execution-ledger-recovery@1", items, recordedReads };
}

export interface ReconciliationRead {
  role: "source" | "target" | "execution";
  serverId: string;
  target: ExecutionTargetRef;
  command: string;
  format: "file-fingerprint@1" | "service-readiness@1";
}
export interface ReadOnlyReconciliation {
  kind: "file_transfer" | "service";
  operationId: string;
  attemptId: string;
  reads: ReconciliationRead[];
}
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Conservative allowlist: even an approved validator is not necessarily read-only. */
export function isReadOnlyServiceValidator(command: string): boolean {
  return /^(?:sudo -n )?systemctl (?:--user )?is-active (?:--quiet )?[A-Za-z0-9_@.:-]+(?:\.service)?$/.test(command)
    || (/^curl (?:-[fsSI]+ )+(?:--max-time [1-9][0-9]* )?'?https?:\/\/[A-Za-z0-9._~:/?#\[\]@!%+,=\-]+'?$/.test(command)
      && /^curl (?:-[fsSI]+ )*-[fsSI]*f[fsSI]* /.test(command));
}

/** A descriptor only: no model, SSH, authorization, or task mutation occurs here. */
export function buildReadOnlyReconciliation(operation: ExecutionOperationRecord, task: Pick<OpsTask, "id">, servers: readonly ServerProfile[]): ReadOnlyReconciliation {
  if (operation.taskId !== task.id || !readExecutionLedger([operation]).compatible) throw new Error("执行记录不属于当前任务或快照校验失败。请先恢复原记录。");
  const attempt = operation.attempts[operation.attempts.length - 1];
  if (!attempt || attempt.status === "not_dispatched") throw new Error("该记录没有需要核对的远端派发尝试。");
  if (operation.reconciliation?.attemptId === attempt.id) throw new Error("该尝试已完成核对，无需重复操作。");
  const semantic = operation.intent.semantic;
  const bind = (target: ExecutionTargetRef | undefined): ExecutionTargetRef & { serverId: string } => {
    if (!target?.username) throw new Error("冻结记录缺少可验证的服务器或账户身份，请人工核对原目标。");
    const matches = servers.filter(server => (!target.serverId || server.id === target.serverId) && server.host.toLowerCase() === target.host.toLowerCase()
      && server.port === target.port && server.username === target.username);
    if (matches.length !== 1) throw new Error("原执行目标的地址、端口或账户已变化，不能把其他服务器的观察作为核对证据。");
    return { ...target, serverId: matches[0].id };
  };
  const base = { operationId: operation.operationId, attemptId: attempt.id };
  if (semantic.action.type === "tool" && semantic.action.toolId === "files.transfer_between_servers") {
    const source = bind(semantic.targets.find(target => target.role === "source")), target = bind(semantic.targets.find(target => target.role === "target"));
    const reads = [source, target].map(endpoint => {
      if (!endpoint.path?.startsWith("/") || /[\r\n\0]/.test(endpoint.path)) throw new Error("自动文件核对需要冻结的绝对文件路径；目录与相对路径请先只读诊断。");
      const path = quote(endpoint.path);
      // Check twice around hashing; changing files are not accepted as a stable fingerprint.
      const command = `test -f ${path} && LC_ALL=C stat -Lc '%s' -- ${path} && sha256sum -- ${path} && LC_ALL=C stat -Lc '%s' -- ${path}`;
      return { role: endpoint.role as "source" | "target", serverId: endpoint.serverId, target: endpoint, command, format: "file-fingerprint@1" as const };
    });
    return { ...base, kind: "file_transfer", reads };
  }
  if (semantic.action.type === "shell" && semantic.runtimeClass === "persistent_service") {
    const command = semantic.validator?.command ?? semantic.validation ?? "";
    if (!isReadOnlyServiceValidator(command)) throw new Error("原服务验收命令不属于可自动核对的只读检查，请生成只读诊断计划；禁止重启或重复部署。");
    const target = bind(semantic.targets.find(item => item.role === "execution"));
    return { ...base, kind: "service", reads: [{ role: "execution", serverId: target.serverId, target, command, format: "service-readiness@1" }] };
  }
  throw new Error("该操作尚无自动对账契约。请先只读检查原进程与实际产物，不能直接重放变更。");
}

export function parseFileReconciliationObservation(read: ReconciliationRead, output: string, exitCode: number | undefined) {
  const lines = output.trim().split(/\r?\n/);
  if (read.format !== "file-fingerprint@1" || exitCode !== 0 || lines.length !== 3
    || !/^\d+$/.test(lines[0]) || lines[0] !== lines[2] || !/^[a-f0-9]{64} [ *].+$/.test(lines[1])
    || !Number.isSafeInteger(Number(lines[0]))) throw new Error("文件核对没有取得稳定的尺寸和 SHA-256 证据，原变更仍待核对。");
  return { serverId: read.serverId, host: read.target.host, port: read.target.port, username: read.target.username,
    path: read.target.path, size: Number(lines[0]), sha256: lines[1].slice(0, 64) };
}
