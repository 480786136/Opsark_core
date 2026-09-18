// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import SupportView from "./SupportView.vue";
import { useOpsStore } from "@/stores/ops";
import { useAccountStore } from "@/features/account/accountStore";
import { cloudRequest } from "@/features/account/cloudClient";
import { collectTaskLogs } from "@/features/support/diagnostics";
import { readFeedbackImages } from "@/features/support/images";
import type { OpsTask } from "@/types";
vi.mock("@/features/account/cloudClient", () => ({ cloudRequest: vi.fn() }));
vi.mock("@/features/support/diagnostics", async importOriginal => ({ ...await importOriginal<typeof import("@/features/support/diagnostics")>(), collectTaskLogs: vi.fn() }));
let app: App;
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await nextTick(); };
beforeEach(() => { localStorage.clear(); vi.resetAllMocks(); vi.mocked(cloudRequest).mockResolvedValue({ id: "ticket-one" }); vi.mocked(collectTaskLogs).mockResolvedValue("complete logs"); });
afterEach(() => { app?.unmount(); document.body.innerHTML = ""; });
async function mount() {
  const pinia = createPinia(); setActivePinia(pinia);
  const ops = useOpsStore(); ops.tasks = [{ id: "task-one", title: "重启服务", status: "failed", plan: [] }] as unknown as OpsTask[];
  const host = document.createElement("div"); document.body.append(host);
  app = createApp(SupportView).use(pinia); app.mount(host); await settle();
  await fill("#feedback-title", "测试反馈"); await fill("#feedback-message", "问题详情");
}
async function fill(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!; input.value = value;
  input.dispatchEvent(new Event(selector === "#feedback-task" ? "change" : "input")); await nextTick();
}
async function submit() { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await settle(); }
function button(label: string) { return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent?.trim() === label)!; }
it("submits ordinary feedback without login, task data or confirmation", async () => {
  await mount(); await fill("#feedback-contact", "my-wechat"); await submit();
  expect(cloudRequest).toHaveBeenCalledWith("feedback_create", expect.objectContaining({ contact: "my-wechat", category: "general", task_logs: "", images: [], consent: true }), undefined);
  expect(collectTaskLogs).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.querySelector('[role="status"]')?.textContent).toContain("反馈已提交");
  expect(document.querySelector(".contact-card")?.textContent).toContain("zgkj@zgspace.cn");
});
it("waits for task-log consent and cancellation uploads nothing", async () => {
  await mount(); await fill("#feedback-task", "task-one"); await submit();
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("仅用于分析和处理");
  expect(cloudRequest).not.toHaveBeenCalled(); expect(collectTaskLogs).not.toHaveBeenCalled();
  button("取消").click(); await settle();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull(); expect(cloudRequest).not.toHaveBeenCalled();
  await submit(); button("确认并提交").click(); await settle();
  expect(collectTaskLogs).toHaveBeenCalledOnce();
  expect(cloudRequest).toHaveBeenCalledWith("feedback_create", expect.objectContaining({ category: "task", task_logs: "complete logs", diagnostic: expect.objectContaining({ taskId: "task-one" }) }), undefined);
});
it("retries the identical task snapshot and mutation after a network failure", async () => {
  await mount(); await fill("#feedback-task", "task-one");
  vi.mocked(cloudRequest).mockRejectedValueOnce(new Error("offline"));
  await submit(); button("确认并提交").click(); await settle();
  const original = vi.mocked(cloudRequest).mock.calls[0][1];
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("offline");
  await submit(); button("确认并提交").click(); await settle();
  expect(collectTaskLogs).toHaveBeenCalledOnce();
  expect(vi.mocked(cloudRequest).mock.calls[1][1]).toEqual(original);
});
it("does not report a successful submission as failed when history refresh fails", async () => {
  await mount();
  useAccountStore().current = { user: { id: "owner" } } as NonNullable<ReturnType<typeof useAccountStore>["current"]>;
  vi.mocked(cloudRequest).mockResolvedValueOnce({ id: "saved" }).mockRejectedValueOnce(new Error("list unavailable"));
  await submit();
  expect(document.querySelector('[role="status"]')?.textContent).toContain("反馈已提交");
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
it("accepts optional images and rejects excess, unsupported and oversized uploads", async () => {
  const png = new File(["image"], "screen.png", { type: "image/png" });
  expect(await readFeedbackImages([png, png, png], 0)).toHaveLength(3);
  await expect(readFeedbackImages([png], 3)).rejects.toThrow("最多上传 3 张");
  await expect(readFeedbackImages([new File(["svg"], "screen.svg", { type: "image/svg+xml" })], 0)).rejects.toThrow("仅支持");
  await expect(readFeedbackImages([new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })], 0)).rejects.toThrow("5 MB");
});
