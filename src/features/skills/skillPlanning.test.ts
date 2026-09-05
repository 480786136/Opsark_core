import { describe, expect, it } from "vitest";
import { builtInSkillCatalog } from "@/features/skills/skillCatalog";
import { planningSkills } from "@/features/skills/skillPlanning";
import { taskAttemptContext } from "@/features/agent/attemptState";
import { buildAdjustmentContext } from "@/features/agent/agentContext";
import type { OpsTask, PlanStep } from "@/types";

const task = (): OpsTask => ({ id: "task", title: "deploy", serverId: "server", modelId: "model",
  status: "running", permission: "safe", messages: [], plan: [], createdAt: "now", updatedAt: "now" });
const skill = () => structuredClone(builtInSkillCatalog.find(({ id }) => id === "application-deployment")!);
function read(current: OpsTask, facts = {}): PlanStep {
  return { id: "read", title: "read", description: "read", command: "read", kind: "observe",
    validation: "", expected: "read", risk: "low", status: "completed", attemptContext: taskAttemptContext(current),
    result: { executionStatus: "success", observationStatus: "matched", facts: { toolId: "files.read_content", ...facts }, warnings: [], evidenceIds: ["e"] } };
}

describe("evidence-driven Skill projection", () => {
  it("retains acceptance and global boundaries, opening software tools only after content evidence", () => {
    const current = task();
    const definition = skill();
    const initial = planningSkills(current, [definition])[0];
    expect(initial.allowedToolIds).not.toContain("software.check");
    expect(initial.allowedToolIds).toContain("context.expand");
    expect(initial.instructions).toContain(definition.planningContract!.acceptanceInstructions);
    expect(initial.instructions).toContain("不得为了“能启动”关闭 TLS");
    current.plan = [read(current)];
    expect(planningSkills(current, [definition])[0].allowedToolIds).toContain("software.check");
    current.credentialRevision = 1;
    expect(planningSkills(current, [definition])[0].allowedToolIds).not.toContain("software.check");
  });

  it("does not use truncated results, model prose or another target as stage evidence", () => {
    const current = task();
    current.plan = [read(current, { truncated: true })];
    expect(planningSkills(current, [skill()])[0].allowedToolIds).not.toContain("software.check");
    current.plan[0] = { ...read(current), attemptContext: "another-server" };
    expect(planningSkills(current, [skill()])[0].allowedToolIds).not.toContain("software.check");
  });

  it("falls back to full policies for failure, explicit expansion, and edited instructions", () => {
    const current = task();
    const definition = skill();
    current.plan = [{ ...read(current), status: "failed" }];
    expect(planningSkills(current, [definition])[0]).toEqual(definition);
    current.plan = [read(current, { toolId: "context.expand", expandedSkillId: definition.id })];
    expect(planningSkills(current, [definition])[0]).toEqual(definition);
    current.plan = [];
    definition.instructions += "\n自定义末尾验收";
    expect(planningSkills(current, [definition])[0]).toEqual(definition);
    const context = buildAdjustmentContext({ task: current, skills: [definition], tools: [], secretMetadata: [],
      metrics: { cpu: 0, memory: 0, disk: 0, networkIn: 0, networkOut: 0, sampledAt: "now" } });
    expect(context.activeSkills[0].instructions).toBe(definition.instructions);
  });

  it("shrinks only the initial source request and restores authentication after real execution", () => {
    const current = task();
    const source = builtInSkillCatalog.find(({ id }) => id === "project-source-acquisition")!;
    const initial = planningSkills(current, [source])[0];
    expect(initial.instructions.length).toBeLessThan(source.instructions.length);
    expect(initial.instructions).toContain("origin");
    expect(initial.instructions).not.toContain("git_https_repository");
    current.plan = [read(current)];
    expect(planningSkills(current, [source])[0].instructions).toBe(source.instructions);
  });
});
