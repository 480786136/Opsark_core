// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { backend } from "./backend";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const connection = { apiKey: "synthetic-probe-secret", endpoint: "http://127.0.0.1:18767/v1", model: "fixture", apiProtocol: "chat_completions" as const };
const adapter = { protocol: "opsark-local-v1" as const, baseUrl: "http://127.0.0.1:18767/" };
beforeEach(() => { vi.resetAllMocks(); Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }); });
afterEach(() => Reflect.deleteProperty(window, "__TAURI_INTERNALS__"));

it("carries the explicitly selected adapter and Core operation into the real probe command without inventing task budget", async () => {
  vi.mocked(invoke).mockResolvedValue({ available: true, reason: "fixture" });
  await backend.checkModel({ ...connection, requestLifecycleAdapter: adapter }, "parameters");
  expect(invoke).toHaveBeenCalledOnce();
  const [command, args] = vi.mocked(invoke).mock.calls[0];
  expect(command).toBe("check_ai_model");
  const context = JSON.parse((args as Record<string, unknown>).context as string);
  expect(context).toEqual({ _modelRecovery: { operationId: expect.any(String), startedAtMs: expect.any(Number) }, _modelRequestLifecycle: { adapter } });
  expect(JSON.stringify(context)).not.toContain(connection.apiKey);
  expect(args).not.toHaveProperty("_requestLifecycleAdapter");
  expect(args).not.toHaveProperty("assertCurrent");
});

it("retains ordinary provider discovery semantics and never opts it into adapter status polling", async () => {
  vi.mocked(invoke).mockResolvedValue({ available: true, reason: "fixture" });
  await backend.checkModel({ apiKey: "synthetic", endpoint: "https://ordinary.invalid/v1", model: "fixture" });
  const args = vi.mocked(invoke).mock.calls[0][1] as Record<string, unknown>;
  expect(args.mode).toBeUndefined(); expect(args.integration).toBeUndefined();
  expect(JSON.parse(args.context as string)).not.toHaveProperty("_modelRequestLifecycle");
  expect(invoke).toHaveBeenCalledOnce();
});

it("propagates original unknown identity unchanged and does not generate a retry", async () => {
  const error = new Error("MODEL_DISPATCH_UNKNOWN request-original");
  vi.mocked(invoke).mockRejectedValue(error);
  await expect(backend.checkModel({ ...connection, requestLifecycleAdapter: adapter }, "structured")).rejects.toBe(error);
  expect(invoke).toHaveBeenCalledOnce();
});

it("does not apply an otherwise successful response after its owner cancels", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(() => new Promise(done => { resolve = done; }));
  let current = true;
  const pending = backend.checkModel({ ...connection, assertCurrent: () => { if (!current) throw new Error("owner cancelled"); } }, "parameters");
  current = false; resolve({ available: true, reason: "late" });
  await expect(pending).rejects.toThrow("owner cancelled");
  expect(invoke).toHaveBeenCalledOnce();
});

it("uses dedicated probe list/cancel/recover commands with original connection identity and no test generation", async () => {
  vi.mocked(invoke).mockResolvedValue([]);
  await backend.listModelProbeRequests(connection);
  await backend.cancelModelProbeRequests(connection);
  await backend.recoverModelProbeRequest(connection, "original-id");
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["list_model_probe_requests", connection], ["cancel_model_probe_requests", connection],
    ["recover_model_probe_request", { ...connection, requestId: "original-id" }],
  ]);
});
