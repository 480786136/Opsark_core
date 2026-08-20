<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { Boxes, BrainCircuit, KeyRound, LayoutDashboard, ScrollText, Settings, ShieldCheck, Sparkles, Wrench } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import AppearanceControls from "@/features/preferences/AppearanceControls.vue";
import { useOpsStore } from "@/stores/ops";

const route = useRoute();
const store = useOpsStore();
const { t } = useI18n();

function suppressBrowserContextMenu(event: MouseEvent) {
  // Opsark is a desktop console. Browser actions such as Reload, Translate and
  // Inspect Element are unrelated to the workspace; feature-owned menus (for
  // example SFTP entries) already handle the event before it reaches here.
  event.preventDefault();
}

onMounted(() => {
  void store.hydrateCredentials();
  document.addEventListener("contextmenu", suppressBrowserContextMenu);
});
onBeforeUnmount(() => document.removeEventListener("contextmenu", suppressBrowserContextMenu));
</script>

<template>
  <div class="app-shell">
    <aside class="app-rail">
      <RouterLink class="brand" to="/" title="Opsark">
        <ShieldCheck :size="23" />
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
    <main :class="['app-main', { 'workspace-main': route.path.startsWith('/server/') }]">
      <RouterView v-slot="{ Component }">
        <KeepAlive include="WorkspaceView">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </main>
  </div>
</template>
