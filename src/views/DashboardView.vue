<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { Activity, Cpu, MoreVertical, Plus, Server, Trash2 } from "lucide-vue-next";
import AddServerModal from "@/components/AddServerModal.vue";
import StatusDot from "@/components/StatusDot.vue";
import { useOpsStore } from "@/stores/ops";

const store = useOpsStore();
const router = useRouter();
const { t } = useI18n();
const adding = ref(false);
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
      <div><Activity :size="17" /><span><strong>{{ store.servers.filter((s) => s.status === 'online').length }}</strong><small>{{ t("dashboard.onlineServers") }}</small></span></div>
      <div><Cpu :size="17" /><span><strong>{{ store.tasks.filter((task) => !['completed', 'cancelled'].includes(task.status)).length }}</strong><small>{{ t("dashboard.activeTasks") }}</small></span></div>
    </div>

    <section class="server-section">
      <div class="section-heading"><h2>{{ t("dashboard.allServers") }}</h2><span>{{ t("dashboard.serverCount", { count: store.servers.length }) }}</span></div>
      <div class="server-grid">
        <article v-for="server in store.servers" :key="server.id" class="server-card" @click="router.push(`/server/${server.id}`)">
          <div class="server-card-top">
            <div class="server-symbol"><Server :size="21" /></div>
            <StatusDot :status="server.status" />
            <button class="more-button" @click.stop><MoreVertical :size="17" /></button>
          </div>
          <h3>{{ server.name }}</h3>
          <p>{{ server.username }}@{{ server.host }}:{{ server.port }}</p>
          <div class="server-meta">
            <span>{{ server.info.os }}</span>
            <span>{{ t("dashboard.resources", { cores: server.info.cores, memory: server.info.memoryGb }) }}</span>
          </div>
          <div class="server-card-foot">
            <span>{{ server.group }}</span>
            <button :title="t('dashboard.removeServer')" @click.stop="store.removeServer(server.id)"><Trash2 :size="14" /></button>
          </div>
        </article>
        <button class="server-card add-card" @click="adding = true">
          <span><Plus :size="24" /></span><strong>{{ t("dashboard.addServer") }}</strong><small>{{ t("dashboard.addHint") }}</small>
        </button>
      </div>
    </section>
    <AddServerModal v-if="adding" @close="adding = false" />
  </div>
</template>
