import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { isRecordedExecution, resetExecutionLedgerForTests } from "@/services/executionLedger";
import { normalizeDatabaseInspectionRequest, type DatabaseInspectionResult } from "@/features/tools/databaseInspection";
import { DATABASE_INSPECTION_LIMITATIONS } from "@/features/tools/databaseInspectionContracts";
import { normalizeLogRotationRequest, logRotationLimitations } from "@/features/tools/logRotationInspection";
import type { PlanStep, SecretMetadata, ServerProfile } from "@/types";
import { useOpsStore } from "./ops";

// Independent integration review: keep plan preparation, authorization, durable
// execution admission and outcome projection real; replace only remote I/O.
const server: ServerProfile = { id: "db-review-server", host: "review.invalid", port: 22, username: "fixture", name: "review",
  group: "test", status: "offline", environment: [], createdAt: "2026-10-12T00:00:00Z",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
const username = "review-protected-db-user", password = "review-protected-db-password";
beforeEach(async () => {
  vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  setActivePinia(createPinia()); useOpsStore().servers = [structuredClone(server)];
  vi.spyOn(backend, "checkSshConnection").mockResolvedValue();
  vi.spyOn(backend, "saveCredential").mockResolvedValue();
  vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
  vi.spyOn(backend, "configureTaskCapabilities").mockResolvedValue();
  await useConnectionStore().connect(server.id, { host: server.host, port: server.port, username: server.username, password: "review-ssh-password" });
  vi.spyOn(useOpsStore(), "advanceTask").mockResolvedValue();
  vi.spyOn(useOpsStore(), "routeAutomaticAdjustment").mockResolvedValue();
});
afterEach(async () => {
  const store = useOpsStore(); store.stopConnectionMonitor(); await store.persist(true); store.$dispose(); vi.restoreAllMocks();
});
function setup() {
  const store = useOpsStore(), task = store.createTask(server.id, "managed", "model");
  task.rootGoal = "核验指定 PostgreSQL 普通表的内容与结构";
  task.status = "running"; task.currentRoundId = "review-round"; task.agentSessionId = "review-session";
  task.agentSessionGeneration = 1; task.credentialRevision = 2; task.confirmedSecretKeys = ["DB_USER", "DB_PASSWORD"];
  const request = normalizeDatabaseInspectionRequest({ clientPath: "/usr/bin/psql", transport: "socket", host: "/var/run/postgresql", port: 15432,
    database: "fixture", auth: "password", usernameSecretKey: "DB_USER", passwordSecretKey: "DB_PASSWORD", tables: [{ schema: "public", name: "orders" }] });
  const call = { id: "review-db-call", toolId: "database.inspect_postgres", arguments: { ...request } };
  task.plan = [{ id: "review-db-step", title: "核验指定表", description: "只读证据采集", command: "", validation: "", expected: "取得单库快照证据",
    risk: "low", kind: "observe", status: "pending", action: { type: "tool", toolId: call.toolId, arguments: call.arguments } } as PlanStep];
  const step = task.plan[0]!;
  store.secretMetadata = ([{ key: "DB_USER", credentialRole: "username" }, { key: "DB_PASSWORD", credentialRole: "secret" }] as const)
    .map(item => ({ ...item, description: "review fixture", scope: "server", serverId: server.id, credentialGroupId: "review-db-group",
      credentialKind: "database", credentialTarget: request.host } as SecretMetadata));
  store.secretValues = { [`${server.id}::DB_USER`]: username, [`${server.id}::DB_PASSWORD`]: password };
  const data: DatabaseInspectionResult = { version: 1, request, status: "complete", reason: "", coverageComplete: true, truncated: false, connectionVerified: true,
    connection: { requestedHost: request.host, transport: "socket", port: request.port, database: request.database, sessionUser: username,
      currentUser: username, serverAddress: null, tls: false, serverVersionNum: 140024, readOnly: true, isolation: "repeatable read", snapshot: "4:5:", observedAt: "2026-10-12T10:00:00Z" },
    tables: [{ schema: "public", name: "orders", status: "complete", reason: "", rowCount: 0, dataSha256: "a".repeat(64), dataBytes: 0,
      columns: [{ name: "id", type: "integer", nullable: false, default: null, identity: "", generated: "", collation: null }], constraints: [], indexes: [], structureSha256: "b".repeat(64) }],
    snapshotScope: "single_database", limitations: [...DATABASE_INSPECTION_LIMITATIONS], readBytes: 1000, elapsedMs: 10 };
  return { store, task, step, call, data };
}
const receipt = (data: unknown) => ({ success: true, simulated: true, exitCode: 0, output: "", stdout: `OPSARK_POSTGRES_RESULT ${JSON.stringify(data)}\n`, stdoutTruncated: false });

describe("第五批数据库实际工具入口独立交叉审", () => {
  it("正常读取经过实际准备、认证和账本，随后才投影证据", async () => {
    const f = setup();
    const execute = vi.spyOn(backend, "executeCommand").mockImplementation(async (_command, _connection, _approval, options) => {
      expect(isRecordedExecution(options!.executionId)).toBe(true);
      expect(options?.privateCommandAudit?.displayCommand).toContain("${secret.DB_USER}");
      return receipt(f.data);
    });
    await f.store.runToolStep(f.task.id, f.step.id, f.call);
    expect(execute).toHaveBeenCalledOnce();
    expect(f.step.status, f.task.pauseReason).toBe("completed");
    expect(f.step.result?.facts).toMatchObject({ evidenceComplete: true, restoreVerified: false });
    expect(f.task.authenticationEvidence).toHaveLength(1);
    expect(JSON.stringify({ output: f.step.output, evidence: f.step.evidence, auth: f.task.authenticationEvidence })).not.toContain(username);
  });
  it.each(["column", "constraint", "index", "collation"] as const)("远端观测的 %s 含已登记私值时不得进入步骤输出", async field => {
    const f = setup(), table = f.data.tables[0]!;
    if (field === "column") table.columns[0]!.name = password;
    if (field === "constraint") table.constraints = [{ name: password, type: "c", definition: "CHECK (id > 0)", validated: true, deferrable: false, initiallyDeferred: false }];
    if (field === "index") table.indexes = [{ name: password, definition: "CREATE INDEX safe_idx ON orders (id)", unique: false, primary: false, valid: true, ready: true }];
    if (field === "collation") table.columns[0]!.collation = password;
    const execute = vi.spyOn(backend, "executeCommand").mockImplementation(async (_command, _connection, _approval, options) => {
      expect(isRecordedExecution(options!.executionId)).toBe(true);
      return receipt(f.data);
    });
    await f.store.runToolStep(f.task.id, f.step.id, f.call);
    expect(execute).toHaveBeenCalledOnce();
    expect(f.step.output, f.task.pauseReason).not.toContain(password);
    expect(JSON.stringify(f.step.evidence)).not.toContain(password);
    expect(f.step.result?.facts.evidenceComplete).not.toBe(true);
  });
  it("需求修订变化后迟到回执不能追加认证或完成原步骤", async () => {
    const f = setup();
    vi.spyOn(backend, "executeCommand").mockImplementation(async () => {
      f.task.workflowEpoch = (f.task.workflowEpoch ?? 0) + 1;
      return receipt(f.data);
    });
    await f.store.runToolStep(f.task.id, f.step.id, f.call);
    expect(f.task.authenticationEvidence ?? []).toHaveLength(0);
    expect(f.step.status).not.toBe("completed");
    expect(f.step.output ?? "").not.toContain("single_database_snapshot");
  });
  it("凭据版本变化后只保留原读取结果，不授予当前版本认证", async () => {
    const f = setup();
    vi.spyOn(backend, "executeCommand").mockImplementation(async () => {
      f.task.credentialRevision! += 1;
      return receipt(f.data);
    });
    await f.store.runToolStep(f.task.id, f.step.id, f.call);
    expect(f.task.authenticationEvidence ?? []).toHaveLength(0);
    expect(f.step.status).toBe("completed");
  });
  it.each(["target", "database"] as const)("采集中 %s 身份变化不能把旧回执当当前步骤成功", async field => {
    const f = setup();
    vi.spyOn(backend, "executeCommand").mockImplementation(async () => {
      if (field === "target") f.task.executionTargetServerId = "different-server";
      if (field === "database" && f.step.action?.type === "tool") f.step.action.arguments.database = "different_database";
      return receipt(f.data);
    });
    await f.store.runToolStep(f.task.id, f.step.id, f.call);
    expect(f.task.authenticationEvidence ?? []).toHaveLength(0);
    expect(f.step.status).not.toBe("completed");
    expect(f.step.result?.facts.evidenceComplete).not.toBe(true);
  });
  it("日志轮转采集在回执脱敏前应关闭原生全局原文流", async () => {
    const f = setup(), request = normalizeLogRotationRequest({ activePaths: ["/var/log/app.log"], writerPids: [123] });
    const call = { id: "review-log-call", toolId: "logs.inspect_rotation", arguments: { ...request } };
    f.task.rootGoal = "核验日志轮转状态";
    f.step.action = { type: "tool", toolId: call.toolId, arguments: call.arguments };
    const time = "2026-10-12T10:00:00.000Z", sha = "a".repeat(64);
    const data = { request, status: "complete", coverageComplete: true,
      files: [{ path: request.activePaths[0], role: "active", status: "complete", kind: "regular", compression: "none", compressionValid: null,
        readBytes: 100, expandedBytes: 100, lineCount: 2, partialLastLine: false, sampledAt: time, finishedAt: time, consistency: "prefix_rechecked", reason: "sampled",
        metadata: { device: "1", inode: "99", sizeBytes: 100, mode: "0640", uid: 99, gid: 99, mtimeNs: "1", ctimeNs: "1" }, appendObserved: false, rawSha256: sha, contentSha256: sha }],
      configs: [], writers: [{ pid: 123, status: "complete", reason: "sampled", startTicks: "5", process: `${password}-worker`, scannedFds: 4,
        descriptors: [{ fd: 3, path: request.activePaths[0], device: "1", inode: "99", append: true }] }],
      sequence: null, sampledAt: time, finishedAt: time, elapsedMs: 2, limitations: [...logRotationLimitations] };
    const execute = vi.spyOn(backend, "executeCommand").mockImplementation(async (_command, _connection, _approval, options) => {
      expect(isRecordedExecution(options!.executionId)).toBe(true);
      return { ...receipt(data), stdout: `OPSARK_LOG_ROTATION ${JSON.stringify(data)}\n` };
    });
    await f.store.runToolStep(f.task.id, f.step.id, call);
    expect(execute).toHaveBeenCalledOnce();
    expect(f.step.output).not.toContain(password); // Receipt presentation already sanitizes.
    expect(f.step.result?.facts.evidenceComplete).toBe(false);
    expect(execute.mock.calls[0]![3]?.privateCommandAudit).toBeDefined(); // Raw transport must be private too.
  });
});
