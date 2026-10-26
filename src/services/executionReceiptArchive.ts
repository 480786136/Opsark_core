import type { ExecutionOperationRecord } from "./executionLedger";
import { canonicalExecutionJson } from "@/features/agent/planPreparation";

export const EXECUTION_RECEIPT_PAGE_CHARACTERS = 12_000;
export const EXECUTION_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;
export type ExecutionReceiptReader = (taskId: string, evidenceId: string, offset: number, limit: number) => Promise<unknown>;
export type ExecutionReceiptCurrentAssertion = () => void | boolean | Promise<void | boolean>;

export class ExecutionReceiptArchiveError extends Error {
  constructor(readonly code: "INVALID_ATTEMPT" | "INVALID_ARCHIVE" | "AMBIGUOUS_REFERENCES" | "INVALID_PAGE"
    | "METADATA_MISMATCH" | "SIZE_LIMIT" | "READ_FAILED" | "OWNER_CHANGED" | "SUMMARY_MISMATCH"
    | "INVALID_JSON" | "TOOL_IDENTITY_MISMATCH") {
    super(`EXECUTION_RECEIPT_ARCHIVE_${code}: 无法完整核对原执行归档，不能用于当前验收`);
    this.name = "ExecutionReceiptArchiveError";
  }
}
const fail = (code: ExecutionReceiptArchiveError["code"]): never => { throw new ExecutionReceiptArchiveError(code); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// Native evidence_store offsets count Rust chars (Unicode scalar values), not
// JS UTF-16 code units. A native page can never contain an unpaired surrogate.
function scalarLength(text: string): number {
  let count = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) fail("INVALID_PAGE");
    count++;
  }
  return count;
}

/** Restore immutable historical text into a local snapshot only. This is not
 * freshness, tool-output, or business-acceptance validation. The caller must
 * recheck its live ledger/owner and enforce the frozen tool arguments/result.
 * reader must be the native task-scoped content-address-verified evidence API;
 * the additional checks below never replace native verification on every read.
 */
export async function restoreArchivedExecutionResult(operation: ExecutionOperationRecord, attemptId: string,
  reader: ExecutionReceiptReader, assertCurrent?: ExecutionReceiptCurrentAssertion): Promise<ExecutionOperationRecord> {
  const current = async () => {
    if (!assertCurrent) return;
    try { if (await assertCurrent() === false) fail("OWNER_CHANGED"); }
    catch { fail("OWNER_CHANGED"); }
  };
  await current();
  let restored: ExecutionOperationRecord;
  try { restored = JSON.parse(JSON.stringify(operation)) as ExecutionOperationRecord; }
  catch { return fail("INVALID_ATTEMPT"); }
  const matches = restored.attempts?.filter(attempt => attempt.id === attemptId);
  if (matches?.length !== 1) return fail("INVALID_ATTEMPT");
  const attempt = matches[0]!;
  if (attempt.operationId !== restored.operationId || !attempt.outcome || attempt.status !== attempt.outcome.status) return fail("INVALID_ATTEMPT");
  const marker = attempt.outcome.result;
  if (!object(marker) || (!own(marker, "archived") && !(own(marker, "summary") && own(marker, "truncated")))) {
    await current();
    return restored;
  }
  if (marker.archived !== true || marker.truncated !== true || typeof marker.summary !== "string" || ![8191, 8192].includes(marker.summary.length)
    || Object.keys(marker).sort().join(",") !== "archived,summary,truncated") return fail("INVALID_ARCHIVE");
  const refs = attempt.outcome.evidenceRefs;
  // Today's writer archives exactly one complete receipt, never multipart text.
  // Selecting one of several references could hide a conflicting receipt.
  if (!Array.isArray(refs) || refs.length !== 1) return fail("AMBIGUOUS_REFERENCES");
  const evidenceId = refs[0]!;
  if (typeof evidenceId !== "string" || !/^[a-f0-9]{64}$/.test(evidenceId)) return fail("INVALID_ARCHIVE");
  const fragments: string[] = [];
  let offset = 0, total: number | undefined, metadataFingerprint: string | undefined, byteCount = 0;
  for (let index = 0; index < Math.ceil(EXECUTION_RECEIPT_MAX_BYTES / EXECUTION_RECEIPT_PAGE_CHARACTERS); index++) {
    await current();
    let page: unknown;
    try { page = await reader(restored.taskId, evidenceId, offset, EXECUTION_RECEIPT_PAGE_CHARACTERS); }
    catch { await current(); return fail("READ_FAILED"); }
    await current();
    if (!object(page) || page.evidenceId !== evidenceId || page.historical !== true || page.offset !== offset
      || !integer(page.totalCharacters) || page.totalCharacters <= offset || typeof page.text !== "string"
      || !object(page.metadata)) return fail("INVALID_PAGE");
    if (page.text.length > EXECUTION_RECEIPT_PAGE_CHARACTERS * 2) return fail("INVALID_PAGE");
    if (page.totalCharacters > EXECUTION_RECEIPT_MAX_BYTES) return fail("SIZE_LIMIT");
    if (total !== undefined && total !== page.totalCharacters) return fail("INVALID_PAGE");
    total = page.totalCharacters;
    const length = scalarLength(page.text), next = offset + length;
    if (length !== Math.min(EXECUTION_RECEIPT_PAGE_CHARACTERS, total - offset)
      || page.nextOffset !== (next < total ? next : null)) return fail("INVALID_PAGE");
    const metadata = page.metadata;
    if (metadata.version !== 1 || metadata.operationId !== restored.operationId || metadata.attemptId !== attempt.id
      || metadata.executionId !== attempt.executionId || metadata.stepId !== restored.stepId || metadata.roundId !== restored.roundId
      || metadata.status !== attempt.status || metadata.late !== attempt.late || own(metadata, "text")
      || typeof metadata.collectedAt !== "string" || !Number.isFinite(Date.parse(metadata.collectedAt))) return fail("METADATA_MISMATCH");
    let fingerprint: string;
    try { fingerprint = canonicalExecutionJson(metadata); } catch { return fail("METADATA_MISMATCH"); }
    if (metadataFingerprint !== undefined && metadataFingerprint !== fingerprint) return fail("METADATA_MISMATCH");
    metadataFingerprint = fingerprint;
    byteCount += new TextEncoder().encode(page.text).length;
    if (byteCount > EXECUTION_RECEIPT_MAX_BYTES) return fail("SIZE_LIMIT");
    fragments.push(page.text);
    offset = next;
    if (page.nextOffset === null) break;
  }
  if (total === undefined || offset !== total) return fail("INVALID_PAGE");
  const text = fragments.join("");
  // Match boundedResult exactly, including its one-code-unit retreat only when
  // the UTF-16 boundary bisects a pair. Never accept an arbitrary short prefix.
  const splitPair = text.charCodeAt(8191) >= 0xd800 && text.charCodeAt(8191) <= 0xdbff
    && text.charCodeAt(8192) >= 0xdc00 && text.charCodeAt(8192) <= 0xdfff;
  if (text.length <= 8192 || text.slice(0, splitPair ? 8191 : 8192) !== marker.summary) return fail("SUMMARY_MISMATCH");
  let result: unknown;
  try { result = JSON.parse(text); } catch { return fail("INVALID_JSON"); }
  if (restored.phase === "tool") {
    const action = restored.intent.semantic.action;
    if (action.type !== "tool" || !object(result) || result.callId !== attempt.executionId || result.toolId !== action.toolId) return fail("TOOL_IDENTITY_MISMATCH");
  }
  await current();
  attempt.outcome.result = result;
  return restored;
}
