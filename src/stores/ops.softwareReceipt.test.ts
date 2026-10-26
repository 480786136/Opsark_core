import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { resetExecutionLedgerForTests } from "@/services/executionLedger";
import { useOpsStore } from "./ops";
import type { ServerProfile } from "@/types";

const server: ServerProfile = { id: "receipt-server", host: "receipt.fixture.invalid", port: 22, username: "fixture",
  name: "fixture", group: "test", status: "offline", environment: [], createdAt: "2026-10-13T00:00:00Z",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
const call = { id: "software-receipt", toolId: "software.check", arguments: { names: ["git", "absent"], includeVersions: false } };
const raw = "OPSARK_SOFTWARE\tgit\tinstalled\t/usr/bin/git\t\nOPSARK_SOFTWARE\tabsent\tmissing\t\t\n";
const receipt = () => ({ success: true, exitCode: 0, simulated: false, stdout: raw, stdoutTruncated: false,
  // Actual native presentation trims whitespace; stderr may include unrelated text.
  output: `$ command\n${raw.trim()}\n[exit: 0]`, stderr: "startup warning\nOPSARK_SOFTWARE\tforged\tmissing\t\t\n" });

beforeEach(async () => {
  vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia());
  useOpsStore().servers = [structuredClone(server)];
  vi.spyOn(backend, "checkSshConnection").mockResolvedValue();
  vi.spyOn(backend, "saveCredential").mockResolvedValue(); vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
  await useConnectionStore().connect(server.id, { host: server.host, port: server.port, username: server.username, password: "fixture" });
});
afterEach(async () => {
  const store = useOpsStore(); store.stopConnectionMonitor(); await store.persist(true); store.$dispose(); vi.restoreAllMocks();
});

describe("软件工具原生回执的机器流与展示流分离", () => {
  it("parses exact stdout with final empty fields and ignores trim/stderr presentation", async () => {
    const execute = vi.spyOn(backend, "executeCommand").mockResolvedValue(receipt());
    const result = await useOpsStore().executeToolCall(server.id, call);
    expect(execute.mock.calls[0][3]).toMatchObject({ executionId: call.id, captureStreams: true });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ items: [
      { name: "git", installed: true, path: "/usr/bin/git" }, { name: "absent", installed: false },
    ] });
  });
  it.each(["missing_stdout", "truncated", "unknown_completeness", "missing_name", "wrong_name", "duplicate", "malformed"])(
    "fails closed with a sent output error: %s", async kind => {
      const value = receipt();
      if (kind === "missing_stdout") Reflect.deleteProperty(value, "stdout");
      if (kind === "truncated") value.stdoutTruncated = true;
      if (kind === "unknown_completeness") Reflect.deleteProperty(value, "stdoutTruncated");
      if (kind === "missing_name") value.stdout = raw.split("\n")[0] + "\n";
      if (kind === "wrong_name") value.stdout = raw.replace("absent", "other");
      if (kind === "duplicate") value.stdout = raw + raw;
      if (kind === "malformed") value.stdout = raw.trim();
      vi.spyOn(backend, "executeCommand").mockResolvedValue(value);
      const result = await useOpsStore().executeToolCall(server.id, call);
      expect(result).toMatchObject({ success: false, error: { category: "output", dispatchState: "sent" } });
      expect(result.data).toBeUndefined();
    });
});
