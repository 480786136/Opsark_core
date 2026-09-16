import { afterEach, describe, expect, it } from "vitest";
import { computed } from "vue";
import { i18n } from "./i18n";
import { localizeCoreText } from "./coreText";

afterEach(() => { i18n.global.locale.value = "zh-CN"; });

describe("Core system message presentation", () => {
  it("reacts to locale changes without changing stored state", () => {
    const stored = { phase: "正在验证 SSH 连接" };
    const label = computed(() => localizeCoreText(stored.phase));
    expect(label.value).toBe(stored.phase);
    i18n.global.locale.value = "en-US";
    expect(label.value).toBe("Verifying the SSH connection");
    i18n.global.locale.value = "zh-CN";
    expect(label.value).toBe(stored.phase);
  });

  it("localizes known validation messages and preserves technical field names", () => {
    expect(localizeCoreText("Invalid thinking", "zh-CN")).toBe("thinking 的值无效");
    expect(localizeCoreText("请填写必填参数“用户名”", "en-US")).toBe("Complete the required field “用户名”");
    expect(localizeCoreText("工具“deploy” 的输出: error", "en-US")).toBe("工具“deploy” 的输出: error");
  });

  it("does not translate arbitrary raw output, user text or undefined values", () => {
    for (const original of ["我的任务", "日志: SSH 已连接", "Error: 用户自定义内容", "模型回答\n正在确认连接"]) {
      expect(localizeCoreText(original, "en-US")).toBe(original);
    }
    expect(localizeCoreText(undefined, "en-US")).toBe("");
    expect(localizeCoreText(null, "zh-CN")).toBe("");
  });

  it("translates persisted credential and knowledge errors in both directions", () => {
    const translated = localizeCoreText("该服务器已存在同名变量", "en-US");
    expect(translated).not.toBe("该服务器已存在同名变量");
    expect(localizeCoreText(translated, "zh-CN")).toBe("该服务器已存在同名变量");
    const error = localizeCoreText("上传开关已关闭，队列已暂停", "en-US");
    expect(localizeCoreText(error, "zh-CN")).toBe("上传开关已关闭，队列已暂停");
    expect(localizeCoreText("知识服务返回 HTTP 503", "en-US")).toBe("Knowledge service returned HTTP 503");
    expect(localizeCoreText("Knowledge service returned HTTP 503", "zh-CN")).toBe("知识服务返回 HTTP 503");
  });
});
