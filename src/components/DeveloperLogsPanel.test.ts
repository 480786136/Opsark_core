// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";
import DeveloperLogsPanel from "./DeveloperLogsPanel.vue";

describe("DeveloperLogsPanel", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => host.remove());

  it("opens the server/task workspace and shows full diagnostics with token usage", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    store.addDeveloperLog({
      level: "error",
      operation: "requirement_processing",
      title: "需求处理模型调用失败",
      summary: "模型响应缺少需求理解结果",
      request: { requirement: "再次尝试" },
      trace: { attempts: [{ attempt: 1, response: { choices: [] } }] },
      response: { intent: "execute" },
      error: "ModelInvocationError: missing result",
      taskId: "task-1",
      modelName: "DeepSeek V4 Flash",
      durationMs: 84,
    });

    const app = createApp(DeveloperLogsPanel).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).not.toContain("再次尝试");
    host.querySelector<HTMLButtonElement>(".developer-server-summary")!.click();
    await nextTick();

    expect(host.textContent).toContain("需求处理模型调用失败");
    expect(host.textContent).toContain("DeepSeek V4 Flash");
    expect(host.textContent).toContain("完整请求（不含鉴权头）");
    expect(host.textContent).toContain("再次尝试");
    expect(host.textContent).toContain('"choices": []');
    expect(host.textContent).toContain("ModelInvocationError: missing result");
    expect(host.textContent).toContain("估算用量");
    expect([...host.querySelectorAll<HTMLElement>(".developer-detail-card pre")].every((block) => block.tabIndex === 0)).toBe(true);
    app.unmount();
  });
});
