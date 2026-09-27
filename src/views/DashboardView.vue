<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { Boxes, Cpu, HardDrive, MemoryStick, Pencil, Plus, Search, Server, Trash2, X } from "lucide-vue-next";
import AddServerModal from "@/components/AddServerModal.vue";
import ConfirmActionDialog from "@/components/ConfirmActionDialog.vue";
import ParameterSelect from "@/components/ParameterSelect.vue";
import ExecutionLedgerRecoveryCard from "@/components/ExecutionLedgerRecoveryCard.vue";
import PreparedExecutionTargets from "@/components/PreparedExecutionTargets.vue";
import type { ExecutionLedgerRecoveryAction, ExecutionLedgerRecoveryItem } from "@/features/agent/executionLedgerRecovery";
import type { OpsTask } from "@/types";
import { useActionConfirmation } from "@/components/useActionConfirmation";
import { useAgentWorkspaceStore } from "@/features/agent/agentWorkspaceStore";
import { useOpsStore } from "@/stores/ops";

const store = useOpsStore();
const router = useRouter();
const agentWorkspaces = useAgentWorkspaceStore();
function openRecoveryTask(task: OpsTask) {
  store.selectTask(task.id);
  agentWorkspaces.updateServer(task.serverId, { activeTaskId: task.id, showTasks: false });
  void router.push(`/server/${task.serverId}`);
}
const { t, locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const query = ref("");
const group = ref("");
const groups = computed(() => [...new Set(store.servers.map(server => server.group).filter(Boolean))].sort());
const groupOptions = computed(() => [
  { value: "", label: zh.value ? "全部分组" : "All groups" },
  ...groups.value.map((item) => ({ value: item, label: item })),
]);
const visibleServers = computed(() => {
  const words = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return store.servers.filter(server => (!group.value || server.group === group.value)
    && words.every(word => `${server.name} ${server.host} ${server.username} ${server.group} ${server.info.os}`.toLocaleLowerCase().includes(word)));
});
const adding = ref(false);
const editingServerId = ref("");
const editingServer = computed(() => store.servers.find((server) => server.id === editingServerId.value));
const groupCount = computed(() => new Set(store.servers.map((server) => server.group).filter(Boolean)).size);
const hasAmount = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0;
const { confirmationMessage, confirmAction, resolveConfirmation } = useActionConfirmation();
const executionRecoveryTasks = computed(() => store.tasks.filter(task => task.executionLedgerRecovery?.items.length));
const executionRecoveryIssues = computed(() => [...new Set([store.taskCacheReadError, store.executionLedgerReadError].filter(Boolean))]);
function recoveryTargets(task: OpsTask) {
  const targets = task.plan.flatMap(step => step.executionIntent?.semantic.targets ?? []);
  return targets.filter((target, index) => targets.findIndex(other => JSON.stringify([other.role, other.host, other.port, other.username, other.path])
    === JSON.stringify([target.role, target.host, target.port, target.username, target.path])) === index);
}
async function handleExecutionRecovery(taskId: string, action: ExecutionLedgerRecoveryAction, item: ExecutionLedgerRecoveryItem) {
  if (action === "retry_storage") await store.retryExecutionLedgerStorage(taskId, item.attemptId);
  else if ((action === "reconcile" || action === "verify") && item.attemptId) await store.reconcileExecutionAttempt(taskId, item.attemptId);
}

async function removeServer(server: (typeof store.servers)[number]) {
  const message = zh.value
    ? `确定删除服务器“${server.name}”吗？该服务器的连接配置、保存的凭据和本地工作区数据将一并移除。`
    : `Delete server “${server.name}”? Its connection settings, saved credentials, and local workspace data will also be removed.`;
  if (!await confirmAction(message)) return;
  store.removeServer(server.id);
}

onMounted(async () => {
  await Promise.allSettled([store.restoreExecutionLedgerTasks(), store.hydrateCredentials()]);
  const incompleteServers = store.servers.filter((server) => (
    !hasAmount(server.info.memoryGb) || !hasAmount(server.info.diskGb)
  ) && Boolean(store.serverPasswords[server.id]));
  await Promise.allSettled(incompleteServers.map((server) => store.refreshServer(server.id)));
});
</script>

<template>
  <div class="page dashboard-page">
    <header class="page-header server-page-header">
      <div>
        <h1>{{ t("dashboard.title") }}</h1>
      </div>
      <button class="button primary" @click="adding = true"><Plus :size="16" />{{ t("dashboard.addServer") }}</button>
    </header>

    <div class="server-summary">
      <div><Server :size="17" /><span><strong>{{ store.servers.length }}</strong><small>{{ t("dashboard.totalServers") }}</small></span></div>
      <div><Boxes :size="17" /><span><strong>{{ groupCount }}</strong><small>{{ t("dashboard.totalGroups") }}</small></span></div>
      <div><Cpu :size="17" /><span><strong>{{ store.tasks.filter((task) => !['completed', 'cancelled', 'failed', 'planning_failed'].includes(task.status)).length }}</strong><small>{{ t("dashboard.activeTasks") }}</small></span></div>
    </div>

    <section v-if="executionRecoveryTasks.length || executionRecoveryIssues.length" class="dashboard-execution-recovery">
      <h2>{{ zh ? `${executionRecoveryTasks.length} 个任务需要处理` : `${executionRecoveryTasks.length} tasks need attention` }}</h2>
      <p v-for="issue in executionRecoveryIssues" :key="issue" class="evidence-warning" role="alert">{{ issue }}</p>
      <article v-for="task in executionRecoveryTasks" :key="task.id" class="dashboard-recovery-task" :data-recovery-task="task.id">
        <h3>{{ task.title }}</h3>
        <p>{{ zh ? `${task.executionLedgerRecovery?.items.length} 项待处理` : `${task.executionLedgerRecovery?.items.length} items need attention` }}</p>
        <button v-if="store.servers.some(server => server.id === task.serverId)" class="button secondary" type="button" @click="openRecoveryTask(task)">{{ zh ? '进入任务处理' : 'Open task' }}</button>
        <details class="dashboard-recovery-details">
          <summary>{{ zh ? '查看处理详情' : 'View details' }}</summary>
          <PreparedExecutionTargets :targets="recoveryTargets(task)" />
          <ExecutionLedgerRecoveryCard :task-id="task.id" :recovery="task.executionLedgerRecovery" @action="(action, item) => handleExecutionRecovery(task.id, action, item)" />
        </details>
      </article>
    </section>

    <section class="server-section">
      <div class="server-toolbar">
        <label class="server-search"><Search :size="15"/><input v-model="query" :aria-label="zh ? '搜索服务器' : 'Search servers'" :placeholder="zh ? '搜索名称、地址或系统…' : 'Search name, address or OS…'"/><button v-if="query" :aria-label="zh ? '清除搜索' : 'Clear search'" @click="query = ''"><X :size="14"/></button></label>
        <ParameterSelect v-model="group" class="server-group-filter" size="small" :options="groupOptions" :ariaLabel="zh ? '筛选分组' : 'Filter group'" />
        <span class="server-result-count" role="status">{{ t('dashboard.serverCount', { count: visibleServers.length }) }}</span>
      </div>
      <div class="server-grid">
        <article v-for="server in visibleServers" :key="server.id" class="server-card" tabindex="0" :aria-label="`${server.name} · ${t('dashboard.openWorkspace')}`" @keydown.enter.self="router.push(`/server/${server.id}`)" @click="router.push(`/server/${server.id}`)">
          <div class="server-card-top">
            <div class="server-symbol"><Server :size="21" /></div>
            <div class="server-card-heading">
              <h3>{{ server.name }}</h3>
            </div>
            <span class="server-group-tag">{{ server.group || t("dashboard.defaultGroup") }}</span>
          </div>
          <p class="server-endpoint" :title="`${server.username}@${server.host}:${server.port}`">{{ server.username }}@{{ server.host }}:{{ server.port }}</p>
          <div class="server-meta">
            <span class="server-os">{{ server.info.os || t("common.notSet") }}</span>
            <div class="server-resources">
              <span><Cpu :size="13" />{{ server.info.cores > 0 ? t("dashboard.cores", { count: server.info.cores }) : t("dashboard.cpuPending") }}</span>
              <span><MemoryStick :size="13" />{{ server.info.memoryGb > 0 ? t("dashboard.memory", { value: server.info.memoryGb }) : t("dashboard.memoryPending") }}</span>
              <span><HardDrive :size="13" />{{ server.info.diskGb > 0 ? t("dashboard.disk", { value: server.info.diskGb }) : t("dashboard.diskPending") }}</span>
            </div>
          </div>
          <div class="server-card-foot">
            <span>{{ t("dashboard.openWorkspace") }}</span>
            <button class="server-edit" :title="t('dashboard.editServer')" :aria-label="t('dashboard.editServer')" @click.stop="editingServerId = server.id"><Pencil :size="14" /></button>
            <button :title="t('dashboard.removeServer')" :aria-label="t('dashboard.removeServer')" @click.stop="removeServer(server)"><Trash2 :size="14" /></button>
          </div>
        </article>
        <button v-if="!store.servers.length" class="server-card add-card" @click="adding = true">
          <span><Plus :size="24" /></span><strong>{{ t("dashboard.addServer") }}</strong><small>{{ t("dashboard.addHint") }}</small>
        </button>
      </div>
      <div v-if="store.servers.length && !visibleServers.length" class="server-empty"><Search :size="24"/><p>{{ zh ? '没有匹配的服务器' : 'No matching servers' }}</p><button class="button secondary" @click="query = ''; group = ''">{{ zh ? '清除筛选' : 'Clear filters' }}</button></div>
    </section>
    <AddServerModal v-if="adding" @close="adding = false" />
    <AddServerModal v-if="editingServer" :server="editingServer" @close="editingServerId = ''" />
    <ConfirmActionDialog
      :message="confirmationMessage"
      :title="zh ? '删除服务器' : 'Delete server'"
      :confirm-label="zh ? '确认删除' : 'Delete'"
      @result="resolveConfirmation"
    />
  </div>
</template>

<style scoped>
.dashboard-execution-recovery{max-width:1320px;margin:0 auto 24px}.dashboard-execution-recovery h2{font-size:15px;margin:0 0 12px}.dashboard-recovery-task{padding:12px 0;border-top:1px solid var(--border-soft)}.dashboard-recovery-task h3{font-size:13px;margin:0 0 10px}.dashboard-execution-recovery>.evidence-warning{font-size:12px;line-height:1.6}
.dashboard-page{padding:20px 28px}.server-page-header{align-items:center;margin-bottom:12px;gap:16px}.server-page-header h1{font-size:22px;margin:0;line-height:1.4}.server-page-header>.button{width:auto;min-height:34px;font-size:12px}.server-summary{max-width:1320px;margin:0 auto 18px;display:flex;align-items:center;gap:24px;color:var(--muted);font-size:12px;flex-wrap:wrap}.server-summary>div,.server-summary span{display:flex;align-items:center;gap:8px}.server-summary strong{color:var(--text);font-size:13px;font-weight:600}.server-summary small{font-size:12px}.server-summary svg{width:14px;height:14px}.server-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px;padding-top:14px;border-top:1px solid var(--border-soft)}.server-search{display:flex;align-items:center;gap:8px;width:min(380px,100%);height:34px;padding:0 10px;border:1px solid var(--border);border-radius:7px;color:var(--muted);background:var(--panel)}.server-search:focus-within{border-color:var(--accent)}.server-search input{flex:1;min-width:0;background:transparent;border:0;outline:0;color:var(--text);font-size:12px}.server-search button{display:flex;background:none;border:0;color:var(--muted);padding:3px;cursor:pointer}.server-group-filter{width:min(200px,40vw);flex:0 1 200px}.server-result-count{margin-left:auto;white-space:nowrap;font-size:12px;color:var(--muted)}.server-card:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.server-empty{display:flex;flex-direction:column;align-items:center;gap:12px;padding:48px 16px;color:var(--muted);font-size:13px}.server-empty p{margin:0}@media(max-width:600px){.dashboard-page{padding:16px}.server-page-header{flex-wrap:nowrap}.server-page-header h1{font-size:20px}.server-summary{gap:12px;margin-bottom:12px}.server-toolbar{flex-wrap:wrap}.server-search{width:100%}.server-group-filter{width:auto;flex:1}.server-result-count{margin-left:auto}}
</style>
