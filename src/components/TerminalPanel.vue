<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CircleStop, Copy, Ellipsis, FolderSync, History, Maximize2, Quote, RefreshCw, Search, Trash2, X } from "lucide-vue-next";
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
  shouldPreserveViewportBeforeCommand,
  updateCommandDraft,
  type TerminalCommandDraft,
  type TerminalPasteAnalysis,
} from "@/features/terminal/terminalInput";
import {
  MAX_TERMINAL_RECONNECT_ATTEMPTS,
  reconnectDelay,
  shouldHandleTerminalGeneration,
} from "@/features/terminal/terminalReconnect";
import { backend, type TerminalOutputEvent, type TerminalStatusEvent } from "@/services/backend";
import { usePreferenceStore } from "@/features/preferences/preferenceStore";
import { useOpsStore } from "@/stores/ops";
import type { TerminalPaneStatus } from "@/features/terminal/terminalSessionStore";
import {
  buildTerminalChangeDirectoryCommand,
  buildTerminalDirectoryProbeCommand,
  extractOsc7Directories,
  useWorkspaceLinkStore,
} from "@/features/workspace/workspaceLinkStore";

const props = defineProps<{ serverId: string; sessionId: string; active: boolean }>();
const emit = defineEmits<{ activate: []; statusChange: [status: TerminalPaneStatus] }>();
const store = useOpsStore();
const preferences = usePreferenceStore();
const workspaceLinks = useWorkspaceLinkStore();
const { t } = useI18n();
const terminalHost = ref<HTMLElement>();
const searchInput = ref<HTMLInputElement>();
const searchVisible = ref(false);
const historyVisible = ref(false);
const toolsMenuOpen = ref(false);
const historyQuery = ref("");
const commandHistory = ref<string[]>([]);
const pendingPaste = ref<{ data: string; analysis: TerminalPasteAnalysis }>();
const selectedTerminalText = ref("");
const statusMessage = ref("");
const pendingSftpSync = ref(false);
const connectionState = ref<"connecting" | "connected" | "disconnected" | "error" | "reconnecting">(
  store.connectedServerIds.includes(props.serverId) ? "connecting" : "disconnected",
);
const terminalId = `pty-${props.serverId}-${props.sessionId}`;
const isLive = computed(() => store.connectedServerIds.includes(props.serverId));
const filteredHistory = computed(() => {
  const query = historyQuery.value.trim().toLocaleLowerCase();
  return [...commandHistory.value].reverse()
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
let selectionDisposable: IDisposable | undefined;
let transcript: TerminalTranscriptState = { lines: [], remainder: "" };
let resizeTimer: number | undefined;
let reconnectTimer: number | undefined;
let pendingTerminalOutputEvents: TerminalOutputEvent[] = [];
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

function readTerminalFontFamily() {
  return getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim()
    || 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace';
}

function currentTerminalLine() {
  if (!terminal) return "";
  const buffer = terminal.buffer.active;
  return buffer.getLine(buffer.cursorY)?.translateToString(true) ?? "";
}

function trackCommandInput(data: string) {
  if (!commandDraft.value && !commandDraft.recordable) {
    commandDraft.recordable = isRecognizedShellPrompt(currentTerminalLine());
  }
  const result = updateCommandDraft(commandDraft, data);
  commandDraft = result.state;
  if (result.submitted !== undefined) {
    if (commandDraft.recordable) commandHistory.value = appendTerminalHistory(commandHistory.value, result.submitted);
    commandDraft = { value: "", recordable: false };
  }
  return result.submitted;
}

/** This is the only path that writes into the user-owned PTY. */
function writeTerminalInput(data: string, confirmed = false) {
  const analysis = analyzeTerminalPaste(data);
  if (!confirmed && analysis.requiresConfirmation) {
    pendingPaste.value = { data, analysis };
    return;
  }
  const submitted = trackCommandInput(data);
  if (submitted && shouldPreserveViewportBeforeCommand(submitted) && terminal) {
    terminal.write("\r\n".repeat(Math.max(1, terminal.rows)));
  }
  if (connectionState.value === "connected") void backend.writeTerminal(terminalId, data);
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

function referenceSelectionToModel() {
  if (!selectedTerminalText.value) return;
  workspaceLinks.publishTerminalModelReference(props.serverId, props.sessionId, selectedTerminalText.value);
  terminal?.clearSelection();
  selectedTerminalText.value = "";
  statusMessage.value = t("terminal.selectionAttached");
  window.setTimeout(() => {
    if (statusMessage.value === t("terminal.selectionAttached")) statusMessage.value = "";
  }, 1_800);
}

/** The model only sees the transcript of the currently focused user pane. */
function syncActiveTranscript() {
  store.terminalLines = transcript.remainder
    ? [...transcript.lines, transcript.remainder]
    : [...transcript.lines];
}

async function startLiveTerminal(): Promise<number | undefined> {
  const connection = store.getRuntimeConnection(props.serverId);
  if (!connection) return;
  statusMessage.value = "";
  connectionState.value = "connecting";
  activeGeneration = undefined;
  try {
    if (terminalHost.value?.clientWidth) fitAddon?.fit();
    const cols = Math.max(2, terminal?.cols ?? 120);
    const rows = remoteTerminalRows();
    activeGeneration = await backend.startTerminal(terminalId, connection, cols, rows);
    if (pendingStatusEvent && shouldHandleTerminalGeneration(activeGeneration, pendingStatusEvent.generation)) {
      handleTerminalStatus(pendingStatusEvent);
    }
    pendingStatusEvent = undefined;
    const pendingOutput = pendingTerminalOutputEvents;
    pendingTerminalOutputEvents = [];
    pendingOutput.forEach(handleTerminalOutputEvent);
    scheduleFit();
    return activeGeneration;
  } catch (error) {
    statusMessage.value = String(error);
    terminal?.writeln(`\r\n\u001b[31m${String(error)}\u001b[0m`);
    return undefined;
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
      void backend.resizeTerminal(terminalId, terminal.cols, remoteTerminalRows());
    }
  }, 60);
}

function renderTerminalOutput(data: string) {
  terminal?.write(data);
  trackTerminalDirectory(data);
  updateTranscript(data);
}

function handleTerminalOutputEvent(event: TerminalOutputEvent) {
  if (activeGeneration === undefined) {
    pendingTerminalOutputEvents.push(event);
    if (pendingTerminalOutputEvents.length > 200) pendingTerminalOutputEvents.shift();
    return;
  }
  if (shouldHandleTerminalGeneration(activeGeneration, event.generation)) renderTerminalOutput(event.data);
}

function remoteTerminalRows() {
  return Math.max(1, terminal?.rows ?? 32);
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
  terminal?.focus();
}

function clearTerminal() {
  terminal?.clear();
  transcript = { lines: [], remainder: "" };
  if (props.active) store.terminalLines = [];
  terminal?.focus();
}

onMounted(async () => {
  terminal = new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: readTerminalFontFamily(),
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
  terminal.attachCustomKeyEventHandler((event) => {
    if (matchesTerminalShortcut(event, "find", preferences.terminalShortcutPreset)) { toggleSearch(); return false; }
    if (matchesTerminalShortcut(event, "history", preferences.terminalShortcutPreset)) { toggleHistory(); return false; }
    if (matchesTerminalShortcut(event, "copy", preferences.terminalShortcutPreset)) { void copySelection(); return false; }
    if (matchesTerminalShortcut(event, "clear", preferences.terminalShortcutPreset)) { clearTerminal(); return false; }
    return true;
  });
  inputDisposable = terminal.onData((data) => writeTerminalInput(data));
  const selectionSource = terminal as Terminal & { onSelectionChange?: (listener: () => void) => IDisposable };
  selectionDisposable = selectionSource.onSelectionChange?.(() => {
    selectedTerminalText.value = terminal?.getSelection().trim() ?? "";
  });
  outputUnlisten = await backend.onTerminalOutput((event) => {
    if (event.terminalId === terminalId) handleTerminalOutputEvent(event);
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
    if (!terminal) return;
    terminal.options.theme = readTerminalTheme();
    terminal.options.fontFamily = readTerminalFontFamily();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  if (isLive.value) await startLiveTerminal();
  scheduleFit();
  if (props.active) {
    syncActiveTranscript();
    terminal.focus();
  }
});

watch(isLive, async (live) => {
  if (live) await startLiveTerminal();
  else {
    clearReconnectTimer();
    activeGeneration = undefined;
    connectionState.value = "disconnected";
    await backend.closeTerminal(terminalId);
  }
});

watch(() => props.active, (active) => {
  if (!active) return;
  syncActiveTranscript();
  scheduleFit();
  void nextTick(() => terminal?.focus());
});

watch(connectionState, (status) => emit("statusChange", status), { immediate: true });

watch(
  [() => workspaceLinks.terminalPathRequests[props.serverId], () => props.active, isLive, connectionState],
  ([request, active, live, status]) => {
    if (!request || !active || !live || status !== "connected") return;
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
  selectionDisposable?.dispose();
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
      <button type="button" class="terminal-pane-tools-trigger" :class="{ active: toolsMenuOpen }" :title="t('terminal.moreActions')" :aria-expanded="toolsMenuOpen" @click.stop="toolsMenuOpen = !toolsMenuOpen"><Ellipsis :size="16" /></button>
      <Transition name="terminal-search">
        <div v-if="toolsMenuOpen" class="terminal-pane-tools-menu" @keydown.esc="toolsMenuOpen = false">
          <button v-if="isLive" type="button" :title="t('terminal.reconnect')" @click="reconnect(); toolsMenuOpen = false"><RefreshCw :size="14" /><span>{{ t("terminal.reconnect") }}</span></button>
          <button v-if="isLive" type="button" :title="t('terminal.syncSftpDirectory')" :disabled="connectionState !== 'connected'" @click="syncSftpDirectory(); toolsMenuOpen = false"><FolderSync :size="14" /><span>{{ t("terminal.syncSftpDirectory") }}</span></button>
          <button type="button" :title="t('terminal.find')" :class="{ active: searchVisible }" @click="toggleSearch(); toolsMenuOpen = false"><Search :size="14" /><span>{{ t("terminal.find") }}</span></button>
          <button type="button" :title="t('terminal.history')" :class="{ active: historyVisible }" @click="toggleHistory(); toolsMenuOpen = false"><History :size="14" /><span>{{ t("terminal.history") }}</span></button>
          <button type="button" :title="t('terminal.fit')" @click="scheduleFit(); toolsMenuOpen = false"><Maximize2 :size="14" /><span>{{ t("terminal.fit") }}</span></button>
          <button type="button" :title="t('terminal.interrupt')" @click="interrupt(); toolsMenuOpen = false"><CircleStop :size="14" /><span>{{ t("terminal.interrupt") }}</span></button>
          <button type="button" :title="t('terminal.copySelection')" @click="copySelection(); toolsMenuOpen = false"><Copy :size="14" /><span>{{ t("terminal.copySelection") }}</span></button>
          <button type="button" :title="t('terminal.clearScreen')" @click="clearTerminal(); toolsMenuOpen = false"><Trash2 :size="14" /><span>{{ t("terminal.clearScreen") }}</span></button>
        </div>
      </Transition>
    </div>
    <Transition name="terminal-search">
      <form v-if="searchVisible" class="terminal-search" @submit.prevent="find()">
        <Search :size="13" /><input ref="searchInput" :placeholder="t('terminal.findPlaceholder')" @keydown.enter.prevent="find($event)" /><button type="button" :title="t('common.close')" @click="toggleSearch"><X :size="13" /></button>
      </form>
    </Transition>
    <Transition name="terminal-search">
      <section v-if="historyVisible" class="terminal-history-panel">
        <header><History :size="13" /><strong>{{ t("terminal.history") }}</strong><button type="button" :title="t('common.close')" @click="toggleHistory"><X :size="13" /></button></header>
        <label><Search :size="12" /><input v-model="historyQuery" :placeholder="t('terminal.historySearch')" /></label>
        <div class="terminal-history-list"><button v-for="(command, index) in filteredHistory" :key="`${index}-${command}`" type="button" @click="reuseHistory(command)"><code>{{ command }}</code></button><p v-if="!filteredHistory.length">{{ t("terminal.historyEmpty") }}</p></div>
        <small>{{ t("terminal.historyHint") }}</small>
      </section>
    </Transition>
    <div ref="terminalHost" class="terminal-host" />
    <Transition name="status-fade"><button v-if="selectedTerminalText" class="terminal-selection-action" type="button" @click="referenceSelectionToModel"><Quote :size="13" /><span>{{ t("terminal.askWithSelection", { count: selectedTerminalText.split('\n').length }) }}</span></button></Transition>
    <Transition name="status-fade"><span v-if="statusMessage" class="terminal-status">{{ statusMessage }}</span></Transition>
    <div v-if="pendingPaste" class="terminal-paste-backdrop" @click.self="cancelPaste">
      <section class="terminal-paste-dialog">
        <header><strong>{{ t("terminal.pasteTitle") }}</strong><button type="button" :title="t('common.close')" @click="cancelPaste"><X :size="14" /></button></header>
        <p>{{ t("terminal.pasteHint", { lines: pendingPaste.analysis.lineCount }) }}</p><p v-if="pendingPaste.analysis.dangerous" class="terminal-paste-warning">{{ t("terminal.dangerousPasteHint") }}</p><label>{{ t("terminal.pastePreview") }}</label><pre>{{ pendingPaste.analysis.content }}</pre>
        <footer><button class="button secondary" type="button" @click="cancelPaste">{{ t("common.cancel") }}</button><button class="button primary" type="button" @click="confirmPaste">{{ t("terminal.pasteConfirm") }}</button></footer>
      </section>
    </div>
  </section>
</template>
