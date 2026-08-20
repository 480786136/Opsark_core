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
  Quote,
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
import { backend, type TerminalStatusEvent } from "@/services/backend";
import { usePreferenceStore } from "@/features/preferences/preferenceStore";
import { useOpsStore } from "@/stores/ops";
import { redactExecutionOutput } from "@/features/agent/secretTool";
import type { TerminalPaneStatus } from "@/features/terminal/terminalSessionStore";
import { useTerminalSessionStore } from "@/features/terminal/terminalSessionStore";
import { appendTerminalOutput, sanitizeTerminalOutput } from "@/utils/terminal";
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
const selectedTerminalText = ref("");
const statusMessage = ref("");
const pendingSftpSync = ref(false);
const connectionState = ref<"connecting" | "connected" | "disconnected" | "error" | "reconnecting">(
  store.connectedServerIds.includes(props.serverId) ? "connecting" : "disconnected",
);
const terminalId = `pty-${props.serverId}-${props.sessionId}`;
const isLive = computed(() => store.connectedServerIds.includes(props.serverId));
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
let selectionDisposable: IDisposable | undefined;
let scrollDisposable: IDisposable | undefined;
let transcript: TerminalTranscriptState = { lines: [], remainder: "" };
let resizeTimer: number | undefined;
let reconnectTimer: number | undefined;
let agentOutputFlushTimer: number | undefined;
let pendingAgentPtyData = "";
let activeGeneration: number | undefined;
let reconnectAttempts = 0;
let pendingStatusEvent: TerminalStatusEvent | undefined;
let commandDraft: TerminalCommandDraft = { value: "", recordable: false };
let osc7Buffer = "";
let activeAgentCapture: {
  id: string;
  begin: string;
  endPrefix: string;
  started: boolean;
  buffer: string;
  output: string;
} | undefined;
let activeSshJump: {
  id: string;
  marker: string;
  output: string;
  passwordSent: boolean;
  hostConfirmed: boolean;
} | undefined;
let followAgentOutput = true;

function isTerminalViewportAtBottom(position?: number) {
  if (!terminal) return true;
  const buffer = terminal.buffer.active;
  return (position ?? buffer.viewportY) >= buffer.baseY;
}

function followLatestAgentOutput() {
  followAgentOutput = true;
  terminal?.scrollToBottom();
}

/**
 * Agent 命令与用户共用一个交互式 Shell。执行前暂停 Bash 历史，
 * 避免内部标记、Base64 载荷和终端探针被 ↑ 重新调出。
 */
const pauseAgentShellHistoryCommand = "\u0015__opsark_history_enabled=0; if [ -n \"${BASH_VERSION:-}\" ]; then case $- in *h*) __opsark_history_enabled=1; __opsark_history_tail=$(history 1); case \"$__opsark_history_tail\" in *__opsark_history_enabled=0*) history -d $((HISTCMD-1)) 2>/dev/null;; esac; unset __opsark_history_tail; set +o history;; esac; fi; stty -echo\r";

const purgeLegacyOpsarkHistoryCommand = "if [ -n \"${BASH_VERSION:-}\" ]; then for __opsark_history_id in $(history | command awk 'index($0, \"__OPSARK_\") || index($0, \"file://%s%s\") { print $1 }' | command sort -rn); do history -d \"$__opsark_history_id\" 2>/dev/null; done; fi;";

const restoreAgentShellCommand = "stty echo; if [ \"${__opsark_history_enabled:-0}\" = 1 ]; then set -o history; fi; unset __opsark_history_enabled __opsark_history_id";

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

