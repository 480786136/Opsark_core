import { describe, expect, it, vi } from "vitest";
import {
  reviewExecutionEvidence,
  reviewExecutionFailure,
  reviewPrecondition,
} from "@/features/agent/reviewService";
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

function createStep(
  id: string,
  command: string,
  status: PlanStep["status"] = "completed",
): PlanStep {
  return {
    id,
    title: id,
    description: id,
    command,
    risk: "low",
    expected: "success",
    validation: "true",
    status,
  };
}

function createTask(): OpsTask {
  return {
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
    plan: [createStep("inspect", "pwd")],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

describe("review service", () => {
  it("does not turn historical recovery semantics into a dispatch gate", async () => {
    const task = createTask();
    const blocker = task.plan[0];
    const deploy = createStep("deploy", "systemctl restart app", "pending");
    task.plan.push(deploy);
    const reviewer = vi.fn().mockResolvedValue({
      decision: "adjust",
      reason: "business disagreement",
      summary: "business disagreement",
      source: "model",
    });
    const result = await reviewPrecondition({
      task,
      step: deploy,
      blockerStep: blocker,
      model,
      apiKey: "secret-key",
    }, reviewer);

    expect(result.allowed).toBe(true);
    expect(result.finalDecision).toMatchObject({ decision: "continue", source: "rules" });
    expect(result.context).toMatchObject({ reviewPolicy: {
      authorizationBoundaryOnly: true,
      recoveryRelationIsAdvisory: true,
    } });
    expect(reviewer).not.toHaveBeenCalled();
  });

  it("preserves a model complete decision while keeping failed mutation facts", async () => {
    const task = createTask();
    const failed = createStep("deploy", "systemctl restart app", "failed");
    failed.attemptContext = "target-1";
    failed.result = {
      executionStatus: "failed",
      observationStatus: "unknown",
      facts: { category: "command_failed" },
      warnings: [],
      evidenceIds: [],
      failureReason: "command failed",
    };
    task.plan = [failed, { ...createStep("修复服务", "systemctl start app", "pending"),
      kind: "change", recovery: { failedStepId: failed.id, targetContext: "target-1", purpose: "repair" } }];
    const result = await reviewExecutionFailure({
      task,
      step: failed,
      failureReason: "command failed",
      failureCategory: "command_failed",
      model,
      apiKey: "secret-key",
    }, vi.fn().mockResolvedValue({
      decision: "complete",
      reason: "done",
      summary: "done",
      source: "model",
    }));

    expect(result.modelDecision?.decision).toBe("complete");
    expect(result.finalDecision).toMatchObject({ decision: "complete", source: "model" });
    expect(result.mutatingStep).toBe(true);
    expect(result.recoveryStepFound).toBe(true);
    expect(failed.status).toBe("failed");
    expect(failed.result?.executionStatus).toBe("failed");
  });

  it("asks the model what to do after a failed change even without recovery metadata", async () => {
    const task = createTask();
    const failed = createStep("build", "npm install && npm run build", "failed");
    failed.kind = "change";
    failed.result = {
      executionStatus: "failed", observationStatus: "unknown", exitCode: 1,
      facts: { category: "command_failed", commandCompleted: false },
      warnings: [], evidenceIds: ["main"], failureReason: "Cannot find module autoprefixer",
    };
    failed.output = "npm install succeeded\nCannot find module autoprefixer";
    task.plan = [failed, createStep("验收", "test -d dist", "pending")];
    const reviewer = vi.fn().mockResolvedValue({
      decision: "continue", reason: "inspect the dependency state",
      summary: "continue with the read-only diagnosis", source: "model",
    });
    const result = await reviewExecutionFailure({
      task, step: failed, failureReason: failed.result.failureReason!, model,
    }, reviewer);

    expect(reviewer).toHaveBeenCalledOnce();
    expect(result.modelDecision).toMatchObject({ decision: "continue", source: "model" });
    expect(result.finalDecision).toMatchObject({ decision: "continue", source: "model" });
    expect(JSON.stringify(result.context)).toContain("Cannot find module autoprefixer");
    expect(failed.status).toBe("failed");
    expect(task.plan[1].status).toBe("pending");
  });

  it("records missing recovery metadata for audit without overriding the model", async () => {
    const task = createTask();
    const failed = createStep(
      "pull-images",
      "timeout 600 kubeadm config images pull --kubernetes-version=v1.28.2",
      "failed",
    );
    failed.kind = "change";
    failed.title = "拉取 Kubernetes 镜像";
    failed.result = {
      executionStatus: "failed",
      observationStatus: "unhealthy",
      exitCode: 1,
      facts: { category: "network_failure", networkFailure: true },
      warnings: [],
      evidenceIds: [],
      failureReason: "registry.k8s.io connection timed out",
    };
    const init = createStep("init-control-plane", "kubeadm init --config /root/kubeadm.yaml", "pending");
    init.kind = "change";
    init.title = "初始化 Kubernetes 控制平面";
    init.description = "配置并部署主节点";
    const flannel = createStep("install-flannel", "kubectl apply -f /root/kube-flannel.yml", "pending");
    flannel.kind = "change";
    flannel.title = "部署 Flannel 网络";
    flannel.description = "应用 CNI 配置";
    task.plan = [failed, init, flannel];
    const reviewer = vi.fn().mockResolvedValue({
      decision: "adjust", reason: "network is unavailable", summary: "adjust the plan", source: "model",
    });

    const result = await reviewExecutionFailure({
      task,
      step: failed,
      failureReason: failed.result.failureReason!,
      failureCategory: "network_failure",
      model,
    }, reviewer);

    expect(reviewer).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ mutatingStep: true, recoveryStepFound: false });
    expect(result.finalDecision).toMatchObject({ decision: "adjust", source: "model" });
  });

  it("still asks the model to interpret a failed read-only diagnostic", async () => {
    const task = createTask();
    const failed = createStep("检查服务", "systemctl is-active app", "failed");
    failed.kind = "observe";
    task.plan = [failed];
    const reviewer = vi.fn().mockResolvedValue({
      decision: "complete", reason: "The query confirmed the service is inactive",
      summary: "inactive", source: "model",
    });
    const result = await reviewExecutionFailure({ task, step: failed, failureReason: "inactive", model }, reviewer);
    expect(reviewer).toHaveBeenCalledOnce();
    expect(result.finalDecision.source).toBe("model");
  });

  it("keeps deterministic postcondition facts without overriding a model continue decision", async () => {
    const task = createTask();
    const deploy = createStep("deploy", "systemctl restart app", "validating");
    deploy.result = {
      executionStatus: "success",
      observationStatus: "unknown",
      facts: {},
      warnings: [],
      evidenceIds: [],
    };
    task.plan = [deploy, createStep("验收", "curl -fsS http://localhost", "pending")];
    const result = await reviewExecutionEvidence({
      task,
      step: deploy,
      reviewRequired: true,
      postconditionReview: true,
      validationExitCode: 127,
      model,
      apiKey: "secret-key",
    }, vi.fn().mockResolvedValue({
      decision: "continue",
      reason: "continue",
      summary: "continue",
      source: "model",
    }));

    expect(result.modelDecision?.decision).toBe("continue");
    expect(result.finalDecision).toMatchObject({ decision: "continue", source: "model" });
    expect(result.hardBlocker).toContain("不可执行或不存在");
  });

  it("does not replace a model adjust decision for adjacent read-only diagnostics", async () => {
    const task = createTask();
    const inspect = createStep("检查端口", "ss -lntp", "validating");
    inspect.result = {
      executionStatus: "success",
      observationStatus: "warning",
      facts: {},
      warnings: ["uncertain"],
      evidenceIds: [],
    };
    task.plan = [inspect, createStep("查看日志", "journalctl -n 20", "pending")];
    const result = await reviewExecutionEvidence({
      task,
      step: inspect,
      reviewRequired: true,
      postconditionReview: false,
      model,
      apiKey: "secret-key",
    }, vi.fn().mockResolvedValue({
      decision: "adjust",
      reason: "uncertain",
      summary: "adjust",
      source: "model",
    }));

    expect(result.continuedForDiagnostics).toBe(false);
    expect(result.finalDecision).toMatchObject({ decision: "adjust", source: "model" });
  });

  it("fails closed when failed-command model review is unavailable", async () => {
    const task = createTask();
    const failed = createStep("deploy", "systemctl restart app", "failed");
    failed.kind = "change";
    task.plan = [failed];
    const result = await reviewExecutionFailure({
      task, step: failed, failureReason: "command failed", model,
    }, vi.fn().mockResolvedValue({
      decision: "complete", reason: "fallback", summary: "fallback", source: "rules",
    }));

    expect(result.finalDecision).toMatchObject({ decision: "adjust", source: "rules" });
  });

  it("enters no_action when semantic evidence review is unavailable", async () => {
    const task = createTask();
    const inspect = createStep("检查服务", "systemctl status app", "validating");
    inspect.kind = "observe";
    inspect.validation = "";
    inspect.result = {
      executionStatus: "success",
      observationStatus: "warning",
      facts: { blockingSignal: true },
      warnings: ["需要解释异常状态"],
      evidenceIds: [],
    };
    task.plan = [inspect];

    const result = await reviewExecutionEvidence({
      task,
      step: inspect,
      reviewRequired: true,
      postconditionReview: false,
      model,
    }, vi.fn().mockResolvedValue({
      decision: "complete", reason: "fallback", summary: "fallback", source: "rules",
    }));

    expect(result.finalDecision).toMatchObject({ decision: "adjust", source: "rules" });
    expect(result.finalDecision.summary).toContain("blocked/no_action");
  });
});
