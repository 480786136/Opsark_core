import { invoke } from "@tauri-apps/api/core";
import type { ExecutionIntentSnapshot, PlanStep } from "@/types";
import { executionDigest, canonicalExecutionJson } from "@/features/agent/planPreparation";
import { backend } from "./backend";

export type ExecutionState = "prepared" | "dispatching" | "succeeded" | "failed" | "unknown" | "not_dispatched";
export type ExecutionOutcomeStatus = Exclude<ExecutionState, "prepared" | "dispatching">;
export interface ExecutionOutcome { status: ExecutionOutcomeStatus; result?: unknown; evidenceRefs: string[] }
export interface ExecutionOperationInput {
  version: 1; operationId: string; taskId: string; stepId: string; roundId?: string;
  workflowEpoch: number; planRevision: number; stepRevision: number;
  intentDigest: string; intent: ExecutionIntentSnapshot;
  phase: "command" | "validation" | "tool" | "framework";
  effect: "read" | "change" | "interaction"; resourceKeys: string[]; executionId?: string;
}
export interface ExecutionAttemptRecord {
  version: 1; id: string; operationId: string; executionId: string;
  status: Exclude<ExecutionState, "prepared">; bootId: string; cancelRequested: boolean;
  late: boolean; startedAt: number; completedAt?: number; outcome?: ExecutionOutcome;
  projectionAppliedAt?: number; reviewCompletedAt?: number;
  reviews?: ExecutionAttemptReviewReceipt[];
}
/** A completed step review is not a claim that its acceptance conditions passed.
 * Task follow-up transfers presentation ownership to the original task, never
 * reconciles an uncertain remote effect or changes the recorded execution. */
export interface ExecutionAttemptReviewInput {
  version: 1; operationId: string; attemptId: string; intentDigest: string;
  outcome: "proven" | "not_met" | "unknown";
  disposition: "accepted" | "task_followup";
  evidenceRefs: string[]; reviewFingerprint: string;
}
export interface ExecutionAttemptReviewReceipt extends ExecutionAttemptReviewInput { recordedAt: number }

export function executionAttemptReviewMatches(operation: ExecutionOperationRecord, attempt: ExecutionAttemptRecord,
  review: ExecutionAttemptReviewInput): boolean {
  const refs = attempt.outcome?.evidenceRefs;
  return review?.version === 1 && review.operationId === operation.operationId && review.attemptId === attempt.id
    && review.intentDigest === operation.intentDigest && ["succeeded", "failed"].includes(attempt.status)
    && ["proven", "not_met", "unknown"].includes(review.outcome)
    && (review.disposition === "accepted" ? review.outcome === "proven" : review.disposition === "task_followup" && review.outcome !== "proven")
    && typeof review.reviewFingerprint === "string" && /^sha256:[a-f0-9]{64}$/.test(review.reviewFingerprint)
    && Array.isArray(review.evidenceRefs) && !!refs?.length && review.evidenceRefs.length === refs.length
    && new Set(review.evidenceRefs).size === refs.length && review.evidenceRefs.every(ref => refs.includes(ref));
}
export interface ExecutionOperationRecord extends ExecutionOperationInput {
  state: ExecutionState; attempts: ExecutionAttemptRecord[]; cancelRequested: boolean;
  createdAt: number; updatedAt: number;
  reconciliation?: { version: 1; status: "completed"; reason: "current_state_verified"; attemptId: string; readOperationId: string; readOperationIds: string[];
    evidenceRefs: string[]; kind: "file_transfer" | "service"; resolvedAt: number };
}
/** Restore only an actual, attempt-bound step review; summaries and task status
 * are intentionally insufficient. Historical steps with compacted-away reviews
 * stay unreviewed rather than inventing a successful acceptance. */
