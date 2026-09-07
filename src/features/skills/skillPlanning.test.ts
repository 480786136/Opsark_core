import { describe, expect, it } from "vitest";
import { builtInSkillCatalog } from "@/features/skills/skillCatalog";
import { planningSkills } from "@/features/skills/skillPlanning";
import { taskAttemptContext } from "@/features/agent/attemptState";
import { buildAdjustmentContext } from "@/features/agent/agentContext";
import { buildToolStepOutcome } from "@/features/agent/toolStepResult";
import type { OpsTask, PlanStep } from "@/types";

const task = (): OpsTask => ({ id: "task", title: "deploy", serverId: "server", modelId: "model",
  status: "running", permission: "safe", messages: [], plan: [], createdAt: "now", updatedAt: "now" });
const skill = (id = "application-deployment") => structuredClone(builtInSkillCatalog.find(item => item.id === id)!);
function read(current: OpsTask, path = "/app/package.json", content = '{"scripts":{"build":"vite build"}}', truncated = false): PlanStep {
  const call = { id: `call-${path}`, toolId: "files.read_content", arguments: { path } };
  const bytes = new TextEncoder().encode(content).length;
  const outcome = buildToolStepOutcome({ call, evidenceId: `e-${path}`, completedAt: "now",
    result: { callId: call.id, toolId: call.toolId, success: true,
      data: { path, content, encoding: "utf-8", totalBytes: bytes, returnedBytes: bytes, truncated } } });
  return { id: path, title: "read", description: "read", command: "read", kind: "observe",
    validation: "", expected: "read", risk: "low", attemptContext: taskAttemptContext(current), ...outcome };
}

// Each transition requires its own product; later evidence cannot skip missing earlier exits.
function orderedSkill() {
  const definition = skill();
  const contract = definition.planningContract!;
  contract.evidenceAdapters = [];
  contract.stages = ["first", "second", "third"].map((id, index) => ({
    id, title: id, instructions: `rules-${id}`, allowedToolIds: ["files.read_content"], requiresTools: [],
    requiresEvidence: index ? [{ kind: "file_content", scope: `/app/${index}.txt` }] : [],
    exitRequirements: [{ kind: "file_content", scope: `/app/${index + 1}.txt` }],
    exitEvidence: `product-${id}`,
  }));
  return definition;
}

