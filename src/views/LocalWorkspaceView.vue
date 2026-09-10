<script setup lang="ts">
import { nextTick, onActivated, onBeforeUnmount, onMounted, ref } from "vue";
import WorkspaceNavigation from "@/features/workspace/WorkspaceNavigation.vue";
import { useI18n } from "vue-i18n";
import { invoke, Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
defineOptions({ name: "LocalWorkspaceView" });
const { locale } = useI18n();
const host = ref<HTMLElement>();
const status = ref("Local");
const error = ref("");
const ready = ref(false);
const starting = ref(false);
let terminal: Terminal;
let fit: FitAddon;
let observer: ResizeObserver;
let themeObserver: MutationObserver;
let id = "";
let disposed = false;
let writes = Promise.resolve();
function theme() {
  const style = getComputedStyle(document.documentElement);
  terminal.options.theme = { background: style.getPropertyValue("--terminal-bg").trim() || "#0b0e11", foreground: style.getPropertyValue("--terminal-text").trim() || "#c5cbd3", cursor: style.getPropertyValue("--accent").trim() || "#d8ff5f" };
}
function resize() {
  if (!host.value?.clientWidth || !host.value?.clientHeight) return;
  fit.fit();
  if (ready.value) void invoke("resize_local_terminal", { id, cols: terminal.cols, rows: terminal.rows }).catch(reason => { error.value = String(reason); });
}
async function start() {
  if (starting.value || ready.value || disposed) return;
  if (!("__TAURI_INTERNALS__" in window)) { error.value = locale.value.startsWith("zh") ? "本地终端需要在桌面客户端中打开。" : "Open the desktop app to use the local terminal."; return; }
  starting.value = true; error.value = ""; id = crypto.randomUUID();
  const sessionId = id;
  let ended = false;
  const output = new Channel<{ data: number[]; ended: boolean }>();
  output.onmessage = event => {
    if (disposed || sessionId !== id) return;
    if (event.ended) { ended = true; ready.value = false; status.value = locale.value.startsWith("zh") ? "已结束" : "Exited"; }
    else terminal.write(new Uint8Array(event.data));
  };
  try {
    resize();
    await invoke("open_local_terminal", { id: sessionId, cols: terminal.cols, rows: terminal.rows, output });
    if (disposed) { await invoke("close_local_terminal", { id: sessionId }); return; }
    ready.value = !ended;
    status.value = ready.value ? "Local · " + (/Win/i.test(navigator.platform) ? "PowerShell" : "Shell") : status.value;
    resize(); terminal.focus();
  } catch (reason) { ready.value = false; error.value = String(reason); }
  finally { starting.value = false; }
}
onMounted(() => {
  terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: '"Cascadia Mono", Menlo, Consolas, monospace', scrollback: 5000 });
  fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.value!); theme();
  terminal.onData(data => {
    if (!ready.value && !starting.value) return;
    const sessionId = id;
    writes = writes.then(() => invoke<void>("write_local_terminal", { id: sessionId, data })).catch(reason => { error.value = String(reason); });
  });
  observer = new ResizeObserver(resize); observer.observe(host.value!);
  themeObserver = new MutationObserver(theme); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  void start();
});
onActivated(async () => { await nextTick(); if (terminal) { resize(); terminal.focus(); } });
onBeforeUnmount(() => {
  disposed = true; observer?.disconnect(); themeObserver?.disconnect(); terminal?.dispose();
  if (id && "__TAURI_INTERNALS__" in window) void invoke("close_local_terminal", { id }).catch(() => {});
});
</script>
<template>
  <div class="local-workspace">
    <WorkspaceNavigation>
      <div class="local-toolbar"><span>{{ status }}</span><small>{{ locale.startsWith('zh') ? '本机交互终端' : 'Local interactive terminal' }}</small><button class="button secondary" :disabled="ready || starting" @click="start">{{ locale.startsWith('zh') ? '重新打开' : 'Reopen' }}</button></div>
    </WorkspaceNavigation>
    <p v-if="error" class="local-error" role="alert">{{ error }}</p>
    <div ref="host" class="local-terminal"/>
  </div>
</template>
<style scoped>
.local-workspace{height:100%;display:flex;flex-direction:column;min-height:0;background:var(--terminal-bg,#0b0e11)}.local-toolbar{display:flex;align-items:center;gap:14px;min-width:0;color:var(--text);font-size:12px}.local-toolbar small{color:var(--muted)}.local-toolbar>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.local-toolbar button{white-space:nowrap;font-size:11px}.local-toolbar button{margin-left:auto}.local-terminal{flex:1;min-height:0;overflow:hidden;padding:8px}.local-error{color:var(--red);padding:8px 16px;font-size:12px;overflow-wrap:anywhere}
@media(max-width:900px){.local-toolbar small{display:none}}
</style>
