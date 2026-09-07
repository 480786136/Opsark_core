import { describe, expect, it } from "vitest";
import { collectPlanningEvidence, planningEvidenceSatisfies } from "./planningEvidence";
import { buildToolStepOutcome } from "@/features/agent/toolStepResult";
import { taskAttemptContext } from "@/features/agent/attemptState";
import type { OpsTask, PlanStep } from "@/types";

const task = (): OpsTask => ({ id: "task", title: "deploy", serverId: "server", modelId: "model",
  status: "running", permission: "safe", messages: [], plan: [], createdAt: "now", updatedAt: "now" });
function read(current: OpsTask, id: string, path = "/app/package.json", truncated = false): PlanStep {
  const content = '{"scripts":{"build":"vite build"},"engines":{"node":">=20"}}';
  const bytes = new TextEncoder().encode(content).length;
  const call = { id, toolId: "files.read_content", arguments: { path } };
  return { id, title: "read", description: "read", command: "read", kind: "observe", validation: "",
    expected: "read", risk: "low", attemptContext: taskAttemptContext(current),
    ...buildToolStepOutcome({ call, completedAt: "now", evidenceId: `e-${id}`,
      result: { callId: id, toolId: call.toolId, success: true,
        data: { path, content, encoding: "utf-8", totalBytes: bytes, returnedBytes: bytes, truncated } } }) };
}
const manifests = (current: OpsTask) => collectPlanningEvidence(current, ["project_manifest"])
  .filter(item => item.kind === "project_manifest");

describe("planning evidence collection and matching", () => {
  it("derives manifest facts only with an enabled adapter and keeps a source reference", () => {
    const current = task();
    current.plan = [read(current, "read")];
    expect(collectPlanningEvidence(current).map(item => item.kind)).toEqual(["file_content"]);
    expect(manifests(current)).toMatchObject([{ evidenceId: "e-read", stepId: "read", scope: "/app/package.json",
      facts: { manifestFormat: "npm", buildEntryKnown: true, runtimeRequirementKnown: true, projectDirectory: "/app" } }]);
    expect(JSON.stringify(manifests(current))).not.toContain("vite build");
  });

  it("uses the same path normalization as tool evidence", () => {
    const current = task();
    current.plan = [read(current, "read", "/app//./package.json")];
    expect(manifests(current)[0]?.scope).toBe("/app/package.json");
  });

  it("requires linked main evidence with consistent completion metadata", () => {
    for (const alter of [
      (step: PlanStep) => { step.result!.evidenceIds = []; },
      (step: PlanStep) => { step.evidence![0].source = "validation"; },
      (step: PlanStep) => { step.evidence![0].facts = { ...step.result!.facts, truncated: true }; },
      (step: PlanStep) => { step.evidence![0].facts = { ...step.result!.facts, evidenceFingerprint: "changed" }; },
    ]) {
      const current = task();
      const step = read(current, "read");
      alter(step);
      current.plan = [step];
      expect(manifests(current)).toEqual([]);
    }
  });

  it("lets the latest partial read replace complete evidence for the same resource", () => {
    const current = task();
    current.plan = [read(current, "first"), read(current, "second", "/app/package.json", true)];
    expect(manifests(current)).toEqual([]);
    const evidence = collectPlanningEvidence(current);
    expect(evidence).toHaveLength(1);
    expect(planningEvidenceSatisfies(evidence, [{ kind: "file_content" }])).toBe(false);
    expect(planningEvidenceSatisfies(evidence, [{ kind: "file_content", complete: false }])).toBe(true);
  });

  it("invalidates evidence after target, session, credential, or actual state changes", () => {
    for (const mutate of [
      (current: OpsTask) => { current.executionTargetServerId = "other"; },
      (current: OpsTask) => { current.agentSessionGeneration = 1; },
      (current: OpsTask) => { current.credentialRevision = 1; },
      (current: OpsTask) => {
        const change = read(current, "install");
        change.kind = "change";
        change.result!.facts.commandDispatched = true;
        current.plan.push(change);
      },
    ]) {
      const current = task();
      current.plan = [read(current, "read")];
      mutate(current);
      expect(manifests(current)).toEqual([]);
    }
  });

  it("matches exact resource and fact predicates and counts distinct resources", () => {
    const current = task();
    current.plan = [read(current, "first"), read(current, "second")];
    const evidence = manifests(current);
    expect(planningEvidenceSatisfies(evidence, [{ kind: "project_manifest", scope: "/other/package.json" }])).toBe(false);
    expect(planningEvidenceSatisfies(evidence, [{ kind: "project_manifest", facts: { manifestFormat: "maven" } }])).toBe(false);
    expect(planningEvidenceSatisfies(evidence, [{ kind: "project_manifest", toolIds: ["custom.read"] }])).toBe(false);
    expect(planningEvidenceSatisfies([...evidence, { ...evidence[0], toolId: "alias" }],
      [{ kind: "project_manifest", minCount: 2 }])).toBe(false);
    current.plan.push(read(current, "third", "/other/package.json"));
    expect(planningEvidenceSatisfies(manifests(current), [{ kind: "project_manifest", minCount: 2 }])).toBe(true);
    expect(planningEvidenceSatisfies(evidence, [
      { kind: "project_manifest", facts: { manifestFormat: "npm" } },
      { kind: "project_manifest", facts: { buildEntryKnown: true } },
    ])).toBe(true);
  });
});
