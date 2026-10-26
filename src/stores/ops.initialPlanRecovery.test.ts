import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { useOpsStore } from "./ops";
import type { PlanStep, RequirementProcessingResult } from "@/types";

const requirement = "检查部署环境并读取交接文件，只读处理";
const probe = (id: string): PlanStep => ({ id, title: "部署检查", description: "获得当前环境事实", command: "", validation: "",
  expected: "取得真实状态", kind: "observe", risk: "low", status: "pending",
  action: { type: "tool", toolId: "software.check", arguments: { names: ["runtime-package"] } } });
const read = (): PlanStep => ({ ...probe("read-handover"), title: "读取交接文件",
  action: { type: "tool", toolId: "files.read_content", arguments: { path: "/opt/deployment/handover.txt" } } });

describe("initial duplicate candidate recovery through requirement submission", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    localStorage.clear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    localStorage.setItem("opsark.servers", JSON.stringify([{ id: "server", name: "Fixture", host: "fixture.invalid", port: 22,
      username: "fixture", group: "test", status: "offline", environment: [], createdAt: "2026-10-12",
      info: { os: "Test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } }]));
    localStorage.setItem("opsark.models", JSON.stringify([{ id: "model", name: "Fixture", provider: "Test", model: "test-model",
      endpoint: "https://model.invalid", enabled: true, hasApiKey: true }]));
    setActivePinia(createPinia());
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue(undefined);
    vi.spyOn(backend, "configureTaskCapabilities").mockResolvedValue();
    vi.spyOn(backend, "executeCommand").mockRejectedValue(new Error("Rejected initial proposals must never be dispatched"));
    vi.spyOn(backend, "processRequirement").mockImplementation(async (content, runtime): Promise<RequirementProcessingResult> => {
      const submission = JSON.parse(runtime.context).requirementSubmission;
      return { intent: "execute", relation: "new_goal", constraints: { changePolicy: "read_only", environmentPolicy: "preserve",
        failurePolicy: "strict", prohibitedActions: [], requiredConditions: [], userDirectives: ["只读处理"] },
        requirementUpdate: { baseRevision: submission.baseRevision, sourceMessageId: submission.sourceMessageId,
          additions: [{ id: "environment", kind: "goal", content, sourceQuote: content, supersedes: [] }], changes: [], focusIds: ["environment"] },
        plan: [probe("rejected-first"), probe("rejected-second")] };
    });
    vi.spyOn(backend, "generatePlan").mockResolvedValue([read()]);
    useOpsStore().modelApiKeys.model = "fixture-api-key";
    await useConnectionStore().connect("server", { host: "fixture.invalid", port: 22, username: "fixture", password: "fixture-password" });
  });
  afterEach(() => {
    for (const task of useOpsStore().tasks) task.cancelRequested = true;
    useOpsStore().$dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("automatically replaces the rejected initial plan once with the same budget and requirement revision", async () => {
    const store = useOpsStore();
    await store.submitRequirement("server", requirement, "safe", "model");
    const task = store.activeTask!;
    expect(task.status, task.pauseReason).toBe("awaiting_plan_approval");
    expect(task.plan.map(step => step.id)).toEqual(["read-handover"]);
    expect(task.requirementLifecycle?.revision).toBe(1);
    expect(task.preparedPlan?.requirementRevision).toBe(1);
    expect(task.permission).toBe("safe");
    expect(task.executionConstraints?.changePolicy).toBe("read_only");
    expect(backend.processRequirement).toHaveBeenCalledOnce();
    expect(backend.generatePlan).toHaveBeenCalledOnce();
    const original = JSON.parse(vi.mocked(backend.processRequirement).mock.calls[0][1].context);
    const regenerated = JSON.parse(vi.mocked(backend.generatePlan).mock.calls[0][1]!.context);
    expect(regenerated._modelRecovery).toEqual(original._modelRecovery);
    expect(regenerated._modelOutputRecovery.strategy).toBe("regenerate");
    expect(regenerated.executionConstraints?.changePolicy).toBe("read_only");
    expect(regenerated.taskGoal.lifecycle.revision).toBe(1);
    const audit = JSON.stringify(store.developerLogs);
    expect(audit).toContain("rejected-first");
    expect(audit).toContain("rejected-second");
    expect(audit).toContain("OBSERVATION_PLAN_NO_PROGRESS");
    expect(audit).toContain("read-handover");
    expect(audit).not.toContain("fixture-api-key");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("stops a second duplicate without a third call, partial plan or server execution", async () => {
    vi.mocked(backend.generatePlan).mockResolvedValue([probe("again-first"), probe("again-second")]);
    const store = useOpsStore();
    await store.submitRequirement("server", requirement, "safe", "model");
    expect(store.activeTask?.status).toBe("planning_failed");
    expect(store.activeTask?.plan).toEqual([]);
    expect(store.activeTask?.planApproval).toBeUndefined();
    expect(backend.processRequirement).toHaveBeenCalledOnce();
    expect(backend.generatePlan).toHaveBeenCalledOnce();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    const audit = JSON.stringify(store.developerLogs);
    expect(audit).toContain("again-first");
    expect(audit).toContain("again-second");
    expect(audit).toContain("OBSERVATION_PLAN_NO_PROGRESS");
  });

  it("does not bypass read-only authority by regenerating a mutating action", async () => {
    vi.mocked(backend.generatePlan).mockResolvedValue([{ ...probe("write"), kind: "change", command: "touch /tmp/new-deployment",
      action: { type: "shell", command: "touch /tmp/new-deployment" } }]);
    const store = useOpsStore();
    await store.submitRequirement("server", requirement, "safe", "model");
    expect(store.activeTask?.status).toBe("planning_failed");
    expect(store.activeTask?.plan).toEqual([]);
    expect(store.activeTask?.requirementLifecycle?.revision).toBe(1);
    expect(store.activeTask?.executionConstraints?.changePolicy).toBe("read_only");
    expect(backend.generatePlan).toHaveBeenCalledOnce();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("retains a failed regeneration without fallback reclassification or fresh budget", async () => {
    vi.mocked(backend.generatePlan).mockRejectedValue(new Error("MODEL_RECOVERY_BUDGET_EXHAUSTED"));
    const store = useOpsStore();
    await store.submitRequirement("server", requirement, "safe", "model");
    expect(store.activeTask?.status).toBe("planning_failed");
    expect(store.activeTask?.plan).toEqual([]);
    expect(backend.processRequirement).toHaveBeenCalledOnce();
    expect(backend.generatePlan).toHaveBeenCalledOnce();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(JSON.stringify(store.developerLogs)).toContain("MODEL_RECOVERY_BUDGET_EXHAUSTED");
  });

  it("discards a regenerated plan after cancellation while preserving the late response", async () => {
    const store = useOpsStore();
    vi.mocked(backend.generatePlan).mockImplementation(async () => {
      store.activeTask!.cancelRequested = true;
      store.activeTask!.status = "cancelled";
      return [read()];
    });
    await store.submitRequirement("server", requirement, "safe", "model");
    expect(store.activeTask?.status).toBe("cancelled");
    expect(store.activeTask?.plan).toEqual([]);
    expect(JSON.stringify(store.developerLogs)).toContain("read-handover");
    expect(backend.generatePlan).toHaveBeenCalledOnce();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it.each(["permission", "revision", "pending", "endpoint"])("rejects stale initial regeneration when %s changes", async boundary => {
    const store = useOpsStore();
    vi.mocked(backend.generatePlan).mockImplementation(async () => {
      const task = store.activeTask!;
      if (boundary === "permission") task.permission = "observe";
      if (boundary === "revision") task.requirementLifecycle!.revision += 1;
      if (boundary === "pending") task.pendingRequirements = [{ id: "new", content: "新增部署约束", baseRevision: 1, state: "pending", receivedAt: "now" }];
      if (boundary === "endpoint") store.servers = store.servers.map(server => ({ ...server, host: "replacement.invalid" }));
      return [read()];
    });
    await store.submitRequirement("server", requirement, "safe", "model");
    expect(store.activeTask?.status).toBe("planning_failed");
    expect(store.activeTask?.plan).toEqual([]);
    expect(store.activeTask?.planApproval).toBeUndefined();
    expect(backend.processRequirement).toHaveBeenCalledOnce();
    expect(backend.generatePlan).toHaveBeenCalledOnce();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });
});
