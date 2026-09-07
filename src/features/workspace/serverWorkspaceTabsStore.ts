import { defineStore } from "pinia";

interface PersistedServerWorkspaceTabs {
  version: 1;
  openServerIds: string[];
  activeServerId: string;
}

const STORAGE_KEY = "opsark.serverWorkspaceTabs.v1";
const MAX_OPEN_SERVER_WINDOWS = 12;

function uniqueAvailableServerIds(value: unknown, availableServerIds: Set<string>) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((serverId): serverId is string => (
    typeof serverId === "string" && availableServerIds.has(serverId)
  )))].slice(0, MAX_OPEN_SERVER_WINDOWS);
}

/** 保存服务器窗口顺序和活动窗口；终端输出与连接凭据不进入该存储。 */
export const useServerWorkspaceTabsStore = defineStore("serverWorkspaceTabs", {
  state: () => ({
    hydrated: false,
    openServerIds: [] as string[],
    activeServerId: "",
  }),
  actions: {
    hydrate(availableServerIds: string[], currentServerId: string) {
      const available = new Set(availableServerIds);
      if (!this.hydrated) {
        this.hydrated = true;
        try {
          const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<PersistedServerWorkspaceTabs>;
          if (parsed.version === 1) {
            this.openServerIds = uniqueAvailableServerIds(parsed.openServerIds, available);
            if (typeof parsed.activeServerId === "string" && available.has(parsed.activeServerId)) {
              this.activeServerId = parsed.activeServerId;
            }
          }
        } catch {
          // 损坏的窗口记录不影响服务器连接，按当前路由重新建立。
        }
      } else {
        this.openServerIds = this.openServerIds.filter((serverId) => available.has(serverId));
      }
      if (available.has(currentServerId)) this.open(currentServerId);
      else this.persist();
    },
    open(serverId: string) {
      if (!this.openServerIds.includes(serverId)) {
        if (this.openServerIds.length >= MAX_OPEN_SERVER_WINDOWS) this.openServerIds.shift();
        this.openServerIds.push(serverId);
      }
      this.activeServerId = serverId;
      this.persist();
    },
    activate(serverId: string) {
      if (!this.openServerIds.includes(serverId)) return false;
      this.activeServerId = serverId;
      this.persist();
      return true;
    },
    close(serverId: string) {
      const index = this.openServerIds.indexOf(serverId);
      if (index < 0) return this.activeServerId;
      this.openServerIds.splice(index, 1);
      if (this.activeServerId === serverId) {
        this.activeServerId = this.openServerIds[Math.min(index, this.openServerIds.length - 1)] ?? "";
      }
      this.persist();
      return this.activeServerId;
    },
    persist() {
      const value: PersistedServerWorkspaceTabs = {
        version: 1,
        openServerIds: this.openServerIds,
        activeServerId: this.activeServerId,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    },
  },
});

export { MAX_OPEN_SERVER_WINDOWS, STORAGE_KEY };
