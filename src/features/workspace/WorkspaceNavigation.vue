<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { ChevronLeft, Plus, SquareTerminal, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { localizeCoreText } from "@/features/preferences/coreText";
import { useOpsStore } from "@/stores/ops";
import { LOCAL_WORKSPACE_ID, useServerWorkspaceTabsStore } from "./serverWorkspaceTabsStore";
import { workspaceEntry, workspaceTabPath } from "./workspaceEntry";
import { closeWorkspaceTab } from "./workspaceRouting";

const ops = useOpsStore();
const tabs = useServerWorkspaceTabsStore();
const router = useRouter();
const route = useRoute();
const { t, locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const root = ref<HTMLElement>();
const picker = ref<HTMLButtonElement>();
const menuOpen = ref(false);
const closingIds = ref<string[]>([]);
const tooltipId = ref("");
const tooltipElement = ref<HTMLElement>();
const tooltipLeft = ref(0);
function positionTooltip() {
  const container = root.value;
  const card = tooltipElement.value;
  const anchor = Array.from(container?.querySelectorAll<HTMLElement>(".navigation-tab") ?? [])
    .find(tab => tab.dataset.workspaceId === tooltipId.value);
  if (!container || !card || !anchor) return;
  const bounds = container.getBoundingClientRect();
  const target = anchor.getBoundingClientRect();
  const minLeft = Math.max(bounds.left, 8);
  const maxLeft = Math.max(minLeft, Math.min(bounds.right, window.innerWidth - 8) - card.getBoundingClientRect().width);
  tooltipLeft.value = Math.min(Math.max(target.left, minLeft), maxLeft) - bounds.left;
}
watch(tooltipId, async () => { await nextTick(); positionTooltip(); });
function statusLabel(status: string) {
  return ({
    idle: zh.value ? "未连接" : "Not connected",
    connecting: zh.value ? "正在连接" : "Connecting",
    connected: zh.value ? "SSH 已连接" : "SSH connected",
    suspect: zh.value ? "正在确认连接" : "Checking connection",
    reconnecting: zh.value ? "正在重连" : "Reconnecting",
    manual: zh.value ? "需要手动重连" : "Reconnect required",
    auth_failed: zh.value ? "身份验证失败" : "Authentication failed",
    disconnected: zh.value ? "已断开" : "Disconnected",
  } as Record<string, string>)[status] ?? "Local";
}
const choices = computed(() => [
  { id: LOCAL_WORKSPACE_ID, kind: "local", name: "Local", title: t("workspace.localTerminal"), status: "" },
  ...ops.servers.map(server => ({ id: server.id, kind: "server", name: server.name, title: `${server.username}@${server.host}:${server.port}`, status: ops.serverConnection(server.id).status })),
]);
const tooltipTab = computed(() => choices.value.find(tab => tab.id === tooltipId.value));
const tooltipConnection = computed(() => tooltipTab.value?.kind === "server" ? ops.serverConnection(tooltipTab.value.id) : undefined);
const lastSuccess = computed(() => tooltipConnection.value?.lastSuccessAt
  ? new Date(tooltipConnection.value.lastSuccessAt).toLocaleString(locale.value, { hour12: false }) : "");
const openedTabs = computed(() => tabs.openTabs
  .map(tab => choices.value.find(choice => choice.id === tab.id))
  .filter((tab): tab is NonNullable<typeof tab> => Boolean(tab)));

watch(() => ops.servers.map(server => server.id), ids => {
  tabs.hydrate(ids);
  if (route.path.startsWith("/server/") && typeof route.params.id === "string" && !ids.includes(route.params.id)) {
    void router.replace(workspaceEntry(tabs.openTabs, tabs.activeTabId));
  }
}, { immediate: true });
watch(() => route.path, () => { menuOpen.value = false; tooltipId.value = ""; });
async function revealActive() {
  await nextTick();
  root.value?.querySelector('.navigation-tab.is-active')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}
watch(() => tabs.activeTabId, revealActive);
function open(id: string) {
  menuOpen.value = false;
  void router.push(workspaceTabPath(id));
}
async function close(id: string) {
  if (closingIds.value.includes(id)) return;
  closingIds.value.push(id);
  try { await closeWorkspaceTab(router, id); }
  finally { closingIds.value = closingIds.value.filter(value => value !== id); }
}
function dismiss(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target)) menuOpen.value = false;
}
function escape() { menuOpen.value = false; picker.value?.focus(); }
onMounted(() => {
  document.addEventListener("pointerdown", dismiss);
  window.addEventListener("resize", positionTooltip);
  void revealActive();
});
onActivated(revealActive);
onDeactivated(() => { menuOpen.value = false; tooltipId.value = ""; });
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", dismiss);
  window.removeEventListener("resize", positionTooltip);
});
</script>

