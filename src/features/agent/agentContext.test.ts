import { describe, expect, it } from "vitest";
import {
  buildAgentContext,
  buildAdjustmentContext,
  buildContinuationContext,
  extractKnownExecutionFacts,
} from "@/features/agent/agentContext";
import type { OpsTask, ServerProfile } from "@/types";
import { resolveToolRegistry } from "@/features/tools/toolRegistry";
import { resolveSkillRegistry } from "@/features/skills/skillRegistry";

describe("agent context", () => {
  it("contains enabled tools and secret metadata without values", () => {
    const context = buildAgentContext({
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 4, networkOut: 5, sampledAt: "now" },
      permission: "safe",
      conversationHistory: [],
      knownExecutionFacts: {},
      tools: resolveToolRegistry([{ id: "server.realtime_metrics", enabled: false }]),
      secretMetadata: [{ key: "TOKEN", description: "部署令牌", scope: "server", serverId: "server-1" }],
      serverId: "server-1",
    });

    expect(context.tools.some((tool) => tool.id === "server.realtime_metrics")).toBe(false);
    expect(context.secretVariables).toEqual([{ key: "TOKEN", description: "部署令牌", placeholder: "${secret.TOKEN}" }]);
    expect(JSON.stringify(context)).not.toContain("secretValues");
  });

  it("provides a selectable Skill directory without loading workflow instructions", () => {
    const skills = resolveSkillRegistry({ overrides: [], customSkills: [] });
    const context = buildAgentContext({
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 4, networkOut: 5, sampledAt: "now" },
      permission: "safe",
      conversationHistory: [],
      knownExecutionFacts: {},
      tools: resolveToolRegistry([]),
      skills: [skills[0]],
      skillDirectory: skills,
      secretMetadata: [],
      serverId: "server-1",
    });

    expect(context.skillSelection).toEqual({
      mode: "model",
      multiple: true,
      currentActiveSkillIds: ["ssh-terminal-jump"],
    });
    expect(context.skillDirectory.map((skill) => skill.id)).toEqual([
      "ssh-terminal-jump",
      "project-source-acquisition",
      "project-build",
      "file-transfer-integrity",
    ]);
    expect(context.activeSkills).toEqual([]);
    expect(JSON.stringify(context.skillDirectory)).not.toContain("server.resolve_connection");
  });

  it("extracts domain facts through the active project skill", () => {
    const task = createTask();
    task.activeSkillIds = ["project-build"];
    task.plan[0].command = "git clone https://example.com/team/app.git /opt/app && cd /opt/app";
    task.plan[0].output = "deployed at /var/www/app";
    const facts = extractKnownExecutionFacts(task);

    expect(facts.skillFacts["project-build"]).toMatchObject({
      repositoryUrls: ["https://example.com/team/app.git"],
      workingDirectories: expect.arrayContaining(["/opt/app"]),
    });
  });

  it("builds consistent adjustment and continuation contexts", () => {
    const task = createTask();
    const input = {
      server: createServer(),
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 4, networkOut: 5, sampledAt: "now" },
      task,
      tools: resolveToolRegistry([]),
      secretMetadata: [{ key: "TOKEN", description: "部署令牌", scope: "server" as const, serverId: "server-1" }],
    };
    const adjustment = buildAdjustmentContext(input, task.plan[0]);
    const continuation = buildContinuationContext(input);

    expect(adjustment.workflowPhase).toBe("adjust_after_failure");
    expect(continuation.workflowPhase).toBe("continue_after_discovery");
    expect(adjustment.tools).toEqual(expect.arrayContaining([expect.objectContaining({ id: "files.get_structure" })]));
    expect(continuation.completedDiscovery[0].output).toContain("ok");
    expect(JSON.stringify({ adjustment, continuation })).not.toContain("secret-value");
  });
});

function createTask(): OpsTask {
  return {
    id: "task-1",
    serverId: "server-1",
    title: "部署",
    status: "running",
    permission: "safe",
    modelId: "model-1",
    messages: [],
    plan: [{
      id: "step-1",
      title: "发现",
      description: "读取状态",
      command: "pwd",
      risk: "low",
      expected: "返回路径",
      validation: "true",
      status: "completed",
      output: "ok",
    }],
    createdAt: "now",
    updatedAt: "now",
  };
}

function createServer(): ServerProfile {
  return {
    id: "server-1",
    name: "测试服务器",
    host: "example.invalid",
    port: 22,
    username: "ops",
    group: "test",
    status: "online",
    environment: [],
    info: { os: "Linux", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" },
    createdAt: "now",
  };
}
