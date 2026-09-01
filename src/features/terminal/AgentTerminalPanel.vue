<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Copy, Search, Square } from "lucide-vue-next";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal, type IDisposable, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useOpsStore } from "@/stores/ops";
import { useAgentTerminalStore } from "./agentTerminalStore";
import { buildAgentTerminalTranscript, toXtermData } from "./agentTerminalTranscript";

const props = defineProps<{ taskId: string; active?: boolean }>();
const ops = useOpsStore();
const terminals = useAgentTerminalStore();
const search = ref("");
const following = ref(true);
const terminalHost = ref<HTMLElement>();
const task = computed(() => ops.tasks.find(({ id }) => id === props.taskId));
const session = computed(() => terminals.sessionsByTask[props.taskId]);
const target = computed(() => ops.servers.find(({ id }) => (
  id === (task.value?.executionTargetServerId ?? task.value?.serverId)
)));
const entries = computed(() => terminals.entriesByTask[props.taskId] ?? []);
const transcript = computed(() => buildAgentTerminalTranscript(entries.value));

let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let searchAddon: SearchAddon | undefined;
let resizeObserver: ResizeObserver | undefined;
let themeObserver: MutationObserver | undefined;
let scrollDisposable: IDisposable | undefined;
let renderedTranscript = "";

function readTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: color("--terminal-bg", "#0b0e11"),
    foreground: color("--terminal-text", "#c5cbd3"),
    cursor: color("--terminal-cursor", color("--accent", "#d8ff5f")),
    selectionBackground: color("--terminal-selection", "#394128"),
    black: color("--terminal-black", "#171b20"),
    red: color("--terminal-red", "#ff7b82"),
    green: color("--terminal-green", "#71db9b"),
    yellow: color("--terminal-yellow", "#eab866"),
    blue: color("--terminal-blue", "#77a9ff"),
    magenta: color("--terminal-magenta", "#c69cff"),
    cyan: color("--terminal-cyan", "#65d9e8"),
    white: color("--terminal-white", "#d9dde2"),
    brightBlack: color("--terminal-bright-black", "#6b7480"),
    brightRed: color("--terminal-bright-red", "#ff9ca1"),
    brightGreen: color("--terminal-bright-green", "#9ce8b7"),
    brightYellow: color("--terminal-bright-yellow", "#f3ca83"),
    brightBlue: color("--terminal-bright-blue", "#9abfff"),
    brightMagenta: color("--terminal-bright-magenta", "#d8bcff"),
    brightCyan: color("--terminal-bright-cyan", "#96e8f2"),
    brightWhite: color("--terminal-bright-white", "#f5f7f9"),
  };
}

function readTerminalFontFamily() {
  return getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim()
    || 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace';
}

function renderTranscript(next: string) {
  if (!terminal) return;
  if (next.startsWith(renderedTranscript)) {
    terminal.write(toXtermData(next.slice(renderedTranscript.length)));
  } else {
    terminal.reset();
    terminal.write(toXtermData(next));
  }
  renderedTranscript = next;
  if (following.value) terminal.scrollToBottom();
}

function searchNext() {
  const query = search.value.trim();
  if (query) searchAddon?.findNext(query, { incremental: true });
  else terminal?.clearSelection();
}

async function copyTranscript() {
  await navigator.clipboard?.writeText(transcript.value);
}

watch(transcript, renderTranscript, { flush: "post" });
watch(search, searchNext);
watch(() => props.active, async (active) => {
  if (!active) return;
  await nextTick();
  fitAddon?.fit();
  if (following.value) terminal?.scrollToBottom();
});