describe("evidence-driven Skill projection", () => {
  it("keeps build acceptance and recovery boundaries through discovery and preparation", () => {
    const current = task();
    const build = skill("project-build");
    const initial = planningSkills(current, [build])[0];
    expect(initial.instructions.length).toBeLessThan(build.instructions.length);
    expect(initial.instructions).toContain(build.planningContract!.acceptanceInstructions);
    expect(initial.instructions).toContain("真实退出码");
    expect(initial.instructions).toContain("没有证据时不得切换镜像");
    expect(initial.allowedToolIds).toContain("context.expand");
    expect(initial.instructions).toContain("当前阶段 discover");
    current.plan = [read(current)];
    const prepared = planningSkills(current, [build])[0];
    expect(prepared.instructions).toContain("当前阶段 prepare");
    expect(prepared.instructions).toContain(build.planningContract!.acceptanceInstructions);
    expect(prepared.instructions).toContain("--production=false 表示包含开发依赖");
    expect(prepared.allowedToolIds).toContain("software.check");
  });

  it("opens software tools after parsed manifest evidence and loses it on credential changes", () => {
    const current = task();
    const definition = skill();
    const initial = planningSkills(current, [definition])[0];
    expect(initial.instructions.length).toBeLessThan(definition.instructions.length);
    expect(initial.allowedToolIds).not.toContain("software.check");
    expect(initial.allowedToolIds).toContain("context.expand");
    expect(initial.instructions).toContain(definition.planningContract!.acceptanceInstructions);
    expect(initial.instructions).toContain("不得为了“能启动”关闭 TLS");
    current.plan = [read(current)];
    expect(planningSkills(current, [definition])[0].allowedToolIds).toContain("software.check");
    current.credentialRevision = 1;
    expect(planningSkills(current, [definition])[0].allowedToolIds).not.toContain("software.check");
  });

  it.each([
    ["/app/README.md", '{"scripts":{"build":"vite build"}}', false],
    ["/app/package.json", "{}", false],
    ["/app/package.json", "not json", false],
    ["/app/package.json", '{"scripts":{"build":"vite build"}}', true],
  ])("does not advance from unsupported or partial content at %s (%s, partial=%s)", (path, content, truncated) => {
    const current = task();
    current.plan = [read(current, path, content, truncated)];
    expect(planningSkills(current, [skill()])[0].instructions).toContain("当前阶段 discover");
  });

  it("rejects unlinked facts and observations from another target", () => {
    const current = task();
    current.plan = [read(current)];
    current.plan[0].evidence = [];
    expect(planningSkills(current, [skill()])[0].instructions).toContain("当前阶段 discover");
    current.plan = [{ ...read(current), attemptContext: "another-server" }];
    expect(planningSkills(current, [skill()])[0].instructions).toContain("当前阶段 discover");
  });

  it("walks exits in order without changing completion state", () => {
    const current = task();
    const definition = orderedSkill();
    current.plan = [read(current, "/app/2.txt", "second")];
    expect(planningSkills(current, [definition])[0].instructions).toContain("当前阶段 first");
    current.plan.push(read(current, "/app/1.txt", "first"));
    expect(planningSkills(current, [definition])[0].instructions).toContain("当前阶段 third");
    current.plan.push(read(current, "/app/3.txt", "third"));
    const before = structuredClone(current);
    expect(planningSkills(current, [definition])[0]).toEqual(definition);
    expect(current).toEqual(before);
    expect(current.status).toBe("running");
  });

  it("uses full rules when a stage exit is met but the next entry is not", () => {
    const current = task();
    const definition = orderedSkill();
    definition.planningContract!.stages[1].requiresEvidence = [{ kind: "software_check" }];
    current.plan = [read(current, "/app/1.txt", "first")];
    expect(planningSkills(current, [definition])[0]).toEqual(definition);
  });

  it("falls back for missing machine exits and unknown requirement selectors", () => {
    const current = task();
    const missing = orderedSkill();
    delete missing.planningContract!.stages[0].exitRequirements;
    expect(planningSkills(current, [missing])[0]).toEqual(missing);
    const unknown = orderedSkill();
    Object.assign(unknown.planningContract!.stages[0].exitRequirements![0], { pathPattern: "/app/*" });
    expect(planningSkills(current, [unknown])[0]).toEqual(unknown);
    const toolOnly = orderedSkill();
    toolOnly.planningContract!.stages[0].requiresTools = ["files.read_content"];
    expect(planningSkills(current, [toolOnly])[0]).toEqual(toolOnly);
  });

  it("restores full rules after executed changes instead of repeating discovery", () => {
    const current = task();
    const definition = skill();
    const change = read(current);
    change.id = "install";
    change.kind = "change";
    change.result!.facts.commandDispatched = true;
    current.plan = [read(current), change];
    expect(planningSkills(current, [definition])[0]).toEqual(definition);
  });

  it("falls back to full policies for failure, explicit expansion, and edited instructions", () => {
    const current = task();
    const definition = skill();
    current.plan = [{ ...read(current), status: "failed" }];
    expect(planningSkills(current, [definition])[0]).toEqual(definition);
    const expanded = read(current);
    expanded.result!.facts = { toolId: "context.expand", expandedSkillId: definition.id };
    current.plan = [expanded];
    expect(planningSkills(current, [definition])[0]).toEqual(definition);
    current.plan = [];
    definition.instructions += "\n自定义末尾验收";
    expect(planningSkills(current, [definition])[0]).toEqual(definition);
    const context = buildAdjustmentContext({ task: current, skills: [definition], tools: [], secretMetadata: [],
      metrics: { cpu: 0, memory: 0, disk: 0, networkIn: 0, networkOut: 0, sampledAt: "now" } });
    expect(context.activeSkills[0].instructions).toBe(definition.instructions);
    delete definition.planningContract;
    expect(planningSkills(current, [definition])[0]).toEqual(definition);
  });

  it("shrinks only the initial source request and restores authentication after real execution", () => {
    const current = task();
    const source = skill("project-source-acquisition");
    const initial = planningSkills(current, [source])[0];
    expect(initial.instructions.length).toBeLessThan(source.instructions.length);
    expect(initial.instructions).toContain("origin");
    expect(initial.instructions).not.toContain("git_https_repository");
    current.plan = [read(current)];
    expect(planningSkills(current, [source])[0].instructions).toBe(source.instructions);
  });
});
