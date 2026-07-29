<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronDown, ChevronRight, Search, ScrollText } from "lucide-vue-next";
import { useOpsStore } from "@/stores/ops";

const store = useOpsStore();
const query = ref("");
const category = ref("all");
const expandedLogs = ref<string[]>([]);
const filtered = computed(() => store.logs.filter((log) =>
  (category.value === "all" || log.category === category.value) &&
  (`${log.title} ${log.detail}`.toLowerCase().includes(query.value.toLowerCase()))
));

function toggleLog(id: string) {
  expandedLogs.value = expandedLogs.value.includes(id)
    ? expandedLogs.value.filter((item) => item !== id)
    : [...expandedLogs.value, id];
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div><span class="eyebrow">AUDIT TRAIL</span><h1>操作日志</h1><p>集中查看任务、模型请求、命令执行与系统事件。</p></div>
    </header>
    <div class="filter-bar">
      <label class="search-box"><Search :size="16" /><input v-model="query" placeholder="搜索日志…" /></label>
      <select v-model="category">
        <option value="all">全部类别</option><option value="task">任务</option><option value="model">模型</option><option value="command">命令</option><option value="system">系统</option>
      </select>
    </div>
    <section class="log-list">
      <article v-for="log in filtered" :key="log.id" :class="['log-row', { expanded: expandedLogs.includes(log.id) }]">
        <button class="log-row-summary" @click="toggleLog(log.id)">
          <span :class="['log-level', log.level]"></span>
          <span class="log-category">{{ log.category }}</span>
          <span class="log-primary"><strong>{{ log.title }}</strong><small>{{ log.detail.split('\n')[0] }}</small></span>
          <time>{{ new Date(log.createdAt).toLocaleString("zh-CN", { hour12: false }) }}</time>
          <ChevronDown v-if="expandedLogs.includes(log.id)" :size="16" />
          <ChevronRight v-else :size="16" />
        </button>
        <div v-if="expandedLogs.includes(log.id)" class="log-detail">
          <div class="log-detail-meta">
            <span v-if="log.serverId">服务器：{{ log.serverId }}</span>
            <span v-if="log.taskId">任务：{{ log.taskId }}</span>
          </div>
          <pre>{{ log.detail }}</pre>
        </div>
      </article>
      <div v-if="!filtered.length" class="empty-list"><ScrollText :size="28" /><strong>暂无日志</strong><span>执行任务或终端命令后，审计记录会显示在这里。</span></div>
    </section>
  </div>
</template>
