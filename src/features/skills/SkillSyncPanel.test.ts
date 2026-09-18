// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, disposePinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { cloudRequest } from "@/features/account/cloudClient";
import { useAccountStore } from "@/features/account/accountStore";
import { useOpsStore } from "@/stores/ops";
import { createCustomSkill } from "./skillRegistry";
import { skillSyncContent, useSkillAutoSyncStore } from "./skillAutoSync";
import SkillSyncPanel from "./SkillSyncPanel.vue";
vi.mock("@/features/account/cloudClient", () => ({ cloudRequest: vi.fn() }));
let app: App, pinia: Pinia;
const snapshot = { user: { id: "one", email: "first@example.test" }, balance: { available: 100, reserved: 0, revision: 1, unit: "tokens" as const }, models: [], endpoint: "https://fixture.invalid" };
beforeEach(() => { vi.mocked(cloudRequest).mockReset(); localStorage.clear(); });
afterEach(() => { app?.unmount(); if (pinia) disposePinia(pinia); document.body.innerHTML = ""; });
async function flush() { await new Promise(resolve => setTimeout(resolve, 0)); await nextTick(); }
async function mount(loggedIn = false) {
  pinia = createPinia(); setActivePinia(pinia);
  const account = useAccountStore(), ops = useOpsStore();
  ops.skills.push(createCustomSkill("skill-test"));
  if (loggedIn) account.apply(snapshot);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: SkillSyncPanel }, { path: "/account", component: { template: "Account" } }] });
  await router.push("/");
  app = createApp(SkillSyncPanel).use(pinia).use(router);
  const host = document.createElement("div"); document.body.append(host); app.mount(host); await flush();
  return { account, host };
}
it("stays hidden in local mode without calling the cloud", async () => {
  const { host } = await mount();
  expect(host.textContent).toBe(""); expect(cloudRequest).not.toHaveBeenCalled();
});
it("automatically syncs on login without showing sync controls or status", async () => {
  vi.mocked(cloudRequest).mockResolvedValueOnce({ items: [], next_cursor: null }).mockResolvedValueOnce({ revision: 1 });
  const { account, host } = await mount(); account.apply(snapshot); await flush();
  expect(host.textContent).not.toContain("个人 Skill 已同步");
  expect(host.textContent).not.toContain("立即同步");
  expect(host.querySelector("select")).toBeNull();
  expect(cloudRequest).toHaveBeenCalledTimes(2);
});
it("asks before resolving a conflict and cancels that choice on account change", async () => {
  vi.mocked(cloudRequest).mockImplementation(async () => {
    const local = useOpsStore().skills.find(skill => skill.id === "skill-test")!;
    const content = { ...skillSyncContent(local), name: "Cloud version" };
    return { items: [{ id: "skill-test", revision: 1, deleted: false, updated_at: Date.parse(local.updatedAt) / 1000, content }], next_cursor: null } as any;
  });
  const { account, host } = await mount(true);
  const sync = useSkillAutoSyncStore(); expect(sync.conflicts).toHaveLength(1);
  expect(host.textContent).toContain("需要处理同步冲突");
  Array.from(host.querySelectorAll("button")).find(b => b.textContent === "采用本地版本")!.click(); await nextTick();
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  account.current = null; await flush();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(vi.mocked(cloudRequest).mock.calls.every(call => call[0] === "skills_list")).toBe(true);
});
it("applies a chosen cloud conflict version only after confirmation", async () => {
  vi.mocked(cloudRequest).mockImplementation(async () => {
    const local = useOpsStore().skills.find(skill => skill.id === "skill-test")!;
    const content = { ...skillSyncContent(local), name: "Chosen cloud version" };
    return { items: [{ id: "skill-test", revision: 1, deleted: false, updated_at: Date.parse(local.updatedAt) / 1000, content }], next_cursor: null } as any;
  });
  const { host } = await mount(true);
  Array.from(host.querySelectorAll("button")).find(b => b.textContent === "采用云端版本")!.click(); await nextTick();
  expect(useOpsStore().skills.find(s => s.id === "skill-test")?.name).toBe("新建 Skill");
  Array.from(document.querySelectorAll("button")).find(b => b.textContent === "确认操作")!.click(); await flush();
  expect(useOpsStore().skills.find(s => s.id === "skill-test")?.name).toBe("Chosen cloud version");
  expect(useSkillAutoSyncStore().conflicts).toHaveLength(0);
});
