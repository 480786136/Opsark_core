// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";
import SkillManagementPanel from "@/features/settings/SkillManagementPanel.vue";
import { backend } from "@/services/backend";
import { useAccountStore } from "@/features/account/accountStore";
import { useOfficialCatalogStore } from "@/features/account/officialCatalogStore";

describe("SkillManagementPanel", () => {
  beforeEach(() => { localStorage.clear(); document.body.innerHTML = ""; });
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });

  it("hides read-only system Skills and can create a user Skill", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    const app = createApp(SkillManagementPanel, { standalone: true }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.querySelector(".tool-list-panel > .tool-search")).not.toBeNull();
    expect(host.querySelector(".tool-list-panel > .tool-list-scroll")).not.toBeNull();
    expect(host.textContent).not.toContain("终端 SSH 跳转");
    expect(store.skills.some(skill => skill.builtIn)).toBe(true);
    host.querySelector<HTMLButtonElement>(".skill-add-button")?.click();
    await nextTick();

    const custom = store.skills.find((skill) => !skill.builtIn);
    expect(custom).toBeDefined();
    expect(custom?.category).toBe("other");
    expect({ name: custom?.name, description: custom?.description, instructions: custom?.instructions })
      .toEqual({ name: "", description: "", instructions: "" });
    expect(host.querySelector<HTMLInputElement>(".skill-basic-fields input")?.placeholder).toBe("新建 Skill");
    expect(host.querySelector<HTMLTextAreaElement>(".skill-basic-fields textarea")?.placeholder)
      .toBe("说明这个 Skill 负责处理的业务场景。");
    expect(host.textContent).toContain(custom!.id);
    expect(host.textContent).toContain("本地版本");
    expect(host.textContent).toContain("Skill 分类");
    expect(host.textContent).not.toContain("请求的执行能力");

    const name = host.querySelector<HTMLInputElement>(".skill-basic-fields input")!;
    name.value = "尚未保存的 Skill";
    name.dispatchEvent(new Event("input"));
    const requirement = host.querySelector<HTMLTextAreaElement>(".skill-authoring-prompt textarea")!;
    requirement.value = "上一份生成需求";
    requirement.dispatchEvent(new Event("input"));
    host.querySelector<HTMLButtonElement>(".skill-add-button")?.click();
    await nextTick();

    const personal = store.skills.filter(skill => !skill.builtIn);
    expect(personal).toHaveLength(2);
    expect(personal[0]?.name).toBe("尚未保存的 Skill");
    expect(host.querySelector(".tool-list-item.active")?.textContent).toContain(personal[1]!.id);
    expect(host.querySelector<HTMLTextAreaElement>(".skill-authoring-prompt textarea")?.value).toBe("");
    expect(Number(host.querySelector<HTMLTextAreaElement>(".skill-basic-fields textarea")?.rows)).toBe(5);
    app.unmount();
    host.remove();
  });

  it("previews AI output before explicitly applying it to the form", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    const skill = store.addSkill();
    Object.assign(skill, { name: "Current Skill", description: "Current description", instructions: "Current instructions" });
    store.models = [
      { id: "model-author", name: "Author", provider: "Test", model: "writer-v1", endpoint: "https://model.test", enabled: true, hasApiKey: true },
      { id: "model-broken", name: "Broken", provider: "Test", model: "broken-v1", endpoint: "https://model.test", enabled: true, hasApiKey: true },
    ];
    store.modelApiKeys["model-author"] = "secret";
    store.modelAvailability["model-author"] = { status: "available", reason: "ok" };
    store.modelAvailability["model-broken"] = { status: "unavailable", reason: "offline" };
    store.credentialsHydrated = true;
    vi.spyOn(backend, "generateSkill")
      .mockRejectedValueOnce(new Error("temporary system failure"))
      .mockRejectedValueOnce(new Error("temporary system failure"))
      .mockResolvedValue({
      name: "Java 服务上线",
      category: "deployment",
      description: "用于 Java 服务安全上线",
      matchRules: ["Java 服务上线"],
      instructions: "识别构建方式，部署前备份；失败时回滚；最后验证健康状态。",
    });
    const app = createApp(SkillManagementPanel, { standalone: true }).use(pinia).use(i18n);
    app.mount(host); await nextTick();

    host.querySelector<HTMLElement>(".skill-authoring-model summary")!.click();
    await nextTick();
    const unavailable = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find(option => option.textContent?.includes("Broken"))!;
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.textContent).toContain("不可用");

    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>(".skill-authoring-actions button"));
    expect(buttons.find(button => button.textContent?.includes("生成新 Skill"))!.disabled).toBe(true);
    const optimize = buttons.find(button => button.textContent?.includes("优化当前 Skill"))!;
    expect(optimize.disabled).toBe(false);
    optimize.click();
    await vi.waitFor(() => expect(document.querySelector(".skill-preview")).not.toBeNull());

    expect(backend.generateSkill).toHaveBeenCalledTimes(3);
    expect(host.querySelector("[role='alert']")?.textContent ?? "").not.toContain("temporary system failure");
    expect(vi.mocked(backend.generateSkill).mock.calls[0]?.[0]).toContain("优化结构");
    expect(vi.mocked(backend.generateSkill).mock.calls[0]?.[1]).toBe("optimize");
    expect(skill.name).toBe("Current Skill");
    expect(document.body.textContent).toContain("Java 服务上线");
    Array.from(document.querySelectorAll<HTMLButtonElement>(".skill-preview footer button"))
      .find(button => button.textContent?.includes("确认并覆盖表单"))!.click();
    await nextTick();
    expect(skill.name).toBe("Java 服务上线");
    expect(skill.instructions).toContain("失败时回滚");
    expect(document.querySelector(".skill-preview")).toBeNull();
    app.unmount();
  });

  it("saves the selected Skill from its bottom dock and confirms deletion", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    const first = store.addSkill();
    const second = store.addSkill();
    Object.assign(first, { name: "First Skill", description: "First description", instructions: "First instructions" });
    const app = createApp(SkillManagementPanel, { standalone: true }).use(pinia).use(i18n);
    app.mount(host); await nextTick();

    const dock = host.querySelector<HTMLElement>(".skill-editor-dock")!;
    const save = dock.querySelector<HTMLButtonElement>(".skill-save-button")!;
    expect(save.disabled).toBe(true);
    const name = host.querySelector<HTMLInputElement>(".skill-basic-fields input")!;
    name.value = "已单独保存的 Skill";
    name.dispatchEvent(new Event("input"));
    await nextTick();
    expect(save.disabled).toBe(false);
    save.click(); await nextTick();
    const persisted = JSON.parse(localStorage.getItem("opsark.skillConfiguration")!);
    expect(persisted.customSkills.find((skill: { id: string }) => skill.id === first.id)?.name).toBe("已单独保存的 Skill");
    expect(persisted.customSkills.some((skill: { id: string }) => skill.id === second.id)).toBe(false);
    expect(save.disabled).toBe(true);

    dock.querySelector<HTMLButtonElement>(".skill-remove-button")!.click();
    await nextTick();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'))
      .find(button => button.textContent?.includes("取消"))!.click();
    await nextTick();
    expect(store.skills.some(skill => skill.id === first.id)).toBe(true);
    dock.querySelector<HTMLButtonElement>(".skill-remove-button")!.click();
    await nextTick();
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'))
      .find(button => button.textContent?.includes("确认删除"))!.click();
    await nextTick();
    expect(store.skills.some(skill => skill.id === first.id)).toBe(false);
    app.unmount();
  });
  it("AI 编写下拉框将未登录官方模型作为登录入口并在登录后显示积分", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const pinia = createPinia();
    const store = useOpsStore(pinia); store.addSkill();
    const catalog = useOfficialCatalogStore(pinia);
    catalog.models = [{ id: "writer", name: "OpsArk Writer" }]; catalog.loaded = true;
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: "/", component: { template: "<div/>" } },
      { path: "/account", component: { template: "<div/>" } },
    ] });
    await router.push("/");
    const app = createApp(SkillManagementPanel, { standalone: true }).use(pinia).use(i18n).use(router);
    app.mount(host); await nextTick();
    host.querySelector<HTMLElement>(".skill-authoring-model summary")!.click(); await nextTick();
    const login = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find(option => option.textContent?.includes("OpsArk Writer"))!;
    expect(login.dataset.action).toBe("true"); login.click();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/account"));

    useAccountStore(pinia).apply({ user: { id: "member", email: "member@example.test" },
      balance: { available: 11_000, reserved: 0, revision: 1, unit: "tokens" },
      models: [{ id: "writer", name: "OpsArk Writer" }], endpoint: "https://zgspace.cn/v1" });
    await nextTick();
    host.querySelector<HTMLElement>(".skill-authoring-model summary")!.click(); await nextTick();
    expect(document.body.textContent).toContain("OpsArk Writer · writer · 剩余 2 积分");
    app.unmount(); host.remove();
  });
});
