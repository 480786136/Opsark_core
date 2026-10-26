import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { resetExecutionLedgerForTests } from "@/services/executionLedger";
import { normalizeFileManifestRequest, fileManifestDigest, FILE_MANIFEST_LIMITATIONS, type FileManifestResult } from "@/features/tools/fileManifestInspection";
import { createHttpDeliveryBinding, httpDeliveryTarget, normalizeHttpDeliveryRequest, httpDeliveryLimitations, type HttpDeliveryResult } from "@/features/tools/httpDeliveryInspection";
import { buildToolEvidenceFacts } from "@/features/tools/toolEvidence";
import { buildToolStepOutcome } from "@/features/agent/toolStepResult";
import { operationsProgressIdentity } from "@/features/tools/operationsObservation";
import { bindPreparedToolTargets } from "@/features/tools/toolPreparation";
import { parseToolAction } from "@/features/tools/toolExecutor";
import { sha256Utf8 } from "@/features/agent/planPreparation";
import type { PlanStep, ServerProfile } from "@/types";
import type { ToolCall } from "@/features/tools/types";
import { useOpsStore } from "./ops";

const server: ServerProfile = { id: "server", host: "fixture.invalid", port: 22, username: "fixture", name: "test",
  group: "test", status: "offline", environment: [], createdAt: "2026-10-02T00:00:00Z",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
const secret = "private-fixture-password", stamp = "2026-10-12T01:00:00Z";
const identity = { device: "1", inode: "10", sizeBytes: 3, mode: "0644", uid: 99, gid: 99, mtimeNs: "1", ctimeNs: "1" };
const wire = (prefix: string, data: unknown) => ({ success: true, simulated: true, exitCode: 0, output: "",
  stdout: `${prefix} ${JSON.stringify(data)}\n`, stdoutTruncated: false });

beforeEach(async () => {
  vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia());
  useOpsStore().servers = [structuredClone(server)];
  vi.spyOn(backend, "checkSshConnection").mockResolvedValue();
  vi.spyOn(backend, "saveCredential").mockResolvedValue(); vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
  await useConnectionStore().connect(server.id, { host: server.host, port: server.port, username: server.username, password: secret });
});
afterEach(async () => {
  const store = useOpsStore(); store.stopConnectionMonitor(); await store.persist(true); store.$dispose(); vi.restoreAllMocks();
});
function manifest() {
  const request = normalizeFileManifestRequest({ path: "/srv/site", source: "directory" });
  const call = { id: "manifest-call", toolId: "files.inspect_manifest", arguments: { ...request } };
  const entries: FileManifestResult["entries"] = [{ path: "index.html", kind: "regular", status: "complete", reason: "",
    sizeBytes: 3, mode: "0644", uid: 99, gid: 99, sha256: sha256Utf8("abc"), identity: { ...identity } }];
  const data: FileManifestResult = { request, status: "complete", coverageComplete: true, truncated: false, safeForDeployment: true,
    rootIdentity: { ...identity, mode: "0755" }, entries, issues: [], issueCount: 0, scannedEntries: 1,
    contentBytes: 3, readBytes: 6, archiveReadBytes: 0, expandedBytes: 0, manifestSha256: fileManifestDigest(entries), archiveSha256: null,
    sampledAt: stamp, finishedAt: stamp, elapsedMs: 0, consistency: "sampled_non_atomic", limitations: [...FILE_MANIFEST_LIMITATIONS] };
  return { call, data };
}
async function http(body = "abc", code = 200) {
  vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
  const request = normalizeHttpDeliveryRequest({ url: "http://site.fixture.invalid/", connectAddress: "127.0.0.1", bodyMode: "utf8" });
  const call = { id: "http-call", toolId: "http.inspect_delivery", arguments: { ...request } };
  const binding = await createHttpDeliveryBinding(call.id, call.arguments);
  const data: HttpDeliveryResult = { request, binding, status: "complete", coverageComplete: true,
    target: { ...httpDeliveryTarget(request, binding), peerAddress: "127.0.0.1", peerPort: 80 },
    response: { status: "complete", reason: "sampled", httpStatus: code, headers: {}, body: { mode: "utf8", readBytes: new TextEncoder().encode(body).length,
      complete: true, eof: true, encoding: "identity", sha256: sha256Utf8(body), text: body } },
    correlation: null, sampledAt: stamp, finishedAt: stamp, elapsedMs: 0, reason: "sampled", limitations: [...httpDeliveryLimitations] };
  return { call, data };
}
function outcome(call: ToolCall, data: unknown) {
  return buildToolStepOutcome({ call, result: { callId: call.id, toolId: call.toolId, success: true, data }, completedAt: stamp, evidenceId: "delivery-receipt" });
}

