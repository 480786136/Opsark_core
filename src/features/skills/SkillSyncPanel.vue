<script setup lang="ts">
import { computed, watch } from "vue";
import { useAccountStore } from "@/features/account/accountStore";
import { useSkillAutoSyncStore } from "./skillAutoSync";
import ConfirmActionDialog from "@/components/ConfirmActionDialog.vue";
import { useActionConfirmation } from "@/components/useActionConfirmation";
const account = useAccountStore(), sync = useSkillAutoSyncStore();
const owner = computed(() => account.current?.user.id);
const { confirmationMessage, confirmAction, resolveConfirmation } = useActionConfirmation();
watch(owner, () => resolveConfirmation(false));
async function resolve(id: string, choice: "local" | "cloud") {
  const userId = owner.value;
  const conflict = sync.conflicts.find(item => item.id === id);
  if (!conflict || !await confirmAction(`采用${choice === "local" ? "本地" : "云端"}版本？另一端的同名 Skill 将被替换；所选版本为删除时，两端都将删除。`)) return;
  if (owner.value !== userId || sync.conflicts.find(item => item.id === id) !== conflict) return;
  await sync.resolveConflict(id, choice);
}
</script>
<template>
  <ConfirmActionDialog :message="confirmationMessage" @result="resolveConfirmation" />
  <section v-if="sync.error || sync.conflicts.length" class="sync-panel" :aria-busy="sync.busy">
    <h2>{{ sync.conflicts.length ? '需要处理同步冲突' : '同步暂时不可用' }}</h2>
    <p v-if="sync.error" role="alert" class="sync-error">{{ sync.error }}</p>
    <div v-for="item in sync.conflicts" :key="item.id" class="conflict-row">
      <div><strong>{{ item.name }}</strong><small>云版本 {{ item.remote.revision }} · {{ item.remote.deleted ? '云端已删除' : '两端内容不同' }}</small></div>
      <button class="button secondary" :disabled="sync.busy" @click="resolve(item.id, 'local')">采用本地版本</button>
      <button class="button secondary" :disabled="sync.busy" @click="resolve(item.id, 'cloud')">采用云端版本</button>
    </div>
  </section>
</template>
<style scoped>
.sync-panel{padding:24px;border:1px solid var(--border);border-radius:12px;margin-top:22px;background:var(--panel)}
.conflict-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.sync-panel h2{font-size:18px}.sync-panel p{font-size:13px;line-height:1.8;color:var(--muted)}
.conflict-row{padding:14px 0;border-bottom:1px solid var(--border)}.conflict-row>div{flex:1;min-width:160px}
.conflict-row small{display:block;color:var(--muted);margin-top:6px}.sync-panel .sync-error{color:var(--red)}
</style>
