import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { resetExecutionLedgerForTests } from "@/services/executionLedger";
import { normalizeDatabaseInspectionRequest, buildDatabaseAuthenticationCommand, type DatabaseInspectionResult } from "@/features/tools/databaseInspection";
import { DATABASE_INSPECTION_LIMITATIONS } from "@/features/tools/databaseInspectionContracts";
import { authenticationFingerprint, recordAuthentication } from "@/features/agent/authenticationEvidence";
import { buildToolEvidenceFacts } from "@/features/tools/toolEvidence";
import { buildToolStepOutcome } from "@/features/agent/toolStepResult";
import type { ServerProfile, PlanStep, SecretMetadata } from "@/types";
import { useOpsStore } from "./ops";

const server: ServerProfile = { id: "db-server", host: "fixture.invalid", port: 22, username: "fixture", name: "test",
  group: "test", status: "offline", environment: [], createdAt: "2026-10-02T00:00:00Z",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
const protectedUser = "fixture-protected-db-user", protectedPassword = "fixture'private-db-password";
beforeEach(async () => {
  vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  setActivePinia(createPinia()); useOpsStore().servers = [structuredClone(server)];
  vi.spyOn(backend, "checkSshConnection").mockResolvedValue(); vi.spyOn(backend, "saveCredential").mockResolvedValue(); vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
  await useConnectionStore().connect(server.id, { host: server.host, port: server.port, username: server.username, password: "fixture-ssh-password" });
});
afterEach(async () => {
  const store = useOpsStore(); store.stopConnectionMonitor(); await store.persist(true); store.$dispose(); vi.restoreAllMocks();
});
function setup(password = false) {
  const store = useOpsStore(), task = store.createTask(server.id, "managed", "model");
  task.status = "running"; task.currentRoundId = "round"; task.agentSessionId = "session"; task.agentSessionGeneration = 1; task.credentialRevision = 2;
  const request = normalizeDatabaseInspectionRequest({ clientPath: "/usr/bin/psql", transport: "socket", host: "/var/run/postgresql", port: 15432,
    database: "fixture", auth: password ? "password" : "socket_identity", tables: [{ schema: "public", name: "orders" }],
    ...(password ? { usernameSecretKey: "DB_USER", passwordSecretKey: "DB_PASSWORD" } : { username: "reader" }) });
  const call = { id: "db-call", toolId: "database.inspect_postgres", arguments: { ...request } };
  const step: PlanStep = { id: "db-step", title: "核验指定表", description: "只读采集", command: "", validation: "", expected: "真实表证据", risk: "low", kind: "observe", status: "running",
    action: { type: "tool", toolId: call.toolId, arguments: call.arguments } };
  task.plan = [step];
  if (password) {
    store.secretMetadata = ([{ key: "DB_USER", credentialRole: "username" }, { key: "DB_PASSWORD", credentialRole: "secret" }] as const)
      .map(item => ({ ...item, description: "fixture", scope: "server", serverId: server.id, credentialGroupId: "db-group", credentialKind: "database", credentialTarget: request.host } as SecretMetadata));
    store.secretValues = { [`${server.id}::DB_USER`]: protectedUser, [`${server.id}::DB_PASSWORD`]: protectedPassword };
  }
  const data: DatabaseInspectionResult = { version: 1, request, status: "complete", reason: "", coverageComplete: true, truncated: false, connectionVerified: true,
    connection: { requestedHost: request.host, transport: "socket", port: request.port, database: request.database, sessionUser: password ? protectedUser : "reader",
      currentUser: password ? protectedUser : "reader", serverAddress: null, tls: false, serverVersionNum: 140024, readOnly: true, isolation: "repeatable read", snapshot: "4:5:", observedAt: new Date().toISOString() },
    tables: [{ schema: "public", name: "orders", status: "complete", reason: "", rowCount: 0, dataSha256: "a".repeat(64), dataBytes: 0,
      columns: [{ name: "id", type: "integer", nullable: false, default: null, identity: "", generated: "", collation: null }], constraints: [], indexes: [], structureSha256: "b".repeat(64) }],
    snapshotScope: "single_database", limitations: [...DATABASE_INSPECTION_LIMITATIONS], readBytes: 1000, elapsedMs: 10 };
  const approveSocket = () => {
    const authStep = { ...step, command: buildDatabaseAuthenticationCommand(request) };
    authStep.authenticationGate = { approved: true, reason: "fixture explicit identity confirmation", fingerprint: authenticationFingerprint(task, authStep) };
    recordAuthentication(task, authStep, [], { success: true, exitCode: 0, output: "fixture connection evidence" }, "main", "prior-connection");
  };
  return { store, task, step, call, data, approveSocket };
}
const receipt = (data: unknown) => ({ success: true, simulated: true, exitCode: 0, output: "", stdout: `OPSARK_POSTGRES_RESULT ${JSON.stringify(data)}\n`, stdoutTruncated: false });

describe("PostgreSQL fixed inspection authorization and presentation", () => {
  it("does not bypass first socket identity confirmation", async () => {
    const f = setup(), execute = vi.spyOn(backend, "executeCommand");
    const result = await f.store.executeToolCall(server.id, f.call, undefined, undefined, f.task.id);
    expect(result).toMatchObject({ success: false, error: { category: "permission", dispatchState: "not_sent" } });
    expect(execute).not.toHaveBeenCalled();
  });
  it("reuses a confirmed connection and keeps table inspection distinct from restore acceptance", async () => {
    const f = setup(); f.approveSocket();
    const execute = vi.spyOn(backend, "executeCommand").mockResolvedValue(receipt(f.data));
    const result = await f.store.executeToolCall(server.id, f.call, undefined, undefined, f.task.id);
    expect(result.success).toBe(true); expect(execute).toHaveBeenCalledOnce();
    expect(f.task.authenticationEvidence).toHaveLength(2);
    expect(buildToolEvidenceFacts(f.call, result)).toMatchObject({ evidenceComplete: true, connectionVerified: true, restoreVerified: false, sourceUnchangedVerified: false });
  });
  it.each(["group", "target", "role", "server", "value"])("rejects incompatible credential %s before dispatch", async kind => {
    const f = setup(true), execute = vi.spyOn(backend, "executeCommand");
    if (kind === "group") f.store.secretMetadata[1].credentialGroupId = "foreign";
    if (kind === "target") f.store.secretMetadata[1].credentialTarget = "/other/socket";
    if (kind === "role") f.store.secretMetadata[1].credentialRole = "username";
    if (kind === "server") f.store.secretMetadata[1].serverId = "foreign";
    if (kind === "value") delete f.store.secretValues[`${server.id}::DB_PASSWORD`];
    const result = await f.store.executeToolCall(server.id, f.call, undefined, undefined, f.task.id);
    expect(result.success).toBe(false); expect(execute).not.toHaveBeenCalled();
  });
  it("keeps protected values out of public results, task authentication evidence and logs", async () => {
    const f = setup(true);
    const execute = vi.spyOn(backend, "executeCommand").mockResolvedValue(receipt(f.data));
    const result = await f.store.executeToolCall(server.id, f.call, undefined, undefined, f.task.id);
    expect(result.success).toBe(true);
    expect(execute.mock.calls[0][3]).toMatchObject({ privateCommandAudit: { secretValues: expect.arrayContaining([protectedUser, protectedPassword]) } });
    expect(execute.mock.calls[0][3]?.privateCommandAudit?.displayCommand).toContain("${secret.DB_USER}");
    expect(result.data).toMatchObject({ connection: { currentUser: "${secret.DB_USER}", sessionUser: "${secret.DB_USER}" } });
    const publicState = JSON.stringify({ result, evidence: f.task.authenticationEvidence, logs: f.store.logs });
    expect(publicState).not.toContain(protectedUser); expect(publicState).not.toContain(protectedPassword);
  });
  it("rejects an actual account that differs from the resolved credential", async () => {
    const f = setup(true); f.data.connection!.sessionUser = "other"; f.data.connection!.currentUser = "other";
    vi.spyOn(backend, "executeCommand").mockResolvedValue(receipt(f.data));
    const result = await f.store.executeToolCall(server.id, f.call, undefined, undefined, f.task.id);
    expect(result.success).toBe(false); expect(f.task.authenticationEvidence ?? []).toHaveLength(0);
  });
  it("does not grant new authentication after credential revision changes in flight", async () => {
    const f = setup(); f.approveSocket();
    vi.spyOn(backend, "executeCommand").mockImplementation(async () => { f.task.credentialRevision! += 1; return receipt(f.data); });
    await f.store.executeToolCall(server.id, f.call, undefined, undefined, f.task.id);
    expect(f.task.authenticationEvidence).toHaveLength(1);
  });
  it("projects unsupported collection as an unfulfilled inspection with bounded replanning", async () => {
    const f = setup();
    Object.assign(f.data, { status: "unsupported", reason: "client unavailable", coverageComplete: false, truncated: true, connectionVerified: false, connection: null, tables: [] });
    const outcome = buildToolStepOutcome({ call: f.call, result: { callId: f.call.id, toolId: f.call.toolId, success: true, data: f.data }, evidenceId: "unsupported", completedAt: new Date().toISOString() });
    expect(outcome.status).toBe("failed"); expect(outcome.result.observationStatus).toBe("warning");
    expect(outcome.review?.recoveryAction?.kind).toBe("replan"); expect(outcome.eventMessage).not.toContain("完整结果");
  });
});
