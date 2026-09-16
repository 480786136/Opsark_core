<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { KeyRound, Plus, Save, Trash2, Search, X, ChevronRight } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import type { SecretMetadata } from "@/types";
import { useOpsStore } from "@/stores/ops";
import { useServerWorkspaceTabsStore } from "@/features/workspace/serverWorkspaceTabsStore";
import ParameterSelect from "@/components/ParameterSelect.vue";
import { localizeCoreText } from "@/features/preferences/coreText";

const store = useOpsStore();
const workspaceTabs = useServerWorkspaceTabsStore();
const { t, locale } = useI18n();
const coreText = (value: string | undefined | null) => localizeCoreText(value, locale.value);
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
const serverOptions = computed(() => store.servers.map((server) => ({
  value: server.id,
  label: `${server.name} · ${server.host} · ${secretCountByServer.value[server.id]} ${t("settings.secretItems")}`,
})));
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
    if (!store.credentialsHydrated) throw new Error(store.credentialError || t("settings.credentialLoadFailed"));
    const normalized = newKey.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (!normalized) throw new Error(t("settings.variableNameRequired"));
    const secret = editing.value;
    if (store.secretMetadata.some(item => item.serverId === editorServer.value && item.key === normalized && item !== secret))
      throw new Error(t("settings.duplicateSecret"));
    if (secret) {
      if (!await store.renameSecretMetadata(secret.key, normalized, editorServer.value)) throw new Error(t("settings.secretRenameFailed"));
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
  } catch { saveState.value = "error"; editorError.value = t("settings.secretDeleteFailed"); }
}

