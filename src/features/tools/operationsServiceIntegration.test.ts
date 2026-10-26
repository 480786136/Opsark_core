import { describe, expect, it } from "vitest";
import { enforceToolResult } from "./toolResultContract";
import { normalizeOperationsRequest, parseOperationsOutput, redactOperationsObservations, type OperationsInspectionResult } from "./operationsInspection";
import { buildToolEvidenceFacts } from "./toolEvidence";
import { operationsProgressIdentity } from "./operationsObservation";
import type { PlanStep } from "@/types";

function fixture() {
  const request = normalizeOperationsRequest("services.inspect", { service: "fixture.service", check: "status" });
  const properties = { Id: "fixture.service", LoadState: "loaded", ActiveState: "active", SubState: "running", MainPID: "123",
    UnitFileState: "enabled", ExecStart: "/opt/fixture/bin/app --token=fixture-private-value" };
  const item = { kind: "service", subject: "fixture.service", text: Object.entries(properties).map(([key, value]) => `${key}=${value}`).join("\n"), exitCode: 0,
    properties, processIdentity: { status: "stable", service: "fixture.service", sampleStartedAt: "2026-10-12T01:00:00Z", sampleFinishedAt: "2026-10-12T01:00:01Z",
      consistency: "sampled_non_atomic", pid: 123, bootId: "00000000-0000-0000-0000-000000000001", startTimeTicks: "9007199254740999", verificationExitCode: 0 } };
  const data: OperationsInspectionResult = { request, items: [item], status: "complete", scannedEntries: 0, matchedEntries: 1, skippedCount: 0, skipped: [],
    coverageComplete: true, truncated: false, elapsedMs: 1000, finishedAt: "2026-10-12T01:00:01Z" };
  const call = { id: "call", toolId: "services.inspect", arguments: request };
  return { call, data, item };
}
const check = (f: ReturnType<typeof fixture>) => enforceToolResult(f.call, { callId: f.call.id, toolId: f.call.toolId, success: true, data: f.data });
describe("structured service evidence boundary", () => {
  it("records sampled process identity without claiming restart or reboot verification", () => {
    const f = fixture(), result = check(f);
    expect(result.success).toBe(true);
    expect(buildToolEvidenceFacts(f.call, result)).toMatchObject({ evidenceComplete: true, processIdentityVerified: true, restartVerified: false, bootAutostartVerified: false });
  });
  it.each(["service", "pid", "time", "properties", "duplicate", "verification"])("rejects inconsistent %s", kind => {
    const f = fixture();
    if (kind === "service") f.item.processIdentity.service = "other.service";
    if (kind === "pid") f.item.processIdentity.pid = 456;
    if (kind === "time") f.item.processIdentity.sampleFinishedAt = "2026-10-11T00:00:00Z";
    if (kind === "properties") f.item.properties.ActiveState = "inactive";
    if (kind === "duplicate") f.item.text += "\nMainPID=123";
    if (kind === "verification") f.item.processIdentity.verificationExitCode = 1;
    expect(check(f).success).toBe(false);
  });
  it("redacts both representations and refuses to reuse redacted semantic evidence", () => {
    const f = fixture();
    redactOperationsObservations(f.data, value => value.split("fixture-private-value").join("[REDACTED]"));
    const result = check(f);
    expect(result.success).toBe(true); expect(JSON.stringify(result)).not.toContain("fixture-private-value");
    expect(buildToolEvidenceFacts(f.call, result)).toMatchObject({ evidenceComplete: false, processIdentityVerified: false });
    expect(() => parseOperationsOutput(f.call.toolId, f.call.arguments, `OPSARK_RESULT ${JSON.stringify(f.data)}`)).toThrow("远端采集不能声明");
  });
  it("accepts old status receipts without inventing process identity", () => {
    const f = fixture(); Reflect.deleteProperty(f.item, "properties"); Reflect.deleteProperty(f.item, "processIdentity");
    const result = check(f); expect(result.success).toBe(true);
    expect(buildToolEvidenceFacts(f.call, result).processIdentityVerified).toBe(false);
  });
  it("does not count newer sample timestamps as progress but retains process replacement", () => {
    const f = fixture();
    const step = { action: { type: "tool", toolId: f.call.toolId, arguments: f.call.arguments }, result: { executionStatus: "success" }, output: JSON.stringify(f.data) } as PlanStep;
    const first = operationsProgressIdentity(step);
    f.item.processIdentity.sampleStartedAt = "2026-10-12T01:01:00Z"; f.item.processIdentity.sampleFinishedAt = "2026-10-12T01:01:01Z";
    f.data.finishedAt = "2026-10-12T01:01:01Z"; step.output = JSON.stringify(f.data);
    expect(operationsProgressIdentity(step)).toBe(first);
    f.item.processIdentity.startTimeTicks = "9007199254741100"; step.output = JSON.stringify(f.data);
    expect(operationsProgressIdentity(step)).not.toBe(first);
  });
});
