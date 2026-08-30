<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Copy, Search, Square } from "lucide-vue-next";
import { useOpsStore } from "@/stores/ops";
import { useAgentTerminalStore } from "./agentTerminalStore";

const props = defineProps<{ taskId: string; active?: boolean }>();
const ops = useOpsStore();
const terminals = useAgentTerminalStore();
const search = ref("");
const following = ref(true);
const viewport = ref<HTMLElement>();
const task = computed(() => ops.tasks.find(({ id }) => id === props.taskId));
const session = computed(() => terminals.sessionsByTask[props.taskId]);
const target = computed(() => ops.servers.find(({ id }) => (
  id === (task.value?.executionTargetServerId ?? task.value?.serverId)
)));
const entries = computed(() => terminals.entriesByTask[props.taskId] ?? []);
const visibleEntries = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return query ? entries.value.filter(({ text }) => text.toLocaleLowerCase().includes(query)) : entries.value;
});
const transcript = computed(() => entries.value.map(({ text }) => text).join("\n"));

watch(() => entries.value.map(({ id, text }) => `${id}:${text.length}`).join(","), async () => {
  if (!following.value) return;
  await nextTick();
  viewport.value?.scrollTo({ top: viewport.value.scrollHeight });
});

async function copyTranscript() {
  await navigator.clipboard?.writeText(transcript.value);
}
</script>

<template>
  <section class="agent-terminal-panel" :aria-label="`任务 ${task?.title ?? taskId} 的 Agent 沙箱终端`">
    <header class="agent-terminal-toolbar">
      <strong>Agent 沙箱终端</strong>
      <span class="agent-terminal-isolation">会话隔离，主机变更真实生效</span>
      <span v-if="target" class="agent-terminal-target">{{ target.username }}@{{ target.host }}:{{ target.port }}</span>
      <span v-if="session" class="agent-terminal-scope">{{ session.state }} · generation {{ session.generation }}</span>
      <label class="agent-terminal-search"><Search :size="13" /><input v-model="search" aria-label="搜索 Agent 输出" /></label>
      <button type="button" title="复制全部 Agent 输出" @click="copyTranscript"><Copy :size="14" /></button>
      <button
        v-if="task && task.currentExecutionId"
        type="button"
        title="终止业务及当前 Agent 命令"
        @click="ops.terminateTask(task.id)"
      ><Square :size="13" /></button>
    </header>
    <div ref="viewport" class="agent-terminal-viewport" @scroll="following = Boolean(viewport && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 8)">
      <div v-if="!visibleEntries.length" class="agent-terminal-empty">尚无 Agent 执行输出</div>
      <article v-for="entry in visibleEntries" :key="entry.id" :class="['agent-terminal-entry', `kind-${entry.kind}`]">
        <div class="agent-terminal-entry-meta">
          <span>{{ entry.kind === 'validation' ? 'Agent 验证' : entry.kind === 'command' ? 'Agent' : entry.kind }}</span>
          <span v-if="entry.scope">{{ entry.scope }}</span>
          <span v-if="entry.exitCode !== undefined">exit {{ entry.exitCode }}</span>
        </div>
        <pre>{{ entry.text }}</pre>
      </article>
    </div>
  </section>
</template>

<style scoped>
.agent-terminal-panel { display: flex; min-height: 0; height: 100%; flex-direction: column; background: var(--terminal-bg, #111315); color: #d8dee9; }
.agent-terminal-toolbar { display: flex; min-height: 34px; align-items: center; gap: 8px; padding: 0 9px; border-bottom: 1px solid rgba(255,255,255,.1); font-size: 12px; }
.agent-terminal-isolation { color: #f0b45b; }
.agent-terminal-target { color: #9db4ca; }
.agent-terminal-scope { margin-left: auto; color: #8995a5; }
.agent-terminal-search { display: flex; align-items: center; gap: 4px; }
.agent-terminal-search input { width: 130px; border: 1px solid rgba(255,255,255,.16); background: #1b1f24; color: inherit; }
.agent-terminal-toolbar button { display: grid; place-items: center; border: 0; background: transparent; color: inherit; cursor: pointer; }
.agent-terminal-viewport { min-height: 0; flex: 1; overflow: auto; padding: 9px 11px; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
.agent-terminal-entry { margin: 0 0 10px; }
.agent-terminal-entry-meta { display: flex; gap: 8px; color: #6fd3df; font-size: 11px; }
.agent-terminal-entry pre { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: inherit; }
.kind-system pre, .agent-terminal-empty { color: #8995a5; }
.kind-validation .agent-terminal-entry-meta { color: #8bd49c; }
</style>
