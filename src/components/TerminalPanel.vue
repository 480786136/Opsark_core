<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CircleStop, Copy, Trash2 } from "lucide-vue-next";
import { backend } from "@/services/backend";
import { useOpsStore } from "@/stores/ops";
import { sanitizeTerminalOutput } from "@/utils/terminal";

const props = defineProps<{ serverId: string }>();
const store = useOpsStore();
const command = ref("");
const output = ref<HTMLElement>();
const terminalId = `pty-${props.serverId}`;
const isLive = computed(() => store.connectedServerIds.includes(props.serverId));
const server = computed(() => store.servers.find((item) => item.id === props.serverId));
const terminalLabel = computed(() =>
  server.value ? `${server.value.username}@${server.value.host}` : "SSH",
);
let unlisten: (() => void) | undefined;
let remainder = "";
let pendingOutput = "";
let flushTimer: number | undefined;
const partialLine = ref("");

function appendChunk(chunk: string) {
  pendingOutput += chunk;
  if (flushTimer !== undefined) return;
  flushTimer = window.setTimeout(flushOutput, 50);
}

function flushOutput() {
  flushTimer = undefined;
  const cleaned = sanitizeTerminalOutput(pendingOutput);
  pendingOutput = "";
  const parts = `${remainder}${cleaned}`.split("\n");
  remainder = parts.pop() ?? "";
  partialLine.value = remainder;
  if (parts.length) {
    store.terminalLines.push(...parts);
    if (store.terminalLines.length > 2000) {
      store.terminalLines.splice(0, store.terminalLines.length - 2000);
    }
  }
  void nextTick().then(() => output.value?.scrollTo({ top: output.value.scrollHeight }));
}

async function startLiveTerminal() {
  const server = store.servers.find((item) => item.id === props.serverId);
  const password = store.serverPasswords[props.serverId];
  if (!server || !password) return;
  await backend.startTerminal(terminalId, {
    host: server.host,
    port: server.port,
    username: server.username,
    password,
  });
}

async function run() {
  const value = command.value.trimEnd();
  if (!value) return;
  command.value = "";
  if (isLive.value) {
    await backend.writeTerminal(terminalId, `${value}\n`);
  } else {
    await store.runTerminalCommand(value, props.serverId);
  }
  await nextTick();
  output.value?.scrollTo({ top: output.value.scrollHeight, behavior: "smooth" });
}

async function copyOutput() {
  const content = [...store.terminalLines, partialLine.value].filter(Boolean).join("\n");
  await navigator.clipboard.writeText(content);
}

function clearOutput() {
  store.terminalLines = [];
  remainder = "";
  pendingOutput = "";
  partialLine.value = "";
}

onMounted(async () => {
  unlisten = await backend.onTerminalOutput((event) => {
    if (event.terminalId === terminalId) appendChunk(event.data);
  });
  if (isLive.value) await startLiveTerminal();
});

watch(isLive, async (live) => {
  if (live) await startLiveTerminal();
  else await backend.closeTerminal(terminalId);
});

onBeforeUnmount(() => {
  if (flushTimer !== undefined) window.clearTimeout(flushTimer);
  if (pendingOutput) flushOutput();
  unlisten?.();
  void backend.closeTerminal(terminalId);
});
</script>

<template>
  <section class="work-panel terminal-panel">
    <header class="panel-header terminal-tabs">
      <div class="terminal-tab"><span class="terminal-led"></span> SSH · {{ terminalLabel }}</div>
      <div class="header-actions">
        <button v-if="isLive" title="发送 Ctrl+C" @click="backend.writeTerminal(terminalId, '\u0003')"><CircleStop :size="15" /></button>
        <button title="复制全部输出" @click="copyOutput"><Copy :size="15" /></button>
        <button title="清空终端显示" @click="clearOutput"><Trash2 :size="15" /></button>
      </div>
    </header>
    <div ref="output" class="terminal-output">
      <div v-for="(line, index) in store.terminalLines" :key="index" :class="{ prompt: line.includes('$ ') }">{{ line }}</div>
      <div v-if="partialLine" class="prompt">{{ partialLine }}</div>
      <form class="terminal-input-line" @submit.prevent="run">
        <span>{{ isLive ? "PTY ›" : `${terminalLabel}:~$` }}</span>
        <input v-model="command" autocomplete="off" spellcheck="false" :placeholder="isLive ? '交互式输入…' : '输入命令…'" />
      </form>
    </div>
  </section>
</template>
