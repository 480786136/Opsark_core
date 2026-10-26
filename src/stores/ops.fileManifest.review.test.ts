import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, listExecutionLedger, pendingExecutionReceipts, resetExecutionLedgerForTests } from "@/services/executionLedger";
import { executionDigest, sha256Utf8 } from "@/features/agent/planPreparation";
import { normalizeFileManifestRequest, fileManifestDigest, FILE_MANIFEST_LIMITATIONS, type FileManifestResult } from "@/features/tools/fileManifestInspection";
import { operationsProgressIdentity } from "@/features/tools/operationsObservation";
import { archiveToolEvidence } from "@/features/agent/evidenceArchive";
import { decisionOutput } from "@/features/agent/decisionEvidence";
import { useOpsStore } from "./ops";
import type { PlanStep, ServerProfile } from "@/types";

const server: ServerProfile = { id: "manifest-review", host: "manifest-review.invalid", port: 22, username: "fixture", name: "review", group: "test",
  status: "offline", environment: [], createdAt: "2026-10-12T00:00:00Z", info: { os: "fixture", kernel: "fixture", cpu: "fixture", cores: 1, memoryGb: 1, diskGb: 1, uptime: "fixture" } };
const secret = "private-manifest-credential";
const identity = { device: "1", inode: "2", sizeBytes: 3, mode: "0644", uid: 0, gid: 0, mtimeNs: "1", ctimeNs: "1" };
function fixture(count = 1) {
  const store = useOpsStore(), task = store.createTask(server.id, "safe", "fixture");
  const request = normalizeFileManifestRequest({ path: "/srv/site", source: "directory" });
  const call = { id: "manifest-review-call", toolId: "files.inspect_manifest", arguments: { ...request } };
  task.rootGoal = "检查指定目录的真实文件清单"; task.currentRoundId = "review-round"; task.workflowEpoch = 1;
  task.plan = [{ id: "manifest-step", title: "检查目录文件清单", description: "只读采集明确目录", action: { type: "tool", toolId: call.toolId, arguments: call.arguments },
    command: "", validation: "", expected: "获得有界清单及覆盖情况", kind: "observe", risk: "low", status: "pending", executionScope: "isolated_exec" }];
  task.status = "awaiting_plan_approval"; store.pushMessage(task, { role: "user", kind: "message", content: task.rootGoal });
  store.prepareTaskPlan(task); task.status = "running";
  const entries: FileManifestResult["entries"] = Array.from({ length: count }, (_, i) => ({ path: `item-${i}.txt`, kind: "regular", status: "complete", reason: "",
    sizeBytes: 3, mode: "0644", uid: 0, gid: 0, sha256: sha256Utf8("abc"), identity: { ...identity, inode: String(i + 10) } }));
  const data: FileManifestResult = { request, entries, status: "complete", coverageComplete: true, truncated: false, safeForDeployment: true,
    rootIdentity: { ...identity, mode: "0755" }, issues: [], issueCount: 0, scannedEntries: count, contentBytes: count * 3, readBytes: count * 6,
    archiveReadBytes: 0, expandedBytes: 0, manifestSha256: fileManifestDigest(entries), archiveSha256: null,
    sampledAt: "2026-10-12T01:00:00Z", finishedAt: "2026-10-12T01:00:01Z", elapsedMs: 1000, consistency: "sampled_non_atomic", limitations: [...FILE_MANIFEST_LIMITATIONS] };
  const saved: Array<Record<string, unknown>> = [];
  const repository = createMemoryExecutionLedgerRepository();
  configureExecutionLedger(store, repository, async (_id, record) => { saved.push(record); return executionDigest(record).slice(7); });
  vi.spyOn(store, "advanceTask").mockResolvedValue(); vi.spyOn(store, "routeAutomaticAdjustment").mockResolvedValue();
  return { store, task, step: task.plan[0], call, data, saved, repository };
}
const wire = (data: FileManifestResult, truncated = false) => ({ success: true, simulated: true, exitCode: 0, output: "",
  stdout: "OPSARK_FILE_MANIFEST " + JSON.stringify(data), stdoutTruncated: truncated });
beforeEach(async () => {
  vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia());
  useOpsStore().servers = [structuredClone(server)];
  vi.spyOn(backend, "checkSshConnection").mockResolvedValue(); vi.spyOn(backend, "loadCredential").mockResolvedValue(null); vi.spyOn(backend, "saveCredential").mockResolvedValue();
  await useConnectionStore().connect(server.id, { host: server.host, port: server.port, username: server.username, password: secret });
});
afterEach(async () => { const store = useOpsStore(); store.stopConnectionMonitor(); await store.persist(true); store.$dispose(); vi.restoreAllMocks(); });

