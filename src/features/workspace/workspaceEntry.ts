import { LOCAL_WORKSPACE_ID, type WorkspaceTab } from "./serverWorkspaceTabsStore";

export const LAST_WORKSPACE = "opsark.lastWorkspace.v1";

export function workspaceTabPath(id: string) {
  return id === LOCAL_WORKSPACE_ID ? "/local" : `/server/${id}`;
}

/** Return to an open tab, never reopen a configured but explicitly closed server. */
export function workspaceEntry(openTabs: WorkspaceTab[], activeTabId: string) {
  const tab = openTabs.find(item => item.id === activeTabId) ?? openTabs[0];
  return tab ? workspaceTabPath(tab.id) : "/local";
}
