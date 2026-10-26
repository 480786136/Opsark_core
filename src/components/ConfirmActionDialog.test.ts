// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import ConfirmActionDialog from "./ConfirmActionDialog.vue";
import { useActionConfirmation } from "./useActionConfirmation";

let app: App | undefined;
afterEach(() => { app?.unmount(); app = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); });
const settle = async () => { await nextTick(); await nextTick(); };
function mount() {
  let api!: ReturnType<typeof useActionConfirmation>;
  const host = document.createElement("div"); document.body.append(host);
  app = createApp({
    setup() {
      api = useActionConfirmation();
      return () => h(ConfirmActionDialog, {
        message: api.confirmationMessage.value,
        requestId: api.confirmationId.value,
        onResult: api.resolveConfirmation,
      });
    },
  });
  app.mount(host);
  return api;
}

describe("原生顶层操作确认", () => {
  it("在已有原生编辑器上调用showModal，取消后返回编辑器焦点", async () => {
    const editor = document.createElement("dialog");
    const trigger = document.createElement("button"); editor.append(trigger); document.body.append(editor);
    editor.showModal(); trigger.focus();
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const api = mount(); const pending = api.confirmAction("删除所选对象？"); await settle();
    const confirmation = document.querySelector<HTMLDialogElement>("dialog.action-confirmation")!;
    expect(confirmation).not.toBeNull();
    expect(confirmation.open).toBe(true);
    expect(showModal).toHaveBeenCalledOnce();
    expect(showModal.mock.contexts[0]).toBe(confirmation);
    expect(editor.open).toBe(true);
    expect(document.activeElement).toBe(confirmation.querySelector(".secondary"));
    confirmation.dispatchEvent(new Event("cancel", { cancelable: true })); await settle();
    await expect(pending).resolves.toBe(false);
    expect(document.querySelector(".action-confirmation")).toBeNull();
    expect(editor.open).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("连续点击仅确认一次，同文案的新请求可再次确认", async () => {
    const api = mount();
    const first = api.confirmAction("删除？"); await settle();
    const button = document.querySelector<HTMLButtonElement>(".action-confirmation .primary")!;
    button.click(); button.click(); await expect(first).resolves.toBe(true);
    const second = api.confirmAction("删除？"); await settle();
    expect(document.querySelector<HTMLDialogElement>(".action-confirmation")!.open).toBe(true);
    document.querySelector<HTMLButtonElement>(".action-confirmation .primary")!.click();
    await expect(second).resolves.toBe(true);
  });

  it("同文案替换使旧请求取消，迟到旧结果不能批准新请求", async () => {
    const api = mount();
    const first = api.confirmAction("删除？"); const firstId = api.confirmationId.value;
    await settle();
    const second = api.confirmAction("删除？"); await settle();
    await expect(first).resolves.toBe(false);
    api.resolveConfirmation(true, firstId);
    expect(api.confirmationMessage.value).toBe("删除？");
    const resolved = vi.fn(); void second.then(resolved); await settle();
    expect(resolved).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>(".action-confirmation .secondary")!.click();
    await expect(second).resolves.toBe(false);
  });

  it("原生close和卸载均取消待定请求，不返回到已关闭编辑器", async () => {
    const editor = document.createElement("dialog"), trigger = document.createElement("button");
    editor.append(trigger); document.body.append(editor); editor.showModal(); trigger.focus();
    const api = mount(); const first = api.confirmAction("删除？"); await settle();
    editor.close();
    const focus = vi.spyOn(trigger, "focus");
    const confirmation = document.querySelector<HTMLDialogElement>(".action-confirmation")!;
    confirmation.close(); confirmation.dispatchEvent(new Event("close")); await settle();
    await expect(first).resolves.toBe(false);
    expect(focus).not.toHaveBeenCalled();
    const second = api.confirmAction("删除另一对象？"); await settle();
    app!.unmount(); app = undefined;
    await expect(second).resolves.toBe(false);
    expect(document.querySelector(".action-confirmation")).toBeNull();
  });
});
