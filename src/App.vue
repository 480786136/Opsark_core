<script setup lang="ts">
import { onMounted } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { Boxes, LayoutDashboard, ScrollText, Settings, ShieldCheck } from "lucide-vue-next";
import { useOpsStore } from "@/stores/ops";

const route = useRoute();
const store = useOpsStore();

onMounted(() => void store.hydrateCredentials());
</script>

<template>
  <div class="app-shell">
    <aside class="app-rail">
      <RouterLink class="brand" to="/" title="Opsark">
        <ShieldCheck :size="23" />
      </RouterLink>
      <nav>
        <RouterLink to="/" title="服务器">
          <LayoutDashboard :size="20" />
        </RouterLink>
        <RouterLink to="/logs" title="日志">
          <ScrollText :size="20" />
        </RouterLink>
        <RouterLink to="/settings" title="模型与设置">
          <Settings :size="20" />
        </RouterLink>
      </nav>
      <div class="rail-bottom"><Boxes :size="18" /></div>
    </aside>
    <main :class="['app-main', { 'workspace-main': route.path.startsWith('/server/') }]">
      <RouterView />
    </main>
  </div>
</template>
