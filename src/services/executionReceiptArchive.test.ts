import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionIntentSemantic, ExecutionIntentSnapshot } from "@/types";
import { executionDigest, sha256Utf8 } from "@/features/agent/planPreparation";
import { enforceToolResult } from "@/features/tools/toolResultContract";
import { fileManifestDigest, normalizeFileManifestRequest, FILE_MANIFEST_LIMITATIONS,
  type FileManifestEntry, type FileManifestResult } from "@/features/tools/fileManifestInspection";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, resetExecutionLedgerForTests, runRecordedExecution } from "./executionLedger";
import { EXECUTION_RECEIPT_MAX_BYTES, EXECUTION_RECEIPT_PAGE_CHARACTERS, restoreArchivedExecutionResult } from "./executionReceiptArchive";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const contentResult = (content = "甲😀".repeat(15_000)) => ({ callId: "execution-1", toolId: "files.read_content", success: true,
  data: { path: "/fixture/nginx.conf", content, encoding: "utf-8", totalBytes: new TextEncoder().encode(content).length,
    returnedBytes: new TextEncoder().encode(content).length, truncated: false } });

async function fixture(result: unknown = contentResult(), toolId = "files.read_content", args: Record<string, unknown> = { path: "/fixture/nginx.conf", maxBytes: 262144 }) {
  const owner = {}, repository = createMemoryExecutionLedgerRepository();
  const records = new Map<string, { taskId: string; serialized: string }>();
  const writer = vi.fn(async (taskId: string, record: Record<string, unknown>) => {
    const serialized = JSON.stringify(record), id = sha256Utf8(serialized);
    records.set(id, { taskId, serialized }); return id;
  });
  configureExecutionLedger(owner, repository, writer);
  const semantic: ExecutionIntentSemantic = { taskId: "task", stepId: "step", action: { type: "tool", toolId, arguments: args },
    targets: [{ role: "execution", serverId: "server", host: "fixture.invalid", port: 22, username: "fixture" }],
    kind: "observe", effect: "read", risk: "low", expected: "读取真实文件证据", dependencies: { precedingStepIds: [] }, permission: "safe", policyVersion: "j1" };
  const intent: ExecutionIntentSnapshot = { version: "execution-intent@1", algorithm: "sha256", semantic,
    digest: executionDigest({ version: "execution-intent@1", semantic }) };
  const execute = vi.fn(async () => result);
  const options = { owner, task: { id: "task", currentRoundId: "round", workflowEpoch: 1, planRevision: 2 },
    step: { id: "step", executionIntent: intent, stepRevision: 1 }, phase: "tool", executionId: "execution-1", execute };
  await runRecordedExecution(options);
  const operation = (await repository.list("task"))[0]!;
  // Only the native-shaped fixture caches parsing/hash work for an identical
  // immutable serialized value. A changed value under the same id is rehashed
  // and rejected; production evidence_store still verifies every native read.
  const pages = new Map<string, { serialized: string; characters: string[]; metadata: Record<string, unknown> }>();
  const reader = vi.fn(async (taskId: string, evidenceId: string, offset: number, limit: number): Promise<Record<string, unknown>> => {
    const captured = records.get(evidenceId);
    if (!captured || captured.taskId !== taskId) throw new Error("missing or integrity mismatch");
    let decoded = pages.get(evidenceId);
    if (!decoded || decoded.serialized !== captured.serialized) {
      if (sha256Utf8(captured.serialized) !== evidenceId) throw new Error("missing or integrity mismatch");
      const record = JSON.parse(captured.serialized) as Record<string, unknown>, metadata = { ...record };
      delete metadata.text;
      decoded = { serialized: captured.serialized, characters: Array.from(record.text as string), metadata };
      pages.set(evidenceId, decoded);
    }
    const characters = decoded.characters, metadata = clone(decoded.metadata);
    const next = Math.min(offset + limit, characters.length);
    return { evidenceId, historical: true, metadata, text: characters.slice(offset, next).join(""), offset,
      totalCharacters: characters.length, nextOffset: next < characters.length ? next : null };
  });
  return { owner, repository, writer, records, operation, attemptId: operation.attempts[0]!.id, reader, execute, options, result };
}
beforeEach(resetExecutionLedgerForTests);

