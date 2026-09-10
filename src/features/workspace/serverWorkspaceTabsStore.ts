import { defineStore } from "pinia";

export const LOCAL_WORKSPACE_ID = "local";
export const WORKSPACE_TABS_STORAGE_KEY = "opsark.workspaceTabs.v2";
export const LEGACY_STORAGE_KEY = "opsark.serverWorkspaceTabs.v1";
const LAST_WORKSPACE_STORAGE_KEY = "opsark.lastWorkspace.v1";
const STORAGE_KEY = WORKSPACE_TABS_STORAGE_KEY;
const MAX_OPEN_SERVER_WINDOWS = 12;

export interface WorkspaceTab {
  id: string;
  kind: "local" | "server";
}

interface PersistedWorkspaceTabs {
  version: 2;
  openTabs: WorkspaceTab[];
  activeTabId: string;
}

function localTab(): WorkspaceTab {
  return { id: LOCAL_WORKSPACE_ID, kind: "local" };
}

function validTabs(value: unknown, available?: Set<string>): WorkspaceTab[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tabs: WorkspaceTab[] = [];
  let serverCount = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || seen.has(entry.id)) continue;
    if (entry.kind === "local" && entry.id === LOCAL_WORKSPACE_ID) {
      tabs.push(localTab());
    } else if (
      entry.kind === "server" && entry.id !== LOCAL_WORKSPACE_ID && (!available || available.has(entry.id))
      && serverCount < MAX_OPEN_SERVER_WINDOWS
    ) {
      tabs.push({ id: entry.id, kind: "server" });
      serverCount += 1;
    } else {
      continue;
    }
    seen.add(entry.id);
  }
  return tabs;
}

function survivingActiveId(previous: WorkspaceTab[], tabs: WorkspaceTab[], activeId: string): string {
  const remaining = new Set(tabs.map(tab => tab.id));
  if (remaining.has(activeId)) return activeId;
  const index = previous.findIndex(tab => tab.id === activeId);
  if (index >= 0) {
    const right = previous.slice(index + 1).find(tab => remaining.has(tab.id));
    const left = previous.slice(0, index).reverse().find(tab => remaining.has(tab.id));
    const neighbor = right ?? left;
    if (neighbor) return neighbor.id;
  }
  return tabs[0].id;
}

/** Persist tab identity and order only; terminal output and credentials stay outside this store. */
export const useServerWorkspaceTabsStore = defineStore("serverWorkspaceTabs", {
  state: () => ({
    hydrated: false,
    openTabs: [localTab()] as WorkspaceTab[],
    activeTabId: LOCAL_WORKSPACE_ID,
  }),
  getters: {
    openServerIds: state => state.openTabs.filter(tab => tab.kind === "server").map(tab => tab.id),
    activeServerId: state => state.openTabs.find(tab => tab.id === state.activeTabId && tab.kind === "server")?.id ?? "",
  },
  actions: {
    hydrate(availableServerIds: string[], _currentTabId?: string) {
      const available = new Set(availableServerIds);
      if (!this.hydrated) {
        this.hydrated = true;
        try {
          const stored = localStorage.getItem(STORAGE_KEY);
          if (stored !== null) {
            const parsed = JSON.parse(stored) as Partial<PersistedWorkspaceTabs> | null;
            if (parsed?.version === 2) {
              this.openTabs = validTabs(parsed.openTabs);
              this.activeTabId = typeof parsed.activeTabId === "string" ? parsed.activeTabId : "";
            }
          } else {
            const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? "null");
            if (legacy?.version === 1) {
              const serverTabs = Array.isArray(legacy.openServerIds)
                ? legacy.openServerIds.map((id: unknown) => ({ id, kind: "server" }))
                : [];
              this.openTabs = validTabs([localTab(), ...serverTabs], available);
              const recent = localStorage.getItem(LAST_WORKSPACE_STORAGE_KEY);
              this.activeTabId = recent !== "/local" && this.openTabs.some(tab => tab.id === legacy.activeServerId)
                ? legacy.activeServerId
                : LOCAL_WORKSPACE_ID;
            }
          }
        } catch {
          // A damaged or unavailable saved record must not prevent opening the workspace.
        }
      }
      const previous = this.openTabs;
      const remaining = validTabs(previous, available);
      this.openTabs = remaining.length ? remaining : [localTab()];
      this.activeTabId = survivingActiveId(previous, this.openTabs, this.activeTabId);
      // Hydration only restores and cleans tabs. Route entry must explicitly open a tab;
      // otherwise a cached server view can reopen the tab the user just closed.
      this.persist();
    },
    open(id: string) {
      if (!id) return;
      if (!this.openTabs.some(tab => tab.id === id)) {
        const kind = id === LOCAL_WORKSPACE_ID ? "local" : "server";
        if (kind === "server" && this.openServerIds.length >= MAX_OPEN_SERVER_WINDOWS) {
          const oldestServer = this.openTabs.findIndex(tab => tab.kind === "server");
          this.openTabs.splice(oldestServer, 1);
        }
        this.openTabs.push({ id, kind });
      }
      this.activeTabId = id;
      this.persist();
    },
    activate(id: string) {
      if (!this.openTabs.some(tab => tab.id === id)) return false;
      this.activeTabId = id;
      this.persist();
      return true;
    },
    close(id: string) {
      const index = this.openTabs.findIndex(tab => tab.id === id);
      if (index < 0) return this.activeTabId;
      this.openTabs.splice(index, 1);
      if (!this.openTabs.length) this.openTabs.push(localTab());
      if (this.activeTabId === id) {
        this.activeTabId = this.openTabs[Math.min(index, this.openTabs.length - 1)].id;
      }
      this.persist();
      return this.activeTabId;
    },
    persist() {
      const value: PersistedWorkspaceTabs = {
        version: 2,
        openTabs: this.openTabs,
        activeTabId: this.activeTabId,
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {
        // Tabs remain usable when browser storage is unavailable or full.
      }
    },
  },
});

export { MAX_OPEN_SERVER_WINDOWS, STORAGE_KEY };