describe("文件清单真实任务与台账入口只读交叉审查", () => {
  it("大清单在真实runToolStep先完整归档再应用，模型预览保留补读引用", async () => {
    const { store, task, step, call, data, saved } = fixture(300);
    const execute = vi.spyOn(backend, "executeCommand").mockResolvedValue(wire(data));
    await store.runToolStep(task.id, step.id, call);
    expect(execute, JSON.stringify({ status: task.status, pause: task.pauseReason, stepStatus: step.status })).toHaveBeenCalledOnce(); expect(step.status).toBe("completed");
    const rows = await listExecutionLedger(store, task.id);
    expect(rows).toHaveLength(1); expect(rows[0].attempts).toHaveLength(1);
    expect(rows[0].intent.semantic.targets).toContainEqual(expect.objectContaining({ serverId: server.id, path: "/srv/site" }));
    expect(JSON.parse(String(saved[0].text)).data.entries).toHaveLength(300);
    expect(JSON.parse(step.output!).entries).toHaveLength(300); expect(step.result?.facts.evidenceComplete).toBe(true);
    expect(step.evidence?.[0].scope?.targetId).toBe(server.id);
    // The native archive callback is independently exercised with the unchanged full step;
    // this test does not claim it ran an actual Tauri process.
    const save = vi.fn().mockResolvedValue("a".repeat(64));
    await archiveToolEvidence(task, step, save, value => value);
    expect(JSON.parse(save.mock.calls[0][1].text).entries).toHaveLength(300);
    const projected = decisionOutput(step.output, step.evidence, 2048, true)!;
    expect(projected.contentState).toBe("excerpt"); expect(projected.references?.[0].readTool).toBe("evidence.read");
    expect(projected.content!.length).toBeLessThanOrEqual(2048);
  });
  it("采集partial不会因实际派发和台账成功变成完整验收", async () => {
    const { store, task, step, call, data } = fixture();
    Object.assign(data, { status: "partial", coverageComplete: false, truncated: true, safeForDeployment: false, manifestSha256: null,
      issues: [{ path: "", reason: "entry_limit" }], issueCount: 1 });
    vi.spyOn(backend, "executeCommand").mockResolvedValue(wire(data));
    await store.runToolStep(task.id, step.id, call);
    expect(step.result).toMatchObject({ executionStatus: "success", observationStatus: "warning", facts: { evidenceComplete: false, truncated: true } });
    expect((await listExecutionLedger(store, task.id))[0].attempts[0].status).toBe("succeeded");
  });
  it("传输截断不进入成功清单证据", async () => {
    const { store, task, step, call, data } = fixture();
    vi.spyOn(backend, "executeCommand").mockResolvedValue(wire(data, true));
    await store.runToolStep(task.id, step.id, call);
    expect(step.result?.executionStatus).toBe("failed"); expect(step.result?.facts.evidenceComplete).not.toBe(true);
    expect((await listExecutionLedger(store, task.id))[0].attempts[0].status).toBe("failed");
  });
  it("已知秘密在台账和步骤公开投影前剔除，不保留虚假全覆盖", async () => {
    const { store, task, step, call, data, saved } = fixture();
    data.entries[0].path = secret; data.manifestSha256 = fileManifestDigest(data.entries);
    vi.spyOn(backend, "executeCommand").mockResolvedValue(wire(data));
    await store.runToolStep(task.id, step.id, call);
    expect(JSON.stringify(saved)).not.toContain(secret); expect(step.output).not.toContain(secret);
    expect(step.result?.facts.evidenceComplete).toBe(false);
    expect(JSON.parse(step.output!)).toMatchObject({ observationsRedacted: true, entries: [], manifestSha256: null });
  });
  it("完整归档保存失败时不把清单应用为完成，也不自动重新采集", async () => {
    const { store, task, step, call, data, repository } = fixture();
    configureExecutionLedger(store, repository, async () => { throw new Error("controlled archive disk failure"); });
    const execute = vi.spyOn(backend, "executeCommand").mockResolvedValue(wire(data));
    await store.runToolStep(task.id, step.id, call);
    expect(step.status).not.toBe("completed"); expect(step.result?.facts.evidenceComplete).not.toBe(true);
    expect(pendingExecutionReceipts(store)).toHaveLength(1);
    await store.runToolStep(task.id, step.id, call); expect(execute).toHaveBeenCalledOnce();
  });
  it("仅重排相同目录枚举顺序不能伪装新进展", async () => {
    const { store, task, step, call, data } = fixture(2);
    vi.spyOn(backend, "executeCommand").mockResolvedValue(wire(data)); await store.runToolStep(task.id, step.id, call);
    expect(step.result?.executionStatus).toBe("success");
    const changed = structuredClone(data); changed.entries.reverse(); changed.sampledAt = "2026-10-12T02:00:00Z"; changed.finishedAt = changed.sampledAt;
    const replay = { ...step, output: JSON.stringify(changed) } as PlanStep;
    expect(fileManifestDigest(changed.entries)).toBe(data.manifestSha256);
    expect(operationsProgressIdentity(replay)).toBe(operationsProgressIdentity(step));
  });
});
