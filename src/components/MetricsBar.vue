<script setup lang="ts">
import { computed } from "vue";
import { ArrowDown, ArrowUp, Cpu, Database, HardDrive, MemoryStick } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";

const props = defineProps<{ serverId?: string }>();
const store = useOpsStore();
const { t, locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const state = computed(() => props.serverId ? store.metricState(props.serverId) : { sample: undefined, loading: false, stale: true, error: undefined });
const sample = computed(() => state.value.sample);
const connected = computed(() => Boolean(props.serverId && store.isServerConnected(props.serverId)));
const paused = computed(() => !connected.value || state.value.stale || Boolean(state.value.error));
const sampleTime = computed(() => {
  const date = sample.value?.sampledAt ? new Date(sample.value.sampledAt) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString(locale.value, { hour12: false }) : "";
});
const status = computed(() => {
  if (!sample.value) {
    if (!connected.value) return zh.value ? "尚未连接 · 无指标数据" : "Not connected · No metrics";
    if (state.value.error) return zh.value ? "采集失败 · 暂无数据" : "Collection failed · No data";
    return zh.value ? "等待指标采集" : "Waiting for metrics";
  }
  if (paused.value) return zh.value ? "采集已暂停" : "Collection paused";
  return t("metrics.collecting");
});

function percent(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) ? `${value}%` : "—";
}

function meter(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function formatNetworkRate(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const rate = Math.max(0, value);
  if (rate < 0.01) return `${(rate * 1024).toFixed(2)} KB/s`;
  return `${rate.toFixed(rate < 1 ? 3 : 2)} MB/s`;
}
</script>

<template>
  <footer :class="['metrics-bar', { 'metrics-paused': paused, 'metrics-empty': !sample }]" :data-server-id="serverId" :title="state.error">
    <div class="metric"><Cpu :size="14" /><span>CPU</span><strong>{{ percent(sample?.cpu) }}</strong><i aria-hidden="true"><b :style="{ width: `${meter(sample?.cpu)}%` }"></b></i></div>
    <div class="metric"><MemoryStick :size="14" /><span>{{ t("metrics.memory") }}</span><strong>{{ percent(sample?.memory) }}</strong><i aria-hidden="true"><b :style="{ width: `${meter(sample?.memory)}%` }"></b></i></div>
    <div class="metric"><HardDrive :size="14" /><span>{{ t("metrics.disk") }}</span><strong>{{ percent(sample?.disk) }}</strong><i aria-hidden="true"><b class="warn" :style="{ width: `${meter(sample?.disk)}%` }"></b></i></div>
    <div class="network-metric"><Database :size="14" /><span>{{ t("metrics.network") }}</span><ArrowDown :size="12" /><strong>{{ formatNetworkRate(sample?.networkIn) }}</strong><ArrowUp :size="12" /><strong>{{ formatNetworkRate(sample?.networkOut) }}</strong></div>
    <div class="metrics-time"><span class="live-dot" aria-hidden="true"></span><span role="status">{{ status }}</span><span v-if="sampleTime"> · {{ zh ? '最后更新于 ' : 'Updated ' }}{{ sampleTime }}</span><span v-if="sample && paused" class="metrics-stale">{{ zh ? '过期样本' : 'Stale sample' }}</span></div>
  </footer>
</template>

<style scoped>
.metrics-bar{font-variant-numeric:tabular-nums}.metrics-paused .metric strong,.metrics-paused .network-metric strong{color:var(--muted)}.metrics-paused .metric i b{background:var(--muted);opacity:.55}.metrics-paused .live-dot,.metrics-empty .live-dot{background:var(--muted)}.metrics-time{color:var(--muted)}.metrics-stale{margin-left:7px;padding-left:7px;border-left:1px solid var(--border);color:var(--orange)}
</style>
