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

  function mountSelect(options: Array<{ value: string; label: string; disabled?: boolean }> = [{ value: "a", label: "目标 A" }, { value: "b", label: "目标 B" }]) {
    const props = reactive({ modelValue: "", options, ariaLabel: "处理目标", placeholder: "请选择处理目标", disabled: false, clearable: false, size: "default" as "compact" | "small" | "default" });
    const update = vi.fn((value: string) => { props.modelValue = value; });
    const change = vi.fn();
    app = createApp(() => h(ParameterSelect, { ...props, "onUpdate:modelValue": update, onChange: change }));
    app.mount(host);
    return { props, update, change, trigger: host.querySelector<HTMLElement>("summary")!, root: host.querySelector("details")! };
  }

  function renderedOptions() {
    return document.querySelectorAll<HTMLButtonElement>(".parameter-options [role='option']");
  }

  function press(element: HTMLElement, key: string) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  it("显示占位符且不默认选择；保留已有空串默认选项的兼容行为", async () => {
    const { props, update, trigger } = mountSelect();
    expect(trigger.textContent).toBe("请选择处理目标");
    expect(document.querySelector(".parameter-options [aria-selected='true']")).toBeNull();
    expect(update).not.toHaveBeenCalled();
    props.options = [{ value: "", label: "应用默认" }, { value: "enabled", label: "开启" }];
    await nextTick();
    expect(trigger.textContent).toBe("应用默认");
    expect(trigger.querySelector(".placeholder")).toBeNull();
    trigger.click();
    await nextTick();
    expect(document.querySelector(".parameter-options [aria-selected='true']")?.textContent?.trim()).toBe("应用默认");
    trigger.click();
    expect(update).not.toHaveBeenCalled();
  });

  it("方向键和首尾键移动焦点，Escape 关闭，显式选择才发出真实值", async () => {
    const { update, change, trigger, root } = mountSelect();
    trigger.focus();
    press(trigger, "ArrowDown");
    await nextTick();
    const options = renderedOptions();
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
    expect(change).toHaveBeenCalledExactlyOnceWith("b");
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
    expect(renderedOptions()).toHaveLength(2);
    expect(document.querySelector(".parameter-options .parameter-clear")).not.toBeNull();
    props.disabled = true;
    await nextTick();
    expect(root.open).toBe(false);
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.tabIndex).toBe(-1);
    expect(document.querySelector(".parameter-options")).toBeNull();
    trigger.click();
    press(trigger, "ArrowDown");
    await nextTick();
    expect(root.open).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("长选项保留完整 title，移出焦点或点击外部会关闭菜单", async () => {
    const longLabel = "目标名称包含用于区分环境和范围的完整说明".repeat(8);
    const { props, trigger, root } = mountSelect([{ value: "target-id", label: longLabel }]);
    props.modelValue = "target-id";
    await nextTick();
    expect(document.querySelector(".parameter-options .parameter-clear")).toBeNull();
    expect(trigger.querySelector("span")?.title).toBe(longLabel);
    trigger.click();
    await nextTick();
    expect(renderedOptions()[0]?.title).toBe(longLabel);
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await nextTick();
    expect(root.open).toBe(false);
    trigger.click();
    await nextTick();
    trigger.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    await nextTick();
    expect(root.open).toBe(false);
  });

  it("跳过禁用选项，并显示紧凑尺寸和选中态", async () => {
    const { props, trigger, root, update } = mountSelect([
      { value: "disabled", label: "不可用", disabled: true },
      { value: "ready", label: "可用" },
    ]);
    props.size = "compact";
    await nextTick();
    expect(root.classList.contains("size-compact")).toBe(true);
    trigger.focus();
    press(trigger, "ArrowDown");
    await nextTick();
    const options = renderedOptions();
    expect(options[0].disabled).toBe(true);
    expect(document.activeElement).toBe(options[1]);
    options[0].click();
    expect(update).not.toHaveBeenCalled();
    options[1].click();
    await nextTick();
    expect(update).toHaveBeenCalledWith("ready");
  });

  it("Tab 从弹层回到对话框的正常焦点顺序，并跳过隐藏元素", async () => {
    app = createApp(() => h("div", { role: "dialog" }, [
      h("button", { id: "before" }, "上一项"),
      h(ParameterSelect, {
        modelValue: "",
        options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
        ariaLabel: "目标",
      }),
      h("button", { id: "hidden", hidden: true }, "隐藏项"),
      h("button", { id: "after" }, "下一项"),
    ]));
    app.mount(host);
    await nextTick();
    const trigger = host.querySelector<HTMLElement>("summary")!;

    trigger.focus();
    press(trigger, "ArrowDown");
    await nextTick();
    press(renderedOptions()[0], "Tab");
    await nextTick();
    expect(document.activeElement).toBe(host.querySelector("#after"));
    expect(host.querySelector("details")?.open).toBe(false);

    trigger.focus();
    press(trigger, "ArrowDown");
    await nextTick();
    renderedOptions()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.activeElement).toBe(host.querySelector("#before"));
  });

  it("尊重禁用 fieldset，并在视口底部自动向上展开", async () => {
    app = createApp(() => h("fieldset", { disabled: true }, [
      h(ParameterSelect, { modelValue: "", options: [{ value: "a", label: "A" }], ariaLabel: "目标" }),
    ]));
    app.mount(host);
    await nextTick();
    const trigger = host.querySelector<HTMLElement>("summary")!;
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.tabIndex).toBe(-1);

    app.unmount();
    app = createApp(() => h(ParameterSelect, { modelValue: "", options: [{ value: "a", label: "A" }], ariaLabel: "目标" }));
    app.mount(host);
    await nextTick();
    const viewportDescriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const heightDescriptor = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    const enabledTrigger = host.querySelector<HTMLElement>("summary")!;
    enabledTrigger.getBoundingClientRect = () => ({
      x: 20, y: 710, top: 710, left: 20, right: 220, bottom: 748, width: 200, height: 38,
      toJSON: () => ({}),
    } as DOMRect);
    enabledTrigger.click();
    await nextTick();
    await nextTick();
    expect(document.querySelector<HTMLElement>(".parameter-options")?.classList.contains("placement-top")).toBe(true);
    expect(document.querySelector<HTMLElement>(".parameter-options")?.style.transform).toBe("translateY(-100%)");
    if (viewportDescriptor) Object.defineProperty(window, "visualViewport", viewportDescriptor);
    if (heightDescriptor) Object.defineProperty(window, "innerHeight", heightDescriptor);
  });
});
