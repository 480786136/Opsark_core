import { describe, expect, it } from "vitest";
import {
  buildEvidenceReviewContext,
  buildExecutionFailureReviewContext,
  buildLongRunningReviewContext,
  buildPreconditionReviewContext,
} from "@/features/agent/reviewContext";
import type { OpsTask, PlanStep } from "@/types";
import { confirmedInputScope } from "@/features/agent/confirmedUserInputs";

const step = (id: string, status: PlanStep["status"]): PlanStep => ({
  id,
  title: id,
  description: "description",
  command: "command",
  risk: "low",
  expected: "expected",
  validation: "validation",
  status,
  output: "output",
});

function task(): OpsTask {
  return {
    id: "task-1",
    serverId: "server-1",
    title: "task",
    status: "validating",
    permission: "safe",
    modelId: "model-1",
    messages: [],
    plan: [step("blocker", "completed"), step("current", "running"), step("remaining", "pending")],
    createdAt: "now",
    updatedAt: "now",
  };
}

describe("review context", () => {
  it.each(["facts", "command"] as const)("does not reintroduce out-of-scope legacy form values in any review (%s identity)", identity => {
    const currentTask = task();
    currentTask.rootGoal = `检查服务${"并保持完整目标".repeat(180)}`;
    currentTask.currentInstruction = "另一个旁问，不能替换原目标";
    currentTask.executionConstraints = { changePolicy: "read_only", environmentPolicy: "preserve", failurePolicy: "strict",
      prohibitedActions: ["修改环境"], requiredConditions: [], userDirectives: ["仅检查"] };
    const legacyInput = (id: string, status: PlanStep["status"]): PlanStep => ({
      ...step(id, status),
      command: identity === "command" ? 'opsark-tool user.request_input {"title":"确认目标","fields":[]}' : "legacy form",
      output: "LEGACY_FORM_OUTPUT",
      result: { executionStatus: status === "failed" ? "failed" : "success", observationStatus: "unknown",
        facts: { ...(identity === "facts" ? { toolId: "user.request_input" } : {}), oldValue: "LEGACY_RESULT_VALUE" },
        warnings: [], evidenceIds: [`evidence-${id}`] },
      evidence: [{ id: `evidence-${id}`, type: "command-output", source: "validation", collectedAt: "now",
        facts: { oldValue: "LEGACY_EVIDENCE_VALUE" }, rawOutput: "LEGACY_EVIDENCE_OUTPUT" }],
    });
    const failedHistory = legacyInput("failed-input", "failed");
    const completedHistory = legacyInput("completed-input", "completed");
    const current = legacyInput("current-input", "failed");
    const remaining = step("remaining", "pending");
    currentTask.plan = [failedHistory, completedHistory, current, remaining];
    currentTask.submittedInputs = { oldChoice: {
      value: "LEGACY_OUT_OF_SCOPE_VALUE", label: "目标", description: "目标", type: "text",
      groupId: "old-group", groupTitle: "目标", submittedAt: "now", scope: confirmedInputScope(currentTask, completedHistory.id),
    } };
    currentTask.executionTargetServerId = "another-server";
    currentTask.submittedInputs.currentChoice = {
      value: "CURRENT_SCOPED_VALUE", label: "目标", description: "目标", type: "text",
      groupId: "current-group", groupTitle: "目标", submittedAt: "now", scope: confirmedInputScope(currentTask, current.id),
    };
    const original = JSON.stringify(currentTask);
    const contexts = [
      buildPreconditionReviewContext(currentTask, current, failedHistory),
      buildExecutionFailureReviewContext(currentTask, current, [remaining]),
      buildEvidenceReviewContext(currentTask, current, [remaining], true),
      buildEvidenceReviewContext(currentTask, current, [remaining], false),
      buildLongRunningReviewContext({ task: currentTask, step: current, reviewRound: 1, elapsedSeconds: 30,
        observation: { passed: false, detail: "LEGACY_OBSERVATION_VALUE" },
        progress: { workload: "bounded", outputFingerprint: "fingerprint", outputChangedSinceLastReview: false,
          lastOutputChangeAt: "now", noProgressSeconds: 30, noProgressReviewRounds: 1, consecutiveContinueRounds: 0 },
        outputWindow: { mode: "initial", newCharacters: 22, omittedCharacters: 0,
          contentFingerprint: "fingerprint", content: "LEGACY_STREAM_OUTPUT" },
        salientEvidence: ["LEGACY_SALIENT_VALUE"],
      }),
    ];
    for (const context of contexts) {
      const serialized = JSON.stringify(context);
      expect(serialized).not.toContain("LEGACY_");
      expect(serialized).toContain("CURRENT_SCOPED_VALUE");
      expect(context.confirmedUserInputs?.index.find(item => item.key === "oldChoice")?.status).toBe("out_of_scope");
      expect(context.executionConstraints).toEqual(currentTask.executionConstraints);
      expect(context.task.permission).toBe(currentTask.permission);
      expect(context.task.rootGoal).toBe(currentTask.rootGoal);
    }
    expect(JSON.stringify(currentTask)).toBe(original);
  });

  it("keeps completed user decisions in failure, precondition and evidence reviews without raw form output", () => {
    const currentTask = task();
    const inputStep = {
      ...step("registry-choice", "completed"),
      title: "选择镜像源",
      command: 'opsark-tool user.request_input {"title":"选择镜像源","fields":[]}',
      output: "RAW_FORM_OUTPUT_MUST_NOT_BE_REQUIRED",
      result: {
        executionStatus: "success" as const,
        observationStatus: "matched" as const,
        facts: { toolId: "user.request_input" },
        warnings: [],
        evidenceIds: [],
      },
    };
    currentTask.plan = [inputStep, ...currentTask.plan];
    currentTask.submittedInputs = {
      image_registry: {
        value: "registry.aliyuncs.com/google_containers",
        type: "select",
        label: "镜像仓库",
        description: "kubeadm 镜像仓库",
        groupId: "registry-choice",
        scope: confirmedInputScope(currentTask, "registry-choice"),
        groupTitle: "选择镜像源",
        submittedAt: "2026-09-15T07:50:52.000Z",
      },
      cni_manifest_source: {
        value: "mirror_url",
        type: "select",
        label: "CNI 来源",
        description: "CNI manifest 获取方式",
        groupId: "registry-choice",
        scope: confirmedInputScope(currentTask, "registry-choice"),
        groupTitle: "选择镜像源",
        submittedAt: "2026-09-15T07:50:52.000Z",
      },
    };
    currentTask.submittedSecretBindings = {
      REGISTRY_TOKEN: {
        key: "REGISTRY_TOKEN",
        label: "DO_NOT_SERIALIZE_SECRET_BINDING",
        description: "DO_NOT_SERIALIZE_SECRET_BINDING",
        groupId: "secret",
        groupTitle: "secret",
        submittedAt: "2026-09-15T07:50:52.000Z",
      },
    };
    const current = currentTask.plan[2];
    const contexts = [
      buildPreconditionReviewContext(currentTask, current, currentTask.plan[1]),
      buildExecutionFailureReviewContext(currentTask, current, [currentTask.plan[3]]),
      buildEvidenceReviewContext(currentTask, current, [currentTask.plan[3]], true),
    ];

    for (const context of contexts) {
      expect(context.confirmedUserInputs?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "image_registry", value: "registry.aliyuncs.com/google_containers" }),
        expect.objectContaining({ key: "cni_manifest_source", value: "mirror_url" }),
      ]));
      const serialized = JSON.stringify(context);
      expect(serialized).not.toContain("RAW_FORM_OUTPUT_MUST_NOT_BE_REQUIRED");
      expect(serialized).not.toContain("DO_NOT_SERIALIZE_SECRET_BINDING");
    }
  });

  it("failure and validation reviews retain available credential references and route rejection evidence", () => {
    const currentTask = task();
    currentTask.authenticationCredentials = [{ ref: "server-credential:db", kind: "database", target: "db.internal:3306",
      usernamePlaceholder: "${secret.DB_USER}", secretPlaceholder: "${secret.DB_PASSWORD}" }];
    currentTask.authenticationEvidence = [{ id: "auth-1", taskId: currentTask.id, stepId: "current", serverId: currentTask.serverId,
      client: "mysql", target: "db.internal:3306", transport: "tcp", credentialKeys: ["DB_USER", "DB_PASSWORD"],
      accountRef: "DB_USER", materialProvided: true, outcome: "route_rejected", createdAt: new Date().toISOString(),
      source: "main", credentialRevision: 0 }];
    for (const context of [buildExecutionFailureReviewContext(currentTask, currentTask.plan[1], []),
      buildEvidenceReviewContext(currentTask, currentTask.plan[1], [], true)]) {
      expect(context.authentication.availableCredentials).toEqual(currentTask.authenticationCredentials);
      expect(context.authentication.attempts[0].outcome).toBe("route_rejected");
      expect(context.authentication.instruction).toContain("不等于密码错误");
    }
  });
  it("builds stable policy flags for every review trigger", () => {
    const currentTask = task();
    const current = currentTask.plan[1];
    const remaining = [currentTask.plan[2]];

    expect(buildPreconditionReviewContext(currentTask, current, currentTask.plan[0]).reviewPolicy.preconditionGate).toBe(true);
    expect(buildExecutionFailureReviewContext(currentTask, current, remaining).reviewPolicy.commandExecutionFailed).toBe(true);
    expect(buildEvidenceReviewContext(currentTask, current, remaining, true).reviewPolicy?.postconditionFailed).toBe(true);
    expect(buildLongRunningReviewContext({
      task: currentTask,
      step: current,
      reviewRound: 1,
      elapsedSeconds: 30,
      observation: { passed: false, detail: "waiting" },
      progress: {
        workload: "bounded",
        outputFingerprint: "7:12345678",
        outputChangedSinceLastReview: false,
        lastOutputChangeAt: "2026-08-14T00:00:00.000Z",
        noProgressSeconds: 30,
        noProgressReviewRounds: 1,
        consecutiveContinueRounds: 0,
        maxConsecutiveContinueRounds: 2,
        hardLimitSeconds: 90,
      },
      outputWindow: {
        mode: "initial",
        newCharacters: 7,
        omittedCharacters: 0,
        contentFingerprint: "7:12345678",
        content: "running",
      },
    }).reviewPolicy.periodicLongRunningReview).toBe(true);
  });

  it("keeps periodic long-running context bounded to goal-adjacent state", () => {
    const currentTask = task();
    currentTask.plan[1].command = `run ${"x".repeat(10_000)}`;
    const context = buildLongRunningReviewContext({
      task: currentTask,
      step: currentTask.plan[1],
      reviewRound: 3,
      elapsedSeconds: 90,
      observation: { passed: false, detail: "waiting" },
      progress: {
        workload: "progressive",
        outputFingerprint: "100:12345678",
        outputChangedSinceLastReview: true,
        lastOutputChangeAt: "2026-08-14T00:01:30.000Z",
        noProgressSeconds: 0,
        noProgressReviewRounds: 0,
        consecutiveContinueRounds: 0,
        maxConsecutiveContinueRounds: 4,
      },
      outputWindow: {
        mode: "delta",
        newCharacters: 100,
        omittedCharacters: 0,
        contentFingerprint: "100:12345678",
        content: "latest output",
      },
      salientEvidence: ["npm ERR! heap out of memory"],
    });

    expect(context.trigger).toBe("periodic_long_running");
    expect(context.currentStep.command.length).toBeLessThanOrEqual(800);
    expect(context.nextStep?.title).toBe("remaining");
    expect(context.terminalOutput.content).toBe("latest output");
    expect(context.salientEvidence).toEqual(["npm ERR! heap out of memory"]);
    expect(context).not.toHaveProperty("fullPlan");
    expect(context).not.toHaveProperty("executionHistory");
    expect(context).not.toHaveProperty("userRequirement");
    expect(JSON.stringify(context)).not.toContain("gggggggggg");
    expect(JSON.stringify(context).length).toBeLessThan(5_000);
  });

  it("keeps pending and historical steps in separate collections", () => {
    const currentTask = task();
    const context = buildExecutionFailureReviewContext(
      currentTask,
      currentTask.plan[1],
      [currentTask.plan[2]],
    );

    expect(context.executionHistory.items.map((item) => item.title)).toEqual(["blocker"]);
    expect(context.remainingSteps.items.map((item) => item.title)).toEqual(["remaining"]);
    expect(context.planSummary.totalSteps).toBe(3);
    expect(context).not.toHaveProperty("fullPlan");
    expect(context).not.toHaveProperty("userRequirement");
  });

  it("bounds repeated terminal output while retaining the final failure evidence", () => {
    const currentTask = task();
    const noisyOutput = [
      "starting build",
      "progress line".repeat(2_000),
      "MIDDLE_TOKEN_MUST_BE_OMITTED",
      "progress line".repeat(2_000),
      "java.lang.NoSuchFieldError: missing compiler field",
      "[exit: 1]",
    ].join("\n");
    const current = currentTask.plan[1];
    current.status = "failed";
    current.output = noisyOutput;
    current.result = {
      executionStatus: "failed",
      observationStatus: "unknown",
      exitCode: 1,
      facts: { category: "build_failed" },
      warnings: [],
      evidenceIds: ["failure-evidence"],
      failureReason: "编译失败",
    };
    current.evidence = [{
      id: "failure-evidence",
      type: "command-output",
      source: "validation",
      facts: { category: "build_failed" },
      rawOutput: noisyOutput,
      collectedAt: "2026-08-14T00:00:00.000Z",
    }];

    const context = buildExecutionFailureReviewContext(
      currentTask,
      current,
      [currentTask.plan[2]],
    );
    const serialized = JSON.stringify(context);

    expect(context.currentStep.output?.totalCharacters).toBeGreaterThan(40_000);
    expect(context.currentStep.output?.content).toContain("NoSuchFieldError");
    expect(context.currentStep.output?.salientLines).toContain("java.lang.NoSuchFieldError: missing compiler field");
    expect(context.currentStep.evidence?.items[0].output?.content).toContain("[exit: 1]");
    expect(serialized).not.toContain("MIDDLE_TOKEN_MUST_BE_OMITTED");
    expect(serialized.length).toBeLessThan(12_000);
  });
});
