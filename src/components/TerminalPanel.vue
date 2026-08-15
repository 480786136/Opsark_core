<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  Bot,
  CircleStop,
  Copy,
  FolderSync,
  History,
  Ellipsis,
  Maximize2,
  RefreshCw,
  Search,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type IDisposable, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { appendTranscriptChunk, type TerminalTranscriptState } from "@/features/terminal/terminalTranscript";
import {
  analyzeTerminalPaste,
  appendTerminalHistory,
  isRecognizedShellPrompt,
  matchesTerminalShortcut,
  updateCommandDraft,
  type TerminalCommandDraft,
  type TerminalPasteAnalysis,
} from "@/features/terminal/terminalInput";
import {
  MAX_TERMINAL_RECONNECT_ATTEMPTS,
  reconnectDelay,
  shouldHandleTerminalGeneration,
} from "@/features/terminal/terminalReconnect";
import { backend, type TerminalStatusEvent } from "@/services/backend";
import { usePreferenceStore } from "@/features/preferences/preferenceStore";
import { useOpsStore } from "@/stores/ops";
import type { TerminalPaneStatus } from "@/features/terminal/terminalSessionStore";
import { useTerminalSessionStore } from "@/features/terminal/terminalSessionStore";
import { sanitizeTerminalOutput } from "@/utils/terminal";
import {
  buildTerminalChangeDirectoryCommand,
  buildTerminalDirectoryProbeCommand,
  extractOsc7Directories,
  useWorkspaceLinkStore,
} from "@/features/workspace/workspaceLinkStore";

const props = defineProps<{
  serverId: string;
  sessionId: string;
  active: boolean;
  agentTaskId?: string;
}>();
const emit = defineEmits<{
  activate: [];
  statusChange: [status: TerminalPaneStatus];
}>();
const store = useOpsStore();
const preferences = usePreferenceStore();
const workspaceLinks = useWorkspaceLinkStore();
const terminalSessions = useTerminalSessionStore();
const { t } = useI18n();
const terminalHost = ref<HTMLElement>();
const searchInput = ref<HTMLInputElement>();
const searchVisible = ref(false);
const historyVisible = ref(false);
const toolsMenuOpen = ref(false);
const showAgentOutput = ref(false);
const agentOutput = ref("");
const agentOutputHost = ref<HTMLElement>();
const historyQuery = ref("");
const commandHistory = ref<string[]>([]);
const pendingPaste = ref<{ data: string; analysis: TerminalPasteAnalysis }>();
const statusMessage = ref("");
const pendingSftpSync = ref(false);
const connectionState = ref<"demo" | "connecting" | "connected" | "disconnected" | "error" | "reconnecting">(
  store.connectedServerIds.includes(props.serverId) ? "connecting" : "demo",
);
const terminalId = `pty-${props.serverId}-${props.sessionId}`;
const isLive = computed(() => store.connectedServerIds.includes(props.serverId));
const server = computed(() => store.servers.find((item) => item.id === props.serverId));
const terminalLabel = computed(() =>
  server.value ? `${server.value.username}@${server.value.host}` : "SSH",
);
const agentTask = computed(() => store.tasks.find(({ id }) => id === props.agentTaskId));
const agentBusy = computed(() => Boolean(
  agentTask.value && ["planning", "running", "validating"].includes(agentTask.value.status),
));
const filteredHistory = computed(() => {
  const query = historyQuery.value.trim().toLocaleLowerCase();
  return [...commandHistory.value]
    .reverse()
    .filter((command) => !query || command.toLocaleLowerCase().includes(query));
});

let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let searchAddon: SearchAddon | undefined;
let outputUnlisten: (() => void) | undefined;
let statusUnlisten: (() => void) | undefined;
let resizeObserver: ResizeObserver | undefined;
let themeObserver: MutationObserver | undefined;
let inputDisposable: IDisposable | undefined;
let transcript: TerminalTranscriptState = { lines: [], remainder: "" };
let demoCommand = "";
let resizeTimer: number | undefined;
let reconnectTimer: number | undefined;
let activeGeneration: number | undefined;
let reconnectAttempts = 0;
let pendingStatusEvent: TerminalStatusEvent | undefined;
let commandDraft: TerminalCommandDraft = { value: "", recordable: false };
let osc7Buffer = "";

function readTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: color("--terminal-bg", "#0b0e11"),
    foreground: color("--terminal-text", "#c5cbd3"),
    cursor: color("--terminal-cursor", color("--accent", "#d8ff5f")),
    cursorAccent: color("--terminal-bg", "#0b0e11"),
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

function currentTerminalLine() {
  if (!terminal) return "";
  const buffer = terminal.buffer.active;
  return buffer.getLine(buffer.cursorY)?.translateToString(true) ?? "";
}

function trackCommandInput(data: string) {
  if (!commandDraft.value && !commandDraft.recordable) {
    commandDraft.recordable = connectionState.value === "demo" || isRecognizedShellPrompt(currentTerminalLine());
  }
  const result = updateCommandDraft(commandDraft, data);
  commandDraft = result.state;
  if (result.submitted !== undefined) {
    if (commandDraft.recordable) commandHistory.value = appendTerminalHistory(commandHistory.value, result.submitted);
    commandDraft = { value: "", recordable: false };
  }
}

/** 所有终端输入统一经过此边界，确认前不会写入远端 PTY。 */
function writeTerminalInput(data: string, confirmed = false) {
  if (agentBusy.value) return;
  const analysis = analyzeTerminalPaste(data);
  if (!confirmed && analysis.requiresConfirmation) {
    pendingPaste.value = { data, analysis };
    return;
  }
  trackCommandInput(data);
  if (connectionState.value === "connected") void backend.writeTerminal(terminalId, data);
  else if (connectionState.value === "demo") handleDemoInput(data);
}

function confirmPaste() {
  if (!pendingPaste.value) return;
  const data = pendingPaste.value.data;
  pendingPaste.value = undefined;
  writeTerminalInput(data, true);
  terminal?.focus();
}

function cancelPaste() {
  pendingPaste.value = undefined;
  terminal?.focus();
}

function toggleHistory() {
  historyVisible.value = !historyVisible.value;
  if (historyVisible.value) searchVisible.value = false;
}

function reuseHistory(command: string) {
  historyVisible.value = false;
  terminal?.paste(command);
  terminal?.focus();
}

function updateTranscript(chunk: string) {
  transcript = appendTranscriptChunk(transcript, chunk);
  if (props.active) syncActiveTranscript();
}

function trackTerminalDirectory(chunk: string) {
  osc7Buffer = `${osc7Buffer}${chunk}`.slice(-4_096);
  const directories = extractOsc7Directories(osc7Buffer);
  const directory = directories[directories.length - 1];
  if (!directory) return;
  osc7Buffer = "";
  workspaceLinks.publishPaneDirectory(props.sessionId, directory);
  if (pendingSftpSync.value) {
    pendingSftpSync.value = false;
    workspaceLinks.requestSftpPath(props.serverId, directory);
  }
}

function syncSftpDirectory() {
  if (connectionState.value !== "connected") return;
  const directory = workspaceLinks.paneDirectories[props.sessionId];
  if (directory) {
    workspaceLinks.requestSftpPath(props.serverId, directory);
    return;
  }
  pendingSftpSync.value = true;
  writeTerminalInput(buildTerminalDirectoryProbeCommand(), true);
}

/** 模型只读取当前聚焦分屏的脱敏转录，后台分屏输出不会覆盖上下文。 */
function syncActiveTranscript() {
  store.terminalLines = transcript.remainder
    ? [...transcript.lines, transcript.remainder]
    : [...transcript.lines];
}

async function startLiveTerminal() {
  const connection = store.getRuntimeConnection(props.serverId);
  if (!connection) return;
  statusMessage.value = "";
  connectionState.value = "connecting";
  activeGeneration = undefined;
  try {
    activeGeneration = await backend.startTerminal(terminalId, connection);
    if (pendingStatusEvent && shouldHandleTerminalGeneration(activeGeneration, pendingStatusEvent.generation)) {
      handleTerminalStatus(pendingStatusEvent);
    }
    pendingStatusEvent = undefined;
    scheduleFit();
  } catch (error) {
    statusMessage.value = String(error);
    terminal?.writeln(`\r\n\u001b[31m${String(error)}\u001b[0m`);
  }
}

