import { describe, expect, it, vi } from "vitest";
import {
  buildCompactFailedSummarySteps,
  buildFailedTaskSummaryContext,
  planDiscoveryContinuation,
  planTaskAdjustment,
  reviewTaskGoal,
  summarizeFailedTask,
  summarizeTaskExecution,
} from "@/features/agent/agentService";
import type { ModelProfile, OpsTask, PlanStep } from "@/types";

const model: ModelProfile = {
  id: "model-1",
  name: "Model",
  provider: "Remote",
  model: "model-v1",
  endpoint: "https://model.test",
  enabled: true,
  hasApiKey: true,
};

const step = (id: string, command: string, status: PlanStep["status"] = "completed"): PlanStep => ({
  id,
  title: id,
  description: id,
  command,
  risk: "low",
  expected: "success",
  validation: "true",
  status,
});

const task = (): OpsTask => ({
  id: "task-1",
  serverId: "server-1",
  title: "Deploy",
  status: "running",
  permission: "safe",
  modelId: model.id,
  messages: [{
    id: "message-1",
    role: "user",
    kind: "message",
    content: "Deploy the application",
    createdAt: "2026-08-14T00:00:00.000Z",
  }],
  plan: [step("inspect", "pwd")],
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
});

const generationSettings = {
  limitOutput: false,
  maxPlanSteps: 6,
  maxOutputTokens: 5000,
  maxTextChars: 200,
  maxCommandChars: 4000,
};

