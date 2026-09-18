import { defineStore } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { useOpsStore } from "@/stores/ops";
import { officialPreferences } from "./officialModelSettings";

export interface AccountSnapshot {
  billingMode?: "direct" | "reserved";
  githubLinked?: boolean;
  user: { id: string; email: string };
  balance: { available: number; reserved: number; revision: number; unit: "tokens" };
  models: { id: string; name?: string }[];
  endpoint: string;
  model_warning?: string;
}
interface AccountConfig { configured: boolean; origin?: string; message?: string }
interface RegistrationPolicy { enabled: boolean; initial_tokens: number }

export const useAccountStore = defineStore("account", {
  state: () => ({
    config: { configured: false } as AccountConfig,
    policy: { enabled: false, initial_tokens: 0 } as RegistrationPolicy,
    current: null as AccountSnapshot | null,
    busy: false, initialized: false, error: "", notice: "",
    githubPending: false,
  }),
  actions: {
    sessionExpired(error: unknown) {
      return /(?:401|Unauthorized|请登录 OpsArk 账号|请重新登录|账号不可用|登录状态已失效)/i.test(String(error));
    },
    expireSession() {
      this.clearModels();
      this.current = null;
      this.githubPending = false;
      this.error = "";
      this.notice = "登录状态已失效，请重新登录。";
    },
    async githubStart() {
      if (this.busy) return; this.busy = true; this.error = "";
      try {
        await invoke("account_request", { operation: this.current ? "github_link" : "github_login" });
        this.githubPending = true; this.notice = "已打开系统浏览器，请在 GitHub 授权后点击完成登录。";
      } catch (e) { this.error = String(e); } finally { this.busy = false; }
    },
    async githubComplete() {
      if (this.busy) return; this.busy = true; this.error = "";
      try {
        const result = await invoke<AccountSnapshot | { status: "pending" }>("account_request", { operation: "github_complete" });
        if ("status" in result) { this.notice = "GitHub 授权尚未完成，请在浏览器确认后重试。"; return; }
        this.apply(result); this.githubPending = false; this.notice = "GitHub 授权已完成。";
      } catch (e) { this.error = String(e); } finally { this.busy = false; }
    },
    clearModels() {
      const ops = useOpsStore();
      for (const model of ops.models.filter(model => model.source === "official")) {
        delete ops.modelApiKeys[model.id];
        delete ops.modelAvailability[model.id];
      }
      ops.models = ops.models.filter(model => model.source !== "official");
      // Do not reassign any task's model ID or touch local data on account change.
    },
    apply(snapshot: AccountSnapshot) {
      this.clearModels();
      this.current = snapshot;
      const ops = useOpsStore();
      for (const item of snapshot.models) {
        const id = `official:${snapshot.user.id}:${item.id}`;
        ops.models.push({ name: item.name || item.id, timeoutSeconds: 90, ...officialPreferences(id),
          id, model: item.id, provider: "OpsArk", endpoint: snapshot.endpoint,
          enabled: true, hasApiKey: true, source: "official" });
        // This is an identity marker, not a secret. Rust resolves the actual access token.
        ops.modelApiKeys[id] = `opsark-account:${snapshot.user.id}`;
        ops.modelAvailability[id] = { status: snapshot.balance.available > 0 ? "available" : "unavailable",
          reason: snapshot.balance.available > 0 ? "官方账号模型（按实际用量扣减积分）" : "官方积分不足，请前往账号页面" };
      }
    },
    async initialize() {
      if (this.initialized || this.busy) return;
      this.busy = true;
      try {
        if (!("__TAURI_INTERNALS__" in window)) {
          this.config = { configured: false, message: "账号登录仅在桌面客户端中可用" };
          return;
        }
        this.config = await invoke<AccountConfig>("account_request", { operation: "config" });
        if (!this.config.configured) return;
        try { this.policy = await invoke<RegistrationPolicy>("account_request", { operation: "policy" }); }
        catch { /* Starting the local workspace never requires an online service. */ }
        try { this.apply(await invoke<AccountSnapshot>("account_request", { operation: "restore" })); }
        catch { /* No saved session or network: stay in local mode. The account page can retry. */ }
      } catch (error) { this.error = String(error); }
      finally { this.initialized = true; this.busy = false; }
    },
    async authenticate(operation: "login" | "register", email: string, password: string) {
      if (this.busy) return;
      this.busy = true; this.error = ""; this.notice = "";
      try {
        this.apply(await invoke<AccountSnapshot>("account_request", { operation, email, password }));
        this.githubPending = false;
      } catch (error) { this.error = String(error); }
      finally { this.busy = false; }
    },
    async refresh() {
      if (this.busy) return;
      this.busy = true; this.error = "";
      try {
        this.policy = await invoke<RegistrationPolicy>("account_request", { operation: "policy" });
        this.apply(await invoke<AccountSnapshot>("account_request", { operation: "me" }));
      } catch (error) {
        if (this.sessionExpired(error)) this.expireSession();
        else this.error = String(error);
      }
      finally { this.busy = false; }
    },
    async validateSession() {
      if (!this.current || this.busy || !("__TAURI_INTERNALS__" in window)) return;
      try { this.apply(await invoke<AccountSnapshot>("account_request", { operation: "me" })); }
      catch (error) { if (this.sessionExpired(error)) this.expireSession(); }
    },
    async logout() {
      if (this.busy) return;
      this.busy = true; this.error = ""; this.notice = "";
      try {
        const result = await invoke<{ revoked: boolean }>("account_request", { operation: "logout" });
        this.notice = result.revoked ? "已退出账号，本地数据保持不变。" : "本机已退出；未能确认服务端会话撤销。";
      } catch (error) { this.error = String(error); }
      finally { this.clearModels(); this.current = null; this.busy = false; this.githubPending = false; }
    },
  },
});