function handleTerminalStatus(event: TerminalStatusEvent) {
  if (event.status === "connected") {
    clearReconnectTimer();
    reconnectAttempts = 0;
    connectionState.value = "connected";
    statusMessage.value = "";
    scheduleFit();
    return;
  }
  if (event.status === "connecting") {
    connectionState.value = "connecting";
    return;
  }
  connectionState.value = event.status;
  statusMessage.value = event.reason ?? t("terminal.disconnected");
  if (event.retryable && isLive.value) scheduleReconnect();
}

function clearReconnectTimer() {
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}

function scheduleReconnect() {
  clearReconnectTimer();
  const attempt = reconnectAttempts + 1;
  const delay = reconnectDelay(attempt);
  if (delay === undefined) {
    connectionState.value = "error";
    statusMessage.value = t("terminal.reconnectExhausted");
    return;
  }
  reconnectAttempts = attempt;
  connectionState.value = "reconnecting";
  statusMessage.value = t("terminal.reconnecting", {
    seconds: delay / 1_000,
    attempt,
    max: MAX_TERMINAL_RECONNECT_ATTEMPTS,
  });
  reconnectTimer = window.setTimeout(() => void startLiveTerminal(), delay);
}

function scheduleFit() {
  if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (!terminal || !fitAddon || !terminalHost.value?.clientWidth) return;
    fitAddon.fit();
    if (connectionState.value === "connected" && terminal.cols > 0 && terminal.rows > 0) {
      void backend.resizeTerminal(terminalId, terminal.cols, terminal.rows);
    }
  }, 60);
}

async function reconnect() {
  if (!isLive.value) return;
  clearReconnectTimer();
  reconnectAttempts = 0;
  activeGeneration = undefined;
  await backend.closeTerminal(terminalId);
  terminal?.clear();
  await startLiveTerminal();
  terminal?.focus();
}

function writeDemoPrompt() {
  terminal?.write(`\r\n\u001b[36m${terminalLabel.value}:~$\u001b[0m `);
}

async function runDemoCommand(command: string) {
  const before = store.terminalLines.length;
  await store.runTerminalCommand(command, props.serverId);
  const appended = store.terminalLines.slice(before);
  const output = appended[0]?.includes(command) ? appended.slice(1) : appended;
  output.forEach((line) => terminal?.writeln(line.replace(/\r?\n/g, "")));
  transcript = { lines: [...store.terminalLines], remainder: "" };
}

function handleDemoInput(data: string) {
  for (const character of data) {
    if (character === "\r") {
      const command = demoCommand.trimEnd();
      demoCommand = "";
      terminal?.write("\r\n");
      if (command) void runDemoCommand(command).finally(writeDemoPrompt);
      else writeDemoPrompt();
    } else if (character === "\u007f") {
      if (!demoCommand) continue;
      demoCommand = demoCommand.slice(0, -1);
      terminal?.write("\b \b");
    } else if (character === "\u0003") {
      demoCommand = "";
      terminal?.write("^C");
      writeDemoPrompt();
    } else if (character >= " " && character !== "\u007f") {
      demoCommand += character;
      terminal?.write(character);
    }
  }
}

function toggleSearch() {
  searchVisible.value = !searchVisible.value;
  if (searchVisible.value) historyVisible.value = false;
  if (searchVisible.value) void nextTick(() => searchInput.value?.focus());
}

function find(event?: KeyboardEvent) {
  const query = searchInput.value?.value ?? "";
  if (!query) return;
  if (event?.shiftKey) searchAddon?.findPrevious(query);
  else searchAddon?.findNext(query);
}

async function copySelection() {
  const selected = terminal?.getSelection();
  if (!selected) {
    statusMessage.value = t("terminal.noSelection");
    return;
  }
  await navigator.clipboard.writeText(selected);
  statusMessage.value = t("terminal.copied");
  window.setTimeout(() => (statusMessage.value = ""), 1_500);
}

