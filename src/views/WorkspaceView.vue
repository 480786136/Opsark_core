<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { RefreshCw, Server, Wifi, WifiOff } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import AgentConsole from "@/components/AgentConsole.vue";
import FileExplorer from "@/components/FileExplorer.vue";
import MetricsBar from "@/components/MetricsBar.vue";
import TerminalWorkspace from "@/features/terminal/TerminalWorkspace.vue";
import WorkspaceNavigation from "@/features/workspace/WorkspaceNavigation.vue";
import WorkspaceToolbar from "@/features/workspace/WorkspaceToolbar.vue";
import ConnectionOverlay from "@/features/workspace/ConnectionOverlay.vue";
import AddServerModal from "@/components/AddServerModal.vue";
import {
  resizeWorkspaceColumns,
  useWorkspaceLayoutStore,
  type WorkspaceResizeHandle,
} from "@/features/workspace/workspaceLayoutStore";
import { useOpsStore } from "@/stores/ops";
import FileEditorPanel from "@/features/files/FileEditorPanel.vue";
import { useFileWorkspaceStore } from "@/features/files/fileWorkspaceStore";
import type { FileEntry } from "@/types";
import { useServerWorkspaceTabsStore } from "@/features/workspace/serverWorkspaceTabsStore";

defineOptions({ name: "WorkspaceView" });

