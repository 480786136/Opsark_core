<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { Boxes, BrainCircuit, KeyRound, LayoutDashboard, ScrollText, Settings, Sparkles, Wrench } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import opsarkLogo from "@/assets/opsark-logo.png";
import AppearanceControls from "@/features/preferences/AppearanceControls.vue";
import WindowTitleBar from "@/components/WindowTitleBar.vue";
import { useOpsStore } from "@/stores/ops";
import { useServerWorkspaceTabsStore } from "@/features/workspace/serverWorkspaceTabsStore";

const route = useRoute();
const macWindow = /Mac/i.test(navigator.platform);
const customFrame = "__TAURI_INTERNALS__" in window && (macWindow || /Win/i.test(navigator.platform));
const store = useOpsStore();
const workspaceTabs = useServerWorkspaceTabsStore();
// Switching preserves sessions; explicitly closing their tabs releases the cache.
const cachedWorkspaceViews = computed(() => [
  ...(workspaceTabs.openServerIds.length ? ["WorkspaceView"] : []),
  ...(workspaceTabs.openTabs.some(tab => tab.kind === "local") ? ["LocalWorkspaceView"] : []),
]);
const { t } = useI18n();

function suppressBrowserContextMenu(event: MouseEvent) {
  // Opsark is a desktop console. Browser actions such as Reload, Translate and
  // Inspect Element are unrelated to the workspace; feature-owned menus (for
  // example SFTP entries) already handle the event before it reaches here.
  event.preventDefault();
}

onMounted(() => {
  document.documentElement.classList.toggle("desktop-window", customFrame);
  void store.hydrateCredentials();
  document.addEventListener("contextmenu", suppressBrowserContextMenu);
});
onBeforeUnmount(() => {
  document.documentElement.classList.remove("desktop-window");
  document.removeEventListener("contextmenu", suppressBrowserContextMenu);
});
</script>

<template>
  <WindowTitleBar v-if="customFrame" :mac="macWindow" />
  <div :class="['app-shell', { 'custom-window-frame': customFrame }]">
    <aside class="app-rail">
      <RouterLink class="brand" to="/workspace" :title="t('dashboard.openWorkspace')">
        <img :src="opsarkLogo" alt="Opsark" />
      </RouterLink>
      <nav>
        <RouterLink to="/" :title="t('nav.servers')">
          <LayoutDashboard :size="20" />
        </RouterLink>
        <RouterLink to="/logs" :title="t('nav.logs')">
          <ScrollText :size="20" />
        </RouterLink>
        <RouterLink to="/secrets" :title="t('nav.secrets')">
          <KeyRound :size="20" />
        </RouterLink>
        <RouterLink to="/models" :title="t('nav.models')">
          <BrainCircuit :size="20" />
        </RouterLink>
        <RouterLink to="/tools" :title="t('nav.tools')">
          <Wrench :size="20" />
        </RouterLink>
        <RouterLink to="/skills" :title="t('nav.skills')">
          <Sparkles :size="20" />
        </RouterLink>
        <RouterLink to="/settings" :title="t('nav.settings')">
          <Settings :size="20" />
        </RouterLink>
      </nav>
      <div class="rail-bottom"><AppearanceControls /><Boxes :size="18" /></div>
    </aside>
    <main :class="['app-main', { 'workspace-main': route.path.startsWith('/server/') || route.path === '/local' }]">
      <RouterView v-slot="{ Component }">
        <KeepAlive :include="cachedWorkspaceViews">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </main>
  </div>
</template>

<style scoped>
.app-shell.custom-window-frame{margin-top:36px;height:calc(100% - 36px)}
:global(.desktop-window .drawer-overlay), :global(.desktop-window .modal-backdrop), :global(.desktop-window .knowledge-overlay){top:36px}
</style>