<template>
  <header ref="root" class="workspace-navigation">
    <RouterLink class="navigation-back" to="/" :aria-label="t('workspace.backToServers')" :title="t('workspace.backToServers')"><ChevronLeft :size="18"/></RouterLink>
    <nav class="navigation-tabs" :aria-label="t('workspace.tabs')" @scroll="tooltipId = ''">
      <div v-for="tab in openedTabs" :key="tab.id" :class="['navigation-tab', { 'is-active': tabs.activeTabId === tab.id }]" :data-workspace-id="tab.id">
        <RouterLink class="navigation-tab-link" :to="workspaceTabPath(tab.id)" :aria-label="`${tab.name} · ${statusLabel(tab.status)} · ${tab.title}`" :aria-describedby="tooltipId === tab.id ? 'workspace-tab-tooltip' : undefined" :aria-current="tabs.activeTabId === tab.id ? 'page' : undefined" @mouseenter="tooltipId = tab.id" @mouseleave="tooltipId = ''" @focus="tooltipId = tab.id" @blur="tooltipId = ''"><SquareTerminal v-if="tab.kind === 'local'" :size="13"/><span v-else :class="['navigation-status', tab.status]" aria-hidden="true"/><span>{{ tab.name }}</span></RouterLink>
        <button class="navigation-tab-close" type="button" :disabled="closingIds.includes(tab.id) || (tab.kind === 'local' && openedTabs.length === 1)" :title="t(tab.kind === 'local' && openedTabs.length === 1 ? 'workspace.keepLocalTab' : 'workspace.closeTab')" :aria-label="`${t('workspace.closeTab')} · ${tab.name}`" @click="close(tab.id)"><X :size="12"/></button>
      </div>
    </nav>
    <div class="navigation-picker" @keydown.esc.stop="escape">
      <button ref="picker" class="navigation-add" type="button" :title="t('workspace.openTab')" :aria-label="t('workspace.openTab')" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen"><Plus :size="15"/></button>
      <section v-if="menuOpen" class="navigation-menu" :aria-label="t('workspace.openTab')">
        <header>{{ t('workspace.openTab') }}</header>
        <button v-for="tab in choices" :key="tab.id" type="button" @click="open(tab.id)"><SquareTerminal v-if="tab.kind === 'local'" :size="13"/><span v-else :class="['navigation-status', tab.status]"/><span><strong>{{ tab.name }}</strong><small>{{ tab.title }}</small></span><small v-if="tabs.openTabs.some(opened => opened.id === tab.id)" class="navigation-open-mark">{{ t('workspace.opened') }}</small></button>
        <RouterLink v-if="!ops.servers.length" to="/">{{ t('dashboard.addServer') }}</RouterLink>
      </section>
    </div>
    <div v-if="$slots.default" class="navigation-actions"><slot/></div>
    <aside v-if="tooltipTab" ref="tooltipElement" id="workspace-tab-tooltip" class="navigation-tooltip" role="tooltip" :style="{ left: `${tooltipLeft}px` }">
      <strong>{{ tooltipTab.name }}</strong><span>{{ tooltipTab.title }}</span>
      <span>{{ statusLabel(tooltipTab.status) }}<template v-if="tooltipConnection?.attempt"> · {{ zh ? `尝试 ${tooltipConnection.attempt} 次` : `Attempt ${tooltipConnection.attempt}` }}</template></span>
      <span v-if="lastSuccess">{{ zh ? '最近成功响应：' : 'Last successful response: ' }}{{ lastSuccess }}</span>
      <span v-if="tooltipConnection?.error" class="navigation-tooltip-error">{{ localizeCoreText(tooltipConnection.error) }}</span>
    </aside>
  </header>
</template>

