import { describe, expect, it } from "vitest";
import { i18n, messages } from "./i18n";

function collectLeafKeys(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object" ? collectLeafKeys(child, path) : [path];
  });
}

describe("i18n resources", () => {
  it("中英文资源拥有相同且非空的叶子键", () => {
    const zhKeys = collectLeafKeys(messages["zh-CN"]).sort();
    const enKeys = collectLeafKeys(messages["en-US"]).sort();

    expect(enKeys).toEqual(zhKeys);
    for (const key of zhKeys) {
      const segments = key.split(".");
      const zh = segments.reduce<unknown>((value, segment) => (value as Record<string, unknown>)[segment], messages["zh-CN"]);
      const en = segments.reduce<unknown>((value, segment) => (value as Record<string, unknown>)[segment], messages["en-US"]);
      expect(String(zh).trim()).not.toBe("");
      expect(String(en).trim()).not.toBe("");
    }
  });

  it("切换语言后立即返回对应的工作台文案", () => {
    i18n.global.locale.value = "zh-CN";
    expect(i18n.global.t("agent.approvePlan")).toBe("批准并执行");

    i18n.global.locale.value = "en-US";
    expect(i18n.global.t("agent.approvePlan")).toBe("Approve & execute");
    expect(i18n.global.t("dashboard.serverCount", { count: 3 })).toBe("3 servers");

    i18n.global.locale.value = "zh-CN";
  });
});
