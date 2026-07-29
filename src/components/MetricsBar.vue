<script setup lang="ts">
import { ArrowDown, ArrowUp, Cpu, Database, HardDrive, MemoryStick } from "lucide-vue-next";
import { useOpsStore } from "@/stores/ops";

const store = useOpsStore();
</script>

<template>
  <footer class="metrics-bar">
    <div class="metric"><Cpu :size="14" /><span>CPU</span><strong>{{ store.metrics.cpu }}%</strong><i><b :style="{ width: `${store.metrics.cpu}%` }"></b></i></div>
    <div class="metric"><MemoryStick :size="14" /><span>内存</span><strong>{{ store.metrics.memory }}%</strong><i><b :style="{ width: `${store.metrics.memory}%` }"></b></i></div>
    <div class="metric"><HardDrive :size="14" /><span>磁盘</span><strong>{{ store.metrics.disk }}%</strong><i><b class="warn" :style="{ width: `${store.metrics.disk}%` }"></b></i></div>
    <div class="network-metric"><Database :size="14" /><span>网络</span><ArrowDown :size="12" /><strong>{{ store.metrics.networkIn }} MB/s</strong><ArrowUp :size="12" /><strong>{{ store.metrics.networkOut }} MB/s</strong></div>
    <div class="metrics-time"><span class="live-dot"></span>实时采集中 · {{ new Date(store.metrics.sampledAt).toLocaleTimeString("zh-CN", { hour12: false }) }}</div>
  </footer>
</template>