function interrupt() {
  commandDraft = { value: "", recordable: false };
  if (connectionState.value === "connected") void backend.writeTerminal(terminalId, "\u0003");
  else if (connectionState.value === "demo") handleDemoInput("\u0003");
  terminal?.focus();
}

function clearTerminal() {
  if (showAgentOutput.value) {
    agentOutput.value = "";
    return;
  }
  terminal?.clear();
  transcript = { lines: [], remainder: "" };
  if (props.active) store.terminalLines = [];
  terminal?.focus();
}

function formatTaskHistory() {
  const task = agentTask.value;
  if (!task) return "";
  const records = task.messages
    .filter(({ kind }) => kind === "event" || kind === "summary")
    .map(({ createdAt, content }) => {
      const time = new Date(createdAt).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      return `[${time}] ${content}`;
    });
  const steps = task.plan.flatMap(({ command, output }) => output
    ? [`$ ${command}`, output]
    : []);
  return [...records, ...steps].join("\n");
}

/** Agent 输出显示在任务发起终端的只读视图，不写入真实 PTY。 */
function flushAgentOutput() {
  const queue = terminalSessions.agentOutputByPane[props.sessionId] ?? [];
  if (!queue.length) return;
  agentOutput.value = `${agentOutput.value}${sanitizeTerminalOutput(queue.map(({ data }) => data).join(""))}`
    .slice(-120_000);
  terminalSessions.consumeAgentOutput(props.sessionId, queue[queue.length - 1].id);
  showAgentOutput.value = true;
  void nextTick(() => agentOutputHost.value?.scrollTo({ top: agentOutputHost.value.scrollHeight }));
}

function toggleAgentOutput() {
  if (agentBusy.value) return;
  showAgentOutput.value = !showAgentOutput.value;
  toolsMenuOpen.value = false;
  if (!showAgentOutput.value) void nextTick(() => terminal?.focus());
}

onMounted(async () => {
  terminal = new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
    fontSize: preferences.terminalFontSize,
    lineHeight: preferences.terminalLineHeight,
    scrollback: 10_000,
    theme: readTerminalTheme(),
  });
  fitAddon = new FitAddon();
  searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.open(terminalHost.value!);
  if (props.agentTaskId) {
    agentOutput.value = formatTaskHistory();
    showAgentOutput.value = agentBusy.value || Boolean(agentOutput.value);
  }
  flushAgentOutput();
  terminal.attachCustomKeyEventHandler((event) => {
    if (agentBusy.value) return false;
    if (matchesTerminalShortcut(event, "find", preferences.terminalShortcutPreset)) {
      toggleSearch();
      return false;
    }
    if (matchesTerminalShortcut(event, "history", preferences.terminalShortcutPreset)) {
      toggleHistory();
      return false;
    }
    if (matchesTerminalShortcut(event, "copy", preferences.terminalShortcutPreset)) {
      void copySelection();
      return false;
    }
    if (matchesTerminalShortcut(event, "clear", preferences.terminalShortcutPreset)) {
      clearTerminal();
      return false;
    }
    return true;
  });
  inputDisposable = terminal.onData((data) => writeTerminalInput(data));
  outputUnlisten = await backend.onTerminalOutput((event) => {
    if (event.terminalId !== terminalId) return;
    terminal?.write(event.data);
    trackTerminalDirectory(event.data);
    updateTranscript(event.data);
  });
  statusUnlisten = await backend.onTerminalStatus((event) => {
    if (event.terminalId !== terminalId) return;
    if (activeGeneration === undefined) {
      pendingStatusEvent = event;
      return;
    }
    if (shouldHandleTerminalGeneration(activeGeneration, event.generation)) handleTerminalStatus(event);
  });

  resizeObserver = new ResizeObserver(scheduleFit);
  resizeObserver.observe(terminalHost.value!);
  themeObserver = new MutationObserver(() => {
    if (terminal) terminal.options.theme = readTerminalTheme();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-accent", "data-terminal-theme"] });

  if (isLive.value) await startLiveTerminal();
  else {
    terminal.writeln(`\u001b[1m${t("terminal.demoWelcome")}\u001b[0m`);
    terminal.write(`\u001b[36m${terminalLabel.value}:~$\u001b[0m `);
  }
  scheduleFit();
  if (props.active) {
    syncActiveTranscript();
    if (!agentBusy.value && !showAgentOutput.value) terminal.focus();
  }
});

