// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia, type Pinia } from "pinia";
import { cloudRequest } from "@/features/account/cloudClient";
import { useAccountStore } from "@/features/account/accountStore";
import { useOpsStore } from "@/stores/ops";
import { createCustomSkill } from "./skillRegistry";
import { persistOwnedSkills } from "./ownedSkills";
import { skillSyncContent, useSkillAutoSyncStore } from "./skillAutoSync";
vi.mock("@/features/account/cloudClient", () => ({ cloudRequest: vi.fn() }));
let pinia: Pinia;
let rows: Record<string, any>;
const snapshot = { user: { id: "one", email: "one@example.test" }, balance: { available: 1, reserved: 0, revision: 1, unit: "tokens" as const }, models: [], endpoint: "https://fixture.invalid" };
const skill = (id = "skill-local") => ({ ...createCustomSkill(id), name: "My workflow" });
const remote = (id: string, revision = 1) => ({ id, revision, deleted: false, updated_at: Date.now() / 1000, content: skillSyncContent(skill(id)) });
const writes = () => vi.mocked(cloudRequest).mock.calls.filter(call => call[0] === "skills_save");
async function flush(ms = 0) { await vi.advanceTimersByTimeAsync(ms); }
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); rows = {};
  pinia = createPinia(); setActivePinia(pinia);
  vi.mocked(cloudRequest).mockReset();
  vi.mocked(cloudRequest).mockImplementation(async (operation, payload, user) => {
    if (operation === "skills_list") return { items: Object.values(rows).filter((r: any) => r.owner === user), next_cursor: null } as any;
    const { id, body } = payload as any;
    const previous = rows[`${user}/${id}`];
    if ((previous?.revision ?? 0) !== body.base_revision) throw new Error("SKILL_REVISION_CONFLICT");
    rows[`${user}/${id}`] = { id, owner: user, revision: body.base_revision + 1, deleted: body.content === null, updated_at: Date.now() / 1000, content: body.content };
    return { revision: body.base_revision + 1, updated_at: rows[`${user}/${id}`].updated_at } as any;
  });
});
afterEach(() => { disposePinia(pinia); vi.useRealTimers(); localStorage.clear(); });
function setup(local = true) {
  const ops = useOpsStore(); if (local) { ops.skills.push(skill()); persistOwnedSkills(ops.skills); }
  const account = useAccountStore(), sync = useSkillAutoSyncStore();
  return { ops, account, sync };
}
it("syncs at login without mounting a Skill view, and uploads only personal fields", async () => {
  const { account, sync } = setup(); await flush();
  expect(cloudRequest).not.toHaveBeenCalled();
  account.apply(snapshot); await flush();
  expect(writes()).toHaveLength(1);
  const [_, payload, owner] = writes()[0];
  expect(owner).toBe("one");
  expect((payload as any).body.content).not.toHaveProperty("builtIn");
  expect((payload as any).body.content).not.toHaveProperty("planningContract");
  expect(sync.notice).toBe("个人 Skill 已同步");
  account.apply(snapshot); await flush(); // Balance refresh is not another login.
  expect(writes()).toHaveLength(1);
});
it("downloads on restored login, keeps stable IDs and does not echo changes back", async () => {
  rows["one/skill-cloud"] = { ...remote("skill-cloud"), owner: "one" };
  useAccountStore().apply(snapshot);
  const { ops, sync } = setup(false); await flush(1000);
  expect(ops.skills.filter(s => s.id === "skill-cloud")).toHaveLength(1);
  expect(writes()).toHaveLength(0);
  await sync.syncNow(); await flush(1000);
  expect(writes()).toHaveLength(0);
});
it("shows synchronized state and keeps an explicit cloud deletion as a tombstone", async () => {
  rows["one/skill-cloud"] = { ...remote("skill-cloud"), owner: "one" };
  const { account, ops, sync } = setup(false); account.apply(snapshot); await flush();
  expect(sync.isSynced("skill-cloud")).toBe(true);
  await sync.deleteCloudSkill("skill-cloud");
  expect(rows["one/skill-cloud"].deleted).toBe(true);
  expect(rows["one/skill-cloud"].content).toBeNull();
  expect(ops.skills.some(item => item.id === "skill-cloud")).toBe(true);
  await sync.syncNow();
  expect(ops.skills.some(item => item.id === "skill-cloud")).toBe(true);
  expect(sync.isSynced("skill-cloud")).toBe(false);
});
it("requires explicit synchronization after local additions and edits", async () => {
  const { account, ops, sync } = setup(false); account.apply(snapshot); await flush();
  const created = ops.addSkill(); await flush(500);
  await sync.syncNow();
  expect(writes()).toHaveLength(0);
  Object.assign(created, { name: "Saved workflow", description: "Saved description", instructions: "Saved instructions" });
  ops.saveSkill(created.id);
  await sync.syncSkill(created.id);
  expect(writes()).toHaveLength(1);
  ops.skills.find(s => s.id === created.id)!.name = "First edit";
  ops.skills.find(s => s.id === created.id)!.name = "Final edit";
  await flush(500); expect(writes()).toHaveLength(1);
  ops.saveSkill(created.id);
  await sync.syncSkill(created.id); expect(writes()).toHaveLength(2);
  expect((writes()[1][1] as any).body.content.name).toBe("Final edit");
  ops.removeSkill(created.id); await sync.syncNow();
  expect((writes()[2][1] as any).body.content).toBeNull();
  expect(rows[`one/${created.id}`].deleted).toBe(true);
});
it("applies cloud edits but keeps local content when the cloud is deleted", async () => {
  const { account, ops, sync } = setup(); account.apply(snapshot); await flush();
  rows["one/skill-local"].content.name = "Remote edit"; rows["one/skill-local"].revision++;
  await sync.syncNow(); expect(ops.skills.find(s => s.id === "skill-local")?.name).toBe("Remote edit");
  rows["one/skill-local"] = { ...rows["one/skill-local"], content: null, deleted: true, revision: 3 };
  await sync.syncNow(); await flush(1000);
  expect(ops.skills.some(s => s.id === "skill-local")).toBe(true);
  expect(writes()).toHaveLength(1);
});
it("keeps both versions on a concurrent conflict and resolves only on explicit choice", async () => {
  const { account, ops, sync } = setup(); account.apply(snapshot); await flush();
  rows["one/skill-local"].content.name = "Cloud edit"; rows["one/skill-local"].revision++;
  ops.skills.find(s => s.id === "skill-local")!.name = "Local edit";
  ops.skills.find(s => s.id === "skill-local")!.updatedAt = new Date(Date.now() + 1000).toISOString();
  ops.saveSkill("skill-local");
  await sync.syncNow();
  expect(sync.conflicts).toHaveLength(1); expect(writes()).toHaveLength(1);
  expect(ops.skills.find(s => s.id === "skill-local")?.name).toBe("Local edit");
  await sync.resolveConflict("skill-local", "local");
  expect((writes()[1][1] as any).body.base_revision).toBe(2);
  expect(rows["one/skill-local"].content.name).toBe("Local edit");
});
it("keeps a local Skill after cloud deletion and restores it only by explicit item sync", async () => {
  const { account, ops, sync } = setup(); account.apply(snapshot); await flush();
  rows["one/skill-local"] = { ...rows["one/skill-local"], revision: 2, deleted: true, content: null };
  ops.skills.find(s => s.id === "skill-local")!.name = "Offline edit";
  ops.skills.find(s => s.id === "skill-local")!.updatedAt = new Date(Date.now() + 1000).toISOString();
  ops.saveSkill("skill-local");
  await sync.syncNow();
  expect(sync.conflicts).toHaveLength(0);
  expect(ops.skills.find(s => s.id === "skill-local")?.name).toBe("Offline edit");
  expect(rows["one/skill-local"].deleted).toBe(true);
  await sync.syncSkill("skill-local");
  expect(rows["one/skill-local"].deleted).toBe(false);
  expect(rows["one/skill-local"].content.name).toBe("Offline edit");
});
it("discards late responses across logout/login even for the same user", async () => {
  const { account, ops } = setup(false);
  let release!: (v: any) => void;
  vi.mocked(cloudRequest).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  account.apply(snapshot); await flush();
  account.current = null; account.apply(snapshot);
  release({ items: [remote("skill-stale")], next_cursor: null }); await flush();
  expect(ops.skills.some(s => s.id === "skill-stale")).toBe(false);
});
it("binds unsynced content before network failure and never uploads it to a different account", async () => {
  const { account } = setup();
  vi.mocked(cloudRequest).mockRejectedValueOnce("offline");
  account.apply(snapshot); await flush();
  account.apply({ ...snapshot, user: { id: "two", email: "two@example.test" } }); await flush();
  expect(writes()).toHaveLength(0);
});
it("preserves ownership from legacy manual sync records", async () => {
  localStorage.setItem("opsark.skillSync.other", JSON.stringify({ "skill-local": { revision: 1 } }));
  const { account } = setup(); account.apply(snapshot); await flush();
  expect(writes()).toHaveLength(0);
});
it("binds new documents immediately during a queued account switch", async () => {
  const { account, ops } = setup(false);
  let release!: (v: any) => void;
  vi.mocked(cloudRequest).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  account.apply(snapshot); await flush();
  account.apply({ ...snapshot, user: { id: "two", email: "two@example.test" } });
  ops.skills.push(skill("skill-second-user"));
  account.apply(snapshot);
  release({ items: [], next_cursor: null }); await flush(1000);
  expect(writes()).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem("opsark.skillSyncOwners")!)["skill-second-user"]).toBe("two");
});
it("propagates a deletion made offline after restarting the sync controller", async () => {
  const { account, ops, sync } = setup(); account.apply(snapshot); await flush();
  sync.$dispose(); account.current = null;
  ops.removeSkill("skill-local");
  useSkillAutoSyncStore(); account.apply(snapshot); await flush();
  expect(rows["one/skill-local"].deleted).toBe(true);
});
it("does not resurrect a remotely accepted create whose acknowledgement was lost", async () => {
  const normal = vi.mocked(cloudRequest).getMockImplementation()!;
  let fail = true;
  vi.mocked(cloudRequest).mockImplementation(async (...args) => {
    const result = await normal(...args);
    if (args[0] === "skills_save" && fail) { fail = false; throw new Error("response lost"); }
    return result;
  });
  const { account, sync } = setup(); account.apply(snapshot); await flush();
  await sync.syncNow();
  expect(writes()).toHaveLength(1);
  expect(sync.error).toBe("");
});
it("reuses the exact pending mutation after network failure without an automatic retry loop", async () => {
  const normal = vi.mocked(cloudRequest).getMockImplementation()!;
  vi.mocked(cloudRequest).mockImplementation(async (operation, ...rest) => {
    if (operation === "skills_save") throw new Error("offline");
    return normal(operation, ...rest);
  });
  const { account, sync } = setup(); account.apply(snapshot); await flush(10_000);
  expect(writes()).toHaveLength(1); expect(sync.error).toContain("offline");
  vi.mocked(cloudRequest).mockImplementation(normal);
  await sync.syncNow();
  expect(writes()[1]).toEqual(writes()[0]);
});
it("retains invalid drafts locally until complete", async () => {
  const { account, ops, sync } = setup();
  ops.skills.find(s => s.id === "skill-local")!.instructions = "";
  account.apply(snapshot); await flush();
  expect(writes()).toHaveLength(0); expect(sync.error).toBe("");
  ops.skills.find(s => s.id === "skill-local")!.instructions = "Inspect resources";
  ops.saveSkill("skill-local"); await sync.syncSkill("skill-local");
  expect(writes()).toHaveLength(1);
});
it("does not mutate local documents when any remote document is invalid", async () => {
  rows["one/skill-first"] = { ...remote("skill-first"), owner: "one" };
  rows["one/skill-bad"] = { ...remote("skill-bad"), owner: "one", content: null };
  const { account, ops, sync } = setup(false); account.apply(snapshot); await flush();
  expect(sync.error).toContain("无效"); expect(ops.skills.some(s => s.id === "skill-first")).toBe(false);
});
it("rejects malformed required fields", async () => {
  const item = { ...remote("skill-bad"), owner: "one" };
  delete (item.content as any).enabled;
  rows["one/skill-bad"] = item;
  const { account, ops, sync } = setup(false); account.apply(snapshot); await flush();
  expect(sync.error).toContain("字段无效");
  expect(ops.skills.some(s => s.id === "skill-bad")).toBe(false);
});
it("does not upload an edit made during a write until explicitly synchronized", async () => {
  const normal = vi.mocked(cloudRequest).getMockImplementation()!;
  let release!: (v: any) => void;
  vi.mocked(cloudRequest).mockImplementation(async (...args) => {
    const result = await normal(...args);
    if (args[0] === "skills_save" && !release) return new Promise(resolve => { release = resolve; });
    return result;
  });
  const { account, ops } = setup(); account.apply(snapshot); await flush();
  ops.skills.find(s => s.id === "skill-local")!.name = "Edited while uploading";
  await flush(500);
  release({ revision: 1 }); await flush();
  expect(writes()).toHaveLength(1);
  useOpsStore().saveSkill("skill-local");
  await useSkillAutoSyncStore().syncSkill("skill-local");
  expect(writes()).toHaveLength(2);
  expect(rows["one/skill-local"].content.name).toBe("Edited while uploading");
});
