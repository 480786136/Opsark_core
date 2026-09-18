import { defineStore } from "pinia";
import { cloudRequest } from "@/features/account/cloudClient";
import { version } from "../../../package.json";
import { officialContentLoadError, officialVersions, syncOfficialRelease, type OfficialRelease } from "./officialContent";
import { useOpsStore } from "@/stores/ops";
export interface ClientRelease { id: string; version: string; notes: string; download_url: string; platform: string; arch: string }
export interface ClientInfo { current_version: string; support_email: string; support_url: string; feedback_retention_days: number;
  support_wechat?: string; developer_name?: string; contact_revision?: number;
  min_cloud_version: string; update_required: boolean; latest: ClientRelease | null;
  system_skills?: OfficialRelease | null; tools?: OfficialRelease | null }
export const DEFAULT_CONTACT = { support_email: "zgkj@zgspace.cn", support_wechat: "zgkjkj", developer_name: "智明", support_url: "" };
const CONTACT_KEY = "opsark.supportContact";
function mergeContact(current: typeof DEFAULT_CONTACT, value: Partial<typeof DEFAULT_CONTACT>) {
  const next = { ...current };
  for (const key of Object.keys(DEFAULT_CONTACT) as (keyof typeof DEFAULT_CONTACT)[]) {
    if (typeof value?.[key] === "string") next[key] = value[key]!.trim() || DEFAULT_CONTACT[key];
  }
  return next;
}
function savedContact() {
  try { return mergeContact(DEFAULT_CONTACT, JSON.parse(localStorage.getItem(CONTACT_KEY) || "{}")); }
  catch { return { ...DEFAULT_CONTACT }; }
}
export const useUpdateStore = defineStore("updates", {
  state: () => ({ info: null as ClientInfo | null, busy: false, error: "", currentVersion: version, dismissed: false,
    contact: savedContact(),
    contentVersions: officialVersions(), contentNotice: "", contentError: officialContentLoadError }),
  actions: {
    async check() {
      if (this.busy) return; this.busy = true; this.error = "";
      try {
        if (!("__TAURI_INTERNALS__" in window)) return;
        this.info = await cloudRequest<ClientInfo>("client_info");
        const contact = mergeContact(this.contact, this.info);
        if (JSON.stringify(contact) !== JSON.stringify(this.contact)) {
          this.contact = contact;
          try { localStorage.setItem(CONTACT_KEY, JSON.stringify(contact)); } catch { /* keep this session's contact */ }
        }
        this.contentError = ""; this.contentNotice = "";
        const errors: string[] = [], changed: string[] = [];
        // Revocations apply even when a Skill download fails. Each channel keeps its last valid release.
        for (const [kind, release] of [["tools", this.info.tools], ["skills", this.info.system_skills]] as const) {
          if (!release) continue;
          try {
            if (release.kind !== kind) throw new Error("官方发布类型不匹配");
            if (await syncOfficialRelease(release)) {
              useOpsStore().refreshOfficialContent();
              changed.push(`${kind === "skills" ? "官方 Skill" : "工具配置"} v${release.version}`);
            }
          } catch (e) { errors.push(`${kind === "skills" ? "官方 Skill" : "工具配置"}：${String(e)}（保留本地有效版本）`); }
        }
        this.contentVersions = officialVersions();
        this.contentError = errors.join("；");
        this.contentNotice = changed.length ? `已更新 ${changed.join("、")}` : "官方内容检查完成，当前使用本地有效版本。";
        let saved: { version?: string; until?: number } = {};
        try { saved = JSON.parse(localStorage.getItem("opsark.updateSnooze") || "{}") ?? {}; } catch { /* retry display */ }
        this.dismissed = saved.version === this.info.latest?.version && (saved.until ?? 0) > Date.now();
      } catch (e) { this.error = String(e); }
      finally { this.busy = false; }
    },
    later() {
      this.dismissed = true;
      try { localStorage.setItem("opsark.updateSnooze", JSON.stringify({ version: this.info?.latest?.version, until: Date.now() + 86400000 })); }
      catch { /* dismiss this process only */ }
    },
    async download() {
      if (!this.info?.latest || this.busy) return;
      this.busy = true; this.error = "";
      try { await cloudRequest("open_download", { id: this.info.latest.id }); }
      catch (e) { this.error = String(e); }
      finally { this.busy = false; }
    },
  },
});