watch(isLive, async (live) => {
  if (live) await startLiveTerminal();
  else {
    clearReconnectTimer();
    activeGeneration = undefined;
    connectionState.value = "demo";
    await backend.closeTerminal(terminalId);
  }
});

watch(() => props.active, (active) => {
  if (!active) return;
  syncActiveTranscript();
  scheduleFit();
  if (!agentBusy.value && !showAgentOutput.value) void nextTick(() => terminal?.focus());
});

watch(
  () => (terminalSessions.agentOutputByPane[props.sessionId] ?? []).map(({ id }) => id),
  flushAgentOutput,
);

watch(agentBusy, (busy) => {
  if (busy) showAgentOutput.value = true;
});

watch(() => props.agentTaskId, () => {
  agentOutput.value = formatTaskHistory();
  showAgentOutput.value = Boolean(props.agentTaskId);
  flushAgentOutput();
});

watch(connectionState, (status) => emit("statusChange", status), { immediate: true });

watch(
  [
    () => workspaceLinks.terminalPathRequests[props.serverId],
    () => props.active,
    isLive,
    connectionState,
  ],
  ([request, active, live, status]) => {
    if (!request || !active || !live || status !== "connected" || agentBusy.value) return;
    writeTerminalInput(buildTerminalChangeDirectoryCommand(request.path), true);
    workspaceLinks.consumeTerminalPath(props.serverId, request.id);
  },
  { immediate: true },
);

watch(
  () => [preferences.terminalFontSize, preferences.terminalLineHeight],
  () => {
    if (!terminal) return;
    terminal.options.fontSize = preferences.terminalFontSize;
    terminal.options.lineHeight = preferences.terminalLineHeight;
    scheduleFit();
  },
);

onBeforeUnmount(() => {
  if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
  clearReconnectTimer();
  activeGeneration = undefined;
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  inputDisposable?.dispose();
  outputUnlisten?.();
  statusUnlisten?.();
  terminal?.dispose();
  workspaceLinks.removePane(props.sessionId);
  void backend.closeTerminal(terminalId);
});
</script>

