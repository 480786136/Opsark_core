<script setup lang="ts">
import { computed, ref } from "vue";
import { UploadCloud, X } from "lucide-vue-next";
import type { OpsTask } from "@/types";
import { useOpsStore } from "@/stores/ops";
import { useKnowledgeStore } from "./knowledgeStore";
import { buildKnowledgeRecord, serializeRecord } from "./record";
import type { KnowledgeRecord, KnowledgeConfig } from "./types";
const props=defineProps<{task:OpsTask}>();
const ops=useOpsStore(),knowledge=useKnowledgeStore();knowledge.hydrate();
const open=ref(false),includeCommands=ref(false),preview=ref<KnowledgeRecord>(),previewBody=ref(""),error=ref(""),confirmed=ref(false),entryId=ref("");
const entry=computed(()=>knowledge.entries.find(e=>e.id===entryId.value));
const destination=ref<KnowledgeConfig>();
function prepare(){
  try{
    error.value="";confirmed.value=false;entryId.value="";
    if(!knowledge.config.uploadEnabled)throw new Error("请先在设置 → 知识服务中保存接口、Key、目标库并启用上传");
    const secretValues={...ops.getServerSecretValues(props.task.serverId)};
    const serverPassword=ops.serverPasswords[props.task.serverId];
    if(serverPassword)secretValues.__SERVER_PASSWORD__=serverPassword;
    const modelApiKey=ops.modelApiKeys[props.task.modelId];
    if(modelApiKey)secretValues.__MODEL_API_KEY__=modelApiKey;
    preview.value=buildKnowledgeRecord(props.task,knowledge.config.knowledgeBaseId,knowledge.nextRevision(props.task.id),{
      secretValues,redactIpAddresses:true,
    },includeCommands.value);
    if(!preview.value.steps.length)throw new Error("当前记录没有可上传的执行步骤，请选择已完成实际执行的任务记录。");
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
  <div class="task-knowledge-upload" role="group" aria-label="当前任务记录操作"><button type="button" class="button secondary" :disabled="knowledge.busy" @click="prepare"><UploadCloud :size="14"/>{{knowledge.busy?'正在上传…':'上传任务记录'}}</button><small v-if="error&&!open" role="alert">{{error}}</small></div>
  <Teleport to="body"><div v-if="open" class="knowledge-overlay" @keydown.esc="!knowledge.busy&&(open=false)"><section class="knowledge-modal" role="dialog" aria-modal="true" aria-label="任务记录上传预览"><header><h2>任务记录上传预览</h2><button class="button secondary" aria-label="关闭上传预览" :disabled="knowledge.busy" @click="open=false"><X :size="16"/></button></header><p>目标：{{destination?.endpoint}} · {{preview?.knowledge_base_id}}</p><p>将上传最近有效执行轮次的 {{preview?.steps.length ?? 0}} 个步骤，包含步骤说明、脱敏后的关键输出、独立校验证据及 Core 总结；不包含完整聊天、模型请求或凭据。长输出会节选，遗漏的历史与校验缺失会明确标注。</p><label><input v-model="includeCommands" type="checkbox" :disabled="!!entryId||knowledge.busy" @change="prepare"/> 附带执行命令（可选，上传前自动脱敏）</label><p>此选项只控制是否包含命令；勾选与否都会在上传前过滤敏感内容，知识服务接收后还会检查。请在确认前检查预览，自动过滤不能识别所有敏感信息。</p><pre tabindex="0">{{previewBody}}</pre><label v-if="!entryId"><input v-model="confirmed" type="checkbox"/> 我已检查以上内容和目标，确认可以上传；自动脱敏不能识别所有敏感信息。</label><p v-if="error" role="alert" class="error">{{error}}</p><p v-if="entry" role="status">{{entry.status==='accepted'?'服务已接收，等待后台整理审核；这不等于已发布知识。':entry.status==='failed'?entry.error:'正在上传…'}}</p><footer><button class="button secondary" :disabled="knowledge.busy" @click="open=false">关闭</button><button v-if="!entryId" class="button primary" :disabled="!confirmed||knowledge.busy" @click="upload">确认并上传</button><span v-else>后续重试和状态查询请到设置 → 上传历史。</span></footer></section></div></Teleport>
</template>
<style scoped>
.task-knowledge-upload{padding:8px 16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.task-knowledge-upload small,.error{color:var(--red)}.knowledge-overlay{position:fixed;inset:0;background:#0009;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px}.knowledge-modal{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:24px;width:min(850px,100%);max-height:90vh;overflow:auto}.knowledge-modal header,.knowledge-modal footer{display:flex;justify-content:space-between;align-items:center;gap:12px}.knowledge-modal h2{font-size:18px}.knowledge-modal p,.knowledge-modal label,.knowledge-modal footer{font-size:12px;line-height:1.8}.knowledge-modal p{color:var(--muted);overflow-wrap:anywhere}.knowledge-modal pre{background:var(--bg);padding:16px;max-height:40vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.knowledge-modal footer{margin-top:16px}
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
