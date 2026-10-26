import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useOpsStore } from "./ops";
import { archiveActivePhase } from "@/features/agent/taskGoal";
import { buildTaskDecisionSnapshot } from "@/features/agent/taskDecisionSnapshot";
import * as agentService from "@/features/agent/agentService";
import type { PlanStep } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
const source = (id = "source", output = "CAPTURED_VALUE=one"): PlanStep => ({ id, title: id, description: "读取状态",
  command: "inspect", validation: "", expected: "取得事实", kind: "observe", risk: "low", status: "completed", output,
  attemptContext: JSON.stringify(["old-server", "old-round", "session", 1, 0]),
  result: { executionStatus: "success", observationStatus: "matched", facts: {}, warnings: [], evidenceIds: [id] },
  evidence: [{ id, type: "command-output", source: "main", rawOutput: output, facts: {}, collectedAt: "now" }] });

describe("决策前证据归档及保存重试", () => {
  beforeEach(() => {
    vi.restoreAllMocks(); localStorage.clear(); setActivePinia(createPinia());
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    vi.spyOn(backend, "saveTaskEvidence").mockResolvedValue("a".repeat(64));
    vi.spyOn(backend, "executeCommand").mockRejectedValue(new Error("禁止派发"));
    vi.spyOn(backend, "executeAgentCommand").mockRejectedValue(new Error("禁止派发"));
    vi.spyOn(backend, "decideNextStage").mockRejectedValue(new Error("禁止调用模型"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    const store = useOpsStore(); store.tasks.forEach(t => { t.cancelRequested = true; });
    await store.persist(true); store.stopConnectionMonitor(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });
  function setup() {
    const store = useOpsStore(), task = store.createTask("current-server", "safe", "fixture");
    task.currentRoundId = "new-round"; task.plan = [source()];
    return { store, task };
  }
  it("失败转阶段前补齐先前成功步骤，短输出也有原轮次和目标的补读引用", async () => {
    const { store, task } = setup();
    task.plan.push({ ...source("failed", "UNSUPPORTED"), status: "failed" });
    await store.archiveTaskDecisionEvidence(task);
    expect(backend.saveTaskEvidence).toHaveBeenCalledWith(task.id, expect.objectContaining({
      roundId: "old-round", serverId: "old-server", stepId: "source", taskId: task.id,
      targetContext: task.plan[0].attemptContext, sourceEvidenceId: "source" }));
    archiveActivePhase(task, "adjustment"); task.plan = [];
    const references = buildTaskDecisionSnapshot(task, undefined, true).recentPhases[0].steps[0].output?.references;
    expect(references).toMatchObject([{ taskId: task.id, serverId: "old-server", roundId: "old-round", readTool: "evidence.read" }]);
  });
  it("真实beginAdjustment入口先保存已有成功证据，再进入联合模型决策", async () => {
    const { store, task } = setup(); task.status = "needs_adjustment";
    task.plan.push({ ...source("unsupported", "UNSUPPORTED"), status: "failed" });
    vi.spyOn(store, "hydrateCredentials").mockResolvedValue(undefined);
    vi.spyOn(store, "reconcilePendingExecution").mockResolvedValue(undefined);
    const decide = vi.spyOn(agentService, "decideTaskNextStage").mockImplementation(async input => {
      expect(input.task.plan[0].evidence![0].archive?.evidenceId).toBe("a".repeat(64));
      expect(backend.saveTaskEvidence).toHaveBeenCalledTimes(2);
      throw new Error("fixture-stop-after-archive");
    });
    await store.beginAdjustment(task.id);
    expect(decide).toHaveBeenCalledTimes(1); expect(backend.executeCommand).not.toHaveBeenCalled();
  });
  it("同一原执行的阶段副本复用归档，但目标不同不合并", async () => {
    const { store, task } = setup();
    archiveActivePhase(task, "adjustment");
    await store.archiveTaskDecisionEvidence(task);
    expect(backend.saveTaskEvidence).toHaveBeenCalledTimes(1);
    task.plan[0].attemptContext = JSON.stringify(["other-server", "old-round", "session", 1, 0]);
    await store.archiveTaskDecisionEvidence(task);
    expect(backend.saveTaskEvidence).toHaveBeenCalledTimes(2);
    expect(task.plan[0].evidence![0].archive?.serverId).toBe("other-server");
  });
  it("归档失败可见；保存重试不会调用模型或远端执行，原正文不变", async () => {
    const { store, task } = setup(), output = task.plan[0].output;
    vi.mocked(backend.saveTaskEvidence).mockRejectedValueOnce(new Error("private internal detail"));
    await store.archiveTaskDecisionEvidence(task);
    expect(task.evidenceArchiveWarning).toContain("重试保存");
    expect(task.plan[0].evidence![0].archive).toBeUndefined();
    expect(JSON.stringify(task)).not.toContain("private internal detail");
    await store.retryTaskEvidenceArchive(task.id);
    expect(task.evidenceArchiveWarning).toBeUndefined(); expect(task.plan[0].output).toBe(output);
    expect(task.plan[0].evidence![0].archive?.evidenceId).toBe("a".repeat(64));
    expect(backend.executeCommand).not.toHaveBeenCalled(); expect(backend.executeAgentCommand).not.toHaveBeenCalled();
    expect(backend.decideNextStage).not.toHaveBeenCalled();
  });
  it("本轮失效时停止后续保存，不修改新计划和审批", async () => {
    const { store, task } = setup(); task.plan.push(source("second"));
    const pending = store.archiveTaskDecisionEvidence(task, () => task.currentRoundId === "new-round");
    task.currentRoundId = "changed-round"; task.plan = [];
    await pending;
    expect(backend.saveTaskEvidence).toHaveBeenCalledTimes(1); expect(task.plan).toEqual([]);
    expect(task.planApproval).toBeUndefined(); expect(backend.decideNextStage).not.toHaveBeenCalled();
  });
});