describe("agentService", () => {
  it("builds discovery context and removes repeated continuation commands", async () => {
    const generatePlan = vi.fn().mockResolvedValue([
      step("duplicate", " pwd ", "pending"),
      step("deploy", "npm run deploy", "pending"),
    ]);
    const continuation = await planDiscoveryContinuation({
      task: task(),
      requirement: "Deploy the application",
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 0, networkOut: 0, sampledAt: "now" },
      tools: [],
      secretMetadata: [],
      model,
      apiKey: "secret-key",
      generationSettings,
    }, generatePlan);

    expect(continuation.map((item) => item.id)).toEqual(["deploy"]);
    expect(generatePlan).toHaveBeenCalledWith(
      expect.stringContaining("发现阶段已完成"),
      expect.objectContaining({ apiKey: "secret-key", context: expect.stringContaining("continue_after_discovery") }),
    );
  });

  it("rejects a continuation that contains no new executable command", async () => {
    await expect(planDiscoveryContinuation({
      task: task(),
      requirement: "Deploy",
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 0, networkOut: 0, sampledAt: "now" },
      tools: [],
      secretMetadata: [],
      model,
      apiKey: "secret-key",
      generationSettings,
    }, vi.fn().mockResolvedValue([step("duplicate", "pwd", "pending")]))).rejects.toThrow(
      "模型未返回可执行的后续步骤",
    );
  });

  it("generates an adjustment plan without re-queueing completed evidence", async () => {
    const currentTask = task();
    currentTask.plan = [
      step("old-1", "echo 1"),
      step("old-2", "echo 2"),
      step("old-3", "echo 3"),
      step("old-4", "echo 4"),
      step("old-5", "echo 5"),
      step("failed", "npm run deploy", "failed"),
    ];
    const replacement = step("repair", "npm ci", "pending");
    const generatePlan = vi.fn().mockResolvedValue([replacement]);
    const sharedSnapshot = { version: 1, snapshotFingerprint: "shared-snapshot" };
    const result = await planTaskAdjustment({
      task: currentTask,
      failedStep: currentTask.plan[5],
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 0, networkOut: 0, sampledAt: "now" },
      tools: [],
      secretMetadata: [],
      model,
      apiKey: "secret-key",
      generationSettings,
      sharedSnapshot,
      reviewDecision: {
        decision: "adjust",
        reason: "acceptance missing",
        summary: "continue deployment",
        source: "model",
      },
    }, generatePlan);

    expect(result.plan.map((item) => item.id)).toEqual(["repair"]);
    expect(result.context).toMatchObject({ workflowPhase: "adjust_after_failure" });
    const context = JSON.parse(generatePlan.mock.calls[0][1].context);
    expect(context.baseSnapshot).toEqual(sharedSnapshot);
    expect(context.adjustmentTrigger.reviewDecision).toMatchObject({
      decision: "adjust",
      summary: "continue deployment",
    });
  });

  it("安全门禁局部调整只提交命中字段并接受单步精确修复", async () => {
    const currentTask = task();
    const failed = {
      ...step("failed", "deploy production", "failed"),
      validation: "test -f release; true",
      result: {
        executionStatus: "blocked" as const,
        observationStatus: "unknown" as const,
        facts: {
          category: "plan_safety_rejection",
          field: "validation",
          issues: [{
            field: "validation",
            ruleId: "UNCONDITIONAL_SUCCESS_TAIL",
            reason: "true masks status",
            snippet: "; true",
            repairable: false,
          }],
        },
        warnings: [],
        evidenceIds: [],
      },
    };
    currentTask.plan = [failed];
    const replacement = {
      ...failed,
      id: "replacement",
      status: "pending" as const,
      validation: "test -f release",
      result: undefined,
    };
    const generatePlan = vi.fn().mockResolvedValue([replacement]);

    const result = await planTaskAdjustment({
      task: currentTask,
      failedStep: failed,
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 0, networkOut: 0, sampledAt: "now" },
      tools: [],
      secretMetadata: [],
      model,
      apiKey: "secret-key",
      generationSettings,
    }, generatePlan);

    expect(result.plan).toHaveLength(1);
    expect(result.plan[0].command).toBe(failed.command);
    expect(result.plan[0].validation).toBe("test -f release");
    expect(generatePlan.mock.calls[0][0]).toContain("只修复该步骤的 validation 字段");
    expect(JSON.parse(generatePlan.mock.calls[0][1].context)).toMatchObject({
      failedStep: {
        offendingFields: ["validation"],
        safetyIssues: [expect.objectContaining({ ruleId: "UNCONDITIONAL_SUCCESS_TAIL" })],
      },
    });
  });

  it("拒绝安全门禁局部调整改写未命中字段或追加步骤", async () => {
    const currentTask = task();
    const failed = {
      ...step("failed", "deploy production", "failed"),
      validation: "test -f release; true",
      result: {
        executionStatus: "blocked" as const,
        observationStatus: "unknown" as const,
        facts: { category: "plan_safety_rejection", field: "validation" },
        warnings: [],
        evidenceIds: [],
      },
    };
    currentTask.plan = [failed];
    const baseInput = {
      task: currentTask,
      failedStep: failed,
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 0, networkOut: 0, sampledAt: "now" },
      tools: [],
      secretMetadata: [],
      model,
      apiKey: "secret-key",
      generationSettings,
    };

    await expect(planTaskAdjustment(baseInput, vi.fn().mockResolvedValue([{
      ...failed,
      id: "scope-drift",
      status: "pending",
      command: "deploy production --force",
      validation: "test -f release",
    }]))).rejects.toThrow("只允许修改 validation 字段");

    await expect(planTaskAdjustment(baseInput, vi.fn().mockResolvedValue([
      { ...failed, id: "repair", status: "pending", validation: "test -f release" },
      step("extra", "restart everything", "pending"),
    ]))).rejects.toThrow("只能返回一个替代步骤");
  });

  it("generates a summary and reports the model audit snapshot", async () => {
    const onModelRequest = vi.fn();
    const generateSummary = vi.fn().mockResolvedValue("Completed");
    const result = await summarizeTaskExecution({
      task: task(),
      model,
      apiKey: "secret-key",
      onModelRequest,
    }, generateSummary);

    expect(result).toEqual({
      summary: "Completed",
      requirement: "Deploy the application",
      usedModel: true,
    });
    expect(onModelRequest).toHaveBeenCalledWith(expect.objectContaining({ requirement: "Deploy the application" }));
    expect(generateSummary).toHaveBeenCalledWith(
      "Deploy the application",
      expect.any(Array),
      expect.objectContaining({ apiKey: "secret-key" }),
    );
  });

  it("combines a deterministic failure reason with the generated summary", async () => {
    const result = await summarizeFailedTask({
      task: task(),
      reason: "retry limit reached",
      model,
      apiKey: "secret-key",
    }, vi.fn().mockResolvedValue("The deployment command failed."));

    expect(result.summary).toContain("本轮任务未完成：retry limit reached");
    expect(result.summary).toContain("最新阻断：retry limit reached");
    expect(result.summary).toContain("补充说明（不改变以上程序结论）：The deployment command failed.");
    expect(result.usedModel).toBe(true);
  });

  it("passes the deterministic reason, latest blocker and fact split to the failure summary model", async () => {
    const currentTask = task();
    currentTask.plan = [
      {
        ...step("install-git", "dnf install -y git"),
        result: {
          executionStatus: "success",
          observationStatus: "matched",
          exitCode: 0,
          facts: { version: "2.43.0", accessToken: "must-not-leak" },
          warnings: [],
          evidenceIds: ["evidence-git"],
        },
      },
      {
        ...step("clone", "git clone https://gitee.com/team/app.git", "failed"),
        output: "raw terminal output contains super-secret-token",
        evidence: [{
          id: "evidence-clone",
          type: "command-output",
          source: "main",
          facts: { transcriptSecret: "super-secret-token" },
          rawOutput: "full raw evidence super-secret-token",
          collectedAt: "2026-08-14T00:02:00.000Z",
        }],
        result: {
          executionStatus: "blocked",
          observationStatus: "unknown",
          facts: { category: "terminal_busy", commandCompleted: false },
          warnings: [],
          evidenceIds: [],
          failureReason: "上一条超时命令未释放终端",
        },
      },
      step("acceptance", "git -C /opt/app rev-parse HEAD", "pending"),
    ];
    const generateSummary = vi.fn().mockResolvedValue("终端恢复后可继续。");

    const result = await summarizeFailedTask({
      task: currentTask,
      reason: "自动调整已达上限",
      model,
      apiKey: "secret-key",
    }, generateSummary);

    const passedRequirement = generateSummary.mock.calls[0][0] as string;
    expect(passedRequirement).toContain('"deterministicFinalReason":"自动调整已达上限"');
    expect(passedRequirement).toContain('"reason":"上一条超时命令未释放终端"');
    expect(passedRequirement).toContain('"confirmedFacts"');
    expect(passedRequirement).toContain('"unconfirmedFacts"');
    expect(passedRequirement).not.toContain("must-not-leak");
    const passedSteps = generateSummary.mock.calls[0][1] as PlanStep[];
    expect(JSON.stringify(passedSteps)).not.toContain("raw terminal output");
    expect(JSON.stringify(passedSteps)).not.toContain("full raw evidence");
    expect(JSON.stringify(passedSteps)).not.toContain("super-secret-token");
    expect(passedSteps[1]).toMatchObject({
      title: "clone",
      command: "",
      validation: "",
      result: {
        facts: { category: "terminal_busy" },
        evidenceIds: [],
      },
    });
    expect(passedSteps[1]).not.toHaveProperty("output");
    expect(passedSteps[1]).not.toHaveProperty("evidence");
    expect(result.summary).toContain("最新阻断：步骤“clone”：上一条超时命令未释放终端");
  });

  it("never lets a model replace a deterministic failed conclusion with success", async () => {
    const result = await summarizeFailedTask({
      task: task(),
      reason: "clone did not return a successful exit",
      model,
      apiKey: "secret-key",
    }, vi.fn().mockResolvedValue("任务已成功完成，仓库已就位。"));

    expect(result.summary).toContain("本轮任务未完成：clone did not return a successful exit");
    expect(result.summary).not.toContain("任务已成功完成");
  });

  it("builds an output-free structured failure context", () => {
    const currentTask = task();
    currentTask.plan[0].output = "very long raw terminal output";
    const context = buildFailedTaskSummaryContext(currentTask, "failed");
    expect(JSON.stringify(context)).not.toContain("very long raw terminal output");
  });

  it("bounds the model-facing failure snapshot while finding the latest blocker from the full ledger", async () => {
    const currentTask = task();
    currentTask.messages[0].content = `Deploy ${"large-goal ".repeat(1_000)}`;
    currentTask.plan = Array.from({ length: 200 }, (_, index): PlanStep => ({
      ...step(
        `step-${index}-${"long-title-".repeat(40)}`,
        `deploy --password raw-secret-${index}`,
        index === 5 ? "failed" : "completed",
      ),
      expected: `expected-${index}-${"long-expected-".repeat(80)}`,
      output: `raw-terminal-${index}-${"x".repeat(10_000)}`,
      result: {
        executionStatus: index === 5 ? "blocked" : "success",
        observationStatus: index === 5 ? "unknown" : "matched",
        exitCode: index === 5 ? 255 : 0,
        facts: {
          category: `category-${index}`,
          rawSecret: `must-not-reach-model-${index}`,
          hugePayload: "y".repeat(20_000),
        },
        warnings: [],
        evidenceIds: [`evidence-${index}`],
        failureReason: index === 5 ? `old blocker ${"z".repeat(5_000)}` : undefined,
      },
    }));
    const generateSummary = vi.fn().mockResolvedValue("仍需处理旧阻断。");

    const result = await summarizeFailedTask({
      task: currentTask,
      reason: `retry limit ${"r".repeat(5_000)}`,
      model,
      apiKey: "secret-key",
    }, generateSummary);

    expect(result.failureContext.latestBlocker.stepTitle).toContain("step-5-");
    expect(result.failureContext.latestBlocker.reason).toHaveLength(480);
    expect(result.failureContext.confirmedFacts).toHaveLength(20);
    expect(result.failureContext.unconfirmedFacts).toHaveLength(0);
    expect(result.failureContext.confirmedFacts[0].stepTitle).toContain("step-180-");
    expect(result.failureContext.confirmedFacts[0].facts).toEqual({ category: "category-180" });

    const passedRequirement = generateSummary.mock.calls[0][0] as string;
    const passedSteps = generateSummary.mock.calls[0][1] as PlanStep[];
    const completeModelInput = `${passedRequirement}\n${JSON.stringify(passedSteps)}`;
    expect(passedRequirement.length).toBeLessThan(15_000);
    expect(completeModelInput.length).toBeLessThan(35_000);
    expect(passedSteps).toHaveLength(20);
    expect(completeModelInput).not.toContain("must-not-reach-model");
    expect(completeModelInput).not.toContain("raw-terminal-");
    expect(completeModelInput).not.toContain("hugePayload");
    expect(completeModelInput).not.toContain("raw-secret-");
  });

  it("bounds failed summary plans and omits commands, output and evidence", () => {
    const steps = Array.from({ length: 25 }, (_, index) => ({
      ...step(`step-${index}`, `deploy --token secret-${index}`, index === 24 ? "failed" : "completed"),
      output: `raw-${index}`,
      evidence: [{
        id: `evidence-${index}`,
        type: "command-output" as const,
        source: "main" as const,
        facts: {},
        rawOutput: `evidence-raw-${index}`,
        collectedAt: "2026-08-14T00:00:00.000Z",
      }],
    }));
    const compact = buildCompactFailedSummarySteps(steps);

    expect(compact).toHaveLength(20);
    expect(compact[0].id).toBe("step-5");
    expect(compact.every((item) => item.command === "" && item.validation === "")).toBe(true);
    expect(JSON.stringify(compact)).not.toContain("secret-");
    expect(JSON.stringify(compact)).not.toContain("evidence-raw");
  });

  it("reviews the stable goal using only the current-round ledger", async () => {
    const currentTask = task();
    currentTask.rootGoal = "Deploy the application and verify HTTP availability";
    currentTask.currentInstruction = "retry";
    currentTask.phaseHistory = [{
      id: "phase-1",
      roundId: "round-1",
      requirement: "continue deployment",
      reason: "adjustment",
      plan: [step("dependencies", "npm ci")],
      createdAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:01:00.000Z",
    }];
    const review = vi.fn().mockResolvedValue({
      decision: "adjust",
      reason: "HTTP acceptance is missing",
      summary: "Dependencies are ready but the application is not yet verified.",
      source: "model",
    });

    const result = await reviewTaskGoal({ task: currentTask, model, apiKey: "secret-key" }, review);

    expect(result.complete).toBe(false);
    expect(review).toHaveBeenCalledWith(
      currentTask.rootGoal,
      expect.stringContaining("baseSnapshot"),
      expect.objectContaining({ apiKey: "secret-key" }),
    );
    expect(review.mock.calls[0][1]).not.toContain("dependencies");
  });

  it("bounds the overall-goal ledger and keeps only exceptional output content", async () => {
    const currentTask = task();
    const noisyFailure = [
      "build started",
      "ordinary progress".repeat(3_000),
      "GOAL_REVIEW_MIDDLE_TOKEN_MUST_BE_OMITTED",
      "ordinary progress".repeat(3_000),
      "fatal: deployment artifact is missing",
      "[exit: 1]",
    ].join("\n");
    currentTask.plan = Array.from({ length: 60 }, (_, index): PlanStep => ({
      ...step(`step-${index}`, `deploy --token secret-${index}`, index === 30 ? "failed" : "completed"),
      output: index === 30 ? noisyFailure : `successful raw output ${index}`,
      result: {
        executionStatus: index === 30 ? "failed" : "success",
        observationStatus: index === 30 ? "unknown" : "matched",
        exitCode: index === 30 ? 1 : 0,
        facts: { category: index === 30 ? "deploy_failed" : "verified" },
        warnings: [],
        evidenceIds: [],
        failureReason: index === 30 ? "部署产物缺失" : undefined,
      },
    }));
    const review = vi.fn().mockResolvedValue({
      decision: "adjust",
      reason: "部署产物缺失",
      summary: "需要修复构建产物后重新验收。",
      source: "model",
    });

    await reviewTaskGoal({
      task: currentTask,
      model,
      apiKey: "secret-key",
      skills: [{
        id: "deploy-skill",
        name: "部署",
        category: "deployment",
        description: "部署并验收应用",
        version: 1,
        enabled: true,
        builtIn: false,
        matchRules: [],
        instructions: `final acceptance ${"long rule ".repeat(1_000)}`,
        updatedAt: "2026-08-14T00:00:00.000Z",
      }],
    }, review);

    const serialized = review.mock.calls[0][1] as string;
    const context = JSON.parse(serialized);
    const successful = context.baseSnapshot.currentPlan.steps
      .find((item: { title: string }) => item.title === "step-0");
    const failed = context.baseSnapshot.currentIncident;
    expect(context.baseSnapshot.currentPlan).toMatchObject({
      totalSteps: 60,
      includedSteps: 20,
      omittedSteps: 40,
      incidentIncludedSeparately: true,
    });
    expect(successful.output).toHaveProperty("totalCharacters");
    expect(successful.output).not.toHaveProperty("content");
    expect(failed.title).toBe("step-30");
    expect(failed.output.content).toContain("fatal: deployment artifact is missing");
    expect(failed.output.salientLines).toContain("fatal: deployment artifact is missing");
    expect(context.activeSkillAcceptance[0].instructions.length).toBeLessThanOrEqual(1_600);
    expect(serialized).not.toContain("GOAL_REVIEW_MIDDLE_TOKEN_MUST_BE_OMITTED");
    expect(serialized).not.toContain("deploy --token secret-");
    expect(serialized.length).toBeLessThan(30_000);
  });

});
