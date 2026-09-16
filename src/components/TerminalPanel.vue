<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CircleStop, Copy, Ellipsis, FolderSync, History, Maximize2, Quote, RefreshCw, Search, Trash2, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type IDisposable } from "@xterm/xterm";
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
import { shouldHandleTerminalGeneration } from "@/features/terminal/terminalReconnect";
import { backend, type TerminalOutputEvent, type TerminalStatusEvent } from "@/services/backend";
import { usePreferenceStore } from "@/features/preferences/preferenceStore";
import {
  readTerminalFontFamily,
  readTerminalTheme,
  TERMINAL_THEME_ATTRIBUTE_FILTER,
} from "@/features/preferences/terminalTheme";
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
  store.isServerConnected(props.serverId) ? "connecting" : "disconnected",
);
const terminalId = `pty-${props.serverId}-${props.sessionId}`;
const isLive = computed(() => store.isServerConnected(props.serverId));
const canWrite = computed(() => isLive.value && connectionState.value === "connected");
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
let pendingTerminalOutputEvents: TerminalOutputEvent[] = [];
let activeGeneration: number | undefined;
let lifecycle = 0;
let disposed = false;
let listenersReady = false;
let starting = false;
let shellEnded = false;
let openedBefore = false;
let sessionServerGeneration: number | undefined;
let lifecycleQueue: Promise<unknown> = Promise.resolve();
let pendingStatusEvent: TerminalStatusEvent | undefined;
let commandDraft: TerminalCommandDraft = { value: "", recordable: false };
let osc7Buffer = "";

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
  if (!canWrite.value || disposed) return;
  const analysis = analyzeTerminalPaste(data);
  if (!confirmed && analysis.requiresConfirmation) {
    pendingPaste.value = { data, analysis };
    return;
  }
  const submitted = trackCommandInput(data);
  if (submitted && shouldPreserveViewportBeforeCommand(submitted) && terminal) {
    terminal.write("\r\n".repeat(Math.max(1, terminal.rows)));
  }
  const currentLifecycle = lifecycle;
  void backend.writeTerminal(terminalId, data).catch((error) => {
    if (currentLifecycle === lifecycle && !disposed) reportTerminalFailure(error);
  });
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
  if (!canWrite.value) return;
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
  if (!canWrite.value) return;
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

function invalidateSession() {
  lifecycle += 1;
  activeGeneration = undefined;
  sessionServerGeneration = undefined;
  starting = false;
  pendingStatusEvent = undefined;
  pendingTerminalOutputEvents = [];
  pendingPaste.value = undefined;
  pendingSftpSync.value = false;
  commandDraft = { value: "", recordable: false };
}

function closeLiveTerminal() {
  invalidateSession();
  lifecycleQueue = lifecycleQueue.catch(() => undefined)
    .then(() => backend.closeTerminal(terminalId)).catch(() => undefined);
  return lifecycleQueue;
}

function reportTerminalFailure(error: unknown) {
  connectionState.value = "error";
  statusMessage.value = String(error);
  void closeLiveTerminal();
  store.reportConnectionFailure(props.serverId, String(error));
}

function startLiveTerminal(): Promise<unknown> {
  if (disposed || !listenersReady || !isLive.value || shellEnded) return Promise.resolve();
  const requestedLifecycle = lifecycle;
  lifecycleQueue = lifecycleQueue.catch(() => undefined).then(async () => {
    if (disposed || requestedLifecycle !== lifecycle || !isLive.value || shellEnded) return;
    if (activeGeneration !== undefined || starting) return;
    await openLiveTerminal(requestedLifecycle);
  });
  return lifecycleQueue;
}

