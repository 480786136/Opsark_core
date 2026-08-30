<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { KeyRound, Plus, Save, Trash2 } from "lucide-vue-next";
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

function addSecret() {
  store.addSecretMetadata(newKey.value, newDescription.value, newValue.value, serverId.value);
  newKey.value = ""; newDescription.value = ""; newValue.value = "";
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
async function renameSecret(secret: SecretMetadata, event: Event) {
  const input = event.target as HTMLInputElement;
  try { if (!await store.renameSecretMetadata(secret.key, input.value, serverId.value)) input.value = secret.key; }
  catch { input.value = secret.key; saveState.value = "error"; }
}
async function saveSecrets() {
  saveState.value = "saving";
  try {
    await store.hydrateCredentials();
    await store.saveSecretSettings();
    saveState.value = "saved";
    window.setTimeout(() => { if (saveState.value === "saved") saveState.value = "idle"; }, 1800);
  } catch { saveState.value = "error"; }
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
  <div class="page management-page">
    <header class="page-header">
      <div><span class="eyebrow">SERVER CREDENTIALS</span><h1>{{ t("settings.secretsTitle") }}</h1><p>{{ t("settings.secretsSubtitle") }}</p></div>
      <button class="button primary" :disabled="saveState === 'saving' || store.credentialsLoading || !serverId" @click="saveSecrets"><Save :size="15" />{{ saveState === "saving" || store.credentialsLoading ? t("settings.saving") : saveState === "saved" ? t("settings.saved") : t("common.save") }}</button>
    </header>
    <main class="management-layout">
      <p v-if="saveState === 'error' || store.credentialError" class="security-hint">{{ t("settings.saveFailed", { reason: store.credentialError || t("settings.invalidSettings") }) }}</p>
      <section class="settings-card">
        <label class="secret-server-picker"><span>{{ t("settings.secretServer") }}</span><select v-model="serverId" @change="selectServerManually"><option v-for="server in store.servers" :key="server.id" :value="server.id">{{ server.name }} · {{ server.host }} · {{ secretCountByServer[server.id] }} {{ t("settings.secretItems") }}</option></select></label>
        <div class="secret-editor-head"><span>{{ t("settings.variableName") }}</span><span>{{ t("settings.description") }}</span><span>{{ t("settings.secretValue") }}</span><span></span></div>
        <div v-if="!store.credentialsLoading && secrets.length === 0" class="secret-empty-state">
          <KeyRound :size="22" />
          <strong>{{ t("settings.noServerSecrets") }}</strong>
          <span>{{ t("settings.noServerSecretsHint") }}</span>
        </div>
        <div v-for="secret in secrets" :key="`${secret.serverId}:${secret.key}`" class="secret-editor-row">
          <input :value="secret.key" autocomplete="off" @change="renameSecret(secret, $event)" />
          <div class="secret-description-cell">
            <input v-model="secret.description" autocomplete="off" />
            <small v-if="credentialGroupHint(secret)">{{ credentialGroupHint(secret) }}</small>
          </div>
          <input :value="store.getServerSecretValues(serverId)[secret.key]" type="password" autocomplete="off" :placeholder="t('common.notSet')" @input="store.setServerSecretValue(serverId, secret.key, ($event.target as HTMLInputElement).value)" />
          <button class="icon-button danger" type="button" :title="t(secret.credentialGroupId ? 'settings.removeCredentialGroup' : 'settings.removeSecret')" @click="store.removeSecretMetadata(secret.key, serverId)"><Trash2 :size="14" /></button>
        </div>
        <form v-if="serverId" class="add-secret-form" @submit.prevent="addSecret"><input v-model="newKey" placeholder="VARIABLE_NAME" /><input v-model="newDescription" :placeholder="t('settings.variableDescription')" /><input v-model="newValue" type="password" autocomplete="off" :placeholder="t('settings.secretValue')" /><button class="button secondary" type="submit" :disabled="!newKey"><Plus :size="14" />{{ t("common.add") }}</button></form>
      </section>
    </main>
  </div>
</template>
