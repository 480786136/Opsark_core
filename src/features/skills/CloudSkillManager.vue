<script setup lang="ts">
import { computed, watch } from "vue";
import { Cloud, Download, RefreshCw, Trash2, X } from "lucide-vue-next";
import { useSkillAutoSyncStore } from "./skillAutoSync";
import ConfirmActionDialog from "@/components/ConfirmActionDialog.vue";
import { useActionConfirmation } from "@/components/useActionConfirmation";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const sync = useSkillAutoSyncStore();
const { confirmationMessage, confirmAction, resolveConfirmation } = useActionConfirmation();
const activeSkills = computed(() => sync.cloudSkills.filter(skill => !skill.deleted));
watch(() => props.open, open => { if (open) void sync.refreshCloudSkills(); });
async function remove(id: string, name: string) {
  if (!await confirmAction(`确定删除云端 Skill“${name}”吗？云端将保留已删除记录。`)) return;
  await sync.deleteCloudSkill(id);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="cloud-skill-backdrop" @click.self="emit('close')">
      <aside class="cloud-skill-drawer" role="dialog" aria-modal="true" aria-label="云同步管理">
        <header><div><Cloud :size="18"/><span><strong>云同步管理</strong><small>管理当前账号的个人 Skill</small></span></div><button class="icon-button" aria-label="关闭" @click="emit('close')"><X :size="18"/></button></header>
        <div class="cloud-skill-toolbar"><button class="button primary" :disabled="sync.busy" @click="sync.syncNow"><RefreshCw :size="14" :class="{ spin: sync.busy }"/>一键同步</button><button class="button secondary" :disabled="sync.busy" @click="sync.refreshCloudSkills">刷新列表</button></div>
        <p class="cloud-skill-hint">按 Skill ID 和最后修改时间对齐：云端缺少的上传，本地缺少的下载，较新的版本更新到另一端。</p>
        <p v-if="sync.error" class="cloud-skill-error" role="alert">{{ sync.error }}</p>
        <div class="cloud-skill-list">
          <article v-for="item in activeSkills" :key="item.id"><div><strong>{{ item.content?.name || item.id }}</strong><code>{{ item.id }}</code><small>云端版本 {{ item.revision }} · {{ new Date(item.updated_at * 1000).toLocaleString() }}</small></div><button class="icon-button" :title="'下载到本地'" :disabled="sync.busy" @click="sync.downloadCloudSkill(item.id)"><Download :size="16"/></button><button class="icon-button danger" title="删除云端 Skill" :disabled="sync.busy" @click="remove(item.id, item.content?.name || item.id)"><Trash2 :size="16"/></button></article>
          <p v-if="!activeSkills.length && !sync.busy" class="cloud-skill-empty">云端暂无个人 Skill</p>
        </div>
      </aside>
    </div>
  </Teleport>
  <ConfirmActionDialog :message="confirmationMessage" title="删除云端 Skill" confirm-label="确认删除" @result="resolveConfirmation" />
</template>

<style scoped>
.cloud-skill-backdrop{position:fixed;inset:36px 0 0;z-index:1900;background:var(--scrim)}.cloud-skill-drawer{position:absolute;inset:0 0 0 auto;width:min(560px,100vw);display:flex;flex-direction:column;background:var(--panel);border-left:1px solid var(--border);box-shadow:var(--shadow-dialog)}.cloud-skill-drawer>header{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--border)}.cloud-skill-drawer>header>div,.cloud-skill-drawer>header span{display:flex;align-items:center;gap:10px}.cloud-skill-drawer>header span{align-items:flex-start;flex-direction:column;gap:3px}.cloud-skill-drawer header svg{color:var(--accent)}.cloud-skill-drawer header small{color:var(--muted);font-size:11px}.cloud-skill-toolbar{display:flex;gap:9px;padding:16px 20px 8px}.cloud-skill-hint,.cloud-skill-notice,.cloud-skill-error{margin:4px 20px 10px;font-size:12px;line-height:1.65;color:var(--muted)}.cloud-skill-notice{color:var(--green)}.cloud-skill-error{color:var(--red)}.cloud-skill-list{min-height:0;overflow:auto;padding:8px 20px 24px}.cloud-skill-list article{display:grid;grid-template-columns:minmax(0,1fr) 34px 34px;gap:8px;align-items:center;padding:14px 0;border-bottom:1px solid var(--border-soft)}.cloud-skill-list article>div{display:grid;gap:5px;min-width:0}.cloud-skill-list code,.cloud-skill-list small{overflow:hidden;text-overflow:ellipsis;color:var(--muted);font-size:10px}.cloud-skill-empty{text-align:center;color:var(--muted);padding:45px 0}.danger{color:var(--red)}.spin{animation:cloud-spin 1s linear infinite}@keyframes cloud-spin{to{transform:rotate(360deg)}}
</style>
