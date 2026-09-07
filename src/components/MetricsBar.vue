<script setup lang="ts">
import { ArrowDown, ArrowUp, Cpu, Database, HardDrive, MemoryStick } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";

const store = useOpsStore();
const { t, locale } = useI18n();

function formatNetworkRate(value: number) {
  const rate = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (rate < 0.01) return `${(rate * 1024).toFixed(2)} KB/s`;
  return `${rate.toFixed(rate < 1 ? 3 : 2)} MB/s`;
}
</script>

<template>
  <footer class="metrics-bar">
    <div class="metric"><Cpu :size="14" /><span>CPU</span><strong>{{ store.metrics.cpu }}%</strong><i><b :style="{ width: `${store.metrics.cpu}%` }"></b></i></div>
    <div class="metric"><MemoryStick :size="14" /><span>{{ t("metrics.memory") }}</span><strong>{{ store.metrics.memory }}%</strong><i><b :style="{ width: `${store.metrics.memory}%` }"></b></i></div>
    <div class="metric"><HardDrive :size="14" /><span>{{ t("metrics.disk") }}</span><strong>{{ store.metrics.disk }}%</strong><i><b class="warn" :style="{ width: `${store.metrics.disk}%` }"></b></i></div>
    <div class="network-metric"><Database :size="14" /><span>{{ t("metrics.network") }}</span><ArrowDown :size="12" /><strong>{{ formatNetworkRate(store.metrics.networkIn) }}</strong><ArrowUp :size="12" /><strong>{{ formatNetworkRate(store.metrics.networkOut) }}</strong></div>
    <div class="metrics-time"><span class="live-dot"></span>{{ t("metrics.collecting") }} · {{ new Date(store.metrics.sampledAt).toLocaleTimeString(locale, { hour12: false }) }}</div>
  </footer>
</template>
