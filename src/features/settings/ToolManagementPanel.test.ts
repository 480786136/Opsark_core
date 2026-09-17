// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import ToolManagementPanel from "@/features/settings/ToolManagementPanel.vue";

describe("ToolManagementPanel", () => {
  beforeEach(() => localStorage.clear());

  it("keeps search controls outside the independently selectable tool list", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const pinia = createPinia();
    const app = createApp(ToolManagementPanel, { standalone: true }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.querySelector(".tool-list-panel > .tool-search")).not.toBeNull();
    expect(host.querySelector(".tool-list-panel > .tool-list-scroll")).not.toBeNull();

    const items = host.querySelectorAll<HTMLButtonElement>(".tool-list-scroll > .tool-list-item");
    expect(items.length).toBeGreaterThan(1);
    items[1].click();
    await nextTick();
    expect(items[1].getAttribute("aria-pressed")).toBe("true");

    app.unmount();
    host.remove();
  });
});