<template>
  <section :class="['terminal-session-panel', { active: props.active }]" @pointerdown.capture="emit('activate')">
    <div class="terminal-pane-tools">
      <button
        type="button"
        class="terminal-pane-tools-trigger"
        :class="{ active: toolsMenuOpen }"
        :title="t('terminal.moreActions')"
        :aria-expanded="toolsMenuOpen"
        @click.stop="toolsMenuOpen = !toolsMenuOpen"
      ><Ellipsis :size="16" /></button>
      <Transition name="terminal-search">
        <div v-if="toolsMenuOpen" class="terminal-pane-tools-menu" @keydown.esc="toolsMenuOpen = false">
        <button v-if="agentTaskId" type="button" :disabled="agentBusy" @click="toggleAgentOutput"><TerminalSquare v-if="showAgentOutput" :size="14" /><Bot v-else :size="14" /><span>{{ showAgentOutput ? t("terminal.returnToShell") : t("terminal.showAgentOutput") }}</span></button>
        <button v-if="isLive" type="button" :title="t('terminal.reconnect')" :disabled="agentBusy" @click="reconnect(); toolsMenuOpen = false"><RefreshCw :size="14" /><span>{{ t("terminal.reconnect") }}</span></button>
        <button v-if="isLive" type="button" :title="t('terminal.syncSftpDirectory')" :disabled="agentBusy || connectionState !== 'connected'" @click="syncSftpDirectory(); toolsMenuOpen = false"><FolderSync :size="14" /><span>{{ t("terminal.syncSftpDirectory") }}</span></button>
        <button type="button" :title="t('terminal.find')" :disabled="agentBusy" :class="{ active: searchVisible }" @click="toggleSearch(); toolsMenuOpen = false"><Search :size="14" /><span>{{ t("terminal.find") }}</span></button>
        <button type="button" :title="t('terminal.history')" :disabled="agentBusy" :class="{ active: historyVisible }" @click="toggleHistory(); toolsMenuOpen = false"><History :size="14" /><span>{{ t("terminal.history") }}</span></button>
        <button type="button" :title="t('terminal.fit')" :disabled="agentBusy" @click="scheduleFit(); toolsMenuOpen = false"><Maximize2 :size="14" /><span>{{ t("terminal.fit") }}</span></button>
        <button type="button" :title="t('terminal.interrupt')" :disabled="agentBusy" @click="interrupt(); toolsMenuOpen = false"><CircleStop :size="14" /><span>{{ t("terminal.interrupt") }}</span></button>
        <button type="button" :title="t('terminal.copySelection')" :disabled="agentBusy" @click="copySelection(); toolsMenuOpen = false"><Copy :size="14" /><span>{{ t("terminal.copySelection") }}</span></button>
        <button type="button" :title="t('terminal.clearScreen')" @click="clearTerminal(); toolsMenuOpen = false"><Trash2 :size="14" /><span>{{ t("terminal.clearScreen") }}</span></button>
        </div>
      </Transition>
      </div>
    <Transition name="terminal-search">
      <form v-if="searchVisible" class="terminal-search" @submit.prevent="find()">
        <Search :size="13" />
        <input ref="searchInput" :placeholder="t('terminal.findPlaceholder')" @keydown.enter.prevent="find($event)" />
        <button type="button" :title="t('common.close')" @click="toggleSearch"><X :size="13" /></button>
      </form>
    </Transition>
    <Transition name="terminal-search">
      <section v-if="historyVisible" class="terminal-history-panel">
        <header><History :size="13" /><strong>{{ t("terminal.history") }}</strong><button type="button" :title="t('common.close')" @click="toggleHistory"><X :size="13" /></button></header>
        <label><Search :size="12" /><input v-model="historyQuery" :placeholder="t('terminal.historySearch')" /></label>
        <div class="terminal-history-list">
          <button v-for="(command, index) in filteredHistory" :key="`${index}-${command}`" type="button" @click="reuseHistory(command)"><code>{{ command }}</code></button>
          <p v-if="!filteredHistory.length">{{ t("terminal.historyEmpty") }}</p>
        </div>
        <small>{{ t("terminal.historyHint") }}</small>
      </section>
    </Transition>
    <div v-show="!showAgentOutput" ref="terminalHost" :class="['terminal-host', { locked: agentBusy }]" />
    <section v-if="showAgentOutput" class="terminal-agent-view">
      <header><Bot :size="14" /><strong>{{ t("terminal.agentOutput") }}</strong><span v-if="agentBusy" class="terminal-agent-running">{{ t("terminal.agentRunning") }}</span></header>
      <pre ref="agentOutputHost">{{ agentOutput }}</pre>
    </section>
    <Transition name="status-fade"><span v-if="statusMessage" class="terminal-status">{{ statusMessage }}</span></Transition>
    <div v-if="pendingPaste" class="terminal-paste-backdrop" @click.self="cancelPaste">
      <section class="terminal-paste-dialog">
        <header><strong>{{ t("terminal.pasteTitle") }}</strong><button type="button" :title="t('common.close')" @click="cancelPaste"><X :size="14" /></button></header>
        <p>{{ t("terminal.pasteHint", { lines: pendingPaste.analysis.lineCount }) }}</p>
        <p v-if="pendingPaste.analysis.dangerous" class="terminal-paste-warning">{{ t("terminal.dangerousPasteHint") }}</p>
        <label>{{ t("terminal.pastePreview") }}</label>
        <pre>{{ pendingPaste.analysis.content }}</pre>
        <footer>
          <button class="button secondary" type="button" @click="cancelPaste">{{ t("common.cancel") }}</button>
          <button class="button primary" type="button" @click="confirmPaste">{{ t("terminal.pasteConfirm") }}</button>
        </footer>
      </section>
    </div>
  </section>
</template>