export function deriveExecutionAttemptReview(operation: ExecutionOperationRecord, attempt: ExecutionAttemptRecord,
  step: PlanStep): ExecutionAttemptReviewInput | undefined {
  const review = step.review, acceptance = review?.acceptance;
  const latestReference = [...(step.executionLedgerAttempts ?? [])].reverse().find(ref => ref.phase === operation.phase);
  if (!review || !acceptance || !step.result || typeof acceptance.reason !== "string" || !acceptance.reason.trim()
    || !Array.isArray(acceptance.evidenceIds)
    || operation.stepId !== step.id || step.executionIntent?.digest !== operation.intentDigest
    || step.executionIntent.semantic.taskId !== operation.taskId
    || attempt.operationId !== operation.operationId || attempt.late || attempt.cancelRequested || operation.cancelRequested
    || !["succeeded", "failed"].includes(attempt.status) || !attempt.outcome?.evidenceRefs.length
    || !step.ledgerAppliedAttemptIds?.includes(attempt.id)
    || latestReference?.operationId !== operation.operationId || latestReference.attemptId !== attempt.id
    || latestReference.executionId !== attempt.executionId) return undefined;
  const availableEvidence = new Set([...(step.result.evidenceIds ?? []), ...(step.evidence ?? []).map(item => item.id)]);
  if (acceptance.evidenceIds.some(id => !availableEvidence.has(id))) return undefined;
  const accepted = acceptance.status === "proven" && step.status === "completed" && acceptance.evidenceIds.length > 0;
  const followingUp = acceptance.status !== "proven" && step.status === "failed"
    && (review.decision === "adjust" || review.decision === "continue" && review.recoveryAction?.kind === "continue_independent")
    && typeof review.recoveryAction?.reason === "string" && !!review.recoveryAction.reason.trim()
    && ["continue_independent", "repair", "retry", "replan", "request_input"].includes(review.recoveryAction.kind);
  if (!accepted && !followingUp) return undefined;
  const input: ExecutionAttemptReviewInput = { version: 1, operationId: operation.operationId, attemptId: attempt.id,
    intentDigest: operation.intentDigest, outcome: acceptance.status, disposition: accepted ? "accepted" : "task_followup",
    evidenceRefs: [...attempt.outcome.evidenceRefs],
    reviewFingerprint: executionDigest({ version: "step-review@1", intentDigest: operation.intentDigest, review,
      evidenceIds: [...availableEvidence].sort() }) };
  return executionAttemptReviewMatches(operation, attempt, input) ? input : undefined;
}
export interface CompleteExecutionAttempt {
  operationId: string; attemptId: string; eventId: string; outcome: ExecutionOutcome; late?: boolean;
}
export type ExecutionReconciliationProof =
  | { version: 1; kind: "file_transfer"; sourceReadOperationId: string; targetReadOperationId: string }
  | { version: 1; kind: "service"; readOperationId: string };
export interface ExecutionLedgerRepository {
  prepare(record: ExecutionOperationInput): Promise<ExecutionOperationRecord>;
  begin(operationId: string, attemptId: string, executionId: string): Promise<ExecutionAttemptRecord>;
  complete(receipt: CompleteExecutionAttempt): Promise<ExecutionAttemptRecord>;
  cancel(operationId: string, attemptId?: string): Promise<ExecutionOperationRecord>;
  list(taskId?: string): Promise<ExecutionOperationRecord[]>;
  acknowledge(operationId: string, attemptId: string, reviewed: boolean, review?: ExecutionAttemptReviewInput): Promise<ExecutionAttemptRecord>;
  resolve(operationId: string, attemptId: string, proof: ExecutionReconciliationProof): Promise<ExecutionOperationRecord>;
}
export type ExecutionLedgerStage = "prepare" | "begin" | "execution" | "result_commit" | "stale_result" | "list" | "cancel";
export class ExecutionLedgerError extends Error {
  readonly code: string;
  constructor(message: string, readonly stage: ExecutionLedgerStage, readonly remoteResultKnown: boolean,
    readonly operationId?: string, readonly attemptId?: string, readonly result?: unknown, readonly originalError?: unknown) {
    super(message); this.name = "ExecutionLedgerError";
    this.code = String(originalError ?? "").match(/EXECUTION_LEDGER_[A-Z_]+/)?.[0]
      ?? `EXECUTION_LEDGER_${stage.toUpperCase()}`;
  }
}
type EvidenceWriter = (taskId: string, record: Record<string, unknown>) => Promise<string>;
interface PendingReceipt {
  taskId: string; executionId: string; receipt: CompleteExecutionAttempt;
  evidence: Record<string, unknown>; evidenceWriter: EvidenceWriter; remoteResultKnown: boolean;
}
interface LedgerScope { repository: ExecutionLedgerRepository; evidenceWriter: EvidenceWriter; pending: Map<string, PendingReceipt> }
let scopes = new WeakMap<object, LedgerScope>();
const activeExecutions = new Set<string>();
let sequence = 0;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const newId = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++sequence}`}`;
// One identity belongs to this entire Webview lifetime, shared by Agent and direct owners.
// Re-registering per repository would incorrectly abandon still-running work on the same page.
let frontendSessionId = newId("frontend");
let frontendSessionRegistration: Promise<void> | undefined;

