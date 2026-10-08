// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import { backend } from "@/services/backend";
import ExecutionHistory from "./ExecutionHistory.vue";
afterEach(() => vi.restoreAllMocks());
it("loads history only on demand and reads evidence under the original task without remote execution", async () => {
  localStorage.clear();
  const pinia = createPinia(), store = useOpsStore(pinia);
  const load = vi.spyOn(store, "loadExecutionHistory").mockResolvedValue([{ taskId: "original", title: "原目标", canOpen: false, removed: true,
    receipts: [{ operationId: "op", attemptId: "attempt", title: "检查磁盘", status: "succeeded", action: { type: "shell", command: "df -h" }, targets: [], expected: "磁盘状态", recordedAt: 1, late: false, evidenceRefs: ["proof"] }] }]);
  const read = vi.spyOn(backend, "readTaskEvidence").mockResolvedValue({ text: "original evidence" });
  const execute = vi.spyOn(backend, "executeCommand"), model = vi.spyOn(backend, "reviewStep");
  const host = document.createElement("div");
  const app = createApp(ExecutionHistory).use(pinia).use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": {} } }));
  app.mount(host);
  try {
    expect(load).not.toHaveBeenCalled(); expect(host.querySelector("section")).toBeNull();
    host.querySelector<HTMLButtonElement>("button")!.click();
    await nextTick(); await nextTick();
    expect(load).toHaveBeenCalledOnce(); expect(host.textContent).toContain("已从任务列表移除");
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "查看已保存证据")!.click();
    await nextTick(); await nextTick();
    expect(read).toHaveBeenCalledWith("original", "proof", 0, 8000);
    expect(host.textContent).toContain("original evidence"); expect(execute).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled();
  } finally { app.unmount(); }
});
