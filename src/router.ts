import { createRouter, createWebHashHistory } from "vue-router";
import DashboardView from "@/views/DashboardView.vue";
import WorkspaceView from "@/views/WorkspaceView.vue";
import LogsView from "@/views/LogsView.vue";
import SettingsView from "@/views/SettingsView.vue";

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", component: DashboardView },
    { path: "/server/:id", component: WorkspaceView },
    { path: "/logs", component: LogsView },
    { path: "/settings", component: SettingsView },
  ],
});