function ensureNativeFrontendSession(): Promise<void> {
  if (!frontendSessionRegistration) {
    const sessionId = frontendSessionId;
    const pending = Promise.resolve().then(() => invoke<void>("register_execution_ledger_session", { frontendSessionId: sessionId }));
    frontendSessionRegistration = pending;
    // Retry the same identity after a failed/lost registration response; Rust treats it idempotently.
    void pending.catch(() => { if (frontendSessionRegistration === pending) frontendSessionRegistration = undefined; });
  }
  return frontendSessionRegistration;
}

export function createNativeExecutionLedgerRepository(): ExecutionLedgerRepository {
  const call = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      throw new Error("EXECUTION_LEDGER_UNAVAILABLE: 持久执行台账需要桌面存储，尚未发送命令");
    }
    const sessionId = frontendSessionId;
    await ensureNativeFrontendSession();
    return invoke<T>(command, { ...args, frontendSessionId: sessionId });
  };
  return {
    prepare: record => call("prepare_execution_operation", { record }),
    begin: (operationId, attemptId, executionId) => call("begin_execution_attempt", { operationId, attemptId, executionId }),
    complete: receipt => call("complete_execution_attempt", { ...receipt }),
    cancel: (operationId, attemptId) => call("request_execution_cancel", { operationId, attemptId }),
    list: taskId => call("list_execution_operations", { taskId }),
    acknowledge: (operationId, attemptId, reviewed, review) => call("acknowledge_execution_attempt", { operationId, attemptId, reviewed, review }),
    resolve: (operationId, attemptId, proof) => call("resolve_execution_operation", { operationId, attemptId, proof }),
  };
}

