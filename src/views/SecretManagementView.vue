<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { KeyRound, Plus, Save, Trash2, Search, X, ChevronRight } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import type { SecretMetadata } from "@/types";
import { useOpsStore } from "@/stores/ops";
import { useServerWorkspaceTabsStore } from "@/features/workspace/serverWorkspaceTabsStore";

const store = useOpsStore();
const workspaceTabs = useServerWorkspaceTabsStore();
const { t } = useI18n();
const preferredServerId = () => store.servers.some(({ id }) => id === workspaceTabs.activeServerId)
  ? workspaceTabs.activeServerId
  : store.servers[0]?.id ?? "";
const serverId = ref(preferredServerId());
const serverSelectionIsManual = ref(false);
const secrets = computed(() => store.secretMetadata.filter((secret) => secret.serverId === serverId.value));
const secretCountByServer = computed(() => Object.fromEntries(store.servers.map(({ id }) => [
  id,
  store.secretMetadata.filter((secret) => secret.serverId === id).length,
])));
const newKey = ref("");
const newDescription = ref("");
const newValue = ref("");
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle");
const query = ref("");
const visibleSecrets = computed(() => secrets.value.filter(secret =>
  [secret.key, secret.description, credentialGroupHint(secret)].join(" ").toLowerCase().includes(query.value.toLowerCase())));
const dialog = ref<HTMLDialogElement>();
const editing = ref<SecretMetadata>();
const editorServer = ref("");
const editorError = ref("");
const deleting = ref(false);
let returnFocus: HTMLElement | null = null;
async function openEditor(secret?: SecretMetadata) {
  returnFocus = document.activeElement as HTMLElement;
  editorServer.value = serverId.value;
  editing.value = secret;
  newKey.value = secret?.key ?? "";
  newDescription.value = secret?.description ?? "";
  newValue.value = "";
  editorError.value = "";
  deleting.value = false;
  await nextTick();
  dialog.value?.showModal();
}
function closeEditor() {
  if (saveState.value === "saving") return;
  dialog.value?.close();
}
function clearEditor() {
  newValue.value = ""; editing.value = undefined;
  returnFocus?.focus();
}
async function submitEditor() {
  if (saveState.value === "saving") return;
  saveState.value = "saving"; editorError.value = "";
  try {
    await store.hydrateCredentials();
    if (!store.credentialsHydrated) throw new Error(store.credentialError || "凭据加载失败");
    const normalized = newKey.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (!normalized) throw new Error("请填写变量名");
    const secret = editing.value;
    if (store.secretMetadata.some(item => item.serverId === editorServer.value && item.key === normalized && item !== secret))
      throw new Error("该服务器已存在同名变量");
    if (secret) {
      if (!await store.renameSecretMetadata(secret.key, normalized, editorServer.value)) throw new Error("变量重命名失败");
      secret.description = newDescription.value.trim();
      if (newValue.value) store.setServerSecretValue(editorServer.value, secret.key, newValue.value);
    } else {
      store.addSecretMetadata(normalized, newDescription.value, newValue.value, editorServer.value);
      editing.value = store.secretMetadata.find(item => item.serverId === editorServer.value && item.key === normalized);
    }
    await store.saveSecretSettings();
    saveState.value = "saved"; closeEditor();
  } catch (error) {
    saveState.value = "error"; editorError.value = error instanceof Error ? error.message : String(error);
  }
}
async function deleteEntry() {
  if (!editing.value || saveState.value === "saving") return;
  saveState.value = "saving";
  try {
    await store.removeSecretMetadata(editing.value.key, editorServer.value);
    saveState.value = "saved"; closeEditor();
  } catch { saveState.value = "error"; editorError.value = "删除失败，请重试"; }
}

function credentialGroupHint(secret: SecretMetadata) {
  if (!secret.credentialGroupId) return "";
  const role = secret.credentialRole === "username"
    ? t("settings.credentialUsername")
    : t("settings.credentialSecret");
  return [secret.credentialLabel, secret.credentialTarget, role].filter(Boolean).join(" · ");
}
function selectServerManually() {
  serverSelectionIsManual.value = true;
}

watch(
  () => store.servers.map(({ id }) => id),
  (serverIds) => {
    if (!serverIds.includes(serverId.value)) {
      serverSelectionIsManual.value = false;
      serverId.value = preferredServerId();
    }
  },
);

watch(
  () => workspaceTabs.activeServerId,
  (activeServerId) => {
    if (!serverSelectionIsManual.value && store.servers.some(({ id }) => id === activeServerId)) {
      serverId.value = activeServerId;
    }
  },
);

onMounted(() => void store.hydrateCredentials());
</script>

