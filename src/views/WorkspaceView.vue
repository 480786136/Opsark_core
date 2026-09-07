<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ChevronLeft, KeyRound, Plus, RefreshCw, Server, Wifi, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import AgentConsole from "@/components/AgentConsole.vue";
import FileExplorer from "@/components/FileExplorer.vue";
import MetricsBar from "@/components/MetricsBar.vue";
import TerminalWorkspace from "@/features/terminal/TerminalWorkspace.vue";
import WorkspaceToolbar from "@/features/workspace/WorkspaceToolbar.vue";
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
const { t } = useI18n();
const serverId = computed(() => String(route.params.id));
const server = computed(() => store.servers.find((item) => item.id === serverId.value));
const openedServers = computed(() => windowTabs.openServerIds
  .map((id) => store.servers.find((item) => item.id === id))
  .filter((item): item is NonNullable<typeof item> => Boolean(item)));
const connecting = ref(false);
const serverMenuOpen = ref(false);
const password = ref("");
const isLive = computed(() => store.connectedServerIds.includes(serverId.value));
const editorEntry = ref<FileEntry>();
const workspaceGrid = ref<HTMLElement>();
const viewActive = ref(true);
let interval: number | undefined;
let stopResize: (() => void) | undefined;
let serverActivationVersion = 0;

const workspaceGridStyle = computed<Record<string, string>>(() => ({
  "--files-column": `${layout.columns.files}fr`,
  "--terminal-column": `${layout.columns.terminal}fr`,
  "--agent-column": `${layout.columns.agent}fr`,
}));
const workspaceGridClass = computed(() => ({
  [`focus-${layout.focusPanel}`]: Boolean(layout.focusPanel),
  "has-focus": Boolean(layout.focusPanel),
}));

function startMetricsTimer() {
  if (interval !== undefined) return;
  interval = window.setInterval(() => void store.refreshMetrics(serverId.value), 10000);
}

function stopMetricsTimer() {
  if (interval !== undefined) window.clearInterval(interval);
  interval = undefined;
}