/** Test-only adapter. It deliberately makes no crash durability claim. */
export function createMemoryExecutionLedgerRepository(): ExecutionLedgerRepository {
  const records = new Map<string, ExecutionOperationRecord>();
  const events = new Map<string, { receipt: string; attempt: ExecutionAttemptRecord }>();
  const fail = (code: string): never => { throw new Error(`EXECUTION_LEDGER_${code}`); };
  return {
    async prepare(input) {
      if (input.intent.version !== "execution-intent@1" || input.intent.algorithm !== "sha256"
        || input.intentDigest !== executionDigest({ version: "execution-intent@1", semantic: input.intent.semantic })
        || input.intent.digest !== input.intentDigest || input.intent.semantic.taskId !== input.taskId
        || input.intent.semantic.stepId !== input.stepId || input.intent.semantic.effect !== input.effect) fail("INTENT_INVALID");
      if (credentialField(input.intent)) fail("SECRET_VALUE");
      const old = records.get(input.operationId);
      if (old) {
        const fields: (keyof ExecutionOperationInput)[] = ["version", "operationId", "taskId", "stepId", "roundId", "workflowEpoch",
          "planRevision", "stepRevision", "intentDigest", "intent", "phase", "effect", "resourceKeys"];
        if (canonicalExecutionJson(Object.fromEntries(fields.map(key => [key, old[key]])))
          !== canonicalExecutionJson(Object.fromEntries(fields.map(key => [key, input[key]])))) fail("INTENT_CONFLICT");
        return copy(old);
      }
      const record: ExecutionOperationRecord = { ...copy(input), state: "prepared", attempts: [],
        cancelRequested: false, createdAt: Date.now(), updatedAt: Date.now() };
      records.set(record.operationId, record); return copy(record);
    },
    async begin(operationId, attemptId, executionId) {
      const operation = records.get(operationId) ?? fail("NOT_FOUND");
      if (operation.cancelRequested) fail("CANCEL_REQUESTED");
      if (["dispatching", "unknown"].includes(operation.state)) fail("UNRESOLVED");
      if (operation.effect !== "read" && ["succeeded", "failed"].includes(operation.state)) fail("ALREADY_FINISHED");
      if ([...records.values()].some(row => row.attempts.some(attempt => attempt.id === attemptId || attempt.executionId === executionId))) fail("ATTEMPT_CONFLICT");
      if (operation.effect === "change" && [...records.values()].some(row => row.operationId !== operationId
        && row.effect === "change" && ["dispatching", "unknown"].includes(row.state)
        && row.reconciliation?.status !== "completed"
        && row.resourceKeys.some(key => operation.resourceKeys.includes(key)))) fail("RESOURCE_BUSY");
      const attempt: ExecutionAttemptRecord = { version: 1, id: attemptId, operationId, executionId, status: "dispatching",
        bootId: "test-memory", cancelRequested: false, late: false, startedAt: Date.now() };
      operation.attempts.push(attempt); operation.state = "dispatching"; operation.updatedAt = Date.now();
      return copy(attempt);
    },
    async complete(receipt) {
      const encoded = canonicalExecutionJson(receipt), old = events.get(receipt.eventId);
      if (old) { if (old.receipt !== encoded) fail("EVENT_CONFLICT"); return copy(old.attempt); }
      const operation = records.get(receipt.operationId) ?? fail("NOT_FOUND");
      const attempt = operation.attempts.find(value => value.id === receipt.attemptId) ?? fail("ATTEMPT_NOT_FOUND");
      if (!["dispatching", "unknown"].includes(attempt.status)) fail("RESULT_CONFLICT");
      attempt.outcome = copy(receipt.outcome); attempt.status = receipt.outcome.status;
      attempt.late = !!receipt.late || attempt.cancelRequested || operation.cancelRequested;
      attempt.completedAt = Date.now(); operation.state = receipt.outcome.status; operation.updatedAt = Date.now();
      events.set(receipt.eventId, { receipt: encoded, attempt: copy(attempt) }); return copy(attempt);
    },
    async cancel(operationId, attemptId) {
      const operation = records.get(operationId) ?? fail("NOT_FOUND");
      if (attemptId && !operation.attempts.some(item => item.id === attemptId)) fail("ATTEMPT_NOT_FOUND");
      operation.cancelRequested = true;
      operation.attempts.filter(item => !attemptId || item.id === attemptId).forEach(item => { item.cancelRequested = true; });
      operation.updatedAt = Date.now(); return copy(operation);
    },
    async list(taskId) { return copy([...records.values()].filter(value => !taskId || value.taskId === taskId)); },
    async acknowledge(operationId, attemptId, reviewed, review) {
      const operation = records.get(operationId) ?? fail("NOT_FOUND");
      const attempt = operation.attempts.find(a => a.id === attemptId) ?? fail("ATTEMPT_MISMATCH");
      if (!["succeeded", "failed", "not_dispatched"].includes(attempt.status) || !attempt.outcome || attempt.late
        || reviewed && attempt.status !== "succeeded") fail("ACKNOWLEDGEMENT_INVALID");
      if (review && (attempt.cancelRequested || operation.cancelRequested
        || !executionAttemptReviewMatches(operation, attempt, review))) fail("REVIEW_INVALID");
      const previous = review && attempt.reviews?.find(item => item.reviewFingerprint === review.reviewFingerprint);
      if (previous && canonicalExecutionJson({ ...previous, recordedAt: undefined }) !== canonicalExecutionJson(review)) fail("REVIEW_CONFLICT");
      attempt.projectionAppliedAt ??= Date.now();
      if (reviewed) attempt.reviewCompletedAt ??= Date.now();
      if (review && !previous) (attempt.reviews ??= []).push({ ...copy(review), recordedAt: Date.now() });
      return copy(attempt);
    },
    async resolve(operationId, attemptId, proof) {
      const operation = records.get(operationId) ?? fail("NOT_FOUND");
      const attempt = operation.attempts.find(value => value.id === attemptId) ?? fail("ATTEMPT_NOT_FOUND");
      if (operation.reconciliation?.attemptId === attemptId) return copy(operation);
      if (proof.version !== 1 || attempt.status === "not_dispatched" || attempt.status === "dispatching") fail("RECONCILIATION_INVALID");
      const ids = proof.kind === "service" ? [proof.readOperationId] : [proof.sourceReadOperationId, proof.targetReadOperationId];
      const reads = ids.map(id => records.get(id) ?? fail("RECONCILIATION_INVALID"));
      const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
      const fingerprints: string[] = [];
      for (let index = 0; index < reads.length; index++) {
        const read = reads[index], receipt = read.attempts[read.attempts.length - 1];
        const result = receipt?.outcome?.result as { exitCode?: number; output?: string } | undefined;
        const output = typeof result?.output === "string" ? result.output : fail("RECONCILIATION_INVALID");
        const action = read.intent.semantic.action.type === "shell" ? read.intent.semantic.action : fail("RECONCILIATION_INVALID");
        if (read.taskId !== operation.taskId || read.effect !== "read" || receipt?.status !== "succeeded"
          || receipt.startedAt < attempt.startedAt || !receipt.outcome?.evidenceRefs.length || result?.exitCode !== 0
          || typeof result.output !== "string" || read.intent.semantic.action.type !== "shell") fail("RECONCILIATION_INVALID");
        const originalTarget = operation.intent.semantic.targets.find(value => value.role === (proof.kind === "service" ? "execution" : index === 0 ? "source" : "target")) ?? fail("RECONCILIATION_TARGET_MISMATCH");
        if (!read.intent.semantic.targets.some(value => value.host.toLowerCase() === originalTarget.host.toLowerCase()
          && value.port === originalTarget.port && value.username === originalTarget.username)) fail("RECONCILIATION_TARGET_MISMATCH");
        if (proof.kind === "service") {
          const validator = operation.intent.semantic.validator?.command ?? operation.intent.semantic.validation;
          if (operation.intent.semantic.action.type !== "shell" || operation.intent.semantic.runtimeClass !== "persistent_service" || !validator || action.command !== validator
            || !(/^(?:sudo -n )?systemctl (?:--user )?is-active (?:--quiet )?[A-Za-z0-9_@.:-]+$/.test(validator)
              || (/^curl (?:-[fsSI]+ )+(?:--max-time [1-9][0-9]* )?'?https?:\/\/[A-Za-z0-9._~:/?#\[\]@!%+,=\-]+'?$/.test(validator)
                && /^curl (?:-[fsSI]+ )*-[fsSI]*f[fsSI]* /.test(validator)))) fail("RECONCILIATION_INVALID");
        } else {
          if (operation.intent.semantic.action.type !== "tool" || operation.intent.semantic.action.toolId !== "files.transfer_between_servers"
            || !originalTarget.path?.startsWith("/") || /[\r\n\0]/.test(originalTarget.path)) fail("RECONCILIATION_INVALID");
          const path = quote(originalTarget.path ?? fail("RECONCILIATION_INVALID"));
          const command = `test -f ${path} && LC_ALL=C stat -Lc '%s' -- ${path} && sha256sum -- ${path} && LC_ALL=C stat -Lc '%s' -- ${path}`;
          const lines = output.trim().split(/\r?\n/);
          if (action.command !== command || lines.length !== 3 || !/^\d+$/.test(lines[0])
            || lines[0] !== lines[2] || !/^[a-f0-9]{64} [ *].+$/.test(lines[1])) fail("RECONCILIATION_INVALID");
          fingerprints.push(`${lines[0]}:${lines[1].slice(0, 64)}`);
        }
      }
      if (fingerprints.length && fingerprints[0] !== fingerprints[1]) fail("RECONCILIATION_MISMATCH");
      operation.reconciliation = { version: 1, status: "completed", reason: "current_state_verified", kind: proof.kind,
        attemptId, readOperationId: ids[0], readOperationIds: ids,
        evidenceRefs: reads.flatMap(read => read.attempts[read.attempts.length - 1].outcome!.evidenceRefs), resolvedAt: Date.now() };
      return copy(operation);
    },
  };
}

