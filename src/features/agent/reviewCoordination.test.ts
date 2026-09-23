import { describe, expect, it } from "vitest";
import {
  applyCommandFailureReview,
  applyExecutionEvidenceReview,
  applyPeriodicReviewAdjustment,
} from "@/features/agent/reviewCoordination";
import type { PlanStep, StepReview } from "@/types";

function createStep(id: string, status: PlanStep["status"]): PlanStep {
  return {
    id,
    title: id,
    description: id,
    command: "command",
    risk: "low",
    expected: "success",
    validation: "true",
    status,
  };
}

function review(decision: StepReview["decision"]): StepReview {
  return {
    decision,
    reason: `${decision} reason`,
    summary: `${decision} summary`,
    source: "model",
  };
}

describe("review coordination", () => {
  it("writes periodic-review failure data and pauses the task", () => {
    const step = createStep("long-running", "running");
    const outcome = applyPeriodicReviewAdjustment(step, {
      review: review("adjust"),
      output: "still waiting",
      exitCode: 130,
      reviewRound: 2,
      elapsedSeconds: 65,
      validationPassed: false,
      evidenceId: "evidence-periodic-review",
      collectedAt: "2026-08-14T01:00:00.000Z",
    });

    expect(step.status).toBe("failed");
    expect(step.review?.decision).toBe("adjust");
    expect(step.result).toMatchObject({
      executionStatus: "failed",
      facts: { stoppedByPeriodicReview: true, reviewRound: 2 },
    });
    expect(step.evidence?.[0].id).toBe("evidence-periodic-review");
    expect(outcome).toMatchObject({
      taskStatus: "needs_adjustment",
      shouldAdvance: false,
      pauseReason: "长任务定期复核建议调整：adjust reason",
    });
    expect(outcome.eventMessage).toContain("adjust summary");
  });

  it("pauses after a failed command adjustment decision", () => {
    const step = createStep("failed", "failed");
    const outcome = applyCommandFailureReview(step, [], review("adjust"));

    expect(outcome).toMatchObject({ taskStatus: "needs_adjustment", shouldAdvance: false });
    expect(outcome.pauseReason).toContain("adjust reason");
    expect(step.review?.decision).toBe("adjust");
  });

  it("skips remaining work when failed-command review completes the goal", () => {
    const step = createStep("failed", "failed");
    step.kind = "observe";
    step.title = "检查服务状态";
    const remaining = [createStep("remaining-1", "pending"), createStep("remaining-2", "pending")];
    const outcome = applyCommandFailureReview(step, remaining, review("complete"));

    expect(outcome.taskStatus).toBe("running");
    expect(outcome.shouldAdvance).toBe(true);
    expect(remaining.every((item) => item.status === "skipped")).toBe(true);
  });

  it("keeps remaining work pending after a continue decision", () => {
    const step = createStep("failed", "failed");
    step.kind = "observe";
    step.title = "检查服务状态";
    const remaining = [createStep("remaining", "pending")];
    const outcome = applyCommandFailureReview(step, remaining, review("continue"));

    expect(outcome.shouldAdvance).toBe(true);
    expect(remaining[0].status).toBe("pending");
  });

  it("honors model completion for flow while preserving a failed change", () => {
    const failed = createStep("pull-images", "failed");
    failed.kind = "change";
    failed.command = "kubeadm config images pull --kubernetes-version=v1.28.2";
    failed.result = {
      executionStatus: "failed",
      observationStatus: "unhealthy",
      facts: { category: "network_failure", networkFailure: true },
      warnings: [],
      evidenceIds: [],
    };
    const remaining = [createStep("deploy-flannel", "pending")];
    remaining[0].kind = "change";
    remaining[0].title = "部署 Flannel 网络";
    remaining[0].command = "kubectl apply -f /root/kube-flannel.yml";

    const outcome = applyCommandFailureReview(failed, remaining, review("complete"));

    expect(outcome).toMatchObject({ taskStatus: "running", shouldAdvance: true });
    expect(failed.review).toMatchObject({ decision: "complete", source: "model" });
    expect(failed.status).toBe("failed");
    expect(failed.result?.executionStatus).toBe("failed");
    expect(remaining[0].status).toBe("skipped");
  });

  it("honors model continuation without requiring recovery metadata", () => {
    const failed = createStep("pull-images", "failed");
    failed.kind = "change";
    failed.command = "kubeadm config images pull --kubernetes-version=v1.28.2";
    failed.result = {
      executionStatus: "failed",
      observationStatus: "unhealthy",
      facts: { category: "network_failure" },
      warnings: [],
      evidenceIds: [],
    };
    const remaining = [createStep("init-control-plane", "pending")];
    remaining[0].kind = "change";
    remaining[0].title = "配置并部署 Kubernetes";
    remaining[0].command = "kubeadm init --config /root/kubeadm.yaml";

    const outcome = applyCommandFailureReview(failed, remaining, review("continue"));

    expect(outcome).toMatchObject({ taskStatus: "running", shouldAdvance: true });
    expect(failed.review).toMatchObject({ decision: "continue", source: "model" });
    expect(failed.status).toBe("failed");
    expect(remaining[0].status).toBe("pending");
  });

  it("keeps successful evidence completed when model review requests adjustment", () => {
    const step = createStep("validate", "validating");
    step.result = {
      executionStatus: "success", observationStatus: "warning", facts: {}, warnings: [], evidenceIds: [],
    };
    const outcome = applyExecutionEvidenceReview({
      step,
      remainingSteps: [],
      review: review("adjust"),
      reviewWasRequired: true,
    });

    expect(step.status).toBe("completed");
    expect(outcome).toMatchObject({ taskStatus: "needs_adjustment", shouldAdvance: false });
  });

  it("keeps a failed postcondition failed while honoring model continuation", () => {
    const step = createStep("validate", "validating");
    step.kind = "change";
    step.result = {
      executionStatus: "success", observationStatus: "unknown",
      facts: { validationPassed: false }, warnings: [], evidenceIds: [],
    };
    const remaining = [createStep("diagnose", "pending")];
    remaining[0].kind = "observe";

    const outcome = applyExecutionEvidenceReview({
      step, remainingSteps: remaining, review: review("continue"), reviewWasRequired: true,
    });

    expect(step.status).toBe("failed");
    expect(step.result.facts.validationPassed).toBe(false);
    expect(outcome).toMatchObject({ taskStatus: "running", shouldAdvance: true });
    expect(remaining[0].status).toBe("pending");
  });

  it("completes evidence and skips remaining work when the reviewed goal is complete", () => {
    const step = createStep("validate", "validating");
    const remaining = [createStep("remaining", "pending")];
    const outcome = applyExecutionEvidenceReview({
      step,
      remainingSteps: remaining,
      review: review("complete"),
      reviewWasRequired: true,
    });

    expect(step.status).toBe("completed");
    expect(remaining[0].status).toBe("skipped");
    expect(outcome.eventMessage).toContain("无需继续剩余 1 个");
  });

  it("does not skip remaining work for a deterministic completion without model review", () => {
    const step = createStep("validate", "validating");
    const remaining = [createStep("remaining", "pending")];
    applyExecutionEvidenceReview({
      step,
      remainingSteps: remaining,
      review: { ...review("complete"), source: "rules" },
      reviewWasRequired: false,
    });

    expect(step.status).toBe("completed");
    expect(remaining[0].status).toBe("pending");
  });
});
