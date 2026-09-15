// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, type App } from "vue";
import ParameterSelect from "./ParameterSelect.vue";

describe("ParameterSelect", () => {
  let host: HTMLElement;
  let app: App;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    app.unmount();
    host.remove();
  });

  function mountSelect(options = [{ value: "a", label: "目标 A" }, { value: "b", label: "目标 B" }]) {
    const props = reactive({ modelValue: "", options, ariaLabel: "处理目标", placeholder: "请选择处理目标", disabled: false, clearable: false });
    const update = vi.fn((value: string) => { props.modelValue = value; });
    app = createApp(() => h(ParameterSelect, { ...props, "onUpdate:modelValue": update }));
    app.mount(host);
    return { props, update, trigger: host.querySelector<HTMLElement>("summary")!, root: host.querySelector("details")! };
  }

  function press(element: HTMLElement, key: string) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  it("显示占位符且不默认选择；保留已有空串默认选项的兼容行为", async () => {
    const { props, update, trigger } = mountSelect();
    expect(trigger.textContent).toBe("请选择处理目标");
    expect(host.querySelector("[aria-selected='true']")).toBeNull();
    expect(update).not.toHaveBeenCalled();
    props.options = [{ value: "", label: "应用默认" }, { value: "enabled", label: "开启" }];
    await nextTick();
    expect(trigger.textContent).toBe("应用默认");
    expect(trigger.querySelector(".placeholder")).toBeNull();
    expect(host.querySelector("[aria-selected='true']")?.textContent?.trim()).toBe("应用默认");
    expect(update).not.toHaveBeenCalled();
  });

  it("方向键和首尾键移动焦点，Escape 关闭，显式选择才发出真实值", async () => {
    const { update, trigger, root } = mountSelect();
    const options = host.querySelectorAll<HTMLButtonElement>("[role='option']");
    trigger.focus();
    press(trigger, "ArrowDown");
    await nextTick();
    expect(root.open).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(options[0]);
    press(options[0], "ArrowDown");
    await nextTick();
    expect(document.activeElement).toBe(options[1]);
    press(options[1], "Home");
    await nextTick();
    expect(document.activeElement).toBe(options[0]);
    press(options[0], "End");
    await nextTick();
    expect(document.activeElement).toBe(options[1]);
    expect(update).not.toHaveBeenCalled();
    press(options[1], "Escape");
    await nextTick();
    expect(root.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    press(trigger, "Enter");
    await nextTick();
    options[1].click();
    await nextTick();
    expect(update).toHaveBeenCalledExactlyOnceWith("b");
    expect(trigger.textContent).toBe("目标 B");
    expect(root.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("禁用时关闭已打开菜单并拒绝鼠标和键盘变更", async () => {
    const { props, update, trigger, root } = mountSelect();
    props.clearable = true;
    props.modelValue = "a";
    trigger.click();
    await nextTick();
    expect(root.open).toBe(true);
    props.disabled = true;
    await nextTick();
    expect(root.open).toBe(false);
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.tabIndex).toBe(-1);
    trigger.click();
    press(trigger, "ArrowDown");
    const option = host.querySelector<HTMLButtonElement>("[role='option']")!;
    expect(option.disabled).toBe(true);
    option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const clear = host.querySelector<HTMLButtonElement>(".parameter-clear")!;
    expect(clear.disabled).toBe(true);
    clear.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(root.open).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("长选项保留完整 title，移出焦点或点击外部会关闭菜单", async () => {
    const longLabel = "目标名称包含用于区分环境和范围的完整说明".repeat(8);
    const { props, trigger, root } = mountSelect([{ value: "target-id", label: longLabel }]);
    props.modelValue = "target-id";
    await nextTick();
    expect(host.querySelector(".parameter-clear")).toBeNull();
    expect(trigger.querySelector("span")?.title).toBe(longLabel);
    expect(host.querySelector<HTMLButtonElement>("[role='option']")?.title).toBe(longLabel);
    trigger.click();
    await nextTick();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await nextTick();
    expect(root.open).toBe(false);
    trigger.click();
    await nextTick();
    trigger.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    await nextTick();
    expect(root.open).toBe(false);
  });
});
