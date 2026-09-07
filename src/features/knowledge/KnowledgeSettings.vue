<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Database, UploadCloud } from "lucide-vue-next";
import { useKnowledgeStore } from "./knowledgeStore";
import { isTauri } from "@/services/backend";

const knowledge=useKnowledgeStore();
knowledge.hydrate();
const draft=ref({...knowledge.config}), apiKey=ref(""), message=ref(""), error=ref("");
const working=ref(false);
async function run(fn:()=>Promise<void>|void) {
  working.value=true;error.value="";message.value="";
  try{await fn();}catch(e){error.value=e instanceof Error?e.message:String(e);}finally{working.value=false;}
}
async function save(){await knowledge.save(draft.value,apiKey.value);apiKey.value="";draft.value={...knowledge.config};message.value="知识设置已保存";}
async function test(){await save();const bases=await knowledge.testConnection();message.value=`连接成功，可访问 ${bases.length} 个知识库`;}
onMounted(()=>{error.value=knowledge.storageError;});
</script>
<template>
  <section class="settings-card knowledge-settings">
    <div class="settings-title"><Database :size="18"/><div><h2>知识服务与记录上传</h2><p>独立知识接口；模型地址和模型 Key 仍在模型管理中配置。</p></div></div>
    <p v-if="!isTauri()" class="knowledge-note">当前为浏览器预览。连接、Key 保存和真实上传需要桌面版。</p>
    <label>知识接口 base URL<input v-model="draft.endpoint" placeholder="http://127.0.0.1:8002/api/v1" autocomplete="off" :disabled="knowledge.busy||working"/></label>
    <label>知识 API Key<input v-model="apiKey" type="password" autocomplete="new-password" :placeholder="knowledge.config.hasApiKey?'已保存在系统钥匙串；留空保持不变':'填写知识 Key，不是模型 Key 或服务 Token'" :disabled="knowledge.busy||working"/></label>
    <div class="knowledge-actions"><button class="button secondary" :disabled="knowledge.busy||working" @click="run(test)">保存并测试连接</button><button class="button secondary" :disabled="knowledge.busy||working||!knowledge.config.hasApiKey" @click="run(async()=>{await knowledge.removeKey();draft={...knowledge.config};apiKey='';message='知识 Key 已从系统钥匙串移除';})">移除 Key</button></div>
    <label>目标知识库<select v-model="draft.knowledgeBaseId" :disabled="knowledge.busy||working"><option value="">先测试连接，再选择知识库</option><option v-if="draft.knowledgeBaseId&&!knowledge.bases.some(b=>b.id===draft.knowledgeBaseId)" :value="draft.knowledgeBaseId">已保存：{{draft.knowledgeBaseId}}</option><option v-for="base in knowledge.bases" :key="base.id" :value="base.id">{{base.name}}</option></select></label>
    <div class="generation-limit-head"><div><strong>启用任务记录上传</strong><small>仅允许手动预览后上传；关闭后暂停发送和状态查询，不会自动清空历史。</small></div><label class="toggle"><input v-model="draft.uploadEnabled" type="checkbox" :disabled="knowledge.busy||working"/><i></i></label></div>
    <div class="generation-limit-head"><div><strong>知识检索开关（预留）</strong><small>本次只保存偏好，尚未接入 Agent，不会自动检索或发送资料。</small></div><label class="toggle"><input v-model="draft.searchEnabled" type="checkbox" :disabled="knowledge.busy||working"/><i></i></label></div>
    <button class="button primary" :disabled="knowledge.busy||working" @click="run(save)">保存知识设置</button>
    <p class="knowledge-note">本机 HTTP 仅供调试；远程地址使用 HTTPS。测试连接不上传任务内容，需要 knowledge:read 权限。</p>
    <p v-if="message" role="status">{{message}}</p><p v-if="error" role="alert" class="knowledge-error">{{error}}</p>
    <div v-if="knowledge.entries.length" class="knowledge-history"><h3><UploadCloud :size="16"/> 上传历史</h3><p class="knowledge-note">只保留已预览的脱敏正文。重试使用相同正文和幂等 Key；移除本地记录不会删除服务端知识。</p><article v-for="entry in knowledge.entries" :key="entry.id"><strong>{{entry.title}}</strong><small>{{entry.createdAt}} · {{entry.status}} <span v-if="entry.remoteStatus">/ {{entry.remoteStatus}}</span></small><p v-if="entry.error" class="knowledge-error">{{entry.error}}</p><div class="knowledge-actions"><button v-if="entry.status!=='accepted'" class="button secondary" :disabled="knowledge.busy||working||!knowledge.config.uploadEnabled" @click="run(()=>knowledge.send(entry.id))">手动重试</button><button v-if="entry.recordId" class="button secondary" :disabled="knowledge.busy||working||!knowledge.config.uploadEnabled" @click="run(()=>knowledge.refreshStatus(entry.id))">刷新处理状态</button><button class="button secondary" :disabled="knowledge.busy||working" @click="run(()=>knowledge.forget(entry.id))">移除本地记录</button></div></article></div>
  </section>
</template>
<style scoped>
.knowledge-settings>label{display:grid;gap:8px;margin:16px 0;font-size:13px}.knowledge-settings input:not([type=checkbox]),.knowledge-settings select{width:100%;padding:9px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text)}.knowledge-actions{display:flex;gap:8px;flex-wrap:wrap}.knowledge-note{font-size:12px;color:var(--muted);line-height:1.7}.knowledge-error{color:var(--red);font-size:13px}.knowledge-history{margin-top:22px;border-top:1px solid var(--border)}.knowledge-history h3{display:flex;gap:8px;align-items:center}.knowledge-history article{padding:12px 0;border-top:1px solid var(--border-soft)}.knowledge-history small{display:block;color:var(--muted);font-size:11px;margin:6px 0}.generation-limit-head{margin:14px 0}.generation-limit-head small{max-width:520px}
</style>
