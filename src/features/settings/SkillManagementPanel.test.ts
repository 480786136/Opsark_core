// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";
import SkillManagementPanel from "@/features/settings/SkillManagementPanel.vue";

describe("SkillManagementPanel", () => {
  beforeEach(() => localStorage.clear());

  it("lists built-in Skills and can create a configurable Skill", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    const app = createApp(SkillManagementPanel, { standalone: true }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain("终端 SSH 跳转");
    host.querySelector<HTMLButtonElement>(".skill-add-button")?.click();
    await nextTick();

    const custom = store.skills.find((skill) => !skill.builtIn);
    expect(custom).toBeDefined();
    expect(host.textContent).toContain(custom!.id);
    expect(host.textContent).toContain("自定义 Skill");
    app.unmount();
    host.remove();
  });
});
