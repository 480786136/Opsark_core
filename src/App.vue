<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { ArrowUpRight, BrainCircuit, KeyRound, LayoutDashboard, ScrollText, Settings, Sparkles, UserRound, Wrench, ShieldCheck, CircleHelp } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import opsarkLogo from "@/assets/opsark-logo.png";
import AppearanceControls from "@/features/preferences/AppearanceControls.vue";
import WindowTitleBar from "@/components/WindowTitleBar.vue";
import { useOpsStore } from "@/stores/ops";
import { useAccountStore } from "@/features/account/accountStore";
import { useSkillAutoSyncStore } from "@/features/skills/skillAutoSync";
import { useUpdateStore } from "@/features/support/updateStore";
import { useServerWorkspaceTabsStore } from "@/features/workspace/serverWorkspaceTabsStore";

const route = useRoute();
const showDevelopmentFeatures = import.meta.env.DEV;
const macWindow = /Mac/i.test(navigator.platform);
const customFrame = "__TAURI_INTERNALS__" in window && (macWindow || /Win/i.test(navigator.platform));
const store = useOpsStore();
const account = useAccountStore();
// Account and local edits sync even when the Skill management route is closed.
useSkillAutoSyncStore();
const updates = useUpdateStore();
const workspaceTabs = useServerWorkspaceTabsStore();
// Switching preserves sessions; explicitly closing their tabs releases the cache.
const cachedWorkspaceViews = computed(() => [
  ...(workspaceTabs.openServerIds.length ? ["WorkspaceView"] : []),
  ...(workspaceTabs.openTabs.some(tab => tab.kind === "local") ? ["LocalWorkspaceView"] : []),
]);
const { t } = useI18n();
let accountValidationTimer: ReturnType<typeof window.setInterval> | undefined;
const validateAccountSession = () => { if (!document.hidden) void account.validateSession(); };

function suppressBrowserContextMenu(event: MouseEvent) {
  // Opsark is a desktop console. Browser actions such as Reload, Translate and
  // Inspect Element are unrelated to the workspace; feature-owned menus (for
  // example SFTP entries) already handle the event before it reaches here.
  event.preventDefault();
}

onMounted(() => {
  document.documentElement.classList.toggle("desktop-window", customFrame);
  void store.hydrateCredentials();
  void account.initialize();
  void updates.check();
  store.startConnectionMonitor();
  document.addEventListener("contextmenu", suppressBrowserContextMenu);
  window.addEventListener("focus", validateAccountSession);
  document.addEventListener("visibilitychange", validateAccountSession);
  accountValidationTimer = window.setInterval(validateAccountSession, 30_000);
});
onBeforeUnmount(() => {
  store.stopConnectionMonitor();
  document.documentElement.classList.remove("desktop-window");
  document.removeEventListener("contextmenu", suppressBrowserContextMenu);
  window.removeEventListener("focus", validateAccountSession);
  document.removeEventListener("visibilitychange", validateAccountSession);
  if (accountValidationTimer) window.clearInterval(accountValidationTimer);
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
        <RouterLink v-if="showDevelopmentFeatures" to="/tools" :title="t('nav.tools')">
          <Wrench :size="20" />
        </RouterLink>
        <RouterLink to="/skills" :title="t('nav.skills')">
          <Sparkles :size="20" />
        </RouterLink>
        <RouterLink v-if="showDevelopmentFeatures" to="/permissions" title="执行权限 / Execution permissions"><ShieldCheck :size="20" /></RouterLink>
        <RouterLink to="/support" title="帮助、反馈与更新 / Help & updates"><CircleHelp :size="20" /></RouterLink>
        <RouterLink v-if="showDevelopmentFeatures" to="/settings" :title="t('nav.settings')">
          <Settings :size="20" />
        </RouterLink>
      </nav>
      <div class="rail-bottom"><AppearanceControls /><RouterLink to="/account" :title="account.current?.user.email || 'OpsArk Account'" aria-label="OpsArk Account"><UserRound :size="20" /></RouterLink></div>
    </aside>
    <main :class="['app-main', { 'workspace-main': route.path.startsWith('/server/') || route.path === '/local' }]">
      <RouterView v-slot="{ Component }">
        <KeepAlive :include="cachedWorkspaceViews">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </main>
  </div>
  <Teleport to="body">
    <div v-if="updates.info?.latest && !updates.dismissed" class="update-dialog-backdrop">
      <section class="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
        <span class="update-dialog-eyebrow">OPSARK UPDATE</span>
        <h2 id="update-dialog-title">OpsArk {{ updates.info.latest.version }} 已发布</h2>
        <p class="update-dialog-platform">适用于 {{ updates.info.latest.platform }} / {{ updates.info.latest.arch }}</p>
        <div class="update-dialog-notes">{{ updates.info.latest.notes }}</div>
        <p v-if="updates.error" class="update-dialog-error" role="alert">{{ updates.error }}</p>
        <div class="update-dialog-actions">
          <button class="button secondary" type="button" @click="updates.later()">稍后提醒</button>
          <button class="button primary" type="button" :disabled="updates.busy" @click="updates.download()">
            {{ updates.busy ? "正在打开…" : "前往官网下载" }}<ArrowUpRight :size="15" />
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.app-shell.custom-window-frame{margin-top:36px;height:calc(100% - 36px)}
.update-dialog-backdrop{position:fixed;inset:0;z-index:1200;display:grid;place-items:center;padding:24px;background:rgba(6,10,18,.58);backdrop-filter:blur(4px)}
.update-dialog{width:min(460px,100%);padding:28px;border:1px solid var(--border);border-radius:16px;background:var(--panel);box-shadow:var(--shadow-dialog)}
.update-dialog-eyebrow{display:block;margin-bottom:12px;color:var(--accent);font:600 10px/1.2 'DM Mono',monospace;letter-spacing:.14em}
.update-dialog h2{margin:0;font-size:23px;line-height:1.3;letter-spacing:-.5px}
.update-dialog-platform{margin:8px 0 20px;color:var(--muted);font-size:12px}
.update-dialog-notes{max-height:240px;overflow:auto;padding:15px;border-radius:8px;background:var(--bg);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text);font-size:12px;line-height:1.75}
.update-dialog-error{margin:14px 0 0;color:var(--red);font-size:12px}
.update-dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}.update-dialog-actions .button{display:inline-flex;align-items:center;justify-content:center;gap:7px}
</style>

<style>
/* Outrank lazy-loaded scoped overlay rules (including inset: 0).
   Teleported dialogs must start below the desktop window controls. */
html.desktop-window body .drawer-overlay,
html.desktop-window body .modal-backdrop,
html.desktop-window body .knowledge-overlay,
html.desktop-window body .update-dialog-backdrop {
  top: 36px;
}
</style>