<template>
  <div class="page management-page logs-page secrets-page">
    <header class="page-header logs-header">
      <div><span class="eyebrow">SERVER CREDENTIALS / SECRET MANAGEMENT</span><h1>{{ t("settings.secretsTitle") }}</h1><p>{{ t("settings.secretsSubtitle") }}</p></div>
      <button class="button primary" :disabled="store.credentialsLoading || !serverId" @click="openEditor()"><Plus :size="15"/>新增敏感信息</button>
    </header>
    <main class="secrets-workspace">
      <div class="secrets-toolbar">
        <label class="secret-server-picker"><span>{{ t("settings.secretServer") }}</span><select v-model="serverId" @change="selectServerManually"><option v-for="server in store.servers" :key="server.id" :value="server.id">{{ server.name }} · {{ server.host }} · {{ secretCountByServer[server.id] }} {{ t("settings.secretItems") }}</option></select></label>
        <label class="secrets-search"><Search :size="15"/><input v-model="query" aria-label="搜索敏感信息" placeholder="搜索变量名或用途"/></label>
      </div>
      <p v-if="store.credentialError" class="secrets-error" role="alert">{{ store.credentialError }}</p>
      <p v-if="saveState === 'saved'" class="secrets-notice" role="status">修改已保存</p>
      <div class="secrets-columns"><span>变量名称 / 用途</span><span>凭据状态</span><span></span></div>
      <div class="secrets-list">
        <p v-if="store.credentialsLoading" role="status" class="secrets-notice">正在加载凭据…</p>
        <div v-else-if="!visibleSecrets.length" class="secret-empty-state"><KeyRound :size="26"/><strong>{{ !serverId ? '请先添加服务器' : query ? '没有匹配的敏感信息' : t("settings.noServerSecrets") }}</strong><span>{{ query ? '尝试其他变量名或用途关键词' : t("settings.noServerSecretsHint") }}</span></div>
        <button v-for="secret in visibleSecrets" :key="`${secret.serverId}:${secret.key}`" class="secret-list-row" @click="openEditor(secret)">
          <span class="server-icon"><KeyRound :size="16"/></span>
          <span class="secret-row-copy"><strong :title="secret.key">{{ secret.key }}</strong><span :title="secret.description">{{ secret.description || '未填写用途' }}</span><small v-if="credentialGroupHint(secret)" :title="credentialGroupHint(secret)">{{ credentialGroupHint(secret) }}</small></span>
          <span class="secret-presence" :class="{ configured: !!store.getServerSecretValues(serverId)[secret.key] }">{{ store.getServerSecretValues(serverId)[secret.key] ? '已设置' : '未设置' }}</span><ChevronRight :size="16"/>
        </button>
      </div>
      <footer class="secrets-footer"><span>敏感值默认隐藏 · 按服务器隔离</span><span>{{ visibleSecrets.length }} / {{ secrets.length }} 项</span></footer>
    </main>
    <Teleport to="body">
      <dialog ref="dialog" class="secret-drawer" @cancel.prevent="closeEditor" @close="clearEditor">
        <header class="secret-drawer-header"><KeyRound :size="20"/><div><small>{{ editing ? '编辑敏感信息' : '新增敏感信息' }}</small><h2 :title="editing?.key">{{ editing?.key || '服务器凭据' }}</h2></div><button type="button" class="icon-button" aria-label="关闭" :disabled="saveState === 'saving'" @click="closeEditor"><X :size="18"/></button></header>
        <form @submit.prevent="submitEditor">
          <fieldset :disabled="saveState === 'saving'">
            <p class="secret-server-context">{{ store.servers.find(server => server.id === editorServer)?.name }}</p>
            <label>变量名称<input v-model="newKey" required autocomplete="off" placeholder="VARIABLE_NAME"/></label>
            <label>用途说明<input v-model="newDescription" autocomplete="off" placeholder="例如：私有 Git 仓库访问令牌"/></label>
            <label>{{ editing ? '替换敏感值' : '敏感值' }}<input v-model="newValue" type="password" :required="!editing" autocomplete="new-password" :placeholder="editing ? '留空保留现有值' : '输入密码或令牌'"/><small>保存在系统凭据存储中，列表不显示明文。</small></label>
            <p v-if="editing && credentialGroupHint(editing)" class="secret-server-context">{{ credentialGroupHint(editing) }}</p>
            <div v-if="deleting" class="delete-confirm"><p>{{ editing?.credentialGroupId ? '将删除该凭据组的全部关联字段。' : '将删除此敏感变量。' }}</p><button class="button danger" type="button" @click="deleteEntry">确认删除</button><button class="button secondary" type="button" @click="deleting = false">取消</button></div>
            <p v-if="editorError" class="secrets-error" role="alert">{{ editorError }}</p>
          </fieldset>
          <footer class="secret-drawer-footer"><button v-if="editing" type="button" class="button danger" :disabled="saveState === 'saving'" @click="deleting = true"><Trash2 :size="14"/>删除</button><span></span><button class="button secondary" type="button" :disabled="saveState === 'saving'" @click="closeEditor">取消</button><button class="button primary" :disabled="saveState === 'saving'"><Save :size="14"/>{{ saveState === 'saving' ? '保存中…' : '保存' }}</button></footer>
        </form>
      </dialog>
    </Teleport>
  </div>