function scope(owner: object): LedgerScope {
  let current = scopes.get(owner);
  if (!current) {
    const testing = import.meta.env.MODE === "test";
    current = { repository: testing ? createMemoryExecutionLedgerRepository() : createNativeExecutionLedgerRepository(),
      evidenceWriter: testing ? async (_taskId, record) => executionDigest(record).slice(7) : (taskId, record) => backend.saveTaskEvidence(taskId, record),
      pending: new Map() };
    scopes.set(owner, current);
  }
  return current;
}
/** Dependency injection is explicit; application callers use the native default. */
export function configureExecutionLedger(owner: object, repository: ExecutionLedgerRepository, evidenceWriter: EvidenceWriter) {
  if (scopes.get(owner)?.pending.size) throw new Error("Cannot replace an execution ledger with uncommitted receipts");
  scopes.set(owner, { repository, evidenceWriter, pending: new Map() });
}
export function resetExecutionLedgerForTests() {
  if (import.meta.env.MODE !== "test") throw new Error("Execution ledger reset is only available in tests");
  scopes = new WeakMap(); sequence = 0;
  activeExecutions.clear();
  frontendSessionId = newId("frontend"); frontendSessionRegistration = undefined;
}
/** Only the exact physical execution ID can reuse admission at a nested backend boundary. */
export function isRecordedExecution(executionId: string): boolean { return activeExecutions.has(executionId); }

// Field semantics, not coincidence with a saved password, determine whether
// credentials entered a durable snapshot. Keep this list aligned with Rust.
const CREDENTIAL_FIELDS = new Set(["password", "passwd", "passphrase", "apikey", "accesstoken", "refreshtoken",
  "authorization", "privatekey", "clientsecret", "secret"]);
const isCredentialField = (key: string) => CREDENTIAL_FIELDS.has(key.toLowerCase().replace(/[_-]/g, ""));
function credentialField(value: unknown, path = ""): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value)) {
    const location = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    if (!Array.isArray(value) && isCredentialField(key)
      && item !== null && item !== undefined && item !== "" && item !== "[REDACTED]") return location;
    const nested = credentialField(item, location);
    if (nested) return nested;
  }
  return undefined;
}