/** 所有终端输入统一经过此边界，确认前不会写入远端 PTY。 */
function writeTerminalInput(data: string, confirmed = false) {
  if (agentBusy.value) return;
  const analysis = analyzeTerminalPaste(data);
  if (!confirmed && analysis.requiresConfirmation) {
    pendingPaste.value = { data, analysis };
    return;
  }
  const submitted = trackCommandInput(data);
  if (submitted && shouldPreserveViewportBeforeCommand(submitted) && terminal) {
    // GNU top may repaint the primary buffer instead of entering the alternate
    // screen. Move the current viewport into scrollback before its first clear.
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

function handleAgentPtyData(data: string) {
  const capture = activeAgentCapture;
  if (!capture) return data;
  capture.buffer += data;
  if (!capture.started) {
    const beginIndex = capture.buffer.indexOf(capture.begin);
    if (beginIndex < 0) {
      // 开始标记之前只会有内部控制行的 PTY 回显，不应展示或写入转录。
      capture.buffer = capture.buffer.slice(-capture.begin.length);
      return "";
    }
    capture.buffer = capture.buffer.slice(beginIndex + capture.begin.length).replace(/^\r?\n/, "");
    capture.started = true;
  }

  const endIndex = capture.buffer.indexOf(capture.endPrefix);
  if (endIndex >= 0) {
    const output = capture.buffer.slice(0, endIndex).replace(/\r?\n$/, "");
    const afterPrefix = capture.buffer.slice(endIndex + capture.endPrefix.length);
    const endMatch = afterPrefix.match(/^(\d+)__\r?\n?/);
    if (!endMatch) return "";
    const visibleOutput = redactExecutionOutput(output, store.getServerSecretValues(props.serverId));
    if (visibleOutput) {
      capture.output = appendTerminalOutput(capture.output, visibleOutput);
      terminalSessions.publishAgentPtyProgress(capture.id, visibleOutput);
    }
    const remainder = afterPrefix.slice(endMatch[0].length);
    terminalSessions.completeAgentPtyCommand(props.sessionId, capture.id, capture.output, Number(endMatch[1]));
    activeAgentCapture = undefined;
    return `${visibleOutput}${remainder}`;
  }

  const longestSecret = Math.max(0, ...Object.values(store.getServerSecretValues(props.serverId)).map((value) => value.length));
  const safeLength = Math.max(0, capture.buffer.length - Math.max(96, longestSecret));
  const rawVisible = capture.buffer.slice(0, safeLength);
  capture.buffer = capture.buffer.slice(safeLength);
  const visible = redactExecutionOutput(rawVisible, store.getServerSecretValues(props.serverId));
  if (visible) {
    capture.output = appendTerminalOutput(capture.output, visible);
    terminalSessions.publishAgentPtyProgress(capture.id, visible);
  }
  return visible;
}

function handleAgentSshJumpData(data: string) {
  const jump = activeSshJump;
  if (!jump) return data;
  const safeData = redactExecutionOutput(data, store.getServerSecretValues(props.serverId));
  jump.output = appendTerminalOutput(jump.output, safeData);
  const plainOutput = sanitizeTerminalOutput(jump.output);
  if (!jump.hostConfirmed && /are you sure you want to continue connecting/i.test(plainOutput)) {
    jump.hostConfirmed = true;
    void backend.writeTerminal(terminalId, "yes\r");
  }
  const passwordPrompts = plainOutput.match(/password\s*:/gi)?.length ?? 0;
  if (passwordPrompts > 0 && !jump.passwordSent) {
    const password = terminalSessions.readAgentSshPassword(jump.id);
    if (!password) {
      terminalSessions.failAgentPtySshJump(props.sessionId, jump.id, "SSH 密码不可用");
      activeSshJump = undefined;
      return safeData;
    }
    jump.passwordSent = true;
    void backend.writeTerminal(terminalId, `${password}\r`);
  } else if (passwordPrompts > 1 && jump.passwordSent) {
    terminalSessions.failAgentPtySshJump(props.sessionId, jump.id, "SSH 用户名或密码错误");
    activeSshJump = undefined;
    return safeData;
  }
  if (plainOutput.includes(jump.marker)) {
    const output = plainOutput.replace(jump.marker, "").trim();
    terminalSessions.completeAgentPtySshJump(props.sessionId, jump.id, output || "SSH 登录成功");
    activeSshJump = undefined;
    return safeData.replace(jump.marker, "");
  }
  if (/permission denied|connection refused|no route to host|could not resolve hostname|connection timed out|connection closed by/i.test(plainOutput)) {
    terminalSessions.failAgentPtySshJump(props.sessionId, jump.id, "终端内 SSH 登录失败，请检查凭据、端口和网络");
    activeSshJump = undefined;
  }
  return safeData;
}

function executeBoundAgentCommand(request: { id: string; command: string; displayCommand: string }) {
  if (connectionState.value !== "connected") {
    terminalSessions.failAgentPtyCommand(props.sessionId, request.id, "绑定终端尚未连接");
    return;
  }
  const markerId = request.id.replace(/[^A-Za-z0-9_-]/g, "_");
  const beginMarker = `__OPSARK_BEGIN_${markerId}__`;
  const endMarkerPrefix = `__OPSARK_END_${markerId}_`;
  activeAgentCapture = {
    id: request.id,
    begin: beginMarker,
    endPrefix: endMarkerPrefix,
    started: false,
    buffer: "",
    output: "",
  };
  // Agent 执行期间的终端是实时观测面。无论用户之前停在哪一段历史，
  // 新的智能命令开始时都先回到最新一行，后续输出也会持续跟随。
  followLatestAgentOutput();
  const safeDisplayCommand = redactExecutionOutput(request.displayCommand, store.getServerSecretValues(props.serverId));
  // The user may have an unsubmitted draft at the prompt. Clear the remote
  // canonical input line before taking control, otherwise commands concatenate
  // (for example `ll` + `export` => `llexport`) and the marker protocol hangs.
  commandDraft = { value: "", recordable: false };
  const bytes = new TextEncoder().encode(request.command);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  const encodedCommand = btoa(binary);
  // First disable echo/history, then submit one CR-terminated line. A single line avoids PTY paste/newline ambiguity.
  void backend.writeTerminal(terminalId, pauseAgentShellHistoryCommand);
  window.setTimeout(() => {
    if (activeAgentCapture?.id !== request.id) return;
    terminal?.write(
      `\r\n\u001b[36m[Agent]\u001b[0m $ ${safeDisplayCommand}\r\n`,
      () => {
        if (followAgentOutput) terminal?.scrollToBottom();
      },
    );
    updateTranscript(`[Agent] $ ${safeDisplayCommand}\n`);
    const script = ` ${purgeLegacyOpsarkHistoryCommand} __opsark_payload='${encodedCommand}'; printf '${beginMarker}\\n'; ( eval \"$(printf '%s' \"$__opsark_payload\" | base64 -d)\" ); __opsark_status=$?; unset __opsark_payload; ${restoreAgentShellCommand}; printf '\\n${endMarkerPrefix}%s__\\n' \"$__opsark_status\"; unset __opsark_status\r`;
    void backend.writeTerminal(terminalId, script);
  }, 80);
}

function executeBoundSshJump(request: { id: string; host: string; port: number; username: string }) {
  if (connectionState.value !== "connected") {
    terminalSessions.failAgentPtySshJump(props.sessionId, request.id, "绑定终端尚未连接");
    return;
  }
  const markerId = request.id.replace(/[^A-Za-z0-9_-]/g, "_");
  const marker = `__OPSARK_SSH_CONNECTED_${markerId}__`;
  activeSshJump = { id: request.id, marker, output: "", passwordSent: false, hostConfirmed: false };
  followLatestAgentOutput();
  commandDraft = { value: "", recordable: false };
  const displayCommand = `ssh -p ${request.port} ${request.username}@${request.host}`;
  const remoteCommand = `printf \"\\n${marker}\\n\"; exec \"\${SHELL:-/bin/sh}\" -l`;
  const sshCommand = `ssh -tt -p ${request.port} -- ${request.username}@${request.host} '${remoteCommand}'`;
  const bytes = new TextEncoder().encode(sshCommand);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  const encodedCommand = btoa(binary);
  void backend.writeTerminal(terminalId, pauseAgentShellHistoryCommand);
  window.setTimeout(() => {
    if (activeSshJump?.id !== request.id) return;
    terminal?.write(`\r\n\u001b[36m[Agent]\u001b[0m $ ${displayCommand}\r\n`, () => terminal?.scrollToBottom());
    updateTranscript(`[Agent] $ ${displayCommand}\n`);
    const script = ` ${purgeLegacyOpsarkHistoryCommand} __opsark_payload='${encodedCommand}'; stty echo; eval \"$(printf '%s' \"$__opsark_payload\" | base64 -d)\"; __opsark_status=$?; unset __opsark_payload; ${restoreAgentShellCommand}; unset __opsark_status\r`;
    void backend.writeTerminal(terminalId, script);
  }, 80);
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
  window.setTimeout(() => { if (statusMessage.value === t("terminal.selectionAttached")) statusMessage.value = ""; }, 1800);
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
    // Full-screen programs such as top rely on the PTY size from their first
    // frame. Fit before opening SSH so the remote session never starts at a
    // placeholder size and leaves stale rows in xterm's scrollback.
    if (terminalHost.value?.clientWidth) fitAddon?.fit();
    const cols = Math.max(2, terminal?.cols ?? 120);
    const rows = remoteTerminalRows();
    activeGeneration = await backend.startTerminal(terminalId, connection, cols, rows);
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
  terminalSessions.clearAgentPtySshTarget(props.sessionId);
  if (activeSshJump) {
    terminalSessions.failAgentPtySshJump(props.sessionId, activeSshJump.id, event.reason ?? "终端连接已断开");
    activeSshJump = undefined;
  }
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
  if (!activeSshJump
    && terminalSessions.effectiveSshTargetByPane[props.sessionId]
    && /connection to .+ closed\.?/i.test(sanitizeTerminalOutput(data))) {
    terminalSessions.clearAgentPtySshTarget(props.sessionId);
  }
  const shouldFollowAgentExecution = Boolean(activeAgentCapture || activeSshJump) && followAgentOutput;
  const visibleData = handleAgentSshJumpData(handleAgentPtyData(data));
  if (!visibleData) return;
  terminal?.write(visibleData, () => {
    if (shouldFollowAgentExecution) terminal?.scrollToBottom();
  });
  trackTerminalDirectory(visibleData);
  updateTranscript(visibleData);
}

function flushAgentPtyOutput() {
  if (agentOutputFlushTimer !== undefined) window.clearTimeout(agentOutputFlushTimer);
  agentOutputFlushTimer = undefined;
  if (!pendingAgentPtyData) return;
  const data = pendingAgentPtyData;
  pendingAgentPtyData = "";
  renderTerminalOutput(data);
}

function queueAgentPtyOutput(data: string) {
  pendingAgentPtyData += data;
  // 20 FPS 足够平滑展示下载进度，并显著减少 xterm 与 Vue 的重复渲染。
  if (pendingAgentPtyData.length >= 64 * 1024) {
    flushAgentPtyOutput();
    return;
  }
  if (agentOutputFlushTimer === undefined) {
    agentOutputFlushTimer = window.setTimeout(flushAgentPtyOutput, 50);
  }
}

function remoteTerminalRows() {
  // Keep the final PTY row clear of xterm's viewport rounding and scrollbar.
  // Full-screen programs otherwise render their last row beneath the panel edge.
  return Math.max(1, (terminal?.rows ?? 32) - 1);
}

async function reconnect() {
  if (!isLive.value) return;
  clearReconnectTimer();
  reconnectAttempts = 0;
  activeGeneration = undefined;
  terminalSessions.clearAgentPtySshTarget(props.sessionId);
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
  if (showAgentOutput.value) void nextTick(() => agentOutputHost.value?.scrollTo({ top: agentOutputHost.value.scrollHeight }));
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
  if (props.agentTaskId) {
    agentOutput.value = formatTaskHistory();
    showAgentOutput.value = false;
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
  scrollDisposable = terminal.onScroll((position) => {
    if (!activeAgentCapture && !activeSshJump) return;
    // 用户向上查看历史时暂停自动跟随；手动滚回底部后继续跟随实时输出。
    followAgentOutput = isTerminalViewportAtBottom(position);
  });
  const selectionSource = terminal as Terminal & { onSelectionChange?: (listener: () => void) => IDisposable };
  selectionDisposable = selectionSource.onSelectionChange?.(() => {
    selectedTerminalText.value = terminal?.getSelection().trim() ?? "";
  });
  outputUnlisten = await backend.onTerminalOutput((event) => {
    if (event.terminalId !== terminalId) return;
    if (activeAgentCapture || activeSshJump || pendingAgentPtyData) queueAgentPtyOutput(event.data);
    else renderTerminalOutput(event.data);
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
    if (!agentBusy.value && !showAgentOutput.value) terminal.focus();
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
  if (!agentBusy.value && !showAgentOutput.value) void nextTick(() => terminal?.focus());
});

watch(
  () => (terminalSessions.agentOutputByPane[props.sessionId] ?? []).map(({ id }) => id),
  flushAgentOutput,
);

watch(agentBusy, (busy) => { if (busy) showAgentOutput.value = false; });

watch(() => props.agentTaskId, () => {
  agentOutput.value = formatTaskHistory();
  showAgentOutput.value = false;
  flushAgentOutput();
});

watch(connectionState, (status) => emit("statusChange", status), { immediate: true });

watch(
  () => terminalSessions.agentCommandByPane[props.sessionId],
  (request) => { if (request && request.id !== activeAgentCapture?.id) executeBoundAgentCommand(request); },
  { immediate: true },
);

watch(
  () => terminalSessions.agentSshJumpByPane[props.sessionId],
  (request) => { if (request && request.id !== activeSshJump?.id) executeBoundSshJump(request); },
  { immediate: true },
);

watch(
  () => terminalSessions.agentInterruptByPane[props.sessionId],
  (version, previous) => {
    if (!version || version === previous || (!activeAgentCapture && !activeSshJump)) return;
    // 只向远程前台进程组发送中断。不在这里提前完成 Promise：
    // 必须等 Shell 继续执行收尾脚本并返回 OPSARK_END 及真实退出码。
    void backend.writeTerminal(terminalId, "\u0003");
    if (activeSshJump) {
      terminalSessions.failAgentPtySshJump(props.sessionId, activeSshJump.id, "终端内 SSH 登录已终止");
      activeSshJump = undefined;
    }
  },
);

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
  if (agentOutputFlushTimer !== undefined) window.clearTimeout(agentOutputFlushTimer);
  clearReconnectTimer();
  activeGeneration = undefined;
  if (activeAgentCapture) terminalSessions.failAgentPtyCommand(props.sessionId, activeAgentCapture.id, "终端已关闭");
  if (activeSshJump) terminalSessions.failAgentPtySshJump(props.sessionId, activeSshJump.id, "终端已关闭");
  terminalSessions.clearAgentPtySshTarget(props.sessionId);
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  inputDisposable?.dispose();
  selectionDisposable?.dispose();
  scrollDisposable?.dispose();
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
    <Transition name="status-fade">
      <button v-if="selectedTerminalText && !showAgentOutput" class="terminal-selection-action" type="button" @click="referenceSelectionToModel"><Quote :size="13" /><span>{{ t("terminal.askWithSelection", { count: selectedTerminalText.split('\n').length }) }}</span></button>
    </Transition>
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
