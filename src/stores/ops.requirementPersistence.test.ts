import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useOpsStore } from "./ops";
import { taskAcceptanceRequirement, taskRequirementSnapshot } from "@/features/agent/taskGoal";

describe("requirement sources across task cache compaction", () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); setActivePinia(createPinia()); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("retains the full supplement after its visible message falls outside the cache window", () => {
    const store = useOpsStore();
    const task = store.createTask("server", "safe", "model");
    task.rootGoal = "查询磁盘剩余空间";
    const supplement = "列出大文件，排除这些路径：" + "/retained-path ".repeat(1300);
    task.currentInstruction = supplement;
    task.lastRequirementRelation = "supplement";
    task.currentRoundId = "scan-round";
    task.messages = [
      { id: "root", role: "user", kind: "message", content: task.rootGoal, requirementRelation: "new_goal", createdAt: "2026-09-27T01:00:00Z" },
      { id: "supplement", role: "user", kind: "message", content: supplement, requirementRelation: "supplement", createdAt: "2026-09-27T01:01:00Z" },
      ...Array.from({ length: 250 }, (_, i) => ({ id: `event-${i}`, role: "system" as const,
        kind: "event" as const, content: "运行中", createdAt: "2026-09-27T01:02:00Z" })),
    ];
    store.persist(true);
    const cached = JSON.parse(localStorage.getItem("opsark.tasks")!)[0];
    expect(cached.messages.some((message: { id: string }) => message.id === "supplement")).toBe(false);
    expect(cached.persistedRequirements.sources.find((source: { sourceMessageId: string }) => source.sourceMessageId === "supplement").content).toBe(supplement);

    store.$dispose();
    setActivePinia(createPinia());
    const reloaded = useOpsStore().tasks.find(item => item.id === task.id)!;
    reloaded.currentInstruction = "继续";
    reloaded.lastRequirementRelation = "continue";
    reloaded.currentRoundId = "continue-round";
    expect(taskAcceptanceRequirement(reloaded)).toContain(supplement);
    expect(taskRequirementSnapshot(reloaded).requirements).toHaveLength(2);
    useOpsStore().persist(true);
    const recached = JSON.parse(localStorage.getItem("opsark.tasks")!)[0];
    expect(taskAcceptanceRequirement(recached)).toContain(supplement);
  });
});
