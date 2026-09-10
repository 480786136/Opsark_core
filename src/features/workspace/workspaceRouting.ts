import type { Pinia } from "pinia";
import type { Router } from "vue-router";
import { useOpsStore } from "@/stores/ops";
import { LOCAL_WORKSPACE_ID, useServerWorkspaceTabsStore } from "./serverWorkspaceTabsStore";
import { LAST_WORKSPACE, workspaceTabPath } from "./workspaceEntry";

const closeQueues = new WeakMap<Router, Promise<void>>();

/** Serialize rapid closes and leave the active tab intact until navigation commits. */
export function closeWorkspaceTab(router: Router, id: string, pinia?: Pinia): Promise<void> {
  const close = async () => {
    const tabs = useServerWorkspaceTabsStore(pinia);
    const index = tabs.openTabs.findIndex(tab => tab.id === id);
    if (index < 0) return;
    if (tabs.activeTabId === id) {
      const nextId = tabs.openTabs[index + 1]?.id ?? tabs.openTabs[index - 1]?.id ?? LOCAL_WORKSPACE_ID;
      if (nextId === id) return;
      const failure = await router.replace(workspaceTabPath(nextId));
      if (failure) return;
    }
    tabs.close(id);
  };
  const pending = (closeQueues.get(router) ?? Promise.resolve()).then(close);
  const settled = pending.catch(() => {});
  closeQueues.set(router, settled);
  void settled.then(() => { if (closeQueues.get(router) === settled) closeQueues.delete(router); });
  return pending;
}

/** Only a committed route may open/activate a workspace. Cached views never do. */
export function installWorkspaceTabRouting(router: Router, pinia?: Pinia) {
  return router.afterEach((to, _from, failure) => {
    if (failure) return;
    const serverIds = useOpsStore(pinia).servers.map(server => server.id);
    const tabs = useServerWorkspaceTabsStore(pinia);
    tabs.hydrate(serverIds);
    const id = to.path === "/local" ? LOCAL_WORKSPACE_ID
      : to.path.startsWith("/server/") && typeof to.params.id === "string" && serverIds.includes(to.params.id)
        ? to.params.id : "";
    if (!id) return;
    tabs.open(id);
    try { localStorage.setItem(LAST_WORKSPACE, to.path); }
    catch { /* The legacy navigation hint must not block a committed route. */ }
  });
}
