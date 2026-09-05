import { describe, expect, it } from "vitest";
import {
  buildAgentContext,
  buildAdjustmentContext,
  buildContinuationContext,
  buildNextStageContext,
  extractKnownExecutionFacts,
  nextStagePolicyFingerprint,
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

  it("exposes reusable server credential group metadata to every task without values", () => {
    const shared = {
      scope: "server" as const,
      serverId: "server-1",
      credentialGroupId: "gitee-main",
      credentialKind: "git-https" as const,
      credentialTarget: "gitee.com",
      credentialLabel: "Gitee 主账号",
    };
    const context = buildAgentContext({
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 4, networkOut: 5, sampledAt: "now" },
      permission: "safe",
      conversationHistory: [],
      knownExecutionFacts: {},
      tools: resolveToolRegistry([]),
      secretMetadata: [{
        ...shared,
        key: "GIT_USERNAME",
        description: "Gitee 用户名",
        credentialRole: "username",
      }, {
        ...shared,
        key: "GIT_HTTP_CREDENTIAL",
        description: "Gitee 令牌",
        credentialRole: "secret",
      }],
      serverId: "server-1",
    });

    expect(context.serverCredentialGroups).toEqual([expect.objectContaining({
      ref: "server-credential:gitee-main",
      kind: "git-https",
      target: "gitee.com",
      usernamePlaceholder: "${secret.GIT_USERNAME}",
      secretPlaceholder: "${secret.GIT_HTTP_CREDENTIAL}",
    })]);
    expect(JSON.stringify(context)).not.toContain("developer@example.com");
    expect(JSON.stringify(context)).not.toContain("private-token");
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
      allowEmpty: true,
      currentActiveSkillIds: ["ssh-terminal-jump"],
    });
    expect(context.skillDirectory.map((skill) => skill.id)).toEqual([
      "ssh-terminal-jump",
      "project-source-acquisition",
      "software-installation",
      "project-build",
      "database-inspection-operations",
      "application-deployment",
      "file-transfer-integrity",
    ]);
    expect(context.activeSkills).toEqual([]);
    expect(context.skillDirectory[0].category).toBe("connectivity");
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

  it("preserves completed outputs and structured evidence from archived phases", () => {
    const task = createTask();
    task.plan = [];
    task.phaseHistory = [{
      id: "phase-1",
      roundId: "round-1",
      requirement: "部署项目",
      reason: "adjustment",
      createdAt: "now",
      completedAt: "now",
      plan: [{
        id: "read-readme",
        title: "读取 README",
        description: "确认项目入口",
        command: 'opsark-tool files.read_content {"path":"/opt/app/README.md"}',
        expected: "返回文档",
        validation: "true",
        risk: "low",
        status: "completed",
        output: "requires PHP 8.2",
        evidence: [{
          id: "evidence-1",
          type: "command-output",
          source: "main",
          facts: { path: "/opt/app/README.md" },
          rawOutput: "requires PHP 8.2",
          collectedAt: "now",
        }],
      }],
    }];

    const facts = extractKnownExecutionFacts(task);
    expect(facts.completedSteps[0]).toMatchObject({
      title: "读取 README",
      output: "requires PHP 8.2",
      evidence: [expect.objectContaining({ rawOutput: "requires PHP 8.2" })],
    });
  });

  it("安全门禁调整上下文只携带命中字段、结构化规则和相邻标题", () => {
    const task = createTask();
    const failed = {
      ...task.plan[0],
      id: "blocked",
      title: "验收数据库",
      command: "mysql -e 'SELECT 1'",
      validation: "test -f result; true",
      status: "failed" as const,
      output: `PRIVATE_OUTPUT_${"x".repeat(5_000)}`,
      result: {
        executionStatus: "blocked" as const,
        observationStatus: "unknown" as const,
        facts: {
          category: "plan_safety_rejection",
          field: "validation",
          ruleId: "UNCONDITIONAL_SUCCESS_TAIL",
          reason: "无条件 true 覆盖失败",
          snippet: "; true",
          repairable: false,
          issues: [{
            field: "validation",
            ruleId: "UNCONDITIONAL_SUCCESS_TAIL",
            reason: "无条件 true 覆盖失败",
            snippet: "; true",
            repairable: false,
          }],
        },
        warnings: [],
        evidenceIds: [],
        failureReason: "执行前安全拦截",
      },
    };
    task.plan = [
      { ...task.plan[0], id: "before", title: "前置检查", command: "UNRELATED_SECRET_COMMAND", status: "completed" },
      failed,
      { ...task.plan[0], id: "after", title: "启动服务", command: "ANOTHER_UNRELATED_COMMAND", status: "pending" },
    ];

    const context = buildAdjustmentContext({
      server: createServer(),
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 4, networkOut: 5, sampledAt: "now" },
      task,
      tools: resolveToolRegistry([]),
      secretMetadata: [],
    }, failed);
    const serialized = JSON.stringify(context);

    expect(context.failedStep).toMatchObject({
      stepIndex: 2,
      title: "验收数据库",
      offendingField: "validation",
      offendingFields: ["validation"],
      previousStepTitle: "前置检查",
      nextStepTitle: "启动服务",
      safetyIssue: { ruleId: "UNCONDITIONAL_SUCCESS_TAIL" },
    });
    expect(context.previousPlan).toEqual([
      { stepIndex: 1, title: "前置检查", status: "completed" },
      { stepIndex: 2, title: "验收数据库", status: "failed" },
      { stepIndex: 3, title: "启动服务", status: "pending" },
    ]);
    expect(serialized).not.toContain("PRIVATE_OUTPUT_");
    expect(serialized).not.toContain("UNRELATED_SECRET_COMMAND");
    expect(serialized).not.toContain("ANOTHER_UNRELATED_COMMAND");
    expect(context.instruction).toContain("命令尚未发送到服务器");
    expect(context.instruction).toContain("failedStep.offendingFields");
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
    expect(JSON.stringify(adjustment).indexOf('"tools"'))
      .toBeLessThan(JSON.stringify(adjustment).indexOf('"baseSnapshot"'));
    expect(JSON.stringify(continuation).indexOf('"tools"'))
      .toBeLessThan(JSON.stringify(continuation).indexOf('"completedDiscovery"'));
  });

  it("builds one next-stage context with only the active Skill tool policy", () => {
    const current = createTask();
    current.activeSkillIds = ["software-installation"];
    const skills = resolveSkillRegistry({ overrides: [], customSkills: [] })
      .filter((skill) => skill.id === "software-installation");
    const input = {
      server: createServer(),
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 4, networkOut: 5, sampledAt: "now" },
      task: current,
      tools: resolveToolRegistry([]),
      secretMetadata: [],
      skills,
    };
    const context = buildNextStageContext(input);

    expect(context.workflowPhase).toBe("decide_after_phase");
    expect(context.tools.map(({ id }) => id)).toEqual(["user.request_input", "software.check"]);
    expect(context.activeSkills[0].instructions).toContain("软件名称明确");
    expect(context.policyFingerprint).toBe(nextStagePolicyFingerprint(input));
    expect(JSON.stringify(context)).not.toContain("secret.merge_command");
    expect(JSON.stringify(context).indexOf('"tools"'))
      .toBeLessThan(JSON.stringify(context).indexOf('"baseSnapshot"'));

    const changedPermission = structuredClone(current);
    changedPermission.permission = "managed";
    expect(nextStagePolicyFingerprint({ ...input, task: changedPermission }))
      .not.toBe(context.policyFingerprint);

    const changedTools = structuredClone(input.tools);
    changedTools.find(({ id }) => id === "software.check")!.description += "（已更新）";
    expect(nextStagePolicyFingerprint({ ...input, tools: changedTools }))
      .not.toBe(context.policyFingerprint);

    expect(nextStagePolicyFingerprint({
      ...input,
      secretMetadata: [{ key: "NPM_TOKEN", description: "依赖令牌", scope: "server", serverId: "server-1" }],
    })).not.toBe(context.policyFingerprint);
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
