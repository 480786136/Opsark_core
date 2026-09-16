<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Database, UploadCloud } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useKnowledgeStore } from "./knowledgeStore";
import { isTauri } from "@/services/backend";
import ParameterSelect from "@/components/ParameterSelect.vue";
import { localizeCoreText } from "@/features/preferences/coreText";

const knowledge=useKnowledgeStore();
const { t, locale } = useI18n();
const coreText = (value: string | undefined | null) => localizeCoreText(value, locale.value);
knowledge.hydrate();
const draft=ref({...knowledge.config}), apiKey=ref(""), messageKey=ref(""), messageParams=ref<Record<string, unknown>>({}), error=ref("");
const working=ref(false);
const baseOptions=computed(()=>[
  ...(draft.value.knowledgeBaseId&&!knowledge.bases.some(base=>base.id===draft.value.knowledgeBaseId)
    ? [{value:draft.value.knowledgeBaseId,label:t("knowledge.savedBase",{id:draft.value.knowledgeBaseId})}]
    : []),
  ...knowledge.bases.map(base=>({value:base.id,label:base.name})),
]);
const message=computed(()=>messageKey.value?t(messageKey.value,messageParams.value):"");
async function run(fn:()=>Promise<void>|void) {
  working.value=true;error.value="";messageKey.value="";messageParams.value={};
  try{await fn();}catch(e){error.value=e instanceof Error?e.message:String(e);}finally{working.value=false;}
}
async function save(){await knowledge.save(draft.value,apiKey.value);apiKey.value="";draft.value={...knowledge.config};messageKey.value="knowledge.settingsSaved";}
async function test(){await save();const bases=await knowledge.testConnection();messageKey.value="knowledge.connectionSucceeded";messageParams.value={count:bases.length};}
async function removeKey(){await knowledge.removeKey();draft.value={...knowledge.config};apiKey.value="";messageKey.value="knowledge.keyRemoved";}
function statusLabel(status:string){
  if(status==="accepted")return t("knowledge.statusAccepted");
  if(status==="failed")return t("knowledge.statusFailed");
  if(status==="uploading")return t("knowledge.statusUploading");
  return t("knowledge.statusQueued");
}
onMounted(()=>{error.value=knowledge.storageError;});
</script>
<template>
  <section class="settings-card knowledge-settings">
    <div class="settings-title"><Database :size="18"/><div><h2>{{t("knowledge.title")}}</h2><p>{{t("knowledge.subtitle")}}</p></div></div>
    <p v-if="!isTauri()" class="knowledge-note">{{t("knowledge.browserPreview")}}</p>
    <label>{{t("knowledge.endpoint")}}<input v-model="draft.endpoint" placeholder="http://127.0.0.1:8002/api/v1" autocomplete="off" :disabled="knowledge.busy||working"/></label>
    <label>{{t("knowledge.apiKey")}}<input v-model="apiKey" type="password" autocomplete="new-password" :placeholder="knowledge.config.hasApiKey?t('knowledge.apiKeyStoredPlaceholder'):t('knowledge.apiKeyPlaceholder')" :disabled="knowledge.busy||working"/></label>
    <div class="knowledge-actions"><button class="button secondary" :disabled="knowledge.busy||working" @click="run(test)">{{t("knowledge.saveAndTest")}}</button><button class="button secondary" :disabled="knowledge.busy||working||!knowledge.config.hasApiKey" @click="run(removeKey)">{{t("knowledge.removeKey")}}</button></div>
    <label><span>{{t("knowledge.targetBase")}}</span><ParameterSelect :model-value="draft.knowledgeBaseId" :options="baseOptions" :ariaLabel="t('knowledge.targetBase')" :placeholder="t('knowledge.selectBase')" :disabled="knowledge.busy||working" clearable :clear-label="t('common.clear')" @update:model-value="draft.knowledgeBaseId=$event"/></label>
    <div class="generation-limit-head"><div><strong>{{t("knowledge.enableUpload")}}</strong><small>{{t("knowledge.enableUploadHint")}}</small></div><label class="toggle"><input v-model="draft.uploadEnabled" type="checkbox" :disabled="knowledge.busy||working"/><i></i></label></div>
    <div class="generation-limit-head"><div><strong>{{t("knowledge.enableSearch")}}</strong><small>{{t("knowledge.enableSearchHint")}}</small></div><label class="toggle"><input v-model="draft.searchEnabled" type="checkbox" :disabled="knowledge.busy||working"/><i></i></label></div>
    <button class="button primary" :disabled="knowledge.busy||working" @click="run(save)">{{t("knowledge.saveSettings")}}</button>
    <p class="knowledge-note">{{t("knowledge.connectionHint")}}</p>
    <p v-if="message" role="status">{{message}}</p><p v-if="error" role="alert" class="knowledge-error">{{coreText(error)}}</p>
    <div v-if="knowledge.entries.length" class="knowledge-history"><h3><UploadCloud :size="16"/> {{t("knowledge.uploadHistory")}}</h3><p class="knowledge-note">{{t("knowledge.uploadHistoryHint")}}</p><article v-for="entry in knowledge.entries" :key="entry.id"><strong>{{entry.title}}</strong><small>{{entry.createdAt}} · {{statusLabel(entry.status)}} <span v-if="entry.remoteStatus">/ {{entry.remoteStatus}}</span></small><p v-if="entry.error" class="knowledge-error">{{coreText(entry.error)}}</p><div class="knowledge-actions"><button v-if="entry.status!=='accepted'" class="button secondary" :disabled="knowledge.busy||working||!knowledge.config.uploadEnabled" @click="run(()=>knowledge.send(entry.id))">{{t("knowledge.retryUpload")}}</button><button v-if="entry.recordId" class="button secondary" :disabled="knowledge.busy||working||!knowledge.config.uploadEnabled" @click="run(()=>knowledge.refreshStatus(entry.id))">{{t("knowledge.refreshStatus")}}</button><button class="button secondary" :disabled="knowledge.busy||working" @click="run(()=>knowledge.forget(entry.id))">{{t("knowledge.forgetLocal")}}</button></div></article></div>
  </section>
</template>
<style scoped>
.knowledge-settings>label{display:grid;gap:8px;margin:16px 0;font-size:13px}.knowledge-settings input:not([type=checkbox]),.knowledge-settings select{width:100%;padding:9px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text)}.knowledge-actions{display:flex;gap:8px;flex-wrap:wrap}.knowledge-note{font-size:12px;color:var(--muted);line-height:1.7}.knowledge-error{color:var(--red);font-size:13px}.knowledge-history{margin-top:22px;border-top:1px solid var(--border)}.knowledge-history h3{display:flex;gap:8px;align-items:center}.knowledge-history article{padding:12px 0;border-top:1px solid var(--border-soft)}.knowledge-history small{display:block;color:var(--muted);font-size:11px;margin:6px 0}.generation-limit-head{margin:14px 0}.generation-limit-head small{max-width:520px}
</style>