const route = useRoute();
const router = useRouter();
const store = useOpsStore();
const layout = useWorkspaceLayoutStore();
const files = useFileWorkspaceStore();
const windowTabs = useServerWorkspaceTabsStore();
layout.hydrate();
const { t, locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
// KeepAlive views still observe the global route while hidden. Retain the last
// server so switching to Local cannot unmount its terminal/Agent subtree.
const serverId = ref(typeof route.params.id === "string" ? route.params.id : "");
watch(() => route.path, () => {
  if (route.path.startsWith("/server/") && typeof route.params.id === "string") {
    serverId.value = route.params.id;
  }
});
const server = computed(() => store.servers.find((item) => item.id === serverId.value));
const openedServers = computed(() => windowTabs.openServerIds
  .map((id) => store.servers.find((item) => item.id === id))
  .filter((item): item is NonNullable<typeof item> => Boolean(item)));
const connection = computed(() => store.serverConnection(serverId.value));
const isLive = computed(() => store.isServerConnected(serverId.value));
const connectionBusy = computed(() => ["connecting", "reconnecting", "suspect"].includes(connection.value.status));
const readOnlyServers = ref<Record<string, boolean>>({});
const editingServer = ref(false);
const connectionLabel = computed(() => ({
  idle: zh.value ? "未连接" : "Not connected",
  connecting: zh.value ? "正在连接" : "Connecting",
  connected: zh.value ? "SSH 已连接" : "SSH connected",
  suspect: zh.value ? "正在确认连接" : "Checking connection",
  reconnecting: zh.value ? "正在重连" : "Reconnecting",
  manual: zh.value ? "需要手动重连" : "Reconnect required",
  auth_failed: zh.value ? "身份验证失败" : "Authentication failed",
  disconnected: zh.value ? "已断开" : "Disconnected",
})[connection.value.status]);
const connectionDetail = computed(() => [connectionLabel.value, connection.value.phase, connection.value.error].filter(Boolean).join(" · "));
const editorEntry = ref<FileEntry>();
const workspaceGrid = ref<HTMLElement>();
const connectionOverlays = ref<InstanceType<typeof ConnectionOverlay>[]>([]);
const viewActive = ref(true);
let stopResize: (() => void) | undefined;

const allPanelsVisible = computed(() => Object.values(layout.visiblePanels).every(Boolean));
const workspaceGridStyle = computed<Record<string, string>>(() => ({
  gridTemplateColumns: (["files", "terminal", "agent"] as const).filter(panel => layout.visiblePanels[panel]).map(panel => `minmax(0, ${layout.columns[panel]}fr)`).join(allPanelsVisible.value ? " 5px " : " "),
  "--files-column": `${layout.columns.files}fr`,
  "--terminal-column": `${layout.columns.terminal}fr`,
  "--agent-column": `${layout.columns.agent}fr`,
}));
const workspaceGridClass = computed(() => ({
  [`focus-${layout.focusPanel}`]: Boolean(layout.focusPanel),
  "has-focus": Boolean(layout.focusPanel),
  "hide-files": !layout.visiblePanels.files,
  "hide-terminal": !layout.visiblePanels.terminal,
  "hide-agent": !layout.visiblePanels.agent,
}));

onActivated(() => {
  viewActive.value = true;
});
onDeactivated(() => {
  viewActive.value = false;
  stopResize?.();
});
onBeforeUnmount(() => {
  stopResize?.();
});

function nudgeResize(handle: WorkspaceResizeHandle, deltaPercent: number) {
  if (layout.focusPanel) return;
  layout.setColumns(resizeWorkspaceColumns(layout.columns, handle, deltaPercent));
}

function startResize(handle: WorkspaceResizeHandle, event: PointerEvent) {
  if (layout.focusPanel || !workspaceGrid.value) return;
  event.preventDefault();
  const startX = event.clientX;
  const startColumns = { ...layout.columns };
  const gridWidth = workspaceGrid.value.clientWidth;
  if (gridWidth <= 0) return;

  document.body.classList.add("workspace-resizing");
  const onMove = (moveEvent: PointerEvent) => {
    const deltaPercent = ((moveEvent.clientX - startX) / gridWidth) * 100;
    layout.setColumns(resizeWorkspaceColumns(startColumns, handle, deltaPercent), false);
  };
  const onEnd = () => {
    layout.persist();
    document.body.classList.remove("workspace-resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onEnd);
    window.removeEventListener("pointercancel", onEnd);
    stopResize = undefined;
  };

  stopResize?.();
  stopResize = onEnd;
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onEnd);
  window.addEventListener("pointercancel", onEnd);
}

function refreshOrConnect() {
  if (isLive.value && server.value) void store.refreshServer(server.value.id);
  else if (!connectionBusy.value) void connectionOverlays.value.find(overlay => overlay.serverId === serverId.value)?.reconnect();
}

function viewTerminalHistory() {
  if (!layout.visiblePanels.terminal) layout.togglePanel("terminal");
  layout.clearFocus();
  void nextTick(() => workspaceGrid.value?.querySelector<HTMLElement>(".terminal-workspace-stack [tabindex]")?.focus());
}

function refreshFileDirectory() {
  if (!server.value || !isLive.value) return;
  const connection = store.getRuntimeConnection(server.value.id);
  if (!connection) return;
  const currentPath = files.ensureServer(server.value.id).currentPath;
  void files.loadDirectory(server.value.id, connection, currentPath);
}

watch(serverId, (nextServerId) => {
  if (!nextServerId || !store.servers.some(server => server.id === nextServerId)) return;
  editingServer.value = false;
  editorEntry.value = undefined;
  void store.ensureServerConnected(nextServerId);
}, { immediate: true });

</script>

<template>
  <div v-if="server" class="workspace">
    <WorkspaceNavigation>
      <div :class="['workspace-env', 'workspace-connection-status', connection.status]" :title="connectionDetail" tabindex="0"><Wifi v-if="isLive || connectionBusy" :size="13"/><WifiOff v-else :size="13"/><span>{{ connectionLabel }}</span></div>
      <WorkspaceToolbar />
      <button class="refresh-button" :title="isLive ? t('workspace.refreshEnvironment') : connectionBusy ? connectionLabel : (zh ? '重新连接' : 'Reconnect')" :aria-label="isLive ? t('workspace.refreshEnvironment') : connectionBusy ? connectionLabel : (zh ? '重新连接' : 'Reconnect')" :disabled="store.isCollecting || connectionBusy" @click="refreshOrConnect">
        <RefreshCw v-if="isLive" :class="{ spin: store.isCollecting }" :size="15" />
        <RefreshCw v-else :size="14" /><span class="refresh-button-copy">{{ isLive ? t("workspace.refreshEnvironment") : connectionBusy ? (zh ? '正在连接' : 'Connecting') : (zh ? '重新连接' : 'Reconnect') }}</span>
      </button>
    </WorkspaceNavigation>
    <div class="workspace-content">
      <ConnectionOverlay
        v-for="option in openedServers"
        ref="connectionOverlays"
        :key="`connection-${option.id}`"
        :server-id="option.id"
        :active="viewActive && option.id === server.id"
        @readonly-change="readOnlyServers[option.id] = $event"
        @view-history="viewTerminalHistory"
        @configure="editingServer = true"
      />
    <div ref="workspaceGrid" :class="['workspace-grid', workspaceGridClass]" :style="workspaceGridStyle" :inert="!isLive && !readOnlyServers[server.id]" :aria-hidden="!isLive && !readOnlyServers[server.id] ? true : undefined">
      <FileExplorer :key="`files-${server.id}`" :server-id="server.id" @edit="editorEntry = $event" />
      <button
        v-if="allPanelsVisible"
        class="workspace-resizer"
        type="button"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('workspace.resizeFilesTerminal')"
        :title="t('workspace.resizeFilesTerminal')"
        @pointerdown="startResize('files-terminal', $event)"
        @keydown.left.prevent="nudgeResize('files-terminal', -2)"
        @keydown.right.prevent="nudgeResize('files-terminal', 2)"
      />
      <section class="work-panel terminal-workspace-stack">
        <TerminalWorkspace
          v-for="option in openedServers"
          v-show="option.id === server.id"
          :key="`terminal-${option.id}`"
          :server-id="option.id"
          :active="viewActive && option.id === server.id"
          :workspace-active="viewActive && option.id === server.id"
        />
      </section>
      <button
        v-if="allPanelsVisible"
        class="workspace-resizer"
        type="button"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('workspace.resizeTerminalAgent')"
        :title="t('workspace.resizeTerminalAgent')"
        @pointerdown="startResize('terminal-agent', $event)"
        @keydown.left.prevent="nudgeResize('terminal-agent', -2)"
        @keydown.right.prevent="nudgeResize('terminal-agent', 2)"
      />
      <section class="work-panel agent-workspace-stack">
        <AgentConsole
          v-for="option in openedServers"
          v-show="option.id === server.id"
          :key="`agent-${option.id}`"
          :server-id="option.id"
          :active="viewActive && option.id === server.id"
        />
      </section>
      <p v-if="!Object.values(layout.visiblePanels).some(Boolean)" class="workspace-panels-empty">点击顶部文件、终端或 AI 图标显示对应区域</p>
    </div>
    </div>
    <MetricsBar :server-id="server.id" />
    <div v-if="editorEntry" class="workspace-editor-backdrop">
      <FileEditorPanel
        :key="`${server.id}-${editorEntry.path}`"
        :server-id="server.id"
        :entry="editorEntry"
        @close="editorEntry = undefined"
        @saved="refreshFileDirectory"
      />
    </div>
    <AddServerModal v-if="editingServer" :server="server" @close="editingServer = false" />
  </div>
  <div v-else class="not-found">
    <Server :size="34" /><h2>{{ t("workspace.notFound") }}</h2><button class="button primary" @click="router.push('/')">{{ t("workspace.backToServers") }}</button>
  </div>
</template>

<style scoped>
.workspace-content{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}.workspace-content>.workspace-grid{flex:1;min-height:0;width:100%}.workspace-connection-status{max-width:180px;min-width:0;gap:6px;color:var(--muted);font-size:10px}.workspace-connection-status>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workspace-connection-status.connected{color:var(--green)}.workspace-connection-status.connecting,.workspace-connection-status.reconnecting{color:var(--accent)}.workspace-connection-status.suspect,.workspace-connection-status.manual{color:var(--orange)}.workspace-connection-status.auth_failed{color:var(--red)}.workspace-connection-status:focus-visible,.refresh-button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.refresh-button{white-space:nowrap}.refresh-button:disabled{cursor:default;opacity:.5}@media(max-width:750px){.workspace-connection-status{max-width:90px}.refresh-button-copy{display:none}}
</style>
