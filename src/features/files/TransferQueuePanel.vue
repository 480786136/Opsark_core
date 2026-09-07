<script setup lang="ts">
import { computed } from "vue";
import { ArrowDownToLine, ArrowUpFromLine, RotateCcw, Trash2, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useTransferQueueStore, type SftpTransferTask } from "./transferQueueStore";

const props = defineProps<{ serverId: string }>();
defineEmits<{ close: [] }>();
const { t } = useI18n();
const queue = useTransferQueueStore();
const tasks = computed(() => queue.tasks.filter(({ serverId }) => serverId === props.serverId));

function progress(task: SftpTransferTask) {
  if (!task.totalBytes) return task.status === "completed" ? 100 : 0;
  return Math.min(100, Math.round((task.transferredBytes / task.totalBytes) * 100));
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function detail(task: SftpTransferTask) {
  if (task.status === "running") {
    const eta = task.remainingSeconds === undefined ? "" : ` · ${Math.ceil(task.remainingSeconds)}s`;
    return `${formatBytes(task.speedBytesPerSecond)}/s${eta}`;
  }
  return t(`files.${task.status}`);
}
</script>

<template>
  <section class="transfer-queue-panel">
    <header>
      <div><strong>{{ t("files.transfers") }}</strong><small>{{ t("files.transferCount", { count: tasks.length }) }}</small></div>
      <span>
        <button type="button" :title="t('files.clearFinished')" @click="queue.clearFinished(serverId)"><Trash2 :size="13" /></button>
        <button type="button" :title="t('common.close')" @click="$emit('close')"><X :size="14" /></button>
      </span>
    </header>
    <div class="transfer-list">
      <div v-for="task in tasks" :key="task.id" class="transfer-row">
        <component :is="task.direction === 'upload' ? ArrowUpFromLine : ArrowDownToLine" :size="14" />
        <div class="transfer-main">
          <span><strong>{{ task.fileName }}</strong><small>{{ progress(task) }}%</small></span>
          <i><b :style="{ width: `${progress(task)}%` }" /></i>
          <small :title="task.error">{{ detail(task) }}</small>
        </div>
        <button v-if="task.status === 'queued' || task.status === 'running'" type="button" :title="t('files.cancelTransfer')" @click="queue.cancel(task.id)"><X :size="13" /></button>
        <button v-else-if="task.status === 'failed' || task.status === 'cancelled'" type="button" :title="t('files.retryTransfer')" @click="queue.retry(task.id)"><RotateCcw :size="13" /></button>
      </div>
    </div>
  </section>
</template>
