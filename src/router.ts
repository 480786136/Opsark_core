import { createRouter, createWebHashHistory } from "vue-router";

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", component: () => import("@/views/DashboardView.vue") },
    { path: "/server/:id", component: () => import("@/views/WorkspaceView.vue") },
    { path: "/logs", component: () => import("@/views/LogsView.vue") },
    { path: "/models", component: () => import("@/views/ModelManagementView.vue") },
    { path: "/secrets", component: () => import("@/views/SecretManagementView.vue") },
    { path: "/tools", component: () => import("@/views/ToolManagementView.vue") },
    { path: "/settings", component: () => import("@/views/SettingsView.vue") },
  ],
});
