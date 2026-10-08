<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { listTaskArchives, taskListSummary, type TaskArchiveEntry } from "@/services/taskArchive";
import { useOpsStore } from "@/stores/ops";
import type { OpsTask } from "@/types";

const props = defineProps<{ serverId: string; query: string; activeTaskId?: string }>();
const emit = defineEmits<{ opened: [taskId: string]; count: [total: number] }>();
const store = useOpsStore();
const { locale, t } = useI18n();
const en = computed(() => locale.value.startsWith("en"));
const entries = ref<TaskArchiveEntry[]>([]);
const loading = ref(false), loadError = ref(""), openError = ref("");
const openingId = ref("");
const PAGE_SIZE = 20;
const limit = ref(PAGE_SIZE);
let generation = 0;
onBeforeUnmount(() => { generation += 1; });
const available = computed(() => {
  const rows = new Map<string, TaskArchiveEntry & { task?: OpsTask }>();
  for (const entry of entries.value) {
    if (entry.serverId === props.serverId && entry.disposition === "active") rows.set(entry.taskId, entry);
  }
  for (const task of store.tasks) {
    if (task.serverId === props.serverId) rows.set(task.id, { ...taskListSummary(task), task });
  }
  return [...rows.values()].sort((a, b) => (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0));
});
const matches = computed(() => available.value.filter(entry => entry.title.toLocaleLowerCase()
  .includes(props.query.trim().toLocaleLowerCase())));
watch(() => props.query, () => { limit.value = PAGE_SIZE; });
watch(() => available.value.length, count => emit("count", count), { immediate: true });
// A removed live task must not reappear from the already fetched directory.
watch(() => store.tasks.filter(task => task.serverId === props.serverId).map(task => task.id), (ids, previous) => {
  const removed = new Set(previous.filter(id => !ids.includes(id)));
  entries.value = entries.value.filter(entry => !removed.has(entry.taskId));
});

async function load() {
  const requestGeneration = ++generation;
  loading.value = true; loadError.value = "";
  try {
    const rows = await listTaskArchives();
    if (requestGeneration === generation) entries.value = rows;
  } catch (failure) { if (requestGeneration === generation) loadError.value = String(failure); }
  finally { if (requestGeneration === generation) loading.value = false; }
}
watch(() => props.serverId, () => {
  entries.value = []; limit.value = PAGE_SIZE; openingId.value = ""; openError.value = "";
  void load();
}, { immediate: true });
async function openTask(entry: TaskArchiveEntry) {
  if (openingId.value || entry.serverId !== props.serverId) return;
  const requestGeneration = generation;
  const serverId = props.serverId;
  openingId.value = entry.taskId; openError.value = "";
  try {
    const task = store.tasks.find(task => task.id === entry.taskId) ?? await store.openArchivedTask(entry.taskId);
    if (requestGeneration === generation && serverId === props.serverId && task.serverId === serverId) emit("opened", task.id);
  } catch (failure) { if (requestGeneration === generation) openError.value = String(failure); }
  finally { if (requestGeneration === generation) openingId.value = ""; }
}
</script>

<template>
  <div class="task-history-entries">
    <TransitionGroup name="task-list">
      <div v-for="entry in matches.slice(0, limit)" :key="entry.taskId"
        :class="['task-strip-item', entry.status, { active: entry.taskId === activeTaskId }]">
        <slot :entry="entry" :open-task="() => openTask(entry)" :busy="Boolean(openingId)">
          <button class="task-select" type="button" :title="entry.title" :disabled="Boolean(openingId)" @click="openTask(entry)">
            <span :class="['task-status-mini', entry.status]"></span><span><strong>{{ entry.title }}</strong></span>
          </button>
        </slot>
      </div>
    </TransitionGroup>
    <p v-if="loading" role="status">{{ en ? 'Loading…' : '读取中…' }}</p>
    <p v-if="loadError || openError" role="alert">{{ loadError || openError }}</p>
    <button v-if="loadError" class="new-task" type="button" :disabled="loading || Boolean(openingId)" @click="load">{{ en ? 'Retry' : '重新加载' }}</button>
    <div v-if="!loading && !loadError && !matches.length" class="task-strip-empty">
      {{ t(available.length ? 'agent.noMatchingTasks' : 'agent.emptyTitle') }}
    </div>
    <button v-if="matches.length > limit" class="new-task task-load-more" type="button" @click="limit += PAGE_SIZE">
      {{ en ? 'Load more' : '加载更多' }}
    </button>
  </div>
</template>

<style scoped>
.task-history-entries p { margin: 8px; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.task-history-entries [role="alert"] { color: var(--red); }
.task-select:disabled { cursor: wait; opacity: .6; }
.task-load-more { justify-content: center; }
</style>
