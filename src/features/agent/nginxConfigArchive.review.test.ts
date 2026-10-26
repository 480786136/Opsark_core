import { describe, expect, it, vi } from "vitest";
import type { ExecutionIntentSemantic } from "@/types";
import type { ExecutionOperationRecord } from "@/services/executionLedger";
import { executionDigest, sha256Utf8 } from "./planPreparation";
import { loadNginxConfigurationLedger } from "./nginxConfigArchive";
import { normalizeNginxConfigRequest } from "@/features/tools/nginxConfigContracts";

const binding = { taskId: "task", roundId: "round", workflowEpoch: 1, serverId: "server", connectionGeneration: 1 };
const request = (ids: string[]) => ({ entryPath: "/etc/nginx/nginx.conf", prefix: "/etc/nginx",
  target: { address: "127.0.0.1", port: 8080, serverName: "app.invalid", uriPath: "/" }, sourceStepIds: ids });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function sources(count = 1, size = 16000) {
  const archives = new Map<string, { text: string; metadata: Record<string, unknown> }>();
  const records = Array.from({ length: count }, (_, index): ExecutionOperationRecord => {
    const stepId = `step-${index}`, operationId = `operation-${index}`, attemptId = `attempt-${index}`, executionId = `execution-${index}`;
    const semantic: ExecutionIntentSemantic = { taskId: "task", stepId, action: { type: "tool", toolId: "files.read_content", arguments: { path: `/etc/nginx/${index}.conf`, maxBytes: 262144 } },
      targets: [{ role: "execution", serverId: "server", host: "host.invalid", port: 22, username: "fixture", connectionGeneration: 1 }],
      kind: "observe", effect: "read", risk: "low", expected: "读取", dependencies: { precedingStepIds: [] }, permission: "safe", policyVersion: "j1" };
    const digest = executionDigest({ version: "execution-intent@1", semantic });
    const result = { callId: executionId, toolId: "files.read_content", success: true,
      data: { path: `/etc/nginx/${index}.conf`, content: "x".repeat(size), encoding: "utf-8", totalBytes: size, returnedBytes: size, truncated: false } };
    const text = JSON.stringify(result), metadata = { version: 1, operationId, attemptId, executionId, stepId, roundId: "round", status: "succeeded", late: false, collectedAt: "2026-10-12T00:00:00.000Z" };
    const evidenceId = sha256Utf8(JSON.stringify({ ...metadata, text }));
    archives.set(evidenceId, { text, metadata });
    return { version: 1, operationId, taskId: "task", stepId, roundId: "round", workflowEpoch: 1, planRevision: 1, stepRevision: 1,
      intentDigest: digest, intent: { version: "execution-intent@1", algorithm: "sha256", digest, semantic }, phase: "tool", effect: "read", resourceKeys: ["fixture"], executionId,
      state: "succeeded", cancelRequested: false, createdAt: 1, updatedAt: 2, attempts: [{ version: 1, id: attemptId, operationId, executionId,
        status: "succeeded", bootId: "fixture", cancelRequested: false, late: false, startedAt: 1, completedAt: 2, projectionAppliedAt: 3,
        outcome: { status: "succeeded", result: { summary: text.slice(0, 8192), archived: true, truncated: true }, evidenceRefs: [evidenceId] } }] };
  });
  let readBytes = 0;
  const read = vi.fn(async (taskId: string, evidenceId: string, offset: number, limit: number) => {
    expect(taskId).toBe("task"); const archive = archives.get(evidenceId)!;
    const end = Math.min(offset + limit, archive.text.length), text = archive.text.slice(offset, end); // ASCII fixture: scalars = code units.
    readBytes += new TextEncoder().encode(text).length;
    return { evidenceId, historical: true, metadata: clone(archive.metadata), offset, text,
      totalCharacters: archive.text.length, nextOffset: end < archive.text.length ? end : null };
  });
  return { records, read, getReadBytes: () => readBytes };
}

describe("独立交叉审：Nginx归档接线", () => {
  it("最终list是完整集合，保留读取期间新出现的另一任务操作供变更屏障检查", async () => {
    const f = sources(), extra = clone(f.records[0]!); extra.operationId = "other-operation"; extra.taskId = "other-task";
    const list = vi.fn().mockResolvedValueOnce(clone(f.records)).mockResolvedValueOnce([...clone(f.records), extra]);
    const result = await loadNginxConfigurationLedger(request(["step-0"]), binding, { list, read: f.read, assertCurrent: () => {} });
    expect(list).toHaveBeenCalledTimes(2); expect(result).toHaveLength(2); expect(result[1]).toEqual(extra);
    expect(result[0]!.attempts[0]!.outcome!.result).toHaveProperty("callId", "execution-0");
    expect(f.records[0]!.attempts[0]!.outcome!.result).toHaveProperty("archived", true);
  });

  it.each(["removed", "duplicate", "changed_ack"])("最后一次list返回来源%s时拒绝本地恢复副本", async kind => {
    const f = sources(), changed = clone(f.records);
    if (kind === "removed") changed.length = 0;
    if (kind === "duplicate") changed.push(clone(changed[0]!));
    if (kind === "changed_ack") changed[0]!.attempts[0]!.projectionAppliedAt = 4;
    const list = vi.fn().mockResolvedValueOnce(clone(f.records)).mockResolvedValueOnce(changed);
    await expect(loadNginxConfigurationLedger(request(["step-0"]), binding, { list, read: f.read, assertCurrent: () => {} }))
      .rejects.toThrow("CONFIGURATION_SOURCE_CHANGED_DURING_READ");
  });

  it("最终list等待期间owner失效仍拒绝，不仅检查归档页await", async () => {
    const f = sources(); let live = true, reads = 0;
    const list = async () => { if (++reads === 2) live = false; return clone(f.records); };
    await expect(loadNginxConfigurationLedger(request(["step-0"]), binding, { list, read: f.read,
      assertCurrent: () => { if (!live) throw new Error("removed-owner"); } })).rejects.toThrow("removed-owner");
    expect(reads).toBe(2);
  });

  it("已恢复JSON超过12MiB时不进入分析或继续读后续来源，允许一条有界临时超额", async () => {
    // Synthetic bounded receipts isolate the transport ceiling; they are not
    // claimed to be valid Nginx/business evidence or actual remote observations.
    const f = sources(14, 1024 * 1024), list = vi.fn(async () => clone(f.records));
    const analyze = vi.fn(), consume = async () => {
      const records = await loadNginxConfigurationLedger(request(f.records.map(row => row.stepId)), binding, { list, read: f.read, assertCurrent: () => {} });
      analyze(records);
    };
    await expect(consume()).rejects.toThrow("CONFIGURATION_ARCHIVE_SIZE_LIMIT");
    expect(f.getReadBytes()).toBeGreaterThan(12 * 1024 * 1024);
    expect(f.getReadBytes()).toBeLessThan(14 * 1024 * 1024);
    expect(new Set(f.read.mock.calls.map(call => call[1])).size).toBeLessThan(f.records.length);
    expect(analyze).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledOnce();
  });

  it("生产工具入口的规范化契约拒绝65个来源，不能扩展成无限来源恢复", () => {
    expect(() => normalizeNginxConfigRequest(request(Array.from({ length: 65 }, (_, index) => `step-${index}`)))).toThrow();
    expect(normalizeNginxConfigRequest(request(Array.from({ length: 64 }, (_, index) => `step-${index}`))).sourceStepIds).toHaveLength(64);
  });
});