describe("目录与 HTTP 交付采集接入真实工具派发边界", () => {
  it("清单摘要从完整成员计算，执行成功仍不证明备份或部署已完成", async () => {
    const { call, data } = manifest(), store = useOpsStore();
    const execute = vi.spyOn(backend, "executeCommand").mockResolvedValue(wire("OPSARK_FILE_MANIFEST", data));
    const dispatch = vi.fn(), progress = vi.fn();
    const result = await store.executeToolCall(server.id, call, progress, undefined, undefined, dispatch);
    expect(result.success).toBe(true); expect(execute).toHaveBeenCalledOnce(); expect(dispatch).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][3]).toMatchObject({ executionId: call.id, captureStreams: true,
      privateCommandAudit: { displayCommand: call.toolId, secretValues: expect.arrayContaining([secret]) } });
    expect(progress).not.toHaveBeenCalled();
    expect(buildToolEvidenceFacts(call, result)).toMatchObject({ evidenceKind: "file_manifest", evidenceComplete: true,
      manifestSha256: data.manifestSha256, backupVerified: false, deploymentPerformed: false });
  });
  it.each(["truncated", "missing_stdout", "nonzero", "wrong_path", "forged_digest"])("拒绝不完整或伪造清单：%s", async kind => {
    const { call, data } = manifest(), response = wire("OPSARK_FILE_MANIFEST", data);
    if (kind === "truncated") response.stdoutTruncated = true;
    if (kind === "missing_stdout") Reflect.deleteProperty(response, "stdout");
    if (kind === "nonzero") response.exitCode = 1;
    if (kind === "wrong_path") response.stdout = wire("OPSARK_FILE_MANIFEST", { ...data, request: { ...data.request, path: "/other" } }).stdout;
    if (kind === "forged_digest") response.stdout = wire("OPSARK_FILE_MANIFEST", { ...data, manifestSha256: "0".repeat(64) }).stdout;
    vi.spyOn(backend, "executeCommand").mockResolvedValue(response);
    const result = await useOpsStore().executeToolCall(server.id, call);
    expect(result).toMatchObject({ success: false, error: { category: "output", dispatchState: "sent" } });
    expect(result.data).toBeUndefined();
  });
  it("敏感成员剔除后清空完整摘要并保留覆盖缺口", async () => {
    const { call, data } = manifest(); data.entries[0].path = secret; data.manifestSha256 = fileManifestDigest(data.entries);
    vi.spyOn(backend, "executeCommand").mockResolvedValue(wire("OPSARK_FILE_MANIFEST", data));
    const result = await useOpsStore().executeToolCall(server.id, call);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ observationsRedacted: true, coverageComplete: false, manifestSha256: null, entries: [] });
    expect(JSON.stringify(result)).not.toContain(secret); expect(buildToolEvidenceFacts(call, result).evidenceComplete).toBe(false);
  });
  it("冻结目录和后端日志路径到当前服务器及连接代次", () => {
    const { call } = manifest();
    const context = { server, servers: [server], connectionGeneration: 7 };
    const bound = bindPreparedToolTargets({ type: "tool", toolId: call.toolId, arguments: call.arguments }, context);
    expect(bound.targets).toContainEqual(expect.objectContaining({ path: "/srv/site", serverId: server.id, connectionGeneration: 7 }));
    const httpBound = bindPreparedToolTargets({ type: "tool", toolId: "http.inspect_delivery",
      arguments: { url: "http://site.fixture.invalid/", backendObservation: { path: "/var/log/backend.jsonl" } } }, context);
    expect(httpBound.targets).toContainEqual(expect.objectContaining({ path: "/var/log/backend.jsonl", serverId: server.id, connectionGeneration: 7 }));
  });
  it("HTTP 200和完整正文仅证明这次访问，未认证日志来源不能算代理交付", async () => {
    const { call, data } = await http();
    const execute = vi.spyOn(backend, "executeCommand").mockResolvedValue(wire("OPSARK_HTTP_DELIVERY", data));
    const result = await useOpsStore().executeToolCall(server.id, call);
    expect(result.success).toBe(true); expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][3]).toMatchObject({ executionId: call.id, privateCommandAudit: { displayCommand: call.toolId } });
    expect(buildToolEvidenceFacts(call, result)).toMatchObject({ evidenceKind: "http_delivery", evidenceComplete: true,
      httpStatus: 200, resourceSha256: sha256Utf8("abc"), backendSourceVerified: false, backendWindowStatus: "not_requested" });
  });
  it.each(["old_execution", "wrong_probe", "wrong_target", "invalid_digest", "truncated"])("HTTP 私有绑定不能被旧回执替换：%s", async kind => {
    const { call, data } = await http();
    if (kind === "old_execution") data.binding.executionId = "old-call";
    if (kind === "wrong_probe") data.binding.probeId = "opsark-22222222-2222-4222-8222-222222222222";
    if (kind === "wrong_target") data.target.authority = "other.fixture.invalid";
    if (kind === "invalid_digest") data.binding.requestDigest = "0".repeat(64);
    const response = wire("OPSARK_HTTP_DELIVERY", data); if (kind === "truncated") response.stdoutTruncated = true;
    vi.spyOn(backend, "executeCommand").mockResolvedValue(response);
    const result = await useOpsStore().executeToolCall(server.id, call);
    expect(result).toMatchObject({ success: false, error: { category: "output", dispatchState: "sent" } });
    expect(result.data).toBeUndefined();
  });
  it("正文含已知凭据时在公开证据前脱敏，原摘要不再可作为完整验收", async () => {
    const { call, data } = await http(secret);
    vi.spyOn(backend, "executeCommand").mockResolvedValue(wire("OPSARK_HTTP_DELIVERY", data));
    const result = await useOpsStore().executeToolCall(server.id, call);
    expect(result.success).toBe(true); expect(result.data).toMatchObject({ observationsRedacted: true });
    expect(JSON.stringify(result)).not.toContain(secret); expect(JSON.stringify(useOpsStore().logs)).not.toContain(secret);
    expect(buildToolEvidenceFacts(call, result).evidenceComplete).toBe(false);
    expect(outcome(call, result.data).result.observationStatus).toBe("warning");
  });
  it("已撤销的准备身份阻止GET，模型不能指定探测ID或自有TLS开关", async () => {
    const { call } = await http(), execute = vi.spyOn(backend, "executeCommand");
    const result = await useOpsStore().executeToolCall(server.id, call, undefined, undefined, undefined, undefined,
      { assertPrepared: () => { throw new Error("stale prepared identity"); } });
    expect(result.success).toBe(false); expect(execute).not.toHaveBeenCalled();
    for (const extra of [{ probeId: "mine" }, { insecure: true }, { connectAddress: "other.fixture.invalid" }]) {
      expect(() => parseToolAction({ type: "tool", toolId: call.toolId, arguments: { ...call.arguments, ...extra } }, "invalid")).toThrow();
    }
  });
  it("只改变探测ID和采样时间不算新的交付进展，正文变更才产生新观察", async () => {
    const { call, data } = await http();
    const step = (value: HttpDeliveryResult): PlanStep => ({ id: "progress", title: "访问证据", description: "独立访问", command: "", validation: "", expected: "取得响应",
      risk: "low", kind: "observe", status: "completed", action: { type: "tool", toolId: call.toolId, arguments: call.arguments },
      output: JSON.stringify(value), result: outcome(call, value).result });
    const first = operationsProgressIdentity(step(data)); expect(first).toBeTruthy();
    const same = structuredClone(data); same.binding.probeId = "opsark-22222222-2222-4222-8222-222222222222";
    same.sampledAt = "2026-10-12T02:00:00Z"; same.finishedAt = same.sampledAt;
    expect(operationsProgressIdentity(step(same))).toBe(first);
    same.response!.body.text = "new"; same.response!.body.sha256 = sha256Utf8("new");
    expect(operationsProgressIdentity(step(same))).not.toBe(first);
  });
});