describe("S03 原执行归档受控恢复", () => {
  it("真实runRecordedExecution归档，中文非BMP跨页及8192边界切开代理对时退1位仍逐字恢复", async () => {
    const empty = contentResult("");
    const prefix = JSON.stringify(empty).indexOf('"content":"') + '"content":"'.length;
    const original = contentResult("x".repeat(8191 - prefix) + "😀" + "文😀".repeat(15000));
    const f = await fixture(original), before = JSON.stringify(f.operation);
    const marker = f.operation.attempts[0]!.outcome!.result as { summary: string; archived: boolean };
    expect(marker.archived).toBe(true);
    expect(marker.summary.length).toBe(8191);
    expect(marker.summary).toBe(JSON.stringify(original).slice(0, 8191));
    expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(marker.summary))).toBe(marker.summary);
    const current = vi.fn(() => true);
    const restored = await restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader, current);
    expect(restored.attempts[0]!.outcome!.result).toEqual(original);
    expect(f.reader.mock.calls.length).toBeGreaterThan(2);
    expect(f.reader.mock.calls.map(call => call[2])).toEqual(f.reader.mock.calls.map((_, index) => index * 12000));
    expect(f.reader.mock.calls.every(call => call[0] === "task" && call[3] === EXECUTION_RECEIPT_PAGE_CHARACTERS)).toBe(true);
    expect(current).toHaveBeenCalledTimes(f.reader.mock.calls.length * 2 + 2);
    expect(JSON.stringify(f.operation)).toBe(before);
    expect(JSON.stringify((await f.repository.list())[0])).toBe(before);
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.writer).toHaveBeenCalledOnce();
    expect(enforceToolResult({ id: "execution-1", toolId: "files.read_content", arguments: f.options.step.executionIntent.semantic.action.type === "tool"
      ? f.options.step.executionIntent.semantic.action.arguments : {} }, restored.attempts[0]!.outcome!.result).success).toBe(true);
  });

  it("旧合法8192摘要兼容，但任意8191短摘要不能冒充边界回退", async () => {
    const f = await fixture(contentResult("x".repeat(20000)));
    const marker = f.operation.attempts[0]!.outcome!.result as { summary: string };
    expect(marker.summary.length).toBe(8192);
    expect((await restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader)).attempts[0]!.outcome!.result).toEqual(f.result);
    marker.summary = marker.summary.slice(0, 8191);
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader)).rejects.toMatchObject({ code: "SUMMARY_MISMATCH" });
  });

  it("拒绝旧内存夹具可表示但原生不可接受的孤立高代理摘要", async () => {
    const empty = contentResult("");
    const prefix = JSON.stringify(empty).indexOf('"content":"') + '"content":"'.length;
    const f = await fixture(contentResult("x".repeat(8191 - prefix) + "😀" + "尾".repeat(20000)));
    (f.operation.attempts[0]!.outcome!.result as { summary: string }).summary = JSON.stringify(f.result).slice(0, 8192);
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader)).rejects.toMatchObject({ code: "SUMMARY_MISMATCH" });
  });

  it("原生产者省略roundId时与原生Option省略语义兼容", async () => {
    const f = await fixture();
    await runRecordedExecution({ ...f.options, task: { id: "task" }, executionId: "legacy-execution", execute: async () => ({ ...contentResult(), callId: "legacy-execution" }) });
    const operation = (await f.repository.list()).find(row => row.roundId === undefined)!;
    expect(operation).not.toHaveProperty("roundId");
    const restored = await restoreArchivedExecutionResult(operation, operation.attempts[0]!.id, f.reader);
    expect(restored.attempts[0]!.outcome!.result).toHaveProperty("callId", "legacy-execution");
  });

  it("真实迟到归档可读取但late标记保留，不复活为当前验收", async () => {
    const f = await fixture(); let live = true;
    await expect(runRecordedExecution({ ...f.options, executionId: "late-execution", isCurrent: () => live,
      execute: async () => { live = false; return { ...contentResult(), callId: "late-execution" }; } })).rejects.toMatchObject({ stage: "stale_result" });
    const operation = (await f.repository.list())[0]!;
    const attempt = operation.attempts.find(row => row.executionId === "late-execution")!;
    expect(attempt.late).toBe(true);
    const restored = await restoreArchivedExecutionResult(operation, attempt.id, f.reader);
    expect(restored.attempts.find(row => row.id === attempt.id)).toMatchObject({ late: true, outcome: { result: { callId: "late-execution" } } });
  });

  it("原生在取消或旧boot提交时升级late但旧metadata仍false则拒绝用于验收", async () => {
    const f = await fixture(); f.operation.attempts[0]!.late = true;
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader)).rejects.toMatchObject({ code: "METADATA_MISMATCH" });
  });

  it("320成员真实manifest经过归档分页后保留完整成员且通过原结果契约", async () => {
    const request = normalizeFileManifestRequest({ path: "/fixture/conf.d", source: "directory" });
    const identity = (inode: string) => ({ device: "1", inode, sizeBytes: 3, mode: "0644", uid: 1, gid: 1, mtimeNs: "100", ctimeNs: "100" });
    const entries: FileManifestEntry[] = Array.from({ length: 320 }, (_, index) => ({ path: `配置😀-${index}.conf`, kind: "regular", status: "complete", reason: "",
      sizeBytes: 3, mode: "0644", uid: 1, gid: 1, sha256: sha256Utf8("文"), identity: identity(String(index + 1)) }));
    const data: FileManifestResult = { request, status: "complete", coverageComplete: true, truncated: false, safeForDeployment: true,
      rootIdentity: { ...identity("999"), sizeBytes: 4096, mode: "0755" }, entries, issues: [], issueCount: 0, scannedEntries: 320,
      contentBytes: 960, readBytes: 1920, archiveReadBytes: 0, expandedBytes: 0, manifestSha256: fileManifestDigest(entries), archiveSha256: null,
      sampledAt: "2026-10-12T00:00:00Z", finishedAt: "2026-10-12T00:00:01Z", elapsedMs: 1000, consistency: "sampled_non_atomic", limitations: [...FILE_MANIFEST_LIMITATIONS] };
    const result = { callId: "execution-1", toolId: "files.inspect_manifest", success: true, data };
    const f = await fixture(result, result.toolId, { ...request });
    expect(f.operation.attempts[0]!.outcome!.result).toHaveProperty("archived", true);
    const restored = await restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader);
    expect(restored.attempts[0]!.outcome!.result).toEqual(result);
    expect(f.reader.mock.calls.length).toBeGreaterThan(5);
    expect(enforceToolResult({ id: "execution-1", toolId: result.toolId, arguments: { ...request } }, restored.attempts[0]!.outcome!.result).success).toBe(true);
  });

  it("仅恢复选中的attempt，本地副本与持久记录及另一attempt隔离", async () => {
    const f = await fixture();
    await runRecordedExecution({ ...f.options, executionId: "execution-2", execute: async () => ({ ...contentResult(), callId: "execution-2" }) });
    const operation = (await f.repository.list())[0]!, before = clone(operation);
    const restored = await restoreArchivedExecutionResult(operation, operation.attempts[1]!.id, f.reader);
    expect(restored.attempts[0]).toEqual(before.attempts[0]);
    expect(restored.attempts[1]!.outcome!.result).toHaveProperty("callId", "execution-2");
    expect(operation).toEqual(before); expect((await f.repository.list())[0]).toEqual(before);
  });

  it("内联结果直接深拷贝而不读取证据", async () => {
    const f = await fixture(contentResult("small"));
    const restored = await restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader);
    expect(restored).toEqual(f.operation); expect(restored).not.toBe(f.operation);
    (restored.attempts[0]!.outcome!.result as ReturnType<typeof contentResult>).data.content = "changed";
    expect(f.operation.attempts[0]!.outcome!.result).toEqual(f.result); expect(f.reader).not.toHaveBeenCalled();
  });

  it.each(["missing", "duplicate", "wrong_operation", "status_mismatch"])("无效attempt身份直接拒绝：%s", async kind => {
    const f = await fixture();
    if (kind === "missing") f.operation.attempts = [];
    if (kind === "duplicate") f.operation.attempts.push(clone(f.operation.attempts[0]!));
    if (kind === "wrong_operation") f.operation.attempts[0]!.operationId = "other-operation";
    if (kind === "status_mismatch") f.operation.attempts[0]!.status = "failed";
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader)).rejects.toMatchObject({ code: "INVALID_ATTEMPT" });
    expect(f.reader).not.toHaveBeenCalled();
  });

  it.each(["short_summary", "missing_flag", "extra_field", "bad_reference"])("不完整存档标记不能被当作内联结果：%s", async kind => {
    const f = await fixture(), marker = f.operation.attempts[0]!.outcome!.result as Record<string, unknown>;
    if (kind === "short_summary") marker.summary = "short";
    if (kind === "missing_flag") delete marker.archived;
    if (kind === "extra_field") marker.full = "guessed";
    if (kind === "bad_reference") f.operation.attempts[0]!.outcome!.evidenceRefs = ["../other-task"];
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader)).rejects.toMatchObject({ code: "INVALID_ARCHIVE" });
    expect(f.reader).not.toHaveBeenCalled();
  });

  it("taskId仍约束证据读取命名空间，不能用原ref跨任务读取", async () => {
    const f = await fixture(); f.operation.taskId = "other-task";
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader)).rejects.toMatchObject({ code: "READ_FAILED" });
    expect(f.reader.mock.calls[0]?.[0]).toBe("other-task");
  });

  it.each(["operationId", "attemptId", "executionId", "stepId", "roundId", "status", "late", "version", "collectedAt"])("拒绝错归属metadata.%s", async key => {
    const f = await fixture(), reader = async (...args: Parameters<typeof f.reader>) => {
      const page = await f.reader(...args); (page.metadata as Record<string, unknown>)[key] = key === "late" ? true : "wrong"; return page;
    };
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, reader)).rejects.toMatchObject({ code: "METADATA_MISMATCH" });
  });

  it("页间metadata变化也拒绝，不能仅比对主要ID", async () => {
    const f = await fixture(), reader = async (...args: Parameters<typeof f.reader>) => {
      const page = await f.reader(...args);
      if (args[2] > 0) (page.metadata as Record<string, unknown>).collectedAt = "2026-10-12T00:00:00Z";
      return page;
    };
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, reader)).rejects.toMatchObject({ code: "METADATA_MISMATCH" });
  });

  it.each(["wrong_id", "not_historical", "wrong_offset", "wrong_next", "missing_next", "changed_total", "half_page", "empty_page", "lone_surrogate"])("拒绝无效分页：%s", async kind => {
    const f = await fixture(), reader = async (...args: Parameters<typeof f.reader>) => {
      const page = await f.reader(...args);
      if (kind === "wrong_id") page.evidenceId = "a".repeat(64);
      if (kind === "not_historical") page.historical = false;
      if (kind === "wrong_offset") page.offset = args[2] + 1;
      if (kind === "wrong_next") page.nextOffset = null;
      if (kind === "missing_next") delete page.nextOffset;
      if (kind === "changed_total" && args[2] > 0) page.totalCharacters = Number(page.totalCharacters) + 1;
      if (kind === "half_page") { page.text = Array.from(String(page.text)).slice(0, 6000).join(""); page.nextOffset = args[2] + 6000; }
      if (kind === "empty_page") page.text = "";
      if (kind === "lone_surrogate") page.text = "\ud800" + String(page.text).slice(1);
      return page;
    };
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, reader)).rejects.toMatchObject({ code: "INVALID_PAGE" });
  });

  it.each([{ refs: [] }, { refs: ["a".repeat(64), "b".repeat(64)] }, { refs: ["a".repeat(64), "a".repeat(64)] }])("缺失或多ref不能猜选：$refs", async ({ refs }) => {
    const f = await fixture(); f.operation.attempts[0]!.outcome!.evidenceRefs = refs;
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader)).rejects.toMatchObject({ code: "AMBIGUOUS_REFERENCES" });
    expect(f.reader).not.toHaveBeenCalled();
  });

  it("第二页缺失或native内容地址核验失败时不返回半份对象", async () => {
    const f = await fixture(), reader = async (...args: Parameters<typeof f.reader>) => {
      if (args[2] > 0) throw new Error("native integrity error: secret body must not escape");
      return f.reader(...args);
    };
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, reader)).rejects.toMatchObject({ code: "READ_FAILED" });
    expect(f.operation.attempts[0]!.outcome!.result).toHaveProperty("archived", true);
  });

  it("夹具缓存不能隐藏同内容地址下分页期间的底层文本变化", async () => {
    const f = await fixture(), reader = async (...args: Parameters<typeof f.reader>) => {
      const page = await f.reader(...args);
      if (args[2] === 0) f.records.get(args[1])!.serialized += " ";
      return page;
    };
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, reader)).rejects.toMatchObject({ code: "READ_FAILED" });
    expect(f.reader).toHaveBeenCalledTimes(2);
  });

  it("完整内容与原8192代码单元摘要不同则拒绝", async () => {
    const f = await fixture(); (f.operation.attempts[0]!.outcome!.result as { summary: string }).summary = "!".repeat(8192);
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader)).rejects.toMatchObject({ code: "SUMMARY_MISMATCH" });
  });

  it("分页齐全且摘要相同也不能接受被截断的无效JSON", async () => {
    const f = await fixture(), reference = f.operation.attempts[0]!.outcome!.evidenceRefs[0]!, record = f.records.get(reference)!;
    const value = JSON.parse(record.serialized); value.text = value.text.slice(0, -1);
    const serialized = JSON.stringify(value), id = sha256Utf8(serialized);
    f.records.set(id, { taskId: "task", serialized }); f.operation.attempts[0]!.outcome!.evidenceRefs = [id];
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader)).rejects.toMatchObject({ code: "INVALID_JSON" });
  });

  it.each(["callId", "toolId"])("解析后的工具%s必须属于原执行", async key => {
    const result = { ...contentResult(), [key]: "wrong" }, f = await fixture(result);
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader)).rejects.toMatchObject({ code: "TOOL_IDENTITY_MISMATCH" });
  });

  it("恢复成功不代替冻结请求校验，原enforce仍拒绝跨路径结果", async () => {
    const result = contentResult(); result.data.path = "/other.conf";
    const f = await fixture(result), restored = await restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader);
    expect(enforceToolResult({ id: "execution-1", toolId: "files.read_content", arguments: { path: "/fixture/nginx.conf", maxBytes: 262144 } },
      restored.attempts[0]!.outcome!.result)).toMatchObject({ success: false, error: { code: "TOOL_OUTPUT_INVALID" } });
  });

  it("声明字符数超过2MiB上限立即拒绝", async () => {
    const f = await fixture(), reader = async (...args: Parameters<typeof f.reader>) => ({ ...await f.reader(...args), totalCharacters: EXECUTION_RECEIPT_MAX_BYTES + 1 });
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, reader)).rejects.toMatchObject({ code: "SIZE_LIMIT" });
    expect(f.reader).toHaveBeenCalledOnce();
  });

  it("中文UTF8字节超2MiB即停止，即使字符数未超过也不能全部读取", async () => {
    const f = await fixture(contentResult("文".repeat(Math.ceil(EXECUTION_RECEIPT_MAX_BYTES / 3) + 20000)));
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader)).rejects.toMatchObject({ code: "SIZE_LIMIT" });
    expect(f.reader.mock.calls.length).toBeLessThan(Math.ceil(Array.from(JSON.stringify(f.result)).length / 12000));
  });

  it("取消发生在第一页之前，不读取；页await期间取消，立即停止后续分页", async () => {
    const f = await fixture();
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, f.reader, () => false)).rejects.toMatchObject({ code: "OWNER_CHANGED" });
    expect(f.reader).not.toHaveBeenCalled();
    let live = true;
    const reader = async (...args: Parameters<typeof f.reader>) => { const page = await f.reader(...args); live = false; return page; };
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, reader, async () => live)).rejects.toMatchObject({ code: "OWNER_CHANGED" });
    expect(f.reader).toHaveBeenCalledOnce(); expect(f.operation.attempts[0]!.outcome!.result).toHaveProperty("archived", true);
  });

  it("最终返回前仍核对owner，不能在末页读取后恢复旧任务", async () => {
    const f = await fixture(); let finished = false, afterFinal = 0;
    const reader = async (...args: Parameters<typeof f.reader>) => { const page = await f.reader(...args); finished = page.nextOffset === null; return page; };
    const current = () => { if (finished && ++afterFinal === 2) throw new Error("task removed"); };
    await expect(restoreArchivedExecutionResult(f.operation, f.attemptId, reader, current)).rejects.toMatchObject({ code: "OWNER_CHANGED" });
  });
});
