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

  it("keeps persisted protocol compiler details out of the user-facing conversation", () => {
    const legacy = "后续计划生成失败：PlanProtocolError: 计划协议校验失败：OBSERVE_COMMAND_MUTATION / steps[3].command；协议修复失败：PROTOCOL_REPAIR_SCOPE_VIOLATION";
    const chinese = localizeCoreText(legacy, "zh-CN");
    const english = localizeCoreText(legacy, "en-US");
    expect(chinese).toContain("当前检查结果和已完成步骤已保留");
    expect(english).toContain("were preserved");
    for (const visible of [chinese, english]) {
      expect(visible).not.toContain("PlanProtocolError");
      expect(visible).not.toContain("OBSERVE_COMMAND_MUTATION");
      expect(visible).not.toContain("steps[3].command");
      expect(visible).not.toContain("PROTOCOL_REPAIR_SCOPE_VIOLATION");
    }
    expect(localizeCoreText("当前阶段已完成；调整计划生成失败：模型未返回后续步骤", "zh-CN"))
      .not.toContain("生成失败");
    expect(localizeCoreText("Skill 选择已保留，计划生成失败", "zh-CN"))
      .not.toContain("生成失败");
    const actionable = "本轮计划生成失败：模型 API Key 未恢复，请前往设置重新保存。";
    expect(localizeCoreText(actionable, "zh-CN")).toBe(actionable);
    expect(localizeCoreText(
      "当前目标和已完成结果已保留，未执行任何新的服务器操作。后续方案待完善；需要确认的操作会在执行前提示。",
      "en-US",
    )).toContain("no new server action was executed");
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
