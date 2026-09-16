<script setup lang="ts">
import { computed, ref } from "vue";
import { UploadCloud, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import type { OpsTask } from "@/types";
import { useOpsStore } from "@/stores/ops";
import { useKnowledgeStore } from "./knowledgeStore";
import { buildKnowledgeRecord, serializeRecord } from "./record";
import type { KnowledgeRecord, KnowledgeConfig } from "./types";
import { localizeCoreText } from "@/features/preferences/coreText";
const props=defineProps<{task:OpsTask}>();
const {t,locale}=useI18n();
const coreText=(value:string|undefined|null)=>localizeCoreText(value,locale.value);
const ops=useOpsStore(),knowledge=useKnowledgeStore();knowledge.hydrate();
const open=ref(false),includeCommands=ref(false),preview=ref<KnowledgeRecord>(),previewBody=ref(""),error=ref(""),confirmed=ref(false),entryId=ref("");
const entry=computed(()=>knowledge.entries.find(e=>e.id===entryId.value));
const entryStatus=computed(()=>entry.value?.status==="accepted"
  ? t("knowledge.accepted")
  : entry.value?.status==="failed" ? coreText(entry.value.error) : t("knowledge.statusUploading"));
const destination=ref<KnowledgeConfig>();
function prepare(){
  try{
    error.value="";confirmed.value=false;entryId.value="";
    if(!knowledge.config.uploadEnabled)throw new Error(t("knowledge.enableUploadFirst"));
    const secretValues={...ops.getServerSecretValues(props.task.serverId)};
    const serverPassword=ops.serverPasswords[props.task.serverId];
    if(serverPassword)secretValues.__SERVER_PASSWORD__=serverPassword;
    const modelApiKey=ops.modelApiKeys[props.task.modelId];
    if(modelApiKey)secretValues.__MODEL_API_KEY__=modelApiKey;
    preview.value=buildKnowledgeRecord(props.task,knowledge.config.knowledgeBaseId,knowledge.nextRevision(props.task.id),{
      secretValues,redactIpAddresses:true,
    },includeCommands.value);
    if(!preview.value.steps.length)throw new Error(t("knowledge.noExecutableSteps"));
    destination.value={...knowledge.config};
    previewBody.value=serializeRecord(preview.value);open.value=true;
  }catch(e){error.value=e instanceof Error?e.message:String(e);}
}
async function upload(){
  if(!preview.value||!confirmed.value||!destination.value)return;
  try{error.value="";entryId.value=knowledge.enqueue(preview.value,destination.value);await knowledge.send(entryId.value);}catch(e){error.value=e instanceof Error?e.message:String(e);}
}
</script>
<template>
  <div class="task-knowledge-upload" role="group" :aria-label="t('knowledge.taskRecordActions')"><button type="button" class="button secondary" :disabled="knowledge.busy" @click="prepare"><UploadCloud :size="14"/>{{knowledge.busy?t('knowledge.uploading'):t('knowledge.uploadTaskRecord')}}</button><small v-if="error&&!open" role="alert">{{coreText(error)}}</small></div>
  <Teleport to="body"><div v-if="open" class="knowledge-overlay" @keydown.esc="!knowledge.busy&&(open=false)"><section class="knowledge-modal" role="dialog" aria-modal="true" :aria-label="t('knowledge.previewLabel')"><header><h2>{{t("knowledge.previewLabel")}}</h2><button class="button secondary" :aria-label="t('knowledge.closePreview')" :disabled="knowledge.busy" @click="open=false"><X :size="16"/></button></header><p>{{t("knowledge.destination",{endpoint:destination?.endpoint??"",base:preview?.knowledge_base_id??""})}}</p><p>{{t("knowledge.previewDescription",{count:preview?.steps.length??0})}}</p><label><input v-model="includeCommands" type="checkbox" :disabled="!!entryId||knowledge.busy" @change="prepare"/> {{t("knowledge.includeCommands")}}</label><p>{{t("knowledge.includeCommandsHint")}}</p><pre tabindex="0">{{previewBody}}</pre><label v-if="!entryId"><input v-model="confirmed" type="checkbox"/> {{t("knowledge.confirmation")}}</label><p v-if="error" role="alert" class="error">{{coreText(error)}}</p><p v-if="entry" role="status">{{entryStatus}}</p><footer><button class="button secondary" :disabled="knowledge.busy" @click="open=false">{{t("common.close")}}</button><button v-if="!entryId" class="button primary" :disabled="!confirmed||knowledge.busy" @click="upload">{{t("knowledge.confirmUpload")}}</button><span v-else>{{t("knowledge.manageHistoryHint")}}</span></footer></section></div></Teleport>
</template>
<style scoped>
.task-knowledge-upload{padding:8px 16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.task-knowledge-upload small,.error{color:var(--red)}.knowledge-overlay{position:fixed;inset:0;background:var(--scrim);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px}.knowledge-modal{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:24px;width:min(850px,100%);max-height:90vh;overflow:auto}.knowledge-modal header,.knowledge-modal footer{display:flex;justify-content:space-between;align-items:center;gap:12px}.knowledge-modal h2{font-size:18px}.knowledge-modal p,.knowledge-modal label,.knowledge-modal footer{font-size:12px;line-height:1.8}.knowledge-modal p{color:var(--muted);overflow-wrap:anywhere}.knowledge-modal pre{background:var(--bg);padding:16px;max-height:40vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.knowledge-modal footer{margin-top:16px}
.task-knowledge-upload {
  position: sticky;
  top: 0;
  z-index: 2;
  justify-content: flex-end;
  padding: 8px 0;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.task-knowledge-upload small {
  flex-basis: 100%;
  text-align: right;
  overflow-wrap: anywhere;
}
</style>
