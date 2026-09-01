// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";
import LogsView from "./LogsView.vue";

describe("LogsView developer mode", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => host.remove());

  it("switches from audit logs to complete developer diagnostics", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    store.addDeveloperLog({
      level: "error",
      operation: "requirement_processing",
      title: "需求处理模型调用失败",
      summary: "模型响应缺少需求理解结果",
      trace: { attempts: [{ attempt: 1, response: { choices: [] } }] },
    });
    const app = createApp(LogsView).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain("操作日志");
    expect(host.querySelector(".developer-log-panel")).toBeNull();

    host.querySelectorAll<HTMLButtonElement>(".log-mode-tabs button")[1].click();
    await nextTick();

    expect(host.textContent).toContain("开发者日志");
    expect(host.textContent).toContain("需求处理模型调用失败");
    expect(host.querySelector(".developer-log-panel")).not.toBeNull();
    app.unmount();
  });
});