/** Redact strings before serializing so quotes/newlines in a secret cannot defeat replacement. */
export function redactExecutionValue(value: unknown, redact: (text: string) => string = value => value, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redact(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (typeof value === "function" || typeof value === "symbol") return "[Unsupported value]";
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular reference]";
    seen.add(value);
    if (value instanceof Error) return { name: value.name, message: redact(value.message) };
    if (Array.isArray(value)) return value.map(item => redactExecutionValue(item, redact, seen));
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key,
      isCredentialField(key)
        ? "[REDACTED]" : redactExecutionValue(item, redact, seen)]));
  }
  return value ?? null;
}
function boundedResult(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text.length <= 8_192 ? value : { summary: text.slice(0, 8_192), truncated: true, archived: true };
}
export function executionResourceKeys(intent: ExecutionIntentSnapshot): string[] {
  return [...new Set(intent.semantic.targets.filter(target => target.host && target.role !== "interaction")
    .map(target => `endpoint:${target.host.toLowerCase()}:${target.port}`))].sort();
}
export interface RecordedExecutionOptions<T> {
  owner: object;
  task: { id: string; currentRoundId?: string; workflowEpoch?: number; planRevision?: number };
  step: { id: string; executionIntent?: ExecutionIntentSnapshot; stepRevision?: number };
  intent?: ExecutionIntentSnapshot; phase: string; subkey?: string; executionId: string;
  effect?: "read" | "change" | "interaction"; resourceKeys?: string[];
  isCurrent?: () => boolean; execute: () => Promise<T>;
  classifyResult?: (result: T) => ExecutionOutcomeStatus;
  classifyError?: (error: unknown) => "failed" | "unknown" | "not_dispatched";
  /** Output/evidence redaction only. Never rewrites or gates approved intent. */
  redact?: (text: string) => string; evidenceWriter?: EvidenceWriter;
  onAttempt?: (operation: ExecutionOperationRecord, attempt: ExecutionAttemptRecord) => void;
  onCommitted?: (operationId: string, attemptId: string, outcome: ExecutionOutcome) => void;
}
async function commitReceipt(current: LedgerScope, pending: PendingReceipt): Promise<ExecutionAttemptRecord> {
  if (!pending.receipt.outcome.evidenceRefs.length) {
    const reference = await pending.evidenceWriter(pending.taskId, pending.evidence);
    if (!reference) throw new Error("EXECUTION_LEDGER_EVIDENCE_MISSING: 证据归档未返回标识");
    pending.receipt.outcome.evidenceRefs = [reference];
  }
  const result = await current.repository.complete(pending.receipt);
  if (result.id !== pending.receipt.attemptId || result.operationId !== pending.receipt.operationId
    || result.executionId !== pending.executionId || result.status !== pending.receipt.outcome.status) {
    throw new Error("EXECUTION_LEDGER_RESULT_MISMATCH: 台账回执身份或结果不匹配");
  }
  current.pending.delete(pending.receipt.attemptId); return result;
}

