import { describe, expect, it } from "vitest";
import {
  isMutatingReviewStep,
  isReadOnlyDiagnosticStep,
  postconditionHasHardBlocker,
  remainingPlanCanRecoverExecutionFailure,
  remainingPlanCanRepairPostcondition,
} from "@/features/agent/evidenceReview";
import type { PlanStep } from "@/types";

const step = (overrides: Partial<PlanStep> = {}): PlanStep => ({
  id: "step-1",
  title: "检查服务状态",
  description: "只读查询",
  command: "systemctl status app",
  risk: "low",
  expected: "返回状态",
  validation: "true",
  status: "completed",
  ...overrides,
});

describe("evidence review policy", () => {
  it("uses the typed step effect before legacy text inference", () => {
    expect(isReadOnlyDiagnosticStep(step({ kind: "observe", title: "collect snapshot", description: "read current facts" }))).toBe(true);
    expect(isReadOnlyDiagnosticStep(step({ kind: "change", command: "systemctl restart app" }))).toBe(false);
    expect(isReadOnlyDiagnosticStep(step())).toBe(true);
    expect(isMutatingReviewStep(step({
      kind: "change",
      command: "custom-control pull-images",
    }))).toBe(true);
    expect(isMutatingReviewStep(step({
      kind: undefined,
      title: "拉取 Kubernetes 镜像",
      command: "kubeadm config images pull --kubernetes-version=v1.28.2",
    }))).toBe(true);
  });

  it("does not treat recovery wording as a relationship for legacy plans", () => {
    expect(remainingPlanCanRepairPostcondition([step({
      kind: "change",
      title: "修复服务",
      command: "systemctl restart app",
    })])).toBe(false);
    expect(remainingPlanCanRepairPostcondition([step({
      kind: "change",
      title: "配置并部署服务",
      command: "systemctl start app",
    })])).toBe(false);
    expect(remainingPlanCanRepairPostcondition([step({ title: "修复配置" })])).toBe(false);
    expect(remainingPlanCanRepairPostcondition([step({ title: "查看日志" })])).toBe(false);
  });

  it("does not mistake kubeadm init or Flannel deployment for image-pull recovery", () => {
    const failed = step({
      id: "pull-images",
      attemptContext: "target-1",
      kind: "change",
      title: "拉取 Kubernetes 镜像",
      command: "timeout 600 kubeadm config images pull --kubernetes-version=v1.28.2",
      status: "failed",
      result: {
        executionStatus: "failed",
        observationStatus: "unhealthy",
        facts: { category: "network_failure", networkFailure: true },
        warnings: [],
        evidenceIds: [],
      },
    });
    const remaining = [
      step({
        id: "init-control-plane",
        kind: "change",
        title: "初始化 Kubernetes 控制平面",
        description: "部署主节点",
        command: "kubeadm init --config /root/kubeadm-config.yaml",
        status: "pending",
      }),
      step({
        id: "install-flannel",
        kind: "change",
        title: "部署 Flannel 网络",
        description: "应用 CNI 配置",
        command: "kubectl apply -f /root/kube-flannel.yml",
        status: "pending",
      }),
    ];

    expect(remainingPlanCanRecoverExecutionFailure("network_failure", remaining, failed)).toBe(false);
    expect(remainingPlanCanRecoverExecutionFailure("network_failure", [step({
      kind: "change",
      title: "切换镜像仓库并重新拉取",
      description: "改用可访问的 registry mirror",
      command: "kubeadm config images pull --image-repository registry.example.test/k8s",
      status: "pending",
      recovery: { failedStepId: failed.id, targetContext: "target-1", purpose: "repair" },
    })], failed)).toBe(true);
  });

  it("keeps deterministic blockers above model review", () => {
    expect(postconditionHasHardBlocker(step(), [], 127)).toContain("不可执行");
    expect(postconditionHasHardBlocker(step({
      result: {
        executionStatus: "success",
        observationStatus: "unknown",
        facts: { validationProtocolIncomplete: true },
        warnings: [],
        evidenceIds: [],
      },
    }), [])).toContain("不能将该步骤判定为成功");
    expect(postconditionHasHardBlocker(step({
      result: {
        executionStatus: "success",
        observationStatus: "unhealthy",
        facts: { platformIncompatible: true },
        warnings: [],
        evidenceIds: [],
      },
    }), [])).toContain("ABI");
  });
});
