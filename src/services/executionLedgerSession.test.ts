import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { configureExecutionLedger, createNativeExecutionLedgerRepository, listExecutionLedger, resetExecutionLedgerForTests } from "./executionLedger";
import { directExecutionLedgerOwner } from "./directExecutionLedger";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const registered = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "register_execution_ledger_session");

describe("native execution ledger Webview session", () => {
  beforeEach(() => {
    vi.resetAllMocks(); resetExecutionLedgerForTests();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  });
  afterEach(() => Reflect.deleteProperty(window, "__TAURI_INTERNALS__"));

  it("registers once for concurrent Agent/direct owners and waits before ledger access", async () => {
    let finishRegistration!: () => void;
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "register_execution_ledger_session") return new Promise<void>(done => { finishRegistration = done; });
      return [];
    });
    const agentOwner = {};
    configureExecutionLedger(agentOwner, createNativeExecutionLedgerRepository(), async () => "evidence");
    configureExecutionLedger(directExecutionLedgerOwner, createNativeExecutionLedgerRepository(), async () => "evidence");
    const agent = listExecutionLedger(agentOwner), direct = listExecutionLedger(directExecutionLedgerOwner);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1); expect(registered()).toHaveLength(1);
    expect(registered()[0]?.[1]).toMatchObject({ frontendSessionId: expect.stringMatching(/^frontend-/) });
    finishRegistration(); await Promise.all([agent, direct]);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "list_execution_operations")).toHaveLength(2);
    for (const [, payload] of vi.mocked(invoke).mock.calls.filter(([command]) => command === "list_execution_operations")) {
      expect(payload).toMatchObject(registered()[0]![1] as Record<string, unknown>);
    }
    await listExecutionLedger({}); // The test default remains memory, never registering another session.
    await listExecutionLedger(agentOwner); expect(registered()).toHaveLength(1);
  });

  it("blocks all ledger calls after registration failure and retries the same session identity", async () => {
    let attempt = 0;
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "register_execution_ledger_session" && attempt++ === 0) throw new Error("EXECUTION_LEDGER_STORAGE_UNAVAILABLE");
      return [];
    });
    const first = createNativeExecutionLedgerRepository(), second = createNativeExecutionLedgerRepository();
    const results = await Promise.allSettled([first.list(), second.list()]);
    expect(results.every(result => result.status === "rejected")).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    await first.list();
    expect(registered()).toHaveLength(2); expect(registered()[0]?.[1]).toEqual(registered()[1]?.[1]);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "list_execution_operations")).toHaveLength(1);
  });

  it("uses a new identity for a new page lifetime instead of reusing a stored/localStorage identity", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await createNativeExecutionLedgerRepository().list();
    const firstIdentity = registered()[0]?.[1];
    resetExecutionLedgerForTests(); // Simulates re-evaluation of the page's module-level state.
    await createNativeExecutionLedgerRepository().list();
    expect(registered()).toHaveLength(2); expect(registered()[1]?.[1]).not.toEqual(firstIdentity);
  });

  it("does not claim a session or durable storage in browser preview", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await expect(createNativeExecutionLedgerRepository().list()).rejects.toThrow("EXECUTION_LEDGER_UNAVAILABLE");
    expect(invoke).not.toHaveBeenCalled();
  });
});
