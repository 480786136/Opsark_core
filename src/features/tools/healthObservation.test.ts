import { describe, expect, it, vi } from "vitest";
import { normalizeHealthObservationRequest, healthObservationResultIssue } from "./healthObservation";
import { parseHealthObservationProbe, healthProbeStartReader } from "./healthObservationProbe";
import { executeHealthObservation } from "./healthObservationExecution";
import { executeToolCall } from "./toolExecutor";
import { defaultToolCatalog } from "./toolCatalog";
import { buildToolEvidenceFacts } from "./toolEvidence";
import { enforceToolResult } from "./toolResultContract";

const request = normalizeHealthObservationRequest({ url: "http://127.0.0.1:19001/health" });
const binding = { taskId: "task", roundId: "round", workflowEpoch: 1, stepId: "step", executionId: "observe" };
const raw = (id: string, exit: number, http: string) => ({ success: true, exitCode: 0,
  stdout: `OPSARK_HEALTH_STARTED ${id}\n\nOPSARK_HEALTH_RESULT ${id} ${exit} ${http}\n` });

describe("health window tool evidence", () => {
  it.each([[0, "200", "valid", true], [0, "503", "valid", false], [7, "000", "valid", false],
    [28, "000", "valid", false], [60, "000", "invalid", false], [0, "000", "invalid", false]] as const)(
    "distinguishes a real attempt from local failure (%s/%s)", (exit, http, status, matched) => {
      expect(parseHealthObservationProbe(request, "observe-p0", raw("observe-p0", exit, http))).toMatchObject({ status, matched });
    });
  it("does not treat truncated, mismatched or unsupported output as observation", () => {
    expect(parseHealthObservationProbe(request, "observe-p0", { ...raw("observe-p0", 0, "200"), stdoutTruncated: true }).status).toBe("invalid");
    expect(parseHealthObservationProbe(request, "observe-p0", raw("foreign-p0", 0, "200")).status).toBe("invalid");
    expect(parseHealthObservationProbe(request, "observe-p0", { success: true, exitCode: 0, stdout: "OPSARK_HEALTH_UNSUPPORTED observe-p0\n" }).status).toBe("unsupported");
    const start = vi.fn(), read = healthProbeStartReader("observe-p0", start);
    read("printf OPSARK_HEALTH_STARTED observe-p0\nOPSARK_HEALTH_STARTED foreign\n");
    expect(start).not.toHaveBeenCalled();
    read("OPSARK_HEALTH_STA"); read("RTED observe-p0\n"); read("OPSARK_HEALTH_STARTED observe-p0\n");
    expect(start).toHaveBeenCalledOnce();
  });
  it.each([{ url: "http://user:secret@localhost/" }, { url: "http://localhost/#fragment" },
    { url: "http://localhost/", windowSeconds: 1, intervalSeconds: 2 }, { url: "http://localhost/", absoluteDeadlineAt: "yesterday" }])(
    "rejects ambiguous health scope %j", value => expect(() => normalizeHealthObservationRequest(value)).toThrow());
  it("dispatches through the registry and retains original request/child identity", async () => {
    const saved: unknown[] = [], commands: string[] = [];
    const result = await executeToolCall({ id: "observe", toolId: "services.observe", arguments: request as unknown as Record<string, unknown> }, defaultToolCatalog, {
      getRemoteFileStructure: vi.fn(),
      observeService: args => executeHealthObservation(args, { binding, preparationStartedAt: Date.now() - 30_000 }, {
        assertCurrent: () => {}, isCancelled: () => false, persist: r => { saved.push(r); }, cancel: vi.fn(),
        execute: async (command, id, progress) => { commands.push(command); progress(`OPSARK_HEALTH_STARTED ${id}\n`); return raw(id, 0, "200"); },
      }),
    });
    expect(result.success).toBe(true);
    expect(saved.length).toBeGreaterThan(1);
    expect(commands).toHaveLength(1);
    expect(buildToolEvidenceFacts({ id: "observe", toolId: "services.observe", arguments: request as unknown as Record<string, unknown> }, result))
      .toMatchObject({ evidenceComplete: true, healthMatched: true, windowSatisfied: false, validSamples: 1 });
    const data = result.data as unknown as Awaited<ReturnType<typeof executeHealthObservation>>;
    expect(data.observation.preparationElapsedMs).toBeGreaterThanOrEqual(30_000);
    expect(data.observation.samples[0].executionId).toBe("observe-p0");
    expect(healthObservationResultIssue({ ...request, expectedStatus: 204 }, data)).toContain("不一致");
    const forged = structuredClone(result) as typeof result;
    (forged.data as unknown as typeof data).observation.windowSatisfied = true;
    expect(enforceToolResult({ id: "observe", toolId: "services.observe", arguments: request as unknown as Record<string, unknown> }, forged).success).toBe(false);
    for (const corrupt of [
      (record: typeof data) => { record.observation.binding.executionId = "foreign"; },
      (record: typeof data) => { record.observation.samples[0].executionId = "foreign-p0"; },
      (record: typeof data) => { record.observation.samples[0].facts!.httpStatus = null; record.observation.samples[0].matched = false; },
      (record: typeof data) => { record.observation.samples[0].facts!.remoteExitCode = 1; },
      (record: typeof data) => { record.request.absoluteDeadlineAt = "2026-10-12T00:00:00Z"; },
    ]) {
      const wrong = structuredClone(result); corrupt(wrong.data as unknown as typeof data);
      expect(enforceToolResult({ id: "observe", toolId: "services.observe", arguments: request as unknown as Record<string, unknown> }, wrong).success).toBe(false);
    }
  });
  it("cannot dispatch when durable preparation fails or the explicit deadline already passed", async () => {
    const execute = vi.fn();
    await expect(executeHealthObservation(request, { binding, preparationStartedAt: Date.now() }, {
      assertCurrent: () => {}, execute, cancel: vi.fn(), persist: () => { throw new Error("disk full"); }, isCancelled: () => false,
    })).rejects.toThrow("disk full");
    const stopped = await executeHealthObservation({ ...request, absoluteDeadlineAt: new Date(Date.now() - 1000).toISOString() }, { binding, preparationStartedAt: Date.now() - 2000 }, {
      assertCurrent: () => {}, execute, cancel: vi.fn(), persist: () => {}, isCancelled: () => false,
    });
    expect(stopped.observation).toMatchObject({ state: "absolute_deadline", windowSatisfied: false, samples: [] });
    expect(execute).not.toHaveBeenCalled();
  });
});
