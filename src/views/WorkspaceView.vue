<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ChevronLeft, KeyRound, RefreshCw, Server, Wifi, X } from "lucide-vue-next";
import AgentConsole from "@/components/AgentConsole.vue";
import FileExplorer from "@/components/FileExplorer.vue";
import MetricsBar from "@/components/MetricsBar.vue";
import StatusDot from "@/components/StatusDot.vue";
import TerminalPanel from "@/components/TerminalPanel.vue";
import { useOpsStore } from "@/stores/ops";

const route = useRoute();
const router = useRouter();
const store = useOpsStore();
const serverId = computed(() => String(route.params.id));
const server = computed(() => store.servers.find((item) => item.id === serverId.value));
const connecting = ref(false);
const password = ref("");
const isLive = computed(() => store.connectedServerIds.includes(serverId.value));
let interval: number | undefined;

onMounted(async () => {
  const connected = await store.ensureServerConnected(serverId.value);
  if (!connected) connecting.value = true;
  void store.refreshMetrics(serverId.value);
  interval = window.setInterval(() => void store.refreshMetrics(serverId.value), 10000);
});
onBeforeUnmount(() => window.clearInterval(interval));

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
</script>

<template>
  <div v-if="server" class="workspace">
    <header class="workspace-header">
      <button class="back-button" @click="router.push('/')"><ChevronLeft :size="18" /></button>
      <div class="server-icon-small"><Server :size="16" /></div>
      <div class="workspace-server"><strong>{{ server.name }}</strong><span>{{ server.username }}@{{ server.host }}</span></div>
      <StatusDot :status="server.status" />
      <div :class="['workspace-env', { live: isLive }]"><Wifi :size="13" />{{ isLive ? "真实 SSH 会话" : "安全演示模式" }}</div>
      <button class="refresh-button" :disabled="store.isCollecting" @click="refreshOrConnect">
        <RefreshCw v-if="isLive" :class="{ spin: store.isCollecting }" :size="15" />
        <KeyRound v-else :size="14" />{{ isLive ? "刷新环境" : "连接服务器" }}
      </button>
    </header>
    <div class="workspace-grid">
      <FileExplorer :server-id="server.id" />
      <TerminalPanel :server-id="server.id" />
      <AgentConsole :server-id="server.id" />
    </div>
    <MetricsBar />
    <div v-if="connecting" class="modal-backdrop" @click.self="connecting = false">
      <form class="modal-card connection-card" @submit.prevent="connect">
        <div class="modal-title">
          <div><h2>连接真实服务器</h2><p>{{ server.username }}@{{ server.host }}:{{ server.port }}</p></div>
          <button class="icon-button" type="button" @click="connecting = false"><X :size="18" /></button>
        </div>
        <label>SSH 密码<input v-model="password" type="password" autocomplete="current-password" placeholder="连接成功后保存到系统钥匙串" autofocus /></label>
        <p class="security-hint"><KeyRound :size="14" />密码仅写入 macOS 钥匙串，不进入 localStorage 或日志；下次进入时自动连接。</p>
        <div class="modal-actions">
          <button class="button secondary" type="button" @click="connecting = false">取消</button>
          <button class="button primary" type="submit" :disabled="!password || store.isCollecting">{{ store.isCollecting ? "正在连接…" : "连接并采集" }}</button>
        </div>
      </form>
    </div>
  </div>
  <div v-else class="not-found">
    <Server :size="34" /><h2>服务器不存在</h2><button class="button primary" @click="router.push('/')">返回服务器列表</button>
  </div>
</template>
