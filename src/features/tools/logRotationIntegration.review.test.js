import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { resetExecutionLedgerForTests } from "@/services/executionLedger";
import { useOpsStore } from "@/stores/ops";
import { buildToolStepOutcome } from "@/features/agent/toolStepResult";
import { operationsProgressIdentity } from "./operationsObservation";
import { logRotationLimitations, normalizeLogRotationRequest } from "./logRotationInspection";

const server = { id: "rotation-review", host: "fixture.invalid", port: 22, username: "fixture", name: "review", group: "test", status: "offline", environment: [],
  createdAt: "2026-10-12T00:00:00Z", info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
const args = normalizeLogRotationRequest({ activePaths: ["/var/log/app.log"] });
const call = { id: "rotation-review", toolId: "logs.inspect_rotation", arguments: args };
const partial = () => ({ request: structuredClone(args), status: "partial", coverageComplete: false, files: [], configs: [], writers: [], sequence: null,
  sampledAt: "2026-10-12T01:00:00Z", finishedAt: "2026-10-12T01:00:01Z", elapsedMs: 1000, limitations: [...logRotationLimitations] });
beforeEach(async () => {
  vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  setActivePinia(createPinia()); useOpsStore().servers = [structuredClone(server)];
  vi.spyOn(backend, "checkSshConnection").mockResolvedValue(); vi.spyOn(backend, "saveCredential").mockResolvedValue(); vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
  await useConnectionStore().connect(server.id, { host: server.host, port: server.port, username: server.username, password: "fixture-only" });
});
afterEach(async () => { const store = useOpsStore(); store.stopConnectionMonitor(); await store.persist(true); store.$dispose(); vi.restoreAllMocks(); });

describe("B05 交叉审的实际完整性边界", () => {
  it("连接代际在返回前变化后，旧回执不能继续作为当前成功结果", async () => {
    vi.spyOn(backend, "executeCommand").mockImplementation(async () => {
      useConnectionStore().disconnect(server.id);
      return { success: true, simulated: true, exitCode: 0, output: "", stdout: "OPSARK_LOG_ROTATION " + JSON.stringify(partial()), stdoutTruncated: false };
    });
    const result = await useOpsStore().executeToolCall(server.id, call);
    expect(result.success).toBe(false);
  });
  it("partial不向用户或模型投影为匹配和完整结果", () => {
    const outcome = buildToolStepOutcome({ call, result: { callId: call.id, toolId: call.toolId, success: true, data: partial() },
      completedAt: "2026-10-12T01:00:02Z", evidenceId: "rotation-review-evidence" });
    expect(outcome.result.facts.evidenceComplete).toBe(false);
    expect(outcome.result.observationStatus).not.toBe("matched");
    expect(outcome.eventMessage).not.toContain("完整结果");
  });
  it("同一partial回执只刷新时钟不算新进展", () => {
    const first = partial(), second = partial(); second.sampledAt = "2026-10-12T02:00:00Z"; second.finishedAt = "2026-10-12T02:00:02Z"; second.elapsedMs = 2000;
    const step = data => ({ action: { type: "tool", toolId: call.toolId, arguments: args }, result: { executionStatus: "success" }, output: JSON.stringify(data) });
    expect(operationsProgressIdentity(step(first))).toBeTruthy();
    expect(operationsProgressIdentity(step(first))).toBe(operationsProgressIdentity(step(second)));
  });
});
