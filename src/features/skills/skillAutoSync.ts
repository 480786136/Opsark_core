import { computed, onScopeDispose, ref, watch } from "vue";
import { defineStore } from "pinia";
import { useAccountStore } from "@/features/account/accountStore";
import { cloudRequest } from "@/features/account/cloudClient";
import { useOpsStore } from "@/stores/ops";
import { loadOwnedSkills, persistOwnedSkills } from "./ownedSkills";
import { parseSkillConfiguration } from "./skillRegistry";
import { validateSkillDefinition } from "./skillValidation";
import type { SkillDefinition } from "./types";
import { SKILL_CATEGORY_IDS } from "./types";

type Content = Pick<SkillDefinition, "name" | "description" | "category" | "instructions" | "matchRules" | "enabled" | "version" | "updatedAt">;
type RemoteContent = Omit<Content, "updatedAt"> & { updatedAt?: string };
export interface CloudSkill { id: string; revision: number; deleted: boolean; updated_at: number; content: RemoteContent | null }
interface Ack { revision: number; fingerprint?: string; pending?: { fingerprint: string; mutationId: string } }
interface Conflict { id: string; name: string; remote: CloudSkill; localFingerprint: string }
const ownerKey = "opsark.skillSyncOwners";
const recordKey = (id: string) => `opsark.skillAutoSync.${id}`;
function read<T>(key: string): Record<string, T> {
  const raw = localStorage.getItem(key);
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Skill 同步记录无效，请保留本地数据并检查存储");
  return value as Record<string, T>;
}
export function skillSyncContent(skill: SkillDefinition): Content {
  return { name: skill.name.trim(), description: skill.description.trim(), category: skill.category,
    instructions: skill.instructions.trim(), matchRules: [...new Set(skill.matchRules.map(s => s.trim()).filter(Boolean))],
    enabled: skill.enabled, version: skill.version, updatedAt: skill.updatedAt };
}
// Store the exact canonical projection: a hash collision must not authorize deletion.
function fingerprint(skill?: SkillDefinition) { return JSON.stringify(skill ? skillSyncContent(skill) : null); }
function validContent(content: RemoteContent) {
  return ["name", "description", "instructions"].every(key => typeof content[key as keyof Content] === "string")
    && SKILL_CATEGORY_IDS.includes(content.category)
    && typeof content.enabled === "boolean"
    && Number.isSafeInteger(content.version) && content.version >= 1 && content.version <= 1_000_000
    && [[content.matchRules, 50]].every(([values, limit]) =>
      Array.isArray(values) && values.length <= Number(limit)
      && values.every(value => typeof value === "string" && value.length <= 256));
}
function fromRemote(item: CloudSkill): SkillDefinition | undefined {
  if (!/^skill-[a-zA-Z0-9-]{1,110}$/.test(item.id) || !Number.isSafeInteger(item.revision) || item.revision < 1) {
    throw new Error("云 Skill 标识或版本无效");
  }
  if (item.deleted && item.content === null) return undefined;
  if (item.deleted !== false || !item.content) throw new Error("云 Skill 删除状态无效");
  if (!validContent(item.content)) throw new Error("云 Skill 字段无效，未修改本地内容");
  const updatedAt = item.content.updatedAt || (Number.isFinite(item.updated_at)
    ? new Date(item.updated_at * 1000).toISOString() : "1970-01-01T00:00:00.000Z");
  const skill = parseSkillConfiguration({ customSkills: [{ ...item.content, updatedAt, id: item.id, builtIn: false }] }).customSkills[0];
  if (!skill || validateSkillDefinition(skill).length) throw new Error("云 Skill 内容无效，未修改本地内容");
  return { ...skill, builtIn: false, source: "user" };
}
function localModifiedAt(skill?: SkillDefinition) {
  const value = skill ? Date.parse(skill.updatedAt) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}
function cloudModifiedAt(item?: CloudSkill) {
  if (!item) return undefined;
  const contentValue = item.content?.updatedAt ? Date.parse(item.content.updatedAt) : Number.NaN;
  if (Number.isFinite(contentValue)) return contentValue;
  return Number.isFinite(item.updated_at) ? item.updated_at * 1000 : undefined;
}

