<script setup lang="ts">
import { onMounted } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { Boxes, LayoutDashboard, ScrollText, Settings, ShieldCheck } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import AppearanceControls from "@/features/preferences/AppearanceControls.vue";
import { useOpsStore } from "@/stores/ops";

const route = useRoute();
const store = useOpsStore();
const { t } = useI18n();

onMounted(() => void store.hydrateCredentials());
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
