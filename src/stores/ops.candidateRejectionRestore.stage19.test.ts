import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useOpsStore } from "./ops";
import type { ModelServiceError, OpsTask, TaskStatus } from "@/types";
import { archiveTasks } from "@/services/taskArchive";

const cause = { version: 1 as const, code: "TOOL_ARGUMENT_INVALID" as const, stepIndex: 0,
  toolIds: ["files.preview_deletion"], keyword: "minItems", rejectedCandidateExecuted: false as const };
function fixture(status: TaskStatus = "planning_failed"): OpsTask {
  const error: ModelServiceError = { code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", origin: "core", stage: "recovery_budget",
    message: "private-provider-prose", retryable: false, requestKey: "original-request", modelOperationId: "original-operation",
    recoveryBudget: { remainingWaitMs: 88067, requiredWaitMs: 90000, generations: 2, fieldRepairs: 0, candidateRegenerations: 0 }, candidateRejection: cause };
  return { id: "saved-task", serverId: "server", title: "读取配置", rootGoal: "读取配置", currentInstruction: "读取配置",
    currentRoundId: "saved-round", status, permission: "safe", modelId: "model", createdAt: "2026-10-22", updatedAt: "2026-10-22",
    messages: [], plan: [], pauseReason: "旧版仅显示预算不足", modelPlanningBlocker: { error, conditionsFingerprint: "saved-fingerprint", recordedAt: "2026-10-22" } };
}
beforeEach(() => { localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia()); });
afterEach(() => { useOpsStore().$dispose(); vi.restoreAllMocks(); localStorage.clear(); });

describe("第十九批：通过实际任务缓存加载入口恢复候选拒绝", () => {
  it.each(["planning_failed", "needs_adjustment", "awaiting_continuation"] as TaskStatus[])("恢复暂停正文和双原因，不重新规划：%s", status => {
    const saved = fixture(status), originalError = structuredClone(saved.modelPlanningBlocker!.error);
    localStorage.setItem("opsark.tasks", JSON.stringify([saved]));
    const generate = vi.spyOn(backend, "generatePlan"), execute = vi.spyOn(backend, "executeCommand");
    const store = useOpsStore(), task = store.tasks.find(task => task.id === saved.id)!;
    expect(task.pauseReason).toContain("工具参数列表条目不足");
    expect(task.pauseReason).toContain("88.067 秒"); expect(task.pauseReason).toContain("90 秒");
    expect(task.pauseReason).not.toContain("private-provider-prose");
    expect(task.modelPlanningBlocker!.error).toEqual(originalError);
    expect(task.status).toBe(status); expect(task.currentRoundId).toBe("saved-round");
    expect(task.plan).toEqual([]); expect(task.planApproval).toBeUndefined();
    expect(generate).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "completed", "failed"] as TaskStatus[])("已结束任务保留原终态和正文：%s", status => {
    const saved = fixture(status); localStorage.setItem("opsark.tasks", JSON.stringify([saved]));
    const task = useOpsStore().tasks[0];
    expect(task.status).toBe(status); expect(task.pauseReason).toBe(saved.pauseReason);
    expect(task.modelPlanningBlocker?.error).toEqual(saved.modelPlanningBlocker?.error);
  });

  it("非法首因不被当作已验证的恢复诊断", () => {
    const saved = fixture();
    (saved.modelPlanningBlocker!.error as unknown as Record<string, unknown>).candidateRejection = { ...cause, rejectedCandidateExecuted: true };
    localStorage.setItem("opsark.tasks", JSON.stringify([saved]));
    expect(useOpsStore().tasks[0].pauseReason).toBe(saved.pauseReason);
  });

  it("从任务归档打开时使用相同加载校验，保留原停止身份且不恢复执行", async () => {
    const saved = fixture("needs_adjustment"), error = structuredClone(saved.modelPlanningBlocker!.error);
    await archiveTasks([saved]);
    const store = useOpsStore();
    vi.spyOn(store, "refreshExecutionLedger").mockResolvedValue();
    const generate = vi.spyOn(backend, "generatePlan"), execute = vi.spyOn(backend, "executeCommand");
    expect(store.tasks).toHaveLength(0);
    const restored = await store.openArchivedTask(saved.id);
    expect(restored.pauseReason).toContain("工具参数列表条目不足");
    expect(restored.pauseReason).toContain("88.067 秒");
    expect(restored.modelPlanningBlocker!.error).toEqual(error);
    expect(restored.status).toBe("needs_adjustment"); expect(restored.currentRoundId).toBe("saved-round");
    expect(restored.planApproval).toBeUndefined(); expect(restored.plan).toEqual([]);
    expect(generate).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
});
