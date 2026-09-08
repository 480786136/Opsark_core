import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { backend } from "./backend";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

describe("Agent transport event routing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  });
  afterEach(() => Reflect.deleteProperty(window, "__TAURI_INTERNALS__"));

  it("accepts a newer invalidation generation while rejecting unrelated and stale output", async () => {
    let emit: (event: unknown) => void = () => undefined;
    const unlisten = vi.fn();
    vi.mocked(listen).mockImplementation(async (_name, handler) => {
      emit = handler as typeof emit;
      return unlisten;
    });
    const error = "SSH 握手失败：[Session(-8)] Unable to exchange encryption keys";
    vi.mocked(invoke).mockImplementation(async () => {
      const payload = { sessionId: "agent-1", executionId: "validation-1", generation: 2, stream: "error", data: "generation changed" };
      emit({ payload: { ...payload, sessionId: "unrelated" } });
      emit({ payload: { ...payload, executionId: "unrelated" } });
      emit({ payload: { ...payload, generation: 0, stream: "stdout" } });
      emit({ payload });
      throw error;
    });
    const onProgress = vi.fn();
    const onSessionInvalidated = vi.fn();
    await expect(backend.executeAgentCommand({
      connection: { host: "example.invalid", port: 22, username: "tester", password: "test" },
      session: { id: "agent-1", generation: 1 }, executionId: "validation-1",
      command: "test -d /opt/repo/.git", scope: "isolated_exec", approvedHighRisk: false,
      onProgress, onSessionInvalidated,
    })).rejects.toBe(error);
    expect(onProgress).not.toHaveBeenCalled();
    expect(onSessionInvalidated.mock.calls).toEqual([[2], []]);
    expect(unlisten).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
  });
});