/** The only dispatch boundary: durable admission precedes I/O; receipt commit precedes projection. */
export async function runRecordedExecution<T>(inputOptions: RecordedExecutionOptions<T>): Promise<T> {
  // Vue task/step references can advance to a new round while the remote request is in flight.
  // Capture provenance once so a late result always belongs to its original operation.
  const options: RecordedExecutionOptions<T> = { ...inputOptions, task: { ...inputOptions.task },
    step: { ...inputOptions.step, executionIntent: inputOptions.step.executionIntent ? copy(inputOptions.step.executionIntent) : undefined },
    intent: inputOptions.intent ? copy(inputOptions.intent) : undefined,
    resourceKeys: inputOptions.resourceKeys ? [...inputOptions.resourceKeys] : undefined };
  const current = scope(options.owner), intent = options.intent ?? options.step.executionIntent;
  if (!intent) throw new ExecutionLedgerError("执行缺少已冻结的意图快照，尚未发送命令", "prepare", false);
  if (intent.version !== "execution-intent@1" || intent.algorithm !== "sha256" || !intent.digest
    || intent.semantic.taskId !== options.task.id || intent.semantic.stepId !== options.step.id) {
    throw new ExecutionLedgerError("执行快照版本或任务归属不匹配，尚未发送命令", "prepare", false);
  }
  const phase = options.phase.split(":", 1)[0] as ExecutionOperationInput["phase"];
  if (!["command", "validation", "tool", "framework"].includes(phase)) throw new ExecutionLedgerError("未知执行阶段", "prepare", false);
  const operationId = `operation-${executionDigest({ taskId: options.task.id, roundId: options.task.currentRoundId ?? "legacy",
    stepId: options.step.id, intentDigest: intent.digest, phase: options.phase, subkey: options.subkey ?? "" }).slice(7)}`;
  const blocked = [...current.pending.values()].find(receipt => receipt.taskId === options.task.id);
  if (blocked) throw new ExecutionLedgerError("已有执行结果尚未落盘，请先重试保存；本次未发送命令", "result_commit",
    blocked.remoteResultKnown, blocked.receipt.operationId, blocked.receipt.attemptId, blocked.receipt.outcome.result);
  const effect = options.effect ?? intent.semantic.effect;
  if (effect !== intent.semantic.effect || intent.digest !== executionDigest({ version: "execution-intent@1", semantic: intent.semantic })) {
    throw new ExecutionLedgerError("执行快照摘要或效果与派发不一致，尚未发送命令", "prepare", false, operationId);
  }
  const resources = options.resourceKeys ?? executionResourceKeys(intent);
  const credential = credentialField(intent);
  if (credential) {
    throw new ExecutionLedgerError(`执行快照字段 ${credential} 不能保存凭据值，请改用凭据引用；尚未发送命令`,
      "prepare", false, operationId, undefined, undefined, new Error("EXECUTION_LEDGER_SECRET_VALUE"));
  }
  const input: ExecutionOperationInput = { version: 1, operationId, taskId: options.task.id, stepId: options.step.id,
    roundId: options.task.currentRoundId, workflowEpoch: options.task.workflowEpoch ?? 0,
    planRevision: options.task.planRevision ?? 0, stepRevision: options.step.stepRevision ?? 0,
    intentDigest: intent.digest, intent: copy(intent),
    phase, effect, resourceKeys: resources.length ? resources : [`task:${options.task.id}`], executionId: options.executionId };
  let prepared: ExecutionOperationRecord;
  try {
    prepared = await current.repository.prepare(input);
    if (prepared.operationId !== operationId || prepared.intentDigest !== intent.digest) throw new Error("EXECUTION_LEDGER_RESULT_MISMATCH");
  } catch (error) { throw new ExecutionLedgerError("执行意图未能持久保存，尚未发送命令", "prepare", false, operationId, undefined, undefined, error); }
  if (options.isCurrent && !options.isCurrent()) {
    await current.repository.cancel(operationId).catch(() => undefined);
    throw new ExecutionLedgerError("任务已取消或轮次已变化，尚未发送命令", "stale_result", false, operationId);
  }
  const attemptId = newId("attempt");
  try {
    const attempt = await current.repository.begin(operationId, attemptId, options.executionId);
    if (attempt.id !== attemptId || attempt.operationId !== operationId || attempt.executionId !== options.executionId
      || attempt.status !== "dispatching") throw new Error("EXECUTION_LEDGER_RESULT_MISMATCH");
    options.onAttempt?.(prepared, attempt);
  } catch (error) { throw new ExecutionLedgerError("执行派发记录未通过持久化检查，尚未发送命令；请检查未决执行记录", "begin", false,
    operationId, attemptId, undefined, error); }
  let value: T | undefined, executionError: unknown, failed = false, dispatched = false;
  let registered = false;
  let status: ExecutionOutcomeStatus;
  if (options.isCurrent && !options.isCurrent()) status = "not_dispatched";
  else {
    try {
      if (activeExecutions.has(options.executionId)) throw new Error("EXECUTION_LEDGER_EXECUTION_CONFLICT");
      activeExecutions.add(options.executionId);
      registered = true;
      dispatched = true; value = await options.execute(); status = options.classifyResult?.(value) ?? "succeeded";
    }
    catch (error) { failed = true; executionError = error; status = options.classifyError?.(error) ?? "unknown"; }
    finally { if (registered) activeExecutions.delete(options.executionId); }
  }
  const safeResult = redactExecutionValue(failed ? { error: executionError } : dispatched ? value : { reason: "cancelled_before_dispatch" }, options.redact);
  const late = !!options.isCurrent && !options.isCurrent();
  const pending: PendingReceipt = { taskId: options.task.id, executionId: options.executionId,
    receipt: { operationId, attemptId, eventId: newId("result"), outcome: { status, result: boundedResult(safeResult), evidenceRefs: [] }, late },
    evidence: { version: 1, operationId, attemptId, executionId: options.executionId, stepId: options.step.id,
      roundId: options.task.currentRoundId, status, late, collectedAt: new Date().toISOString(), text: JSON.stringify(safeResult) },
    evidenceWriter: options.evidenceWriter ?? current.evidenceWriter, remoteResultKnown: dispatched && !failed };
  current.pending.set(attemptId, pending);
  try { await commitReceipt(current, pending); }
  catch (error) { throw new ExecutionLedgerError("远端执行已结束，但结果尚未完整保存。请重试保存，不要重复执行命令", "result_commit",
    pending.remoteResultKnown, operationId, attemptId, pending.receipt.outcome.result, error); }
  if (late || !dispatched) throw new ExecutionLedgerError("执行结果已保存；任务已取消或轮次已变化，不应用到当前任务", "stale_result",
    pending.remoteResultKnown, operationId, attemptId, pending.receipt.outcome.result);
  options.onCommitted?.(operationId, attemptId, copy(pending.receipt.outcome));
  if (failed) {
    if (executionError instanceof ExecutionLedgerError) throw executionError;
    if (status === "failed" || status === "not_dispatched") throw executionError;
    throw new ExecutionLedgerError("命令已派发但无法确定远端结果，执行记录已保存，需核对后恢复", "execution", false,
      operationId, attemptId, pending.receipt.outcome.result, executionError);
  }
  if (status === "unknown") throw new ExecutionLedgerError("执行结果不确定，执行记录已保存，需核对后恢复", "execution", true,
    operationId, attemptId, pending.receipt.outcome.result);
  return value as T;
}

