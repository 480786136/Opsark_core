// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, nextTick, reactive } from "vue";
import { createI18n } from "vue-i18n";
import { backend } from "@/services/backend";
import SavedEvidenceViewer from "./SavedEvidenceViewer.vue";
afterEach(() => vi.restoreAllMocks());
const i18n = () => createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": {} } });
it("renders the tool's actual tree and keeps the evidence envelope in collapsed technical details", async () => {
  const read = vi.spyOn(backend, "readTaskEvidence").mockResolvedValue({ evidenceId: "proof", historical: true, metadata: { attemptId: "attempt" }, nextOffset: null,
    text: JSON.stringify({ toolId: "files.get_structure", success: true, data: { tree: "/opt/\n└── core-case/", pathStatus: "directory", truncated: false } }) });
  const host = document.createElement("div"), app = createApp(SavedEvidenceViewer, { taskId: "task", evidenceRefs: ["proof"] }).use(i18n());
  app.mount(host);
  try {
    expect(read).not.toHaveBeenCalled(); host.querySelector<HTMLButtonElement>("button")!.click();
    await nextTick(); await nextTick();
    expect(host.querySelector(".saved-evidence-output")?.textContent).toBe("/opt/\n└── core-case/");
    expect(host.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
    expect(host.querySelector("details")?.textContent).toContain("attemptId");
  } finally { app.unmount(); }
});
it("appends only explicitly requested evidence pages under the original identity", async () => {
  const read = vi.spyOn(backend, "readTaskEvidence").mockResolvedValueOnce({ text: "first ", nextOffset: 6 }).mockResolvedValueOnce({ text: "second", nextOffset: null });
  const host = document.createElement("div"), app = createApp(SavedEvidenceViewer, { taskId: "original", evidenceRefs: ["proof"] }).use(i18n());
  app.mount(host);
  try {
    host.querySelector<HTMLButtonElement>("button")!.click(); await nextTick(); await nextTick();
    expect(read).toHaveBeenCalledOnce();
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "继续读取")!.click();
    await nextTick(); await nextTick();
    expect(read).toHaveBeenLastCalledWith("original", "proof", 6, 8000);
    expect(host.querySelector(".saved-evidence-output")?.textContent).toBe("first second");
  } finally { app.unmount(); }
});
it("discards a late evidence response after switching tasks", async () => {
  let finish!: (value: Record<string, unknown>) => void;
  vi.spyOn(backend, "readTaskEvidence").mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const props = reactive({ taskId: "old", evidenceRefs: ["proof"] });
  const host = document.createElement("div"), app = createApp({ components: { SavedEvidenceViewer }, setup: () => ({ props }), template: '<SavedEvidenceViewer v-bind="props" />' }).use(i18n());
  app.mount(host);
  try {
    host.querySelector<HTMLButtonElement>("button")!.click(); props.taskId = "new"; await nextTick();
    finish({ text: "old task output" }); await nextTick(); await nextTick();
    expect(host.querySelector(".saved-evidence-output")).toBeNull();
  } finally { app.unmount(); }
});