export const useSkillAutoSyncStore = defineStore("skillAutoSync", () => {
  const account = useAccountStore(), ops = useOpsStore();
  const owner = computed(() => account.current?.user.id);
  const busy = ref(false), error = ref(""), notice = ref("");
  const cloudSkills = ref<CloudSkill[]>([]), syncVersion = ref(0);
  const conflicts = ref<Conflict[]>([]);
  let generation = 0, applying = false, requested = false, resolving = false, timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const localSkill = (id: string) => ops.skills.find(skill => skill.id === id && !skill.builtIn);
  const check = (id: string, epoch: number) => {
    if (owner.value !== id || generation !== epoch) throw new Error("账号已切换，同步响应已丢弃");
  };
  function claim(id: string, migrate = true) {
    const bindings = read<string>(ownerKey);
    // Preserve account ownership from the previous manual-sync implementation.
    for (let index = 0; migrate && index < localStorage.length; index++) {
      const key = localStorage.key(index)!;
      const match = key.match(/^opsark\.skill(?:Sync|AutoSync)\.(.+)$/);
      if (!match) continue;
      for (const skillId of Object.keys(read<Ack>(key))) {
        if (!bindings[skillId]) bindings[skillId] = match[1];
        else if (bindings[skillId] !== match[1]) bindings[skillId] = "__ambiguous__";
      }
    }
    for (const skill of ops.skills.filter(skill => !skill.builtIn)) bindings[skill.id] ??= id;
    localStorage.setItem(ownerKey, JSON.stringify(bindings));
    return bindings;
  }
  function acknowledge(id: string, skillId: string, revision: number, value: string) {
    const entries = read<Ack>(recordKey(id));
    entries[skillId] = { revision, fingerprint: value };
    localStorage.setItem(recordKey(id), JSON.stringify(entries));
    syncVersion.value++;
  }
  async function write(id: string, epoch: number, skillId: string, payload: Content | null, revision: number) {
    check(id, epoch);
    const entries = read<Ack>(recordKey(id)), ack = entries[skillId];
    const value = JSON.stringify({ payload, revision });
    const mutationId = ack?.pending?.fingerprint === value ? ack.pending.mutationId : crypto.randomUUID();
    entries[skillId] = { ...ack, revision: ack?.revision ?? revision, pending: { fingerprint: value, mutationId } };
    localStorage.setItem(recordKey(id), JSON.stringify(entries));
    const result = await cloudRequest<{ revision: number; deleted?: boolean; updated_at?: number }>("skills_save", { id: skillId,
      body: { base_revision: revision, mutation_id: mutationId, content: payload } }, id);
    check(id, epoch);
    if (!Number.isSafeInteger(result.revision) || result.revision <= revision) throw new Error("云 Skill 确认版本无效");
    acknowledge(id, skillId, result.revision, JSON.stringify(payload));
    return result;
  }
  function applyRemote(item: CloudSkill, expectedLocal: string) {
    if (ops.skills.some(skill => skill.id === item.id && skill.builtIn)) throw new Error("云 Skill 不能替换系统 Skill");
    if (fingerprint(localSkill(item.id)) !== expectedLocal) throw new Error("同步期间本地 Skill 已修改，请重新同步");
    const skill = fromRemote(item);
    const next = ops.skills.filter(s => s.id !== item.id);
    if (skill) next.push(skill);
    // Persist before replacing UI state; storage failure must not hide local data.
    persistOwnedSkills(next);
    applying = true;
    try { ops.skills = next; } finally { applying = false; }
  }
  async function synchronize(id: string, epoch: number, onlySkillId?: string) {
    const bindings = claim(id);
    const savedSkills = loadOwnedSkills().filter(skill => !skill.builtIn);
    const items: CloudSkill[] = [], cursors = new Set<string>();
    let cursor: string | null = "";
    do {
      if (cursors.has(cursor)) throw new Error("云 Skill 分页游标重复");
      cursors.add(cursor);
      const page: { items: CloudSkill[]; next_cursor: string | null } = await cloudRequest("skills_list", { cursor }, id);
      check(id, epoch);
      items.push(...page.items);
      if (items.length > 200) throw new Error("云 Skill 数量超出客户端上限");
      cursor = page.next_cursor;
    } while (cursor);
    cloudSkills.value = items;
    // Validate the complete remote snapshot before performing any mutation.
    for (const item of items) fromRemote(item);
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("云 Skill 标识重复");
    const remote = new Map(items.map(item => [item.id, item]));
    const records = read<Ack>(recordKey(id));
    const legacy = read<Ack>(`opsark.skillSync.${id}`);
    const ids = onlySkillId ? new Set([onlySkillId]) : new Set([...items.map(item => item.id), ...Object.keys(records),
      ...savedSkills.filter(skill => bindings[skill.id] === id).map(skill => skill.id)]);
    const found: Conflict[] = [], problems: string[] = [];
    for (const skillId of ids) {
      check(id, epoch);
      if (ops.skills.some(skill => skill.id === skillId && skill.builtIn)
        || (bindings[skillId] && bindings[skillId] !== id)) {
        if (remote.has(skillId)) problems.push(`Skill ${skillId} 与系统或其他账号标识冲突，未覆盖`);
        continue;
      }
      bindings[skillId] = id;
      localStorage.setItem(ownerKey, JSON.stringify(bindings));
      const current = localSkill(skillId);
      const local = savedSkills.find(skill => skill.id === skillId);
      const item = remote.get(skillId);
      // Drafts and unsaved edits never participate in cloud synchronization.
      if (current && fingerprint(current) !== fingerprint(local)) continue;
      if (local && (validateSkillDefinition(local).length || !validContent(skillSyncContent(local)))) {
        problems.push(`「${local.name}」配置不完整或超出同步限制，保留本地草稿`); continue;
      }
      const value = fingerprint(local), cloud = item ? fingerprint(fromRemote(item)) : "null";
      const ack = records[skillId];
      if (item && value === cloud) { acknowledge(id, skillId, item.revision, value); continue; }
      const base = ack?.fingerprint;
      const conflict = () => found.push({ id: skillId, name: local?.name ?? item?.content?.name ?? skillId,
        remote: item!, localFingerprint: value });
      if (item?.deleted && local) {
        // A cloud-only deletion never removes the local document. The user can
        // explicitly click its yellow cloud button to upload it again.
        if (onlySkillId === skillId) await write(id, epoch, skillId, skillSyncContent(local), item.revision);
        continue;
      }
      if (!item) {
        if (!local) continue;
        if (ack?.revision || legacy[skillId]?.revision) { problems.push(`「${local.name}」云版本缺失，未自动重建`); continue; }
        await write(id, epoch, skillId, skillSyncContent(local), 0);
      } else if (base === undefined) {
        if (local || legacy[skillId]) {
          const localTime = localModifiedAt(local), cloudTime = cloudModifiedAt(item);
          if (local && localTime !== undefined && cloudTime !== undefined && localTime !== cloudTime) {
            if (localTime > cloudTime) await write(id, epoch, skillId, skillSyncContent(local), item.revision);
            else { applyRemote(item, value); acknowledge(id, skillId, item.revision, cloud); }
            continue;
          }
          conflict(); continue;
        }
        applyRemote(item, value); acknowledge(id, skillId, item.revision, cloud);
      } else if (value === base) {
        applyRemote(item, value); acknowledge(id, skillId, item.revision, cloud);
      } else if (cloud === base && item.revision === ack.revision) {
        await write(id, epoch, skillId, local ? skillSyncContent(local) : null, item.revision);
      } else conflict();
    }
    check(id, epoch);
    conflicts.value = found;
    error.value = problems.join("；");
    notice.value = found.length ? `${found.length} 个 Skill 存在两端冲突，请选择要保留的版本。`
      : problems.length ? "有效内容已同步，部分草稿需要完善。" : "个人 Skill 已同步";
  }
  function syncNow(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (!owner.value) return Promise.resolve();
    requested = true;
    if (resolving) return Promise.resolve();
    if (running) return running;
    busy.value = true;
    running = (async () => {
      while (requested && owner.value) {
        requested = false;
        const id = owner.value, epoch = generation;
        error.value = "";
        try { await synchronize(id, epoch); }
        catch (e) { if (owner.value === id && generation === epoch) error.value = `自动同步未完成：${String(e)}。本地内容保留，可重试。`; }
      }
    })().finally(() => { running = undefined; busy.value = false; });
    return running;
  }
  async function refreshCloudSkills() {
    const id = owner.value;
    if (!id || busy.value) return;
    busy.value = true; error.value = "";
    try {
      const items: CloudSkill[] = [], cursors = new Set<string>();
      let cursor: string | null = "";
      do {
        if (cursors.has(cursor)) throw new Error("云 Skill 分页游标重复");
        cursors.add(cursor);
        const page: { items: CloudSkill[]; next_cursor: string | null } = await cloudRequest("skills_list", { cursor }, id);
        items.push(...page.items); cursor = page.next_cursor;
      } while (cursor);
      cloudSkills.value = items;
    } catch (e) { error.value = `云端列表加载失败：${String(e)}`; }
    finally { busy.value = false; }
  }
  async function deleteCloudSkill(skillId: string) {
    const id = owner.value, item = cloudSkills.value.find(skill => skill.id === skillId && !skill.deleted);
    if (!id || !item || busy.value) return;
    busy.value = true; error.value = "";
    try {
      const result = await write(id, generation, skillId, null, item.revision);
      cloudSkills.value = cloudSkills.value.map(skill => skill.id === skillId
        ? { ...skill, revision: result.revision, deleted: true, content: null, updated_at: result.updated_at ?? Date.now() / 1000 }
        : skill);
      notice.value = `云端 Skill“${item.content?.name || skillId}”已标记删除。`;
    } catch (e) { error.value = `删除未完成：${String(e)}`; }
    finally { busy.value = false; }
  }
  async function downloadCloudSkill(skillId: string) {
    const id = owner.value, item = cloudSkills.value.find(skill => skill.id === skillId && !skill.deleted);
    if (!id || !item || busy.value) return;
    busy.value = true; error.value = "";
    try {
      const expected = fingerprint(localSkill(skillId));
      applyRemote(item, expected);
      acknowledge(id, skillId, item.revision, fingerprint(fromRemote(item)));
      notice.value = `Skill“${item.content?.name || skillId}”已下载到本地。`;
    } catch (e) { error.value = `下载未完成：${String(e)}`; }
    finally { busy.value = false; }
  }
  const syncedSkillIds = computed(() => {
    void syncVersion.value;
    if (!owner.value) return new Set<string>();
    const records = read<Ack>(recordKey(owner.value));
    return new Set(ops.skills.filter(skill => !skill.builtIn).filter(skill => {
      const remote = cloudSkills.value.find(item => item.id === skill.id && !item.deleted);
      return remote && records[skill.id]?.revision === remote.revision
        && records[skill.id]?.fingerprint === fingerprint(skill)
        && fingerprint(fromRemote(remote)) === fingerprint(skill);
    }).map(skill => skill.id));
  });
  const isSynced = (skillId: string) => syncedSkillIds.value.has(skillId);
  const syncSkill = async (skillId: string) => {
    const id = owner.value;
    if (!id || busy.value) return;
    busy.value = true; error.value = "";
    try {
      await synchronize(id, generation, skillId);
      if (!conflicts.value.some(item => item.id === skillId) && !error.value) notice.value = "此 Skill 已同步";
    } catch (e) { error.value = `同步未完成：${String(e)}`; }
    finally { busy.value = false; }
  };
  async function resolveConflict(skillId: string, choice: "local" | "cloud") {
    const id = owner.value, epoch = generation, item = conflicts.value.find(c => c.id === skillId);
    if (!id || !item || busy.value) return;
    resolving = true;
    busy.value = true;
    try {
      if (fingerprint(localSkill(skillId)) !== item.localFingerprint) throw new Error("本地内容已变化，请先重新同步");
      if (choice === "local") {
        const local = localSkill(skillId);
        await write(id, epoch, skillId, local ? skillSyncContent(local) : null, item.remote.revision);
      } else {
        check(id, epoch);
        applyRemote(item.remote, item.localFingerprint);
        acknowledge(id, skillId, item.remote.revision, fingerprint(fromRemote(item.remote)));
      }
      conflicts.value = conflicts.value.filter(c => c.id !== skillId);
      error.value = "";
      requested = true;
    } catch (e) { if (owner.value === id && generation === epoch) error.value = String(e); }
    finally { resolving = false; busy.value = false; if (requested) void syncNow(); }
  }
  watch(owner, () => {
    generation++; error.value = ""; notice.value = ""; conflicts.value = []; cloudSkills.value = [];
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (owner.value) {
      try { claim(owner.value); } catch (e) { error.value = String(e); return; }
      void syncNow();
    }
  }, { immediate: true, flush: "sync" });
  watch(() => ops.skills.filter(skill => !skill.builtIn).map(skill => skill.id), () => {
    if (applying || !owner.value) return;
    // Bind a newly created document immediately, even while another account's
    // request is still in flight. A fast account switch must not claim it.
    try { claim(owner.value, false); } catch (e) { error.value = String(e); return; }
  }, { flush: "sync" });
  const online = () => { void syncNow(); };
  window.addEventListener("online", online);
  onScopeDispose(() => { generation++; requested = false; if (timer) clearTimeout(timer); window.removeEventListener("online", online); });
  return { busy, error, notice, conflicts, cloudSkills, syncedSkillIds, isSynced,
    syncNow, syncSkill, refreshCloudSkills, downloadCloudSkill, deleteCloudSkill, resolveConflict };
});