onMounted(() => {
  if (!terminalHost.value) return;
  terminal = new Terminal({
    convertEol: true,
    cursorBlink: false,
    cursorInactiveStyle: "none",
    disableStdin: true,
    fontFamily: readTerminalFontFamily(),
    fontSize: 12,
    scrollback: 8_000,
    theme: readTerminalTheme(),
  });
  fitAddon = new FitAddon();
  searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.open(terminalHost.value);
  renderTranscript(transcript.value);
  fitAddon.fit();
  scrollDisposable = terminal.onScroll(() => {
    const buffer = terminal?.buffer.active;
    following.value = Boolean(buffer && buffer.viewportY >= buffer.baseY);
  });
  resizeObserver = new ResizeObserver(() => {
    if (props.active) fitAddon?.fit();
  });
  resizeObserver.observe(terminalHost.value);
  themeObserver = new MutationObserver(() => {
    if (!terminal) return;
    terminal.options.theme = readTerminalTheme();
    terminal.options.fontFamily = readTerminalFontFamily();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
});

onBeforeUnmount(() => {
  scrollDisposable?.dispose();
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  terminal?.dispose();
});
</script>

<template>
  <section class="agent-terminal-panel" :aria-label="`任务 ${task?.title ?? taskId} 的 Agent 沙箱终端`">
    <header class="agent-terminal-toolbar">
      <strong>Agent 沙箱终端</strong>
      <span class="agent-terminal-isolation">只读显示 Agent 发往服务器的命令和服务器原始输出</span>
      <span v-if="target" class="agent-terminal-target">{{ target.username }}@{{ target.host }}:{{ target.port }}</span>
      <span v-if="session" class="agent-terminal-scope">{{ session.state }} · generation {{ session.generation }}</span>
      <label class="agent-terminal-search"><Search :size="13" /><input v-model="search" aria-label="搜索 Agent 终端" @keydown.enter.prevent="searchNext" /></label>
      <button type="button" title="复制全部 Agent 终端内容" @click="copyTranscript"><Copy :size="14" /></button>
      <button
        v-if="task && task.currentExecutionId"
        type="button"
        title="终止业务及当前 Agent 命令"
        @click="ops.terminateTask(task.id)"
      ><Square :size="13" /></button>
    </header>
    <div class="agent-terminal-screen">
      <div ref="terminalHost" class="agent-terminal-host" aria-label="Agent 服务器终端输入输出" />
      <span v-if="!transcript" class="agent-terminal-empty">等待 Agent 向服务器发送命令…</span>
    </div>
  </section>
</template>

<style scoped>
.agent-terminal-panel { display: flex; min-height: 0; height: 100%; flex-direction: column; background: var(--terminal-bg); color: var(--terminal-text); }
.agent-terminal-toolbar { display: flex; min-height: 34px; align-items: center; gap: 8px; padding: 0 9px; border-bottom: 1px solid var(--border); color: var(--muted); background: var(--chrome); font-size: 8px; }
.agent-terminal-toolbar strong { color: var(--text); font-size: 9px; }
.agent-terminal-isolation { color: var(--orange); }
.agent-terminal-target { color: var(--muted); font-family: var(--font-mono); }
.agent-terminal-scope { margin-left: auto; color: var(--dim); font-family: var(--font-mono); }
.agent-terminal-search { display: flex; height: 24px; align-items: center; gap: 4px; padding: 0 6px; border: 1px solid var(--border); border-radius: 3px; color: var(--dim); background: var(--terminal-bg); }
.agent-terminal-search input { width: 130px; border: 0; outline: 0; background: transparent; color: var(--terminal-text); font: 8px var(--font-mono); }
.agent-terminal-toolbar button { width: 24px; height: 24px; padding: 0; display: grid; place-items: center; border: 0; border-radius: 3px; background: transparent; color: var(--muted); cursor: pointer; }
.agent-terminal-toolbar button:hover { color: var(--accent); background: var(--hover); }
.agent-terminal-screen { position: relative; min-height: 0; flex: 1; overflow: hidden; background: var(--terminal-bg); }
.agent-terminal-host { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; background: var(--terminal-bg); }
.agent-terminal-host :deep(.xterm) { width: 100%; height: 100%; padding: 10px 8px 6px 12px; background: var(--terminal-bg); }
.agent-terminal-host :deep(.xterm-viewport) { overflow-y: auto !important; scrollbar-gutter: stable; background: var(--terminal-bg) !important; }
.agent-terminal-empty { position: absolute; top: 12px; left: 14px; color: var(--dim); font: 9px var(--font-mono); pointer-events: none; }
</style>