</template>
<style scoped>
.secrets-page{gap:0;overflow:hidden}.secrets-page .page-header{width:100%;margin:0 auto 24px;flex:none}.secrets-workspace{width:100%;max-width:1320px;margin:0 auto;min-height:0;flex:1;display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden}.secrets-toolbar{display:flex;align-items:center;gap:14px;min-height:58px;padding:10px 13px;border-bottom:1px solid var(--border);background:var(--panel-2)}.secret-server-picker{display:flex;align-items:center;gap:12px;margin:0;min-width:0;flex:1}.secret-server-picker>span{white-space:nowrap;font-size:12px;color:var(--muted)}.secret-server-picker select{flex:1;min-width:0;max-width:440px;margin:0;height:35px;font-size:10px}.secrets-search{display:flex;align-items:center;gap:8px;padding:0 10px;height:35px;border:1px solid var(--border);border-radius:5px;background:var(--panel);color:var(--muted)}.secrets-search input{background:transparent;border:0;min-width:0;width:180px;color:var(--text);font-size:10px}.secrets-columns{display:grid;grid-template-columns:minmax(0,1fr) 80px 16px;gap:10px;padding:10px 14px 10px 56px;color:var(--dim);font:9px DM Mono,monospace;border-bottom:1px solid var(--border-soft)}.secrets-list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.secret-list-row{width:100%;display:grid;grid-template-columns:32px minmax(0,1fr) 80px 16px;gap:10px;align-items:center;min-height:64px;padding:11px 14px;border:0;border-bottom:1px solid var(--border-soft);background:transparent;text-align:left;cursor:pointer;color:var(--muted)}.secret-list-row:hover{background:var(--panel-2)}.secret-list-row:focus-visible{outline:1px solid var(--accent);outline-offset:-2px}.secret-row-copy{display:grid;gap:5px;min-width:0}.secret-row-copy>*{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.secret-row-copy strong{font-size:11px;color:var(--text);font-weight:600}.secret-row-copy span{font-size:10px}.secret-row-copy small{color:var(--dim);font:8px DM Mono,monospace}.secret-presence{justify-self:start;border:1px solid var(--border-soft);border-radius:10px;padding:3px 7px;background:var(--panel-2);color:var(--dim);font:9px DM Mono,monospace}.secret-presence.configured{color:var(--green)}.secrets-footer{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;border-top:1px solid var(--border);font:9px DM Mono,monospace;color:var(--dim)}.secret-empty-state{padding:50px 20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px;color:var(--muted);font-size:12px}.secrets-error{color:var(--red);font-size:12px;padding:0 16px}.secrets-notice{color:var(--accent);font-size:12px;padding:0 16px}.secret-drawer{position:fixed;inset:0 0 0 auto;margin:0;width:min(560px,100vw);max-width:100vw;height:100%;max-height:100%;padding:0;border:0;border-left:1px solid var(--border);background:var(--panel);color:var(--text)}.secret-drawer[open]{display:flex;flex-direction:column}.secret-drawer::backdrop{background:#0007}.secret-drawer-header{display:grid;grid-template-columns:20px minmax(0,1fr) 32px;gap:14px;align-items:center;padding:16px 24px;border-bottom:1px solid var(--border);background:var(--panel-2);flex:none}.secret-drawer-header>svg{color:var(--accent)}.secret-drawer-header>div{min-width:0}.secret-drawer-header h2{font-size:16px;margin:5px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.secret-drawer-header small{color:var(--dim);font:9px DM Mono,monospace}.secret-drawer form{display:flex;flex:1;min-height:0;flex-direction:column}.secret-drawer fieldset{border:0;padding:24px;margin:0;overflow:auto;flex:1;min-height:0;min-width:0}.secret-drawer label{display:grid;gap:9px;margin:0 0 22px;font-size:12px}.secret-drawer input{width:100%;height:40px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);padding:0 12px}.secret-drawer label small,.secret-server-context{font-size:12px;color:var(--muted);line-height:1.6;overflow-wrap:anywhere}.secret-server-context{margin:0 0 24px}.secret-drawer-footer{display:flex;gap:10px;padding:14px 24px;border-top:1px solid var(--border);background:var(--panel-2);flex:none}.secret-drawer-footer>span{flex:1}.delete-confirm{padding:12px;border:1px solid var(--border);border-radius:6px;font-size:12px}.delete-confirm button{margin-right:8px}:global(html.desktop-window .secret-drawer){top:36px;height:calc(100% - 36px);max-height:calc(100% - 36px)}@media(max-width:700px){.secrets-page{gap:0}.secrets-toolbar{flex-direction:column;align-items:stretch;gap:12px}.secrets-search input{width:100%}.secret-server-picker select{max-width:none}.secret-list-row{gap:10px;padding-inline:12px}.secrets-page .page-header{gap:12px}.secrets-page h1{font-size:20px}.secrets-columns{padding-left:54px;gap:10px}}
</style>