function credentialGroupHint(secret: SecretMetadata) {
  if (!secret.credentialGroupId) return "";
  const role = secret.credentialRole === "username"
    ? t("settings.credentialUsername")
    : t("settings.credentialSecret");
  return [secret.credentialLabel, secret.credentialTarget, role].filter(Boolean).join(" · ");
}
function selectServer(value: string) {
  serverId.value = value;
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
      <div><span class="eyebrow">{{ t("settings.serverCredentialsEyebrow") }}</span><h1>{{ t("settings.secretsTitle") }}</h1><p>{{ t("settings.secretsSubtitle") }}</p></div>
      <button class="button primary" :disabled="store.credentialsLoading || !serverId" @click="openEditor()"><Plus :size="15"/>{{ t("settings.addSecret") }}</button>
    </header>
    <main class="secrets-workspace">
      <div class="secrets-toolbar">
        <label class="secret-server-picker"><span>{{ t("settings.secretServer") }}</span><ParameterSelect :model-value="serverId" :options="serverOptions" :ariaLabel="t('settings.selectSecretServer')" :placeholder="t('settings.selectSecretServer')" size="small" @update:model-value="selectServer"/></label>
        <label class="secrets-search"><Search :size="15"/><input v-model="query" :aria-label="t('settings.secretSearch')" :placeholder="t('settings.secretSearchPlaceholder')"/></label>
      </div>
      <p v-if="store.credentialError" class="secrets-error" role="alert">{{ coreText(store.credentialError) }}</p>
      <p v-if="saveState === 'saved'" class="secrets-notice" role="status">{{ t("settings.secretChangesSaved") }}</p>
      <div class="secrets-columns"><span>{{ t("settings.secretNameAndPurpose") }}</span><span>{{ t("settings.credentialStatus") }}</span><span></span></div>
      <div class="secrets-list">
        <p v-if="store.credentialsLoading" role="status" class="secrets-notice">{{ t("settings.credentialsLoading") }}</p>
        <div v-else-if="!visibleSecrets.length" class="secret-empty-state"><KeyRound :size="26"/><strong>{{ !serverId ? t('settings.addServerFirst') : query ? t('settings.noMatchingSecrets') : t("settings.noServerSecrets") }}</strong><span>{{ query ? t('settings.tryAnotherSecretSearch') : t("settings.noServerSecretsHint") }}</span></div>
        <button v-for="secret in visibleSecrets" :key="`${secret.serverId}:${secret.key}`" class="secret-list-row" @click="openEditor(secret)">
          <span class="server-icon"><KeyRound :size="16"/></span>
          <span class="secret-row-copy"><strong :title="secret.key">{{ secret.key }}</strong><span :title="secret.description">{{ secret.description || t('settings.noSecretPurpose') }}</span><small v-if="credentialGroupHint(secret)" :title="credentialGroupHint(secret)">{{ credentialGroupHint(secret) }}</small></span>
          <span class="secret-presence" :class="{ configured: !!store.getServerSecretValues(serverId)[secret.key] }">{{ store.getServerSecretValues(serverId)[secret.key] ? t('settings.secretConfigured') : t('settings.secretNotConfigured') }}</span><ChevronRight :size="16"/>
        </button>
      </div>
      <footer class="secrets-footer"><span>{{ t("settings.secretIsolationHint") }}</span><span>{{ t("settings.visibleSecretCount", { visible: visibleSecrets.length, total: secrets.length }) }}</span></footer>
    </main>
    <Teleport to="body">
      <dialog ref="dialog" class="secret-drawer" @cancel.prevent="closeEditor" @close="clearEditor">
        <header class="secret-drawer-header"><KeyRound :size="20"/><div><small>{{ editing ? t('settings.editSecret') : t('settings.addSecret') }}</small><h2 :title="editing?.key">{{ editing?.key || t('settings.serverCredential') }}</h2></div><button type="button" class="icon-button" :aria-label="t('common.close')" :disabled="saveState === 'saving'" @click="closeEditor"><X :size="18"/></button></header>
        <form @submit.prevent="submitEditor">
          <fieldset :disabled="saveState === 'saving'">
            <p class="secret-server-context">{{ store.servers.find(server => server.id === editorServer)?.name }}</p>
            <label>{{ t("settings.variableName") }}<input v-model="newKey" required autocomplete="off" placeholder="VARIABLE_NAME"/></label>
            <label>{{ t("settings.purpose") }}<input v-model="newDescription" autocomplete="off" :placeholder="t('settings.purposePlaceholder')"/></label>
            <label>{{ editing ? t('settings.replaceSecretValue') : t('settings.secretValueShort') }}<input v-model="newValue" type="password" :required="!editing" autocomplete="new-password" :placeholder="editing ? t('settings.keepExistingSecretValue') : t('settings.enterPasswordOrToken')"/><small>{{ t("settings.secretStorageHint") }}</small></label>
            <p v-if="editing && credentialGroupHint(editing)" class="secret-server-context">{{ credentialGroupHint(editing) }}</p>
            <div v-if="deleting" class="delete-confirm"><p>{{ editing?.credentialGroupId ? t('settings.deleteCredentialGroupConfirm') : t('settings.deleteSecretConfirm') }}</p><button class="button danger" type="button" @click="deleteEntry">{{ t("settings.confirmDelete") }}</button><button class="button secondary" type="button" @click="deleting = false">{{ t("common.cancel") }}</button></div>
            <p v-if="editorError" class="secrets-error" role="alert">{{ coreText(editorError) }}</p>
          </fieldset>
          <footer class="secret-drawer-footer"><button v-if="editing" type="button" class="button danger" :disabled="saveState === 'saving'" @click="deleting = true"><Trash2 :size="14"/>{{ t("common.remove") }}</button><span></span><button class="button secondary" type="button" :disabled="saveState === 'saving'" @click="closeEditor">{{ t("common.cancel") }}</button><button class="button primary" :disabled="saveState === 'saving'"><Save :size="14"/>{{ saveState === 'saving' ? t('settings.saving') : t('common.save') }}</button></footer>
        </form>
      </dialog>
    </Teleport>
  </div>
</template>
<style scoped>
.secrets-page{gap:0;overflow:hidden}.secrets-page .page-header{width:100%;margin:0 auto 24px;flex:none}.secrets-workspace{width:100%;max-width:1320px;margin:0 auto;min-height:0;flex:1;display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden}.secrets-toolbar{display:flex;align-items:center;gap:14px;min-height:58px;padding:10px 13px;border-bottom:1px solid var(--border);background:var(--panel-2)}.secret-server-picker{display:flex;align-items:center;gap:12px;margin:0;min-width:0;flex:1}.secret-server-picker>span{white-space:nowrap;font-size:12px;color:var(--muted)}.secret-server-picker :deep(.parameter-select){flex:1;min-width:0;max-width:440px;margin:0;font-size:10px}.secrets-search{display:flex;align-items:center;gap:8px;padding:0 10px;height:35px;border:1px solid var(--border);border-radius:5px;background:var(--panel);color:var(--muted)}.secrets-search input{background:transparent;border:0;min-width:0;width:180px;color:var(--text);font-size:10px}.secrets-columns{display:grid;grid-template-columns:minmax(0,1fr) 80px 16px;gap:10px;padding:10px 14px 10px 56px;color:var(--dim);font:9px DM Mono,monospace;border-bottom:1px solid var(--border-soft)}.secrets-list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.secret-list-row{width:100%;display:grid;grid-template-columns:32px minmax(0,1fr) 80px 16px;gap:10px;align-items:center;min-height:64px;padding:11px 14px;border:0;border-bottom:1px solid var(--border-soft);background:transparent;text-align:left;cursor:pointer;color:var(--muted)}.secret-list-row:hover{background:var(--panel-2)}.secret-list-row:focus-visible{outline:1px solid var(--accent);outline-offset:-2px}.secret-row-copy{display:grid;gap:5px;min-width:0}.secret-row-copy>*{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.secret-row-copy strong{font-size:11px;color:var(--text);font-weight:600}.secret-row-copy span{font-size:10px}.secret-row-copy small{color:var(--dim);font:8px DM Mono,monospace}.secret-presence{justify-self:start;border:1px solid var(--border-soft);border-radius:10px;padding:3px 7px;background:var(--panel-2);color:var(--dim);font:9px DM Mono,monospace}.secret-presence.configured{color:var(--green)}.secrets-footer{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;border-top:1px solid var(--border);font:9px DM Mono,monospace;color:var(--dim)}.secret-empty-state{padding:50px 20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px;color:var(--muted);font-size:12px}.secrets-error{color:var(--red);font-size:12px;padding:0 16px}.secrets-notice{color:var(--accent);font-size:12px;padding:0 16px}.secret-drawer{position:fixed;inset:0 0 0 auto;margin:0;width:min(560px,100vw);max-width:100vw;height:100%;max-height:100%;padding:0;border:0;border-left:1px solid var(--border);background:var(--panel);color:var(--text)}.secret-drawer[open]{display:flex;flex-direction:column}.secret-drawer::backdrop{background:var(--scrim)}.secret-drawer-header{display:grid;grid-template-columns:20px minmax(0,1fr) 32px;gap:14px;align-items:center;padding:16px 24px;border-bottom:1px solid var(--border);background:var(--panel-2);flex:none}.secret-drawer-header>svg{color:var(--accent)}.secret-drawer-header>div{min-width:0}.secret-drawer-header h2{font-size:16px;margin:5px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.secret-drawer-header small{color:var(--dim);font:9px DM Mono,monospace}.secret-drawer form{display:flex;flex:1;min-height:0;flex-direction:column}.secret-drawer fieldset{border:0;padding:24px;margin:0;overflow:auto;flex:1;min-height:0;min-width:0}.secret-drawer label{display:grid;gap:9px;margin:0 0 22px;font-size:12px}.secret-drawer input{width:100%;height:40px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);padding:0 12px}.secret-drawer label small,.secret-server-context{font-size:12px;color:var(--muted);line-height:1.6;overflow-wrap:anywhere}.secret-server-context{margin:0 0 24px}.secret-drawer-footer{display:flex;gap:10px;padding:14px 24px;border-top:1px solid var(--border);background:var(--panel-2);flex:none}.secret-drawer-footer>span{flex:1}.delete-confirm{padding:12px;border:1px solid var(--border);border-radius:6px;font-size:12px}.delete-confirm button{margin-right:8px}:global(html.desktop-window .secret-drawer){top:36px;height:calc(100% - 36px);max-height:calc(100% - 36px)}@media(max-width:700px){.secrets-page{gap:0}.secrets-toolbar{flex-direction:column;align-items:stretch;gap:12px}.secrets-search input{width:100%}.secret-server-picker :deep(.parameter-select){max-width:none}.secret-list-row{gap:10px;padding-inline:12px}.secrets-page .page-header{gap:12px}.secrets-page h1{font-size:20px}.secrets-columns{padding-left:54px;gap:10px}}
</style>
