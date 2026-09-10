import { createRouter, createWebHashHistory } from "vue-router";
import { useOpsStore } from "@/stores/ops";
import { useServerWorkspaceTabsStore } from "@/features/workspace/serverWorkspaceTabsStore";
import { workspaceEntry } from "@/features/workspace/workspaceEntry";
import { installWorkspaceTabRouting } from "@/features/workspace/workspaceRouting";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", component: () => import("@/views/DashboardView.vue") },
    { path: "/local", component: () => import("@/views/LocalWorkspaceView.vue") },
    { path: "/workspace", redirect: () => {
      const ids = useOpsStore().servers.map(server => server.id);
      const tabs = useServerWorkspaceTabsStore();
      tabs.hydrate(ids);
      return workspaceEntry(tabs.openTabs, tabs.activeTabId);
    } },
    { path: "/server/:id", component: () => import("@/views/WorkspaceView.vue") },
    { path: "/logs", component: () => import("@/views/LogsView.vue") },
    { path: "/models", component: () => import("@/views/ModelManagementView.vue") },
    { path: "/secrets", component: () => import("@/views/SecretManagementView.vue") },
    { path: "/tools", component: () => import("@/views/ToolManagementView.vue") },
    { path: "/skills", component: () => import("@/views/SkillManagementView.vue") },
    { path: "/settings", component: () => import("@/views/SettingsView.vue") },
  ],
});
installWorkspaceTabRouting(router);
export default router;
