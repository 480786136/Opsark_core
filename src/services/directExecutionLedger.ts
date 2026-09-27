import type { ExecutionIntentSemantic, ExecutionIntentSnapshot, ExecutionTargetRef, StepAction } from "@/types";
import { executionDigest } from "@/features/agent/planPreparation";
import { cancelExecutionById, isRecordedExecution, runRecordedExecution, type ExecutionOutcomeStatus } from "./executionLedger";

const owner = {};
export const directExecutionLedgerOwner = owner;
export const directExecutionId = () => `direct-${globalThis.crypto.randomUUID()}`;
type ConnectionIdentity = { host: string; port: number; username: string; password: string };
export interface DirectExecutionOptions<T> {
  executionId: string; connections: ConnectionIdentity[]; action: StepAction;
  phase: "command" | "tool"; effect?: "read" | "change";
  targets?: ExecutionTargetRef[]; execute: () => Promise<T>;
  classifyResult?: (value: T) => ExecutionOutcomeStatus;
  additionalSecrets?: string[];
}

/** Direct user actions share durable resource locks with Agent work, keyed by physical request ID. */
export async function runDirectExecution<T>(options: DirectExecutionOptions<T>): Promise<T> {
  if (isRecordedExecution(options.executionId)) return options.execute();
  const targets = options.targets ?? options.connections.map((connection, index): ExecutionTargetRef => ({
    role: index === 0 ? "execution" : "target", host: connection.host, port: connection.port, username: connection.username,
  }));
  const taskId = `direct-${executionDigest(targets.map(target => ({ host: target.host.toLowerCase(), port: target.port, username: target.username }))).slice(7)}`;
  const stepId = `direct-${options.executionId}`, effect = options.effect ?? "change";
  const semantic: ExecutionIntentSemantic = { taskId, stepId, action: options.action, targets, effect,
    kind: effect === "read" ? "observe" : "change", risk: effect === "read" ? "low" : "medium", expected: "记录用户直接操作的实际结果",
    dependencies: { precedingStepIds: [] }, permission: "managed", policyVersion: "direct-user-action@1" };
  const intent: ExecutionIntentSnapshot = { version: "execution-intent@1", algorithm: "sha256",
    digest: executionDigest({ version: "execution-intent@1", semantic }), semantic };
  const secrets = [...options.connections.map(connection => connection.password), ...options.additionalSecrets ?? []].filter(Boolean);
  const redact = (value: string) => secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
  return runRecordedExecution({ owner, task: { id: taskId }, step: { id: stepId, executionIntent: intent },
    phase: options.phase, executionId: options.executionId, execute: options.execute, redact,
    classifyResult: options.classifyResult, classifyError: effect === "read" ? () => "failed" : undefined });
}

export async function fileContentIdentity(data: Uint8Array) {
  // Only length and digest enter the intent; the content itself remains on the I/O path.
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(data).buffer);
    return { bytes: data.length, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
  }
  return { bytes: data.length, canonicalDigest: executionDigest(Array.from(data)) };
}

/** Still attempt the stop if its local receipt fails; report that failure without claiming a stop. */
export async function cancelDirectExecution<T>(executionId: string, execute: () => Promise<T>): Promise<T> {
  let storageError: unknown;
  try { await cancelExecutionById(owner, executionId); } catch (error) { storageError = error; }
  const result = await execute();
  if (storageError) throw storageError;
  return result;
}