onMounted(startMetricsTimer);
onActivated(() => {
  viewActive.value = true;
  startMetricsTimer();
});
onDeactivated(() => {
  viewActive.value = false;
  stopMetricsTimer();
});
onBeforeUnmount(() => {
  stopMetricsTimer();
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

async function connect() {
  if (!password.value || !server.value) return;
  await store.connectServer(server.value.id, password.value);
  password.value = "";
  connecting.value = server.value.status !== "online";
}

function refreshOrConnect() {
  if (isLive.value && server.value) void store.refreshServer(server.value.id);
  else connecting.value = true;
}

function refreshFileDirectory() {
  if (!server.value) return;
  const connection = store.getRuntimeConnection(server.value.id);
  if (!connection) return;
  const currentPath = files.ensureServer(server.value.id).currentPath;
  void files.loadDirectory(server.value.id, connection, currentPath);
}

function switchServer(nextServerId: string) {
  serverMenuOpen.value = false;
  windowTabs.open(nextServerId);
  if (nextServerId !== serverId.value) void router.push(`/server/${nextServerId}`);
}

function closeServerWindow(serverWindowId: string) {
  const nextServerId = windowTabs.close(serverWindowId);
  if (serverWindowId !== serverId.value) return;
  if (nextServerId) void router.replace(`/server/${nextServerId}`);
  else void router.push("/");
}

watch(serverId, async (nextServerId) => {
  const activationVersion = serverActivationVersion + 1;
  serverActivationVersion = activationVersion;
  serverMenuOpen.value = false;
  connecting.value = false;
  editorEntry.value = undefined;
  windowTabs.hydrate(store.servers.map(({ id }) => id), nextServerId);
  const connected = await store.ensureServerConnected(nextServerId);
  if (activationVersion !== serverActivationVersion || nextServerId !== serverId.value) return;
  connecting.value = !connected;
  void store.refreshMetrics(nextServerId);
}, { immediate: true });

</script>

<template>
  <div v-if="server" class="workspace">
    <header class="workspace-header">
      <button class="back-button" @click="router.push('/')"><ChevronLeft :size="18" /></button>
      <nav class="workspace-server-tabs" :aria-label="t('workspace.serverWindows')">
        <div
          v-for="option in openedServers"
          :key="option.id"
          :class="['workspace-server-window-tab', { active: option.id === server.id }]"
        >
          <button type="button" :title="`${option.username}@${option.host}`" @click="switchServer(option.id)">
            <span :class="['workspace-server-status', option.status]" />
            <span>{{ option.name }}</span>
          </button>
          <button type="button" class="workspace-server-window-close" :title="t('workspace.closeServerWindow')" @click.stop="closeServerWindow(option.id)"><X :size="11" /></button>
        </div>
      </nav>
      <div class="workspace-server-tab-add">
        <button type="button" :title="t('workspace.openServerWindow')" :aria-expanded="serverMenuOpen" @click="serverMenuOpen = !serverMenuOpen"><Plus :size="14" /></button>
        <Transition name="layout-menu">
          <section v-if="serverMenuOpen" class="workspace-server-menu" @keydown.esc="serverMenuOpen = false">
            <header>{{ t("workspace.openServerWindow") }}</header>
            <button
              v-for="option in store.servers"
              :key="option.id"
              type="button"
              :class="{ active: option.id === server.id }"
              @click="switchServer(option.id)"
            >
              <span :class="['workspace-server-status', option.status]" />
              <span><strong>{{ option.name }}</strong><small>{{ option.username }}@{{ option.host }}</small></span>
              <span v-if="windowTabs.openServerIds.includes(option.id)" class="workspace-server-open-mark">{{ t("workspace.opened") }}</span>
            </button>
          </section>
        </Transition>
      </div>
      <div :class="['workspace-env', { live: isLive, preparing: !isLive }]"><Wifi :size="13" />{{ isLive ? t("workspace.liveSession") : t("workspace.preparingSession") }}</div>
      <WorkspaceToolbar />
      <button class="refresh-button" :disabled="store.isCollecting" @click="refreshOrConnect">
        <RefreshCw v-if="isLive" :class="{ spin: store.isCollecting }" :size="15" />
        <KeyRound v-else :size="14" />{{ isLive ? t("workspace.refreshEnvironment") : t("workspace.connectServer") }}
      </button>
    </header>
    <div ref="workspaceGrid" :class="['workspace-grid', workspaceGridClass]" :style="workspaceGridStyle">
      <FileExplorer :key="`files-${server.id}`" :server-id="server.id" @edit="editorEntry = $event" />
      <button
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
          :workspace-active="viewActive && option.id === server.id"
        />
      </section>
      <button
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
        />
      </section>
    </div>
    <MetricsBar />
    <div v-if="editorEntry" class="workspace-editor-backdrop">
      <FileEditorPanel
        :key="`${server.id}-${editorEntry.path}`"
        :server-id="server.id"
        :entry="editorEntry"
        @close="editorEntry = undefined"
        @saved="refreshFileDirectory"
      />
    </div>
    <div v-if="connecting" class="modal-backdrop" @click.self="connecting = false">
      <form class="modal-card connection-card" @submit.prevent="connect">
        <div class="modal-title">
          <div><h2>{{ t("workspace.connectTitle") }}</h2><p>{{ server.username }}@{{ server.host }}:{{ server.port }}</p></div>
          <button class="icon-button" type="button" @click="connecting = false"><X :size="18" /></button>
        </div>
        <label>{{ t("workspace.password") }}<input v-model="password" type="password" autocomplete="current-password" :placeholder="t('workspace.passwordPlaceholder')" autofocus /></label>
        <p class="security-hint"><KeyRound :size="14" />{{ t("workspace.securityHint") }}</p>
        <div class="modal-actions">
          <button class="button secondary" type="button" @click="connecting = false">{{ t("common.cancel") }}</button>
          <button class="button primary" type="submit" :disabled="!password || store.isCollecting">{{ store.isCollecting ? t("workspace.connecting") : t("workspace.connectAndCollect") }}</button>
        </div>
      </form>
    </div>
  </div>
  <div v-else class="not-found">
    <Server :size="34" /><h2>{{ t("workspace.notFound") }}</h2><button class="button primary" @click="router.push('/')">{{ t("workspace.backToServers") }}</button>
  </div>
</template>
