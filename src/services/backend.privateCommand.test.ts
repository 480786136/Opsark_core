import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { backend } from "./backend";
import { runDirectExecution } from "./directExecutionLedger";
import { isRecordedExecution } from "./executionLedger";
import { privateCommandRedactor } from "./privateCommandAudit";
import { isSshExecPayloadError } from "./sshCommandTransport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./directExecutionLedger", async importOriginal => ({ ...await importOriginal<typeof import("./directExecutionLedger")>(), runDirectExecution: vi.fn() }));
vi.mock("./executionLedger", async importOriginal => ({ ...await importOriginal<typeof import("./executionLedger")>(), isRecordedExecution: vi.fn() }));
const password = "private'\n$()密码";
const command = `PGPASSWORD='${password.replace(/'/g, "'\"'\"'")}' /fixed/probe`;
const audit = { displayCommand: "psql -U ${secret.DB_USER} --inspection", secretValues: [password, "database-user"] };
const connection = { host: "fixture.invalid", port: 22, username: "fixture", password: "ssh-password" };
const nativeDiagnostic = { version: 1, origin: "core", code: "SSH_EXEC_PAYLOAD_TOO_LARGE", stage: "exec_preflight",
  dispatchCertainty: "not_dispatched", retryable: false, payloadBytes: 34744, payloadLimitExclusive: 34744 };
const nativeEnvelope = "OPSARK_SSH_EXEC_PREFLIGHT_V1:" + JSON.stringify(nativeDiagnostic);
beforeEach(() => {
  vi.resetAllMocks(); Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.mocked(isRecordedExecution).mockReturnValue(true);
  vi.mocked(runDirectExecution).mockImplementation(options => options.execute());
});
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.restoreAllMocks(); });

describe("private fixed probe transport audit", () => {
  it("rejects private material before transport when no admitted execution exists", async () => {
    vi.mocked(isRecordedExecution).mockReturnValue(false);
    await expect(backend.executeCommand(command, connection, false, { executionId: "missing", privateCommandAudit: audit })).rejects.toThrow("已落账");
    expect(invoke).not.toHaveBeenCalled(); expect(runDirectExecution).not.toHaveBeenCalled();
  });
  it("keeps public intent and sanitizes echo/errors while private stdout is parsed locally", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, simulated: false, exitCode: 0,
      output: `$ ${command}\n${password}\n[exit: 0]`, stderr: `account database-user: ${password}`, stdout: '{"actualUser":"database-user"}' });
    const progress = vi.fn();
    const result = await backend.executeCommand(command, connection, false, { executionId: "admitted", captureStreams: true, onProgress: progress, privateCommandAudit: audit });
    expect(vi.mocked(runDirectExecution).mock.calls[0][0].action).toEqual({ type: "shell", command: audit.displayCommand });
    expect(invoke).toHaveBeenCalledWith("execute_ssh_command", expect.objectContaining({ command, separateOutput: true, privateOutput: true, approvedHighRisk: false }));
    expect(result.output).toContain(audit.displayCommand); expect(result.output).not.toContain(password);
    expect(result.stderr).not.toContain("database-user"); expect(result.stderr).not.toContain(password);
    expect(result.stdout).toBe('{"actualUser":"database-user"}');
    expect(listen).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled();
  });
  it("sanitizes rejected transport messages before propagation", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error(`failed ${command}; ${password}; database-user`));
    try {
      await backend.executeCommand(command, connection, false, { executionId: "admitted", privateCommandAudit: audit });
      throw new Error("expected rejection");
    } catch (error) {
      expect(String(error)).toContain("failed"); expect(String(error)).not.toContain(password);
      expect(String(error)).not.toContain("database-user"); expect(String(error)).not.toContain(command);
    }
  });
  it.each([false, true])("preserves the trusted native rejection through private audit=%s", privateCommand => {
    vi.mocked(invoke).mockRejectedValue(nativeEnvelope);
    return backend.executeCommand(command, connection, false, { executionId: "admitted",
      ...(privateCommand ? { privateCommandAudit: audit } : {}) }).then(() => {
      throw new Error("expected rejection");
    }, error => {
      expect(isSshExecPayloadError(error)).toBe(true);
      expect(error.diagnostic).toEqual(nativeDiagnostic);
      expect(String(error)).toContain("未派发");
      expect(JSON.stringify(error)).not.toContain(command);
      for (const secret of [password, "database-user", connection.password]) {
        expect(JSON.stringify(error)).not.toContain(secret);
        expect(String(error)).not.toContain(secret);
      }
      expect(invoke).toHaveBeenCalledTimes(1);
    });
  });
  it("never parses a successful invoke's remote output as native rejection evidence", async () => {
    const result = { success: false, simulated: false, exitCode: 125, output: nativeEnvelope,
      stdout: nativeEnvelope, stderr: nativeEnvelope };
    vi.mocked(invoke).mockResolvedValue(result);
    const returned = await backend.executeCommand(command, connection, false,
      { executionId: "admitted", captureStreams: true, privateCommandAudit: audit });
    expect(returned).toEqual(result);
    expect(isSshExecPayloadError(returned)).toBe(false);
  });
  it("does not grant native provenance to remote progress text and cleans the listener", async () => {
    const progress = vi.fn(), unlisten = vi.fn();
    vi.mocked(listen).mockImplementation(async (_event, handler) => {
      handler({ event: "command-output", id: 1, payload: { executionId: "admitted", chunk: nativeEnvelope } } as never);
      return unlisten;
    });
    vi.mocked(invoke).mockRejectedValue(nativeEnvelope);
    await expect(backend.executeCommand("true", connection, false,
      { executionId: "admitted", onProgress: progress })).rejects.toMatchObject({ diagnostic: nativeDiagnostic });
    expect(progress).toHaveBeenCalledWith({ executionId: "admitted", chunk: nativeEnvelope });
    expect(isSshExecPayloadError(progress.mock.calls[0][0])).toBe(false);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
  it.each([
    new Error(nativeEnvelope),
    "Failed opening SSH channel: [Session(-34)]",
    "OPSARK_SSH_EXEC_PREFLIGHT_V1:" + JSON.stringify({ ...nativeDiagnostic, password }),
    `${nativeEnvelope}\n${command}\n${password}`,
  ])("keeps malformed or unrelated errors untrusted through private redaction", async failure => {
    vi.mocked(invoke).mockRejectedValue(failure);
    const error = await backend.executeCommand(command, connection, false,
      { executionId: "admitted", privateCommandAudit: audit }).catch(value => value);
    expect(isSshExecPayloadError(error)).toBe(false);
    expect(String(error)).not.toContain(password);
    expect(String(error)).not.toContain(command);
    expect(error).not.toHaveProperty("diagnostic");
  });
  it("redacts escaped representations as well as exact values", () => {
    const redact = privateCommandRedactor(command, audit);
    for (const value of [password, password.replace(/'/g, "'\"'\"'"), JSON.stringify(password).slice(1, -1)]) {
      expect(redact(`detail=${value}`)).toBe("detail=[REDACTED]");
    }
  });
});
