import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { resetExecutionLedgerForTests } from "@/services/executionLedger";
import { logRotationLimitations, normalizeLogRotationRequest, type LogRotationResult } from "@/features/tools/logRotationInspection";
import { buildToolEvidenceFacts } from "@/features/tools/toolEvidence";
import { bindPreparedToolTargets } from "@/features/tools/toolPreparation";
import { isRemoteToolObservation } from "@/features/agent/toolEvidenceScope";
import type { ServerProfile } from "@/types";
import { useOpsStore } from "./ops";

const server: ServerProfile = { id: "server", host: "fixture.invalid", port: 22, username: "fixture", name: "test",
  group: "test", status: "offline", environment: [], createdAt: "2026-10-02T00:00:00Z",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
const sshPassword = "fixture-ssh-private-value";
beforeEach(async () => {
  vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia());
  useOpsStore().servers = [structuredClone(server)];
  vi.spyOn(backend, "checkSshConnection").mockResolvedValue();
  vi.spyOn(backend, "saveCredential").mockResolvedValue();
  vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
  await useConnectionStore().connect(server.id, { host: server.host, port: server.port, username: server.username, password: sshPassword });
});
afterEach(async () => {
  const store = useOpsStore(); store.stopConnectionMonitor(); await store.persist(true); store.$dispose(); vi.restoreAllMocks();
});
function setup() {
  const store = useOpsStore();
  const request = normalizeLogRotationRequest({ activePaths: ["/var/log/fixture/app.jsonl"], configPaths: ["/etc/logrotate.d/fixture"] });
  const call = { id: "log-call", toolId: "logs.inspect_rotation", arguments: { ...request } };
  const result: LogRotationResult = { request, status: "partial", coverageComplete: false, files: [], configs: [], writers: [], sequence: null,
    sampledAt: "2026-10-12T01:00:00Z", finishedAt: "2026-10-12T01:00:01Z", elapsedMs: 1000, limitations: [...logRotationLimitations] };
  return { store, call, result };
}
const receipt = (data: unknown) => ({ success: true, simulated: true, exitCode: 0, output: "",
  stdout: `OPSARK_LOG_ROTATION ${JSON.stringify(data)}\n`, stdoutTruncated: false });

describe("log rotation inspection store integration", () => {
  it("executes the registered fixed probe once and preserves incomplete business evidence", async () => {
    const { store, call, result } = setup();
    const execute = vi.spyOn(backend, "executeCommand").mockResolvedValue(receipt(result));
    const dispatched = vi.fn(), progress = vi.fn();
    const value = await store.executeToolCall(server.id, call, progress, undefined, undefined, dispatched);
    expect(value.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce(); expect(dispatched).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toContain("OPSARK_LOG_ROTATION");
    expect(execute.mock.calls[0][3]).toMatchObject({ executionId: call.id, captureStreams: true,
      privateCommandAudit: { displayCommand: "logs.inspect_rotation", secretValues: expect.arrayContaining([sshPassword]) } });
    expect(progress).not.toHaveBeenCalled();
    expect(buildToolEvidenceFacts(call, value)).toMatchObject({ evidenceKind: "log_rotation", evidenceComplete: false,
      rotationPerformed: false, scheduleVerified: false, uninterruptedWritingVerified: false });
    expect(isRemoteToolObservation(call.toolId)).toBe(true);
  });
  it.each(["truncated", "missing_stdout", "nonzero", "mismatched_request", "invalid_json"])("rejects %s without returning raw observations", async kind => {
    const { store, call, result } = setup();
    const response = receipt(result);
    if (kind === "truncated") response.stdoutTruncated = true;
    if (kind === "missing_stdout") Reflect.deleteProperty(response, "stdout");
    if (kind === "nonzero") response.exitCode = 1;
    if (kind === "mismatched_request") response.stdout = receipt({ ...result, request: { ...result.request, activePaths: ["/unrelated"] } }).stdout;
    if (kind === "invalid_json") response.stdout = `OPSARK_LOG_ROTATION ${sshPassword}`;
    vi.spyOn(backend, "executeCommand").mockResolvedValue(response);
    const value = await store.executeToolCall(server.id, call);
    expect(value).toMatchObject({ success: false, error: { category: "output", dispatchState: "sent" } });
    expect(value.data).toBeUndefined();
    expect(JSON.stringify(value)).not.toContain(sshPassword);
    expect(JSON.stringify(store.logs)).not.toContain(sshPassword);
  });
  it("redacts returned configuration observations before exposing results", async () => {
    const { store, call, result } = setup();
    result.configs = [{ path: result.request.configPaths[0], status: "partial", reason: "unparsed", blocks: [],
      globalDirectives: [{ name: "mail", value: sshPassword }], includes: [], scripts: [], unparsedCount: 1 }];
    vi.spyOn(backend, "executeCommand").mockResolvedValue(receipt(result));
    const value = await store.executeToolCall(server.id, call);
    expect(value.success).toBe(true);
    expect(value.data).toMatchObject({ observationsRedacted: true });
    expect(JSON.stringify(value)).not.toContain(sshPassword);
    expect(buildToolEvidenceFacts(call, value).evidenceComplete).toBe(false);
  });
  it("checks the prepared owner immediately before dispatch", async () => {
    const { store, call } = setup();
    const execute = vi.spyOn(backend, "executeCommand");
    const value = await store.executeToolCall(server.id, call, undefined, undefined, undefined, undefined,
      { assertPrepared: () => { throw new Error("stale prepared identity"); } });
    expect(value.success).toBe(false); expect(execute).not.toHaveBeenCalled();
  });
  it("binds every declared log, archive and configuration path to the approved source", () => {
    const { call } = setup();
    const action = { type: "tool" as const, toolId: call.toolId, arguments: { ...call.arguments, archivePaths: ["/var/log/fixture/old.gz"] } };
    const bound = bindPreparedToolTargets(action, { server, servers: [server], connectionGeneration: 7 });
    expect(bound.targets.filter(target => target.path).map(target => target.path)).toEqual([
      "/var/log/fixture/app.jsonl", "/var/log/fixture/old.gz", "/etc/logrotate.d/fixture",
    ]);
    expect(bound.targets.every(target => target.serverId === server.id && target.connectionGeneration === 7)).toBe(true);
  });
});