async function openLiveTerminal(requestedLifecycle: number) {
  const connection = store.getRuntimeConnection(props.serverId);
  if (!connection) return;
  const serverGeneration = store.serverConnection(props.serverId).generation;
  starting = true;
  sessionServerGeneration = serverGeneration;
  if (openedBefore) terminal?.writeln(`\r\n${t("terminal.newSessionBanner")}\r\n`);
  openedBefore = true;
  statusMessage.value = "";
  connectionState.value = "connecting";
  activeGeneration = undefined;
  try {
    if (terminalHost.value?.clientWidth) fitAddon?.fit();
    const cols = Math.max(2, terminal?.cols ?? 120);
    const rows = remoteTerminalRows();
    const generation = await backend.startTerminal(terminalId, connection, cols, rows);
    if (disposed || requestedLifecycle !== lifecycle || !isLive.value
      || serverGeneration !== store.serverConnection(props.serverId).generation) {
      await backend.closeTerminal(terminalId);
      return;
    }
    activeGeneration = generation;
    if (pendingStatusEvent && shouldHandleTerminalGeneration(activeGeneration, pendingStatusEvent.generation)) {
      handleTerminalStatus(pendingStatusEvent);
    }
    pendingStatusEvent = undefined;
    const pendingOutput = pendingTerminalOutputEvents;
    pendingTerminalOutputEvents = [];
    pendingOutput.forEach(handleTerminalOutputEvent);
    scheduleFit();
  } catch (error) {
    if (disposed || requestedLifecycle !== lifecycle) return;
    reportTerminalFailure(error);
    terminal?.writeln(`\r\n\u001b[31m${String(error)}\u001b[0m`);
  } finally {
    if (requestedLifecycle === lifecycle) starting = false;
  }
}

function handleTerminalStatus(event: TerminalStatusEvent) {
  if (disposed || sessionServerGeneration !== store.serverConnection(props.serverId).generation) return;
  if (event.status === "connected") {
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
  if (event.status === "disconnected" && !event.retryable) shellEnded = true;
  else if (event.retryable || /身份认证失败|authentication failed/i.test(statusMessage.value)) reportTerminalFailure(statusMessage.value);
}

function scheduleFit() {
  if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (!terminal || !fitAddon || !terminalHost.value?.clientWidth) return;
    fitAddon.fit();
    if (canWrite.value && terminal.cols > 0 && terminal.rows > 0) {
      const currentLifecycle = lifecycle;
      void backend.resizeTerminal(terminalId, terminal.cols, remoteTerminalRows()).catch((error) => {
        if (currentLifecycle === lifecycle && !disposed) reportTerminalFailure(error);
      });
    }
  }, 60);
}

function renderTerminalOutput(data: string) {
  terminal?.write(data);
  trackTerminalDirectory(data);
  updateTranscript(data);
}

function handleTerminalOutputEvent(event: TerminalOutputEvent) {
  if (disposed || sessionServerGeneration !== store.serverConnection(props.serverId).generation) return;
  if (activeGeneration === undefined) {
    if (!starting) return;
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
  if (disposed || starting) return;
  shellEnded = false;
  if (!isLive.value) {
    await store.reconnectServer(props.serverId);
    return;
  }
  await closeLiveTerminal();
  if (disposed || !isLive.value) return;
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
  if (!canWrite.value) return;
  commandDraft = { value: "", recordable: false };
  writeTerminalInput("\u0003", true);
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
    return canWrite.value;
  });
  inputDisposable = terminal.onData((data) => writeTerminalInput(data));
  const selectionSource = terminal as Terminal & { onSelectionChange?: (listener: () => void) => IDisposable };
  selectionDisposable = selectionSource.onSelectionChange?.(() => {
    selectedTerminalText.value = terminal?.getSelection().trim() ?? "";
  });
  outputUnlisten = await backend.onTerminalOutput((event) => {
    if (event.terminalId === terminalId) handleTerminalOutputEvent(event);
  });
  if (disposed) { outputUnlisten(); return; }
  statusUnlisten = await backend.onTerminalStatus((event) => {
    if (disposed || event.terminalId !== terminalId) return;
    if (activeGeneration === undefined) {
      if (starting) pendingStatusEvent = event;
      return;
    }
    if (shouldHandleTerminalGeneration(activeGeneration, event.generation)) handleTerminalStatus(event);
  });
  if (disposed) { statusUnlisten(); return; }
  listenersReady = true;
  resizeObserver = new ResizeObserver(scheduleFit);
  resizeObserver.observe(terminalHost.value!);
  themeObserver = new MutationObserver(() => {
    if (!terminal) return;
    terminal.options.theme = readTerminalTheme();
    terminal.options.fontFamily = readTerminalFontFamily();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: [...TERMINAL_THEME_ATTRIBUTE_FILTER] });
  if (isLive.value) await startLiveTerminal();
  if (disposed) return;
  scheduleFit();
  if (props.active) {
    syncActiveTranscript();
    terminal.focus();
  }
});

