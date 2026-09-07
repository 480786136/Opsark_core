<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { Boxes, Cpu, HardDrive, MemoryStick, Pencil, Plus, Server, Trash2 } from "lucide-vue-next";
import AddServerModal from "@/components/AddServerModal.vue";
import { useOpsStore } from "@/stores/ops";

const store = useOpsStore();
const router = useRouter();
const { t } = useI18n();
const adding = ref(false);
const editingServerId = ref("");
const editingServer = computed(() => store.servers.find((server) => server.id === editingServerId.value));
const groupCount = computed(() => new Set(store.servers.map((server) => server.group).filter(Boolean)).size);
const hasAmount = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0;

onMounted(async () => {
  await store.hydrateCredentials();
  const incompleteServers = store.servers.filter((server) => (
    !hasAmount(server.info.memoryGb) || !hasAmount(server.info.diskGb)
  ) && Boolean(store.serverPasswords[server.id]));
  await Promise.allSettled(incompleteServers.map((server) => store.refreshServer(server.id)));
});
</script>

<template>
  <div class="page dashboard-page">
    <header class="page-header">
      <div>
        <span class="eyebrow">INFRASTRUCTURE</span>
        <h1>{{ t("dashboard.title") }}</h1>
        <p>{{ t("dashboard.subtitle") }}</p>
      </div>
      <button class="button primary" @click="adding = true"><Plus :size="16" />{{ t("dashboard.addServer") }}</button>
    </header>

    <div class="summary-grid">
      <div><Server :size="17" /><span><strong>{{ store.servers.length }}</strong><small>{{ t("dashboard.totalServers") }}</small></span></div>
      <div><Boxes :size="17" /><span><strong>{{ groupCount }}</strong><small>{{ t("dashboard.totalGroups") }}</small></span></div>
      <div><Cpu :size="17" /><span><strong>{{ store.tasks.filter((task) => !['completed', 'cancelled'].includes(task.status)).length }}</strong><small>{{ t("dashboard.activeTasks") }}</small></span></div>
    </div>

    <section class="server-section">
      <div class="section-heading"><h2>{{ t("dashboard.allServers") }}</h2><span>{{ t("dashboard.serverCount", { count: store.servers.length }) }}</span></div>
      <div class="server-grid">
        <article v-for="server in store.servers" :key="server.id" class="server-card" @click="router.push(`/server/${server.id}`)">
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
            <button :title="t('dashboard.removeServer')" :aria-label="t('dashboard.removeServer')" @click.stop="store.removeServer(server.id)"><Trash2 :size="14" /></button>
          </div>
        </article>
        <button class="server-card add-card" @click="adding = true">
          <span><Plus :size="24" /></span><strong>{{ t("dashboard.addServer") }}</strong><small>{{ t("dashboard.addHint") }}</small>
        </button>
      </div>
    </section>
    <AddServerModal v-if="adding" @close="adding = false" />
    <AddServerModal v-if="editingServer" :server="editingServer" @close="editingServerId = ''" />
  </div>
</template>
