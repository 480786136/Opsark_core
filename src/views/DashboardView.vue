<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { Activity, Cpu, MoreVertical, Plus, Server, Trash2 } from "lucide-vue-next";
import AddServerModal from "@/components/AddServerModal.vue";
import StatusDot from "@/components/StatusDot.vue";
import { useOpsStore } from "@/stores/ops";

const store = useOpsStore();
const router = useRouter();
const adding = ref(false);
</script>

<template>
  <div class="page dashboard-page">
    <header class="page-header">
      <div>
        <span class="eyebrow">INFRASTRUCTURE</span>
        <h1>服务器</h1>
        <p>连接、观察并通过智能任务安全地处理服务器需求。</p>
      </div>
      <button class="button primary" @click="adding = true"><Plus :size="16" />添加服务器</button>
    </header>

    <div class="summary-grid">
      <div><Server :size="17" /><span><strong>{{ store.servers.length }}</strong><small>服务器总数</small></span></div>
      <div><Activity :size="17" /><span><strong>{{ store.servers.filter((s) => s.status === 'online').length }}</strong><small>当前在线</small></span></div>
      <div><Cpu :size="17" /><span><strong>{{ store.tasks.filter((t) => !['completed', 'cancelled'].includes(t.status)).length }}</strong><small>进行中任务</small></span></div>
    </div>

    <section class="server-section">
      <div class="section-heading"><h2>全部服务器</h2><span>{{ store.servers.length }} 台</span></div>
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
            <span>{{ server.info.cores }} 核 · {{ server.info.memoryGb }} GB</span>
          </div>
          <div class="server-card-foot">
            <span>{{ server.group }}</span>
            <button title="删除" @click.stop="store.removeServer(server.id)"><Trash2 :size="14" /></button>
          </div>
        </article>
        <button class="server-card add-card" @click="adding = true">
          <span><Plus :size="24" /></span><strong>添加服务器</strong><small>SSH / 演示连接</small>
        </button>
      </div>
    </section>
    <AddServerModal v-if="adding" @close="adding = false" />
  </div>
</template>