watch([() => store.serverConnection(props.serverId).status, () => store.serverConnection(props.serverId).generation], ([status]) => {
  if (status === "connected") {
    if (sessionServerGeneration !== undefined && sessionServerGeneration !== store.serverConnection(props.serverId).generation) void closeLiveTerminal();
    void startLiveTerminal();
  }
  else if (status !== "suspect") {
    connectionState.value = "disconnected";
    void closeLiveTerminal();
  }
}, { flush: "sync" });

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
  disposed = true;
  if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
  void closeLiveTerminal();
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  inputDisposable?.dispose();
  selectionDisposable?.dispose();
  outputUnlisten?.();
  statusUnlisten?.();
  terminal?.dispose();
  workspaceLinks.removePane(props.sessionId);
});
</script>

<template>
  <section :class="['terminal-session-panel', { active: props.active }]" @pointerdown.capture="emit('activate')">
    <div class="terminal-pane-tools">
      <button type="button" class="terminal-pane-tools-trigger" :class="{ active: toolsMenuOpen }" :title="t('terminal.moreActions')" :aria-expanded="toolsMenuOpen" @click.stop="toolsMenuOpen = !toolsMenuOpen"><Ellipsis :size="16" /></button>
      <Transition name="terminal-search">
        <div v-if="toolsMenuOpen" class="terminal-pane-tools-menu" @keydown.esc="toolsMenuOpen = false">
          <button type="button" :title="t('terminal.reconnect')" :disabled="connectionState === 'connecting' || connectionState === 'reconnecting'" @click="reconnect(); toolsMenuOpen = false"><RefreshCw :size="14" /><span>{{ t("terminal.reconnect") }}</span></button>
          <button v-if="isLive" type="button" :title="t('terminal.syncSftpDirectory')" :disabled="connectionState !== 'connected'" @click="syncSftpDirectory(); toolsMenuOpen = false"><FolderSync :size="14" /><span>{{ t("terminal.syncSftpDirectory") }}</span></button>
          <button type="button" :title="t('terminal.find')" :class="{ active: searchVisible }" @click="toggleSearch(); toolsMenuOpen = false"><Search :size="14" /><span>{{ t("terminal.find") }}</span></button>
          <button type="button" :title="t('terminal.history')" :class="{ active: historyVisible }" @click="toggleHistory(); toolsMenuOpen = false"><History :size="14" /><span>{{ t("terminal.history") }}</span></button>
          <button type="button" :title="t('terminal.fit')" @click="scheduleFit(); toolsMenuOpen = false"><Maximize2 :size="14" /><span>{{ t("terminal.fit") }}</span></button>
          <button type="button" :title="t('terminal.interrupt')" :disabled="!canWrite" @click="interrupt(); toolsMenuOpen = false"><CircleStop :size="14" /><span>{{ t("terminal.interrupt") }}</span></button>
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
        <div class="terminal-history-list"><button v-for="(command, index) in filteredHistory" :key="`${index}-${command}`" type="button" :disabled="!canWrite" @click="reuseHistory(command)"><code>{{ command }}</code></button><p v-if="!filteredHistory.length">{{ t("terminal.historyEmpty") }}</p></div>
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
        <footer><button class="button secondary" type="button" @click="cancelPaste">{{ t("common.cancel") }}</button><button class="button primary" type="button" :disabled="!canWrite" @click="confirmPaste">{{ t("terminal.pasteConfirm") }}</button></footer>
      </section>
    </div>
  </section>
</template>
