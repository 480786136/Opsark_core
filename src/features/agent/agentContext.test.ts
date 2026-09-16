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
import { taskAttemptContext } from "@/features/agent/attemptState";
import { planCommandIdentity } from "@/features/agent/taskProgression";
import { textFingerprint } from "@/features/agent/longRunningReviewOutput";
import { confirmedInputScope } from "@/features/agent/confirmedUserInputs";

describe("agent context", () => {
  it("does not rebuild the general decision snapshot for a persisted protocol repair", () => {
    const task = createTask();
    task.protocolRepair = { roundId: task.currentRoundId, serverId: task.serverId,
      repair: { errorCode: "plan_normalization_failed", validationError: "recovery command mutation",
        previousModelOutput: task.plan, instruction: "只修复command", fieldPath: "steps[0].command" },
      repairError: "no progress" };
    const input = { task, server: createServer(), tools: [], secretMetadata: [] };
    const context = buildAdjustmentContext(input, task.plan[0], { sharedSnapshot: { rawHistory: "must-not-return".repeat(30000) } });
    expect(context.baseSnapshot).toBeUndefined();
    expect(context.authentication).toBeUndefined();
    expect(context.planGenerationRepair).toBe(task.protocolRepair.repair);
    expect(context.permission).toBe(task.permission);
    expect(JSON.stringify(context)).not.toContain("must-not-return");
  });

  it("keeps current authority at the top level even when adjustment evidence uses a cached snapshot", () => {
    const current = createTask();
    current.rootGoal = "只读检查应用";
    current.permission = "safe";
    current.executionConstraints = { changePolicy: "read_only", environmentPolicy: "preserve", failurePolicy: "strict",
      prohibitedActions: ["修改"], requiredConditions: [], userDirectives: ["用户未授权修改"] };
    const input = { server: createServer(), task: current, metrics: undefined, tools: [], secretMetadata: [] };
    const context = buildAdjustmentContext(input, undefined, {
      sharedSnapshot: { task: { permission: "managed" }, executionConstraints: { changePolicy: "requested_changes_only" } },
    });
    expect(context.permission).toBe("safe");
    expect(context.executionConstraints?.changePolicy).toBe("read_only");
    expect(context.taskGoal.rootGoal).toBe("只读检查应用");
    expect(buildNextStageContext(input).permission).toBe("safe");
  });

  it("carries confirmed non-sensitive inputs through every planning context and cache identity", () => {
    const current = createTask();
    current.submittedInputs = {
      image_registry: {
        value: "registry.aliyuncs.com/google_containers",
        type: "select",
        label: "镜像仓库",
        description: "kubeadm 镜像仓库",
        groupId: "input-1",
        scope: confirmedInputScope(current, "input-1"),
        groupTitle: "部署源选择",
        submittedAt: "2026-09-15T07:50:52.000Z",
      },
    };
    current.submittedSecretBindings = {
      REGISTRY_TOKEN: {
        key: "REGISTRY_TOKEN",
        label: "SECRET_BINDING_MUST_NOT_LEAK",
        description: "SECRET_BINDING_MUST_NOT_LEAK",
        groupId: "secret-1",
        groupTitle: "secret",
        submittedAt: "2026-09-15T07:50:52.000Z",
      },
    };
    const workflowInput = {
      server: createServer(),
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 4, networkOut: 5, sampledAt: "now" },
      task: current,
      tools: resolveToolRegistry([]),
      secretMetadata: [],
    };
    const initial = buildAgentContext({
      ...workflowInput,
      permission: current.permission,
      conversationHistory: [],
      knownExecutionFacts: {},
      serverId: current.serverId,
    });
    const contexts = [
      initial,
      buildAdjustmentContext(workflowInput, current.plan[0]),
      buildContinuationContext(workflowInput),
      buildNextStageContext(workflowInput),
    ];

    for (const context of contexts) {
      expect(context.confirmedUserInputs?.items[0]).toMatchObject({
        key: "image_registry",
        value: "registry.aliyuncs.com/google_containers",
      });
      expect(JSON.stringify(context)).not.toContain("SECRET_BINDING_MUST_NOT_LEAK");
    }

    const changed = structuredClone(current);
    changed.submittedInputs!.image_registry.value = "registry.example.invalid/k8s";
    expect(nextStagePolicyFingerprint({ ...workflowInput, task: changed }))
      .not.toBe(nextStagePolicyFingerprint(workflowInput));
  });

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
      evidence: [expect.objectContaining({ rawOutputRef: "output" })],
    });
  });

  it("安全门禁调整上下文只携带命中字段、结构化规则和相邻标题", () => {
    const task = createTask();
    task.executionConstraints = { changePolicy: "read_only", environmentPolicy: "preserve", failurePolicy: "strict",
      prohibitedActions: ["修改"], requiredConditions: [], userDirectives: ["只允许检查"] };
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

    expect(context.permission).toBe(task.permission);
    expect(context.executionConstraints?.changePolicy).toBe("read_only");
    expect(context.taskGoal.rootGoal).toBeTruthy();
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

  it("carries valid completed identities across archived and current standalone phases", () => {
    const task = createTask();
    task.currentRoundId = "round-1";
    const attemptContext = taskAttemptContext(task);
    const prefix = { ...task.plan[0], id: "prefix", command: "uname -a", attemptContext };
    task.phaseHistory = [{
      id: "phase-prefix",
      roundId: "round-1",
      requirement: "部署 k8s 集群",
      reason: "replan",
      plan: [prefix],
      createdAt: "now",
      completedAt: "now",
    }];
    const standalone = {
      ...task.plan[0],
      id: "resolve-worker",
      command: 'opsark-tool server.resolve_connection {"host":"10.213.81.53","port":22}',
      attemptContext,
      result: {
        executionStatus: "success" as const,
        observationStatus: "matched" as const,
        facts: { toolId: "server.resolve_connection" },
        warnings: [],
        evidenceIds: [],
      },
    };
    task.plan = [standalone];

    const context = buildContinuationContext({
      task,
      tools: resolveToolRegistry([]),
      secretMetadata: [],
    });

    expect(new Set(context.completedCommandFingerprints)).toEqual(new Set([
      textFingerprint(planCommandIdentity(prefix.command)),
      textFingerprint(planCommandIdentity(standalone.command)),
    ]));
    expect(context.knownExecutionFacts.completedSteps.map(({ stepId }) => stepId)).toContain("prefix");
    expect(context.completedDiscovery.map(({ stepId }) => stepId)).toEqual(["resolve-worker"]);
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
    expect(context.tools.map(({ id }) => id)).toEqual(["user.request_input", "evidence.read", "software.check"]);
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