<style scoped>
.workspace-navigation{position:relative;z-index:6;display:flex;align-items:center;flex:0 0 auto;width:100%;height:38px;min-width:0;padding:0 10px;gap:6px;border-bottom:1px solid var(--border);background:var(--chrome)}
.navigation-back,.navigation-add,.navigation-tab-close{display:grid;place-items:center;flex-shrink:0;border:0;background:transparent;color:var(--muted);text-decoration:none;cursor:pointer;padding:0}
.navigation-back{width:28px;height:28px;border-radius:4px}.navigation-back:hover{background:var(--hover);color:var(--text)}
.navigation-tabs{display:flex;flex:1;min-width:90px;height:100%;overflow-x:auto;scrollbar-width:none;overscroll-behavior-x:contain}.navigation-tabs::-webkit-scrollbar{display:none}
.navigation-tab{display:flex;align-items:center;flex:0 0 auto;min-width:112px;max-width:190px;height:100%;border-top:1px solid transparent;border-right:1px solid var(--border);background:var(--panel);color:var(--muted)}.navigation-tab:first-child{border-left:1px solid var(--border)}.navigation-tab:hover{background:var(--hover)}.navigation-tab.is-active{border-top-color:var(--accent);color:var(--text);background:var(--raised)}
.navigation-tab-link{height:100%;display:flex;align-items:center;gap:7px;flex:1;min-width:0;padding:0 12px;color:inherit;text-decoration:none;font-size:11px;white-space:nowrap}.navigation-tab-link>svg{flex-shrink:0}.navigation-tab-link>span:last-child{overflow:hidden;text-overflow:ellipsis}.navigation-tab-close{width:22px;height:24px;margin-right:4px;border-radius:3px}.navigation-tab-close:hover{color:var(--text);background:var(--hover)}
.navigation-status{width:6px;height:6px;flex-shrink:0;border-radius:50%;background:var(--muted)}.navigation-status.connected{background:var(--green)}.navigation-status.connecting,.navigation-status.reconnecting{background:var(--accent)}.navigation-status.suspect,.navigation-status.manual{background:var(--orange)}.navigation-status.auth_failed{background:var(--red)}
.navigation-picker{position:static;align-self:stretch;flex-shrink:0}.navigation-add{height:100%;width:32px;border-right:1px solid var(--border)}.navigation-add:hover,.navigation-add[aria-expanded=true]{color:var(--accent);background:var(--accent-soft)}
.navigation-menu{position:absolute;z-index:50;top:calc(100% + 4px);right:8px;width:min(310px,calc(100% - 16px));max-height:min(420px,60vh);overflow:auto;padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--raised);box-shadow:var(--shadow-popover)}.navigation-menu header{padding:8px;color:var(--muted);font-size:11px}.navigation-menu>button{display:flex;align-items:center;gap:8px;width:100%;padding:9px 8px;text-align:left;background:transparent;border:0;border-radius:4px;color:var(--text);cursor:pointer}.navigation-menu>button:hover{background:var(--hover)}.navigation-menu>button>span:nth-child(2){display:flex;flex-direction:column;gap:3px;min-width:0}.navigation-menu strong,.navigation-menu small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.navigation-menu small{color:var(--muted);font-weight:normal}.navigation-menu .navigation-open-mark{margin-left:auto;color:var(--accent);flex-shrink:0}.navigation-menu>a{display:block;padding:10px;color:var(--accent);font-size:12px}.navigation-actions{display:flex;align-items:center;gap:8px;flex:0 1 auto;min-width:0;max-width:55%}
a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:-3px}
.navigation-tooltip{position:absolute;z-index:51;left:40px;top:calc(100% + 6px);display:grid;gap:5px;width:max-content;max-width:min(410px,calc(100vw - 60px));padding:11px 13px;border:1px solid var(--border);border-radius:5px;background:var(--raised);box-shadow:var(--shadow-popover);font-size:11px;color:var(--muted);line-height:1.5;overflow-wrap:anywhere;pointer-events:none}.navigation-tooltip strong{color:var(--text);font-weight:600}.navigation-tooltip-error{color:var(--orange)}.navigation-back,.navigation-add,.navigation-tab,.navigation-tab-close{transition:background .18s,color .18s}.navigation-tab-close:active:enabled,.navigation-add:active{transform:translateY(1px)}.navigation-tab-close:disabled{opacity:.4;cursor:default}
@media(max-width:900px){.workspace-navigation{height:38px;padding:0 8px;gap:6px}.navigation-tab{min-width:96px;max-width:160px}}
@media(max-width:520px){.workspace-navigation{padding:0 5px;gap:3px}.navigation-tab{min-width:84px;max-width:120px}.navigation-tab-link{padding:0 8px}.navigation-back{width:25px}.navigation-actions{max-width:45%;gap:4px}}
@media(max-height:520px){.workspace-navigation{height:36px}}@media(prefers-reduced-motion:reduce){.navigation-back,.navigation-add,.navigation-tab,.navigation-tab-close{transition:none}}
</style>
