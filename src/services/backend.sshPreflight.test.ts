import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { backend } from "./backend";
import { directExecutionLedgerOwner } from "./directExecutionLedger";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, listExecutionLedger, resetExecutionLedgerForTests } from "./executionLedger";
import { isSshExecPayloadError } from "./sshCommandTransport";
import { executionDigest } from "@/features/agent/planPreparation";
import type { ExecutionIntentSemantic, PlanStep } from "@/types";
import { useOpsStore } from "@/stores/ops";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const diagnostic = { version: 1, origin: "core", code: "SSH_EXEC_PAYLOAD_TOO_LARGE", stage: "exec_preflight",
  dispatchCertainty: "not_dispatched", retryable: false, payloadBytes: 40000, payloadLimitExclusive: 34744 };
const nativeFrame = "OPSARK_SSH_EXEC_PREFLIGHT_V1:" + JSON.stringify(diagnostic);
const connection = { host: "preflight.invalid", port: 22, username: "fixture", password: "private-ssh-fixture" };
const command = "printf 'planned command'";
const session = { id: "agent-fixture-session", generation: 1 };
const unlisten = vi.fn();
const evidenceWriter = vi.fn(async () => "fixture-evidence");

function commandInput(prompt: boolean, executionId = "agent-native-rejection") {
  return { connection, session, executionId, command, scope: "isolated_exec" as const, approvedHighRisk: false,
    ...(prompt ? { promptCredential: { kind: "git-https" as const, username: "private-account-fixture",
      secret: "private-prompt-fixture", target: "https://fixture.invalid" } } : {}),
    onProgress: vi.fn(), onSessionInvalidated: vi.fn() };
}

beforeEach(() => {
  vi.resetAllMocks(); resetExecutionLedgerForTests(); localStorage.clear(); setActivePinia(createPinia());
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.mocked(listen).mockResolvedValue(unlisten);
  evidenceWriter.mockResolvedValue("fixture-evidence");
  configureExecutionLedger(directExecutionLedgerOwner, createMemoryExecutionLedgerRepository(), evidenceWriter);
});
afterEach(() => {
  useOpsStore().stopConnectionMonitor(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.restoreAllMocks();
});

describe("real Agent backend invoke boundary and execution ledger", () => {
  it.each([false, true])("records direct Agent exec/PTY preflight without losing native provenance: prompt=%s", async prompt => {
    vi.mocked(invoke).mockRejectedValue(nativeFrame);
    const input = commandInput(prompt);
    const error = await backend.executeAgentCommand(input).catch(value => value);
    expect(isSshExecPayloadError(error)).toBe(true);
    const [operation] = await listExecutionLedger(directExecutionLedgerOwner);
    expect(operation).toMatchObject({ state: "not_dispatched", attempts: [{ status: "not_dispatched",
      outcome: { result: { error: { diagnostic } }, evidenceRefs: ["fixture-evidence"] } }] });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("execute_agent_terminal_command", expect.objectContaining({
      command, scope: input.scope, approvedHighRisk: false, promptCredential: input.promptCredential,
    }));
    expect(input.onSessionInvalidated).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledOnce();
    const saved = JSON.stringify(evidenceWriter.mock.calls);
    expect(saved).not.toContain(connection.password);
    expect(saved).not.toContain("private-prompt-fixture");
    expect(saved).not.toContain("private-account-fixture");
  });

  it.each([
    ["read", false], ["read", true], ["change", false], ["change", true],
  ] as const)("records the actual Agent store → backend → invoke path for %s / prompt=%s", async (effect, prompt) => {
    const store = useOpsStore();
    // Keep archive/UI persistence outside this ledger integration fixture.
    vi.spyOn(store, "persist").mockImplementation(() => undefined);
    configureExecutionLedger(store, createMemoryExecutionLedgerRepository(), evidenceWriter);
    const task = store.createTask("fixture-server", "managed", "fixture-model");
    const semantic: ExecutionIntentSemantic = { taskId: task.id, stepId: "fixture-step", action: { type: "shell", command },
      targets: [{ role: "execution", host: connection.host, port: 22, username: connection.username }], effect,
      kind: effect === "read" ? "observe" : "change", risk: effect === "read" ? "low" : "medium", expected: "记录实际执行",
      dependencies: { precedingStepIds: [] }, permission: "managed", policyVersion: "preflight-fixture" };
    const step: PlanStep = { id: semantic.stepId, title: "原生预检", description: "验证实际错误边界", action: semantic.action,
      command, validation: "", expected: semantic.expected, kind: semantic.kind, risk: semantic.risk, status: "pending",
      executionIntent: { version: "execution-intent@1", algorithm: "sha256", semantic,
        digest: executionDigest({ version: "execution-intent@1", semantic }) } };
    task.plan = [step];
    const input = commandInput(prompt);
    vi.mocked(invoke).mockRejectedValue(nativeFrame);
    const error = await store.recordStepExecution(task, step, "command", input.executionId, () => true,
      () => backend.executeAgentCommand(input)).catch(value => value);
    expect(isSshExecPayloadError(error)).toBe(true);
    const operations = await listExecutionLedger(store, task.id);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ state: "not_dispatched", attempts: [{ status: "not_dispatched",
      outcome: { result: { error: { diagnostic } }, evidenceRefs: ["fixture-evidence"] } }] });
    expect(await listExecutionLedger(directExecutionLedgerOwner)).toEqual([]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("execute_agent_terminal_command", expect.any(Object));
    expect(input.onSessionInvalidated).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it.each([new Error(nativeFrame), "无法执行远程命令：[Session(-34)]"])(
    "does not convert an unrelated Agent invoke failure into a native no-dispatch proof", async failure => {
      vi.mocked(invoke).mockRejectedValue(failure);
      const error = await backend.executeAgentCommand(commandInput(false)).catch(value => value);
      expect(isSshExecPayloadError(error)).toBe(false);
      expect(error).toMatchObject({ stage: "execution" });
      expect((await listExecutionLedger(directExecutionLedgerOwner))[0]).toMatchObject({ state: "unknown" });
      await expect(backend.executeAgentCommand(commandInput(false, "second-command"))).rejects.toMatchObject({ stage: "begin" });
      expect(invoke).toHaveBeenCalledOnce();
    });

  it.each([125, 130])("keeps returned remote text and exit %s as a dispatched receipt", async exitCode => {
    const result = { success: false, simulated: false, output: nativeFrame, exitCode,
      sessionId: session.id, generation: session.generation, scope: "isolated_exec" };
    vi.mocked(invoke).mockResolvedValue(result);
    expect(await backend.executeAgentCommand(commandInput(false))).toEqual(result);
    expect((await listExecutionLedger(directExecutionLedgerOwner))[0]).toMatchObject({ state: "failed",
      attempts: [{ outcome: { result } }] });
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
