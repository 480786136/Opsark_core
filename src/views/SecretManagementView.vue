<script setup lang="ts">
import { computed, ref } from "vue";
import { Plus, Save, Trash2 } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import type { SecretMetadata } from "@/types";
import { useOpsStore } from "@/stores/ops";

const store = useOpsStore();
const { t } = useI18n();
const serverId = ref(store.servers[0]?.id ?? "");
const secrets = computed(() => store.secretMetadata.filter((secret) => secret.serverId === serverId.value));
const newKey = ref("");
const newDescription = ref("");
const newValue = ref("");
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle");

function addSecret() {
  store.addSecretMetadata(newKey.value, newDescription.value, newValue.value, serverId.value);
  newKey.value = ""; newDescription.value = ""; newValue.value = "";
}
async function renameSecret(secret: SecretMetadata, event: Event) {
  const input = event.target as HTMLInputElement;
  try { if (!await store.renameSecretMetadata(secret.key, input.value, serverId.value)) input.value = secret.key; }
  catch { input.value = secret.key; saveState.value = "error"; }
}
async function saveSecrets() {
  saveState.value = "saving";
  try {
    await store.saveSecretSettings();
    saveState.value = "saved";
    window.setTimeout(() => { if (saveState.value === "saved") saveState.value = "idle"; }, 1800);
  } catch { saveState.value = "error"; }
}
</script>

<template>
  <div class="page management-page">
    <header class="page-header">
      <div><span class="eyebrow">SERVER CREDENTIALS</span><h1>{{ t("settings.secretsTitle") }}</h1><p>{{ t("settings.secretsSubtitle") }}</p></div>
      <button class="button primary" :disabled="saveState === 'saving' || !serverId" @click="saveSecrets"><Save :size="15" />{{ saveState === "saving" ? t("settings.saving") : saveState === "saved" ? t("settings.saved") : t("common.save") }}</button>
    </header>
    <main class="management-layout">
      <p v-if="saveState === 'error'" class="security-hint">{{ t("settings.saveFailed", { reason: store.credentialError || t("settings.invalidSettings") }) }}</p>
      <section class="settings-card">
        <label class="secret-server-picker"><span>{{ t("settings.secretServer") }}</span><select v-model="serverId"><option v-for="server in store.servers" :key="server.id" :value="server.id">{{ server.name }} · {{ server.host }}</option></select></label>
        <div class="secret-editor-head"><span>{{ t("settings.variableName") }}</span><span>{{ t("settings.description") }}</span><span>{{ t("settings.secretValue") }}</span><span></span></div>
        <div v-for="secret in secrets" :key="`${secret.serverId}:${secret.key}`" class="secret-editor-row">
          <input :value="secret.key" autocomplete="off" @change="renameSecret(secret, $event)" />
          <input v-model="secret.description" autocomplete="off" />
          <input :value="store.getServerSecretValues(serverId)[secret.key]" type="password" autocomplete="off" :placeholder="t('common.notSet')" @input="store.setServerSecretValue(serverId, secret.key, ($event.target as HTMLInputElement).value)" />
          <button class="icon-button danger" type="button" :title="t('settings.removeSecret')" @click="store.removeSecretMetadata(secret.key, serverId)"><Trash2 :size="14" /></button>
        </div>
        <form v-if="serverId" class="add-secret-form" @submit.prevent="addSecret"><input v-model="newKey" placeholder="VARIABLE_NAME" /><input v-model="newDescription" :placeholder="t('settings.variableDescription')" /><input v-model="newValue" type="password" autocomplete="off" :placeholder="t('settings.secretValue')" /><button class="button secondary" type="submit" :disabled="!newKey"><Plus :size="14" />{{ t("common.add") }}</button></form>
      </section>
    </main>
  </div>
</template>
