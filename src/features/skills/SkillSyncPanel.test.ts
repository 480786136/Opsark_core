// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import { createPinia, disposePinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { cloudRequest } from "@/features/account/cloudClient";
import { useAccountStore } from "@/features/account/accountStore";
import { useOpsStore } from "@/stores/ops";
import { createCustomSkill } from "./skillRegistry";
import * as skillStorage from "./ownedSkills";
import { skillSyncContent, useSkillAutoSyncStore } from "./skillAutoSync";
import SkillSyncPanel from "./SkillSyncPanel.vue";
import CloudSkillManager from "./CloudSkillManager.vue";
vi.mock("@/features/account/cloudClient", () => ({ cloudRequest: vi.fn() }));
let app: App, pinia: Pinia;
const snapshot = { user: { id: "one", email: "first@example.test" }, balance: { available: 100, reserved: 0, revision: 1, unit: "tokens" as const }, models: [], endpoint: "https://fixture.invalid" };
beforeEach(() => { vi.mocked(cloudRequest).mockReset(); localStorage.clear(); });
afterEach(() => { app?.unmount(); if (pinia) disposePinia(pinia); vi.restoreAllMocks(); document.body.innerHTML = ""; });
async function flush() { await new Promise(resolve => setTimeout(resolve, 0)); await nextTick(); }
async function mount(loggedIn = false, withCloudManager = false) {
  pinia = createPinia(); setActivePinia(pinia);
  const account = useAccountStore(), ops = useOpsStore();
  ops.skills.push(createCustomSkill("skill-test"));
  skillStorage.persistOwnedSkills(ops.skills);
  if (loggedIn) account.apply(snapshot);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: SkillSyncPanel }, { path: "/account", component: { template: "Account" } }] });
  await router.push("/");
  app = createApp(withCloudManager ? { render: () => [h(SkillSyncPanel), h(CloudSkillManager, { open: true })] } : SkillSyncPanel).use(pinia).use(router);
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
  await vi.waitFor(() => expect(cloudRequest).toHaveBeenCalledTimes(2));
  expect(document.querySelector(".skill-sync-message")).toBeNull();
});
it("does not expose conflict resolution controls", async () => {
  vi.mocked(cloudRequest).mockImplementation(async () => {
    const local = useOpsStore().skills.find(skill => skill.id === "skill-test")!;
    const content = { ...skillSyncContent(local), name: "Cloud version" };
    return { items: [{ id: "skill-test", revision: 1, deleted: false, updated_at: Date.parse(local.updatedAt) / 1000, content }], next_cursor: null } as any;
  });
  const { host } = await mount(true);
  const sync = useSkillAutoSyncStore();
  await vi.waitFor(() => expect(sync.conflicts).toHaveLength(1));
  expect(host.textContent).not.toContain("需要处理同步冲突");
  expect(host.textContent).not.toContain("采用本地版本");
  expect(host.textContent).not.toContain("采用云端版本");
  expect(vi.mocked(cloudRequest).mock.calls.every(call => call[0] === "skills_list")).toBe(true);
});
it("shows synchronization failures as a floating message", async () => {
  vi.mocked(cloudRequest).mockRejectedValue(new Error("network unavailable"));
  await mount(true);
  await vi.waitFor(() => expect(document.querySelector(".skill-sync-message")?.textContent).toContain("同步失败"));
  expect(document.querySelector(".skill-sync-message")?.textContent).toContain("network unavailable");
  expect(document.querySelector(".sync-panel")).toBeNull();
});
it("confirms a persisted download in the drawer and a dismissible success message, including repeated downloads", async () => {
  vi.mocked(cloudRequest).mockResolvedValueOnce({ items: [], next_cursor: null }).mockResolvedValueOnce({ revision: 1 });
  await mount(true, true);
  const sync = useSkillAutoSyncStore();
  const skill = { ...createCustomSkill("skill-download"), name: "巡检流程" };
  sync.cloudSkills = [{ id: skill.id, revision: 1, deleted: false, updated_at: Date.now() / 1000, content: skillSyncContent(skill) }];
  await nextTick();

  document.querySelector<HTMLButtonElement>('[title="下载到本地"]')!.click(); await flush();
  expect(skillStorage.loadOwnedSkills().find(item => item.id === skill.id)?.name).toBe("巡检流程");
  expect(document.querySelector(".cloud-skill-notice")?.textContent).toBe("Skill“巡检流程”已下载到本地。");
  const toast = document.querySelector(".skill-sync-message.success")!;
  expect(toast.getAttribute("role")).toBe("status");
  expect(toast.textContent).toContain("下载成功");
  expect(toast.textContent).toContain("巡检流程");

  const local = useOpsStore().skills.find(item => item.id === "skill-test")!;
  vi.mocked(cloudRequest).mockResolvedValueOnce({ items: [...sync.cloudSkills,
    { id: local.id, revision: 1, deleted: false, updated_at: Date.now() / 1000, content: skillSyncContent(local) }], next_cursor: null });
  await sync.syncNow(); await nextTick();
  expect(sync.error).toBe("");
  expect(document.querySelector(".skill-sync-message.success")?.textContent).toContain("巡检流程");

  toast.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() => expect(document.querySelector(".skill-sync-message")).toBeNull());
  document.querySelector<HTMLButtonElement>('[title="下载到本地"]')!.click(); await flush();
  expect(document.querySelector(".skill-sync-message.success")?.textContent).toContain("巡检流程");
});
it("replaces prior download success with a failure when local persistence fails", async () => {
  vi.mocked(cloudRequest).mockResolvedValueOnce({ items: [], next_cursor: null }).mockResolvedValueOnce({ revision: 1 });
  await mount(true, true);
  const sync = useSkillAutoSyncStore();
  const skill = { ...createCustomSkill("skill-download"), name: "已保存版本" };
  sync.cloudSkills = [{ id: skill.id, revision: 1, deleted: false, updated_at: Date.now() / 1000, content: skillSyncContent(skill) }];
  await nextTick();
  document.querySelector<HTMLButtonElement>('[title="下载到本地"]')!.click(); await flush();
  expect(document.querySelector(".skill-sync-message.success")).not.toBeNull();

  sync.cloudSkills[0].content!.name = "无法保存的新版本";
  vi.spyOn(skillStorage, "persistOwnedSkills").mockImplementationOnce(() => { throw new Error("local storage full"); });
  document.querySelector<HTMLButtonElement>('[title="下载到本地"]')!.click(); await flush();
  expect(sync.notice).toBe("");
  expect(sync.downloadNotice).toBeNull();
  expect(document.querySelector(".cloud-skill-notice")).toBeNull();
  expect(document.querySelector(".skill-sync-message.success")).toBeNull();
  expect(document.querySelector('.skill-sync-message[role="alert"]')?.textContent).toContain("下载未完成");
  expect(useOpsStore().skills.find(item => item.id === skill.id)?.name).toBe("已保存版本");
  expect(skillStorage.loadOwnedSkills().find(item => item.id === skill.id)?.name).toBe("已保存版本");
});
