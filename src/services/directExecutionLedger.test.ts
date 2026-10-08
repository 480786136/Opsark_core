import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { backend } from "./backend";
import { directExecutionLedgerOwner, fileContentIdentity } from "./directExecutionLedger";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, flushPendingReceipts,
  listExecutionLedger, resetExecutionLedgerForTests, runRecordedExecution } from "./executionLedger";
import { projectExecutionLedgerRecovery, readExecutionLedger } from "@/features/agent/executionLedgerRecovery";
import { executionDigest } from "@/features/agent/planPreparation";
import type { ExecutionIntentSemantic } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
const connection = { host: "server.example", port: 22, username: "deploy", password: "value-never-in-intent" };

describe("direct backend durable execution boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks(); resetExecutionLedgerForTests();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  });
  afterEach(() => Reflect.deleteProperty(window, "__TAURI_INTERNALS__"));

  it.each(["1", "root", "core-case", "directory", "sha256"])("keeps delete intent exact despite a credential collision: %s", async password => {
    const current = { ...connection, username: "root", password };
    vi.mocked(invoke).mockResolvedValue(undefined);
    await backend.deleteSftpEntry(current, "/opt/core-case", "directory");
    await backend.deleteSftpEntry(current, "/root/core-case", "directory");
    const rows = await listExecutionLedger(directExecutionLedgerOwner);
    expect(rows).toHaveLength(2);
    for (const [index, path] of ["/opt/core-case", "/root/core-case"].entries()) {
      const semantic = rows[index].intent.semantic;
      expect(semantic.action).toEqual({ type: "tool", toolId: "core.sftp.delete", arguments: { path, kind: "directory" } });
      expect(semantic.targets).toEqual([{ role: "execution", host: current.host, port: 22, username: "root" }]);
      expect(semantic.targets[0]).not.toHaveProperty("password");
      expect(rows[index].intent.digest).toBe(executionDigest({ version: "execution-intent@1", semantic }));
      expect(rows[index].state).toBe("succeeded");
      expect(invoke).toHaveBeenNthCalledWith(index + 1, "delete_sftp_entry", { ...current, path, kind: "directory" });
    }
  });

  it("persists a direct SSH dispatch before invoking Tauri and stores its actual result", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      expect(command).toBe("execute_ssh_command"); expect(args).toMatchObject({ executionId: "direct-shell" });
      expect((await listExecutionLedger(directExecutionLedgerOwner))[0]?.state).toBe("dispatching");
      return { output: "created", success: true, simulated: false, exitCode: 0 };
    });
    await backend.executeCommand("touch /srv/a", connection, false, { executionId: "direct-shell" });
    expect((await listExecutionLedger(directExecutionLedgerOwner))[0]).toMatchObject({ state: "succeeded",
      intent: { semantic: { action: { type: "shell", command: "touch /srv/a" } } } });
  });

  it("keeps successful SFTP deletes as history without inventing a business-task review", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await backend.deleteSftpEntry(connection, "/opt/core-case", "directory");
    await backend.deleteSftpEntry(connection, "/root/core-case", "directory");
    const rows = await listExecutionLedger(directExecutionLedgerOwner), before = JSON.stringify(rows);
    expect(readExecutionLedger(rows).compatible).toBe(true);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.taskId)).size).toBe(1);
    expect(rows.every(row => row.attempts[0].status === "succeeded" && row.attempts[0].reviewCompletedAt === undefined)).toBe(true);
    expect(projectExecutionLedgerRecovery(rows).items).toEqual([]);
    expect(JSON.stringify(rows)).toBe(before);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("reuses only the identical Agent execution ID and does not create a second operation", async () => {
    const owner = {}, semantic: ExecutionIntentSemantic = { taskId: "task", stepId: "step", action: { type: "shell", command: "touch /srv/a" },
      targets: [{ role: "execution", host: connection.host, port: 22, username: "deploy" }], kind: "change", effect: "change",
      risk: "medium", expected: "created", dependencies: { precedingStepIds: [] }, permission: "managed", policyVersion: "j1" };
    vi.mocked(invoke).mockResolvedValue({ output: "created", success: true, simulated: false, exitCode: 0 });
    await runRecordedExecution({ owner, task: { id: "task" }, step: { id: "step", executionIntent: {
      version: "execution-intent@1", algorithm: "sha256", semantic, digest: executionDigest({ version: "execution-intent@1", semantic }) } },
      phase: "command", executionId: "agent-shell", execute: () => backend.executeCommand("touch /srv/a", connection, false, { executionId: "agent-shell" }) });
    expect(await listExecutionLedger(directExecutionLedgerOwner)).toEqual([]);
    expect((await listExecutionLedger(owner))[0]?.attempts).toHaveLength(1); expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("requests separate streams only for callers that opt in", async () => {
    vi.mocked(invoke).mockResolvedValue({ output: "combined", stdout: "json", stderr: "progress",
      stdoutTruncated: false, success: true, simulated: false, exitCode: 0 });
    const result = await backend.executeCommand("df -k", connection, false,
      { executionId: "inspection-streams", captureStreams: true });
    expect(invoke).toHaveBeenLastCalledWith("execute_ssh_command", expect.objectContaining({ separateOutput: true }));
    expect(result).toMatchObject({ stdout: "json", stderr: "progress", stdoutTruncated: false });
    await backend.executeCommand("df -k", connection, false, { executionId: "ordinary-shell" });
    expect(vi.mocked(invoke).mock.calls.slice(-1)[0]?.[1]).not.toHaveProperty("separateOutput");
  });

  it("stores file identity instead of file content and never includes the connection password", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const bytes = new TextEncoder().encode("sensitive file contents");
    await backend.writeSftpFile(connection, "/srv/config", bytes);
    const rows = await listExecutionLedger(directExecutionLedgerOwner);
    expect(rows[0]?.intent.semantic.action).toEqual({ type: "tool", toolId: "core.sftp.write_file",
      arguments: { path: "/srv/config", content: await fileContentIdentity(bytes) } });
    expect(JSON.stringify(rows)).not.toContain("sensitive file contents"); expect(JSON.stringify(rows)).not.toContain(connection.password);
    expect(invoke).toHaveBeenCalledWith("write_sftp_file", { ...connection, path: "/srv/config", data: Array.from(bytes) });
  });

  it("retains direct-result receipts after a storage failure without repeating the write", async () => {
    const writer = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue("saved-evidence");
    configureExecutionLedger(directExecutionLedgerOwner, createMemoryExecutionLedgerRepository(), writer);
    vi.mocked(invoke).mockResolvedValue(undefined);
    await expect(backend.createSftpDirectory(connection, "/srv/new")).rejects.toMatchObject({ stage: "result_commit", remoteResultKnown: true });
    await flushPendingReceipts(directExecutionLedgerOwner);
    expect(invoke).toHaveBeenCalledTimes(1); expect((await listExecutionLedger(directExecutionLedgerOwner))[0]?.state).toBe("succeeded");
    expect(projectExecutionLedgerRecovery(await listExecutionLedger(directExecutionLedgerOwner)).items).toEqual([]);
  });

  it("keeps a direct mutation uncertain after transport loss and prevents another write", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("transport read"));
    await expect(backend.renameSftpEntry(connection, "/srv/a", "/srv/b")).rejects.toMatchObject({ stage: "execution" });
    await expect(backend.deleteSftpEntry(connection, "/srv/b", "file")).rejects.toMatchObject({ stage: "begin", code: "EXECUTION_LEDGER_RESOURCE_BUSY" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("records cancellation separately from a later physical result", async () => {
    let resolve!: (value: unknown) => void, dispatched!: () => void;
    const started = new Promise<void>(done => { dispatched = done; });
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "execute_ssh_command") { dispatched(); return new Promise(done => { resolve = done; }); }
      expect(command).toBe("cancel_ssh_execution");
      expect((await listExecutionLedger(directExecutionLedgerOwner))[0]?.cancelRequested).toBe(true);
    });
    const running = backend.executeCommand("sleep 30", connection, false, { executionId: "cancel-me" });
    await started; await backend.cancelCommand(connection, "cancel-me");
    resolve({ output: "interrupted", success: false, simulated: false, exitCode: 130 }); await running;
    const [record] = await listExecutionLedger(directExecutionLedgerOwner);
    expect(record).toMatchObject({ state: "failed", cancelRequested: true, attempts: [{ late: true, status: "failed" }] });
  });
});