export function pendingExecutionReceipts(owner: object, taskId?: string) {
  return [...scope(owner).pending.values()].filter(value => !taskId || value.taskId === taskId).map(value => ({
    taskId: value.taskId, operationId: value.receipt.operationId, attemptId: value.receipt.attemptId,
    remoteResultKnown: value.remoteResultKnown, outcome: copy(value.receipt.outcome),
  }));
}
export async function flushPendingReceipts(owner: object, taskId?: string): Promise<ExecutionAttemptRecord[]> {
  const current = scope(owner), committed: ExecutionAttemptRecord[] = [];
  for (const pending of [...current.pending.values()].filter(value => !taskId || value.taskId === taskId)) {
    try { committed.push(await commitReceipt(current, pending)); }
    catch (error) { throw new ExecutionLedgerError("执行结果仍未保存，请保留当前窗口并重试保存", "result_commit",
      pending.remoteResultKnown, pending.receipt.operationId, pending.receipt.attemptId, pending.receipt.outcome.result, error); }
  }
  return committed;
}
export async function listExecutionLedger(owner: object, taskId?: string): Promise<ExecutionOperationRecord[]> {
  try { return await scope(owner).repository.list(taskId); }
  catch (error) { throw new ExecutionLedgerError("无法读取持久执行记录，暂不能恢复执行", "list", false, undefined, undefined, undefined, error); }
}
export async function cancelExecutionLedger(owner: object, taskId: string): Promise<ExecutionOperationRecord[]> {
  const current = scope(owner);
  try {
    const records = await current.repository.list(taskId);
    return await Promise.all(records.filter(record => ["prepared", "dispatching", "unknown"].includes(record.state))
      .map(record => current.repository.cancel(record.operationId)));
  } catch (error) { throw new ExecutionLedgerError("取消请求未能写入执行台账，无法确认远端已经停止", "cancel", false, undefined, undefined, undefined, error); }
}
export async function cancelExecutionById(owner: object, executionId: string): Promise<ExecutionOperationRecord[]> {
  const current = scope(owner);
  try {
    const records = await current.repository.list();
    const results: ExecutionOperationRecord[] = [];
    for (const record of records) {
      const attempt = record.attempts.find(value => value.executionId === executionId && ["dispatching", "unknown"].includes(value.status));
      if (attempt) results.push(await current.repository.cancel(record.operationId, attempt.id));
    }
    return results;
  } catch (error) { throw new ExecutionLedgerError("取消请求未能写入执行台账，远端停止结果仍需核对", "cancel", false,
    undefined, undefined, undefined, error); }
}
export async function resolveExecutionOperation(owner: object, operationId: string, attemptId: string, proof: ExecutionReconciliationProof) {
  try { return await scope(owner).repository.resolve(operationId, attemptId, proof); }
  catch (error) { throw new ExecutionLedgerError("只读证据未通过持久台账核对，原执行仍未确认", "result_commit", false,
    operationId, attemptId, undefined, error); }
}

/** Persist UI acknowledgement independently of the bounded task cache. Never unlocks remote effects. */
export async function acknowledgeExecutionAttempt(owner: object, operationId: string, attemptId: string, reviewed: boolean,
  review?: ExecutionAttemptReviewInput) {
  return scope(owner).repository.acknowledge(operationId, attemptId, reviewed, review);
}
