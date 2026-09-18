import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { useAccountStore, type AccountSnapshot } from "./accountStore";
import { useOpsStore } from "@/stores/ops";
import { backend } from "@/services/backend";
import { saveOfficialPreferences } from "./officialModelSettings";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const snapshot: AccountSnapshot = {
  user: { id: "user-one", email: "user@example.test" },
  balance: { available: 100000, reserved: 0, revision: 1, unit: "tokens" },
  models: [{ id: "trial-model" }], endpoint: "https://platform.example.test/v1",
};
beforeEach(() => {
  vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); localStorage.clear(); setActivePinia(createPinia());
  const ops = useOpsStore();
  ops.models = [{ id: "own", name: "Own model", model: "custom", provider: "Compatible", endpoint: "https://own.example.test/v1", enabled: true, hasApiKey: true }];
  ops.modelApiKeys.own = "synthetic-byok";
});
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

it("browser/local startup does not create an anonymous identity or call cloud APIs", async () => {
  const account = useAccountStore(); await account.initialize();
  expect(invoke).not.toHaveBeenCalled();
  expect(account.current).toBeNull();
  expect(useOpsStore().models.map(m => m.id)).toEqual(["own"]);
});

it("keeps official profiles and identity markers out of persisted models and the BYOK keychain", async () => {
  const account = useAccountStore(), ops = useOpsStore(); account.apply(snapshot);
  expect(ops.models).toHaveLength(2);
  expect(ops.modelApiKeys["official:user-one:trial-model"]).toBe("opsark-account:user-one");
  ops.persist(true);
  expect(JSON.parse(localStorage.getItem("opsark.models")!)).toEqual([ops.models[0]]);
  const saved = vi.spyOn(backend, "saveCredential").mockResolvedValue();
  vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue();
  await ops.saveModels();
  expect(saved).toHaveBeenCalledExactlyOnceWith("model", "own", "synthetic-byok");
});

it("logging out removes only official models and preserves local data and task model selection", async () => {
  const account = useAccountStore(), ops = useOpsStore(); account.apply(snapshot);
  // This minimal fixture intentionally checks that logout never traverses/reassigns tasks.
  const tasks = ops.tasks;
  vi.mocked(invoke).mockResolvedValue({ revoked: false }); await account.logout();
  expect(account.current).toBeNull();
  expect(ops.models.map(m => m.id)).toEqual(["own"]);
  expect(ops.modelApiKeys).toEqual({ own: "synthetic-byok" });
  expect(ops.tasks).toBe(tasks);
  expect(account.notice).toContain("未能确认");
});

it("clears the local account when Admin has revoked the session", async () => {
  Reflect.set(window, "__TAURI_INTERNALS__", {});
  const account = useAccountStore(); account.apply(snapshot);
  vi.mocked(invoke).mockRejectedValueOnce("请登录 OpsArk 账号");
  await account.validateSession();
  expect(account.current).toBeNull();
  expect(account.notice).toContain("登录状态已失效");
  expect(useOpsStore().models.map(model => model.id)).toEqual(["own"]);
});

it("keeps the account during a temporary session-check network failure", async () => {
  Reflect.set(window, "__TAURI_INTERNALS__", {});
  const account = useAccountStore(); account.apply(snapshot);
  vi.mocked(invoke).mockRejectedValueOnce("无法连接官方服务");
  await account.validateSession();
  expect(account.current?.user.id).toBe("user-one");
});

it("different accounts never share an official model ID", () => {
  const account = useAccountStore(), ops = useOpsStore(); account.apply(snapshot);
  account.apply({ ...snapshot, user: { id: "user-two", email: "second@example.test" } });
  expect(ops.modelApiKeys["official:user-one:trial-model"]).toBeUndefined();
  expect(ops.models.map(m => m.id)).toEqual(["own", "official:user-two:trial-model"]);
});

it("authentication consumes a safe snapshot and failed login preserves BYOK", async () => {
  const account = useAccountStore(); vi.mocked(invoke).mockRejectedValueOnce("invalid password");
  await account.authenticate("login", "user@example.test", "synthetic-password");
  expect(account.error).toBe("invalid password");
  expect(useOpsStore().models.map(m => m.id)).toEqual(["own"]);
  vi.mocked(invoke).mockResolvedValueOnce(snapshot);
  await account.authenticate("register", "user@example.test", "synthetic-password");
  expect(account.current?.balance.available).toBe(100000);
  expect(JSON.stringify(account.$state)).not.toContain("synthetic-password");
});

it("previously persisted official profiles are ignored at startup", () => {
  localStorage.setItem("opsark.models", JSON.stringify([{ source: "official", id: "official:stale", provider: "OpsArk" }]));
  setActivePinia(createPinia());
  expect(useOpsStore().models).toEqual([]);
});

it("uses the Admin display name and only restores account-scoped editable preferences", () => {
  const account = useAccountStore(); account.apply({ ...snapshot, models: [{ id: "trial-model", name: "Admin public name" }] });
  const official = useOpsStore().models.find(m => m.source === "official")!;
  expect(official.name).toBe("Admin public name");
  localStorage.setItem("opsark.officialModelSettings", "null");
  saveOfficialPreferences({ ...official, name: "My label", timeoutSeconds: 123, requestParameters: { temperature: 0.2 } });
  account.apply({ ...snapshot, models: [{ id: "trial-model", name: "Renamed by Admin" }] });
  expect(useOpsStore().models.find(m => m.source === "official")).toMatchObject({ name: "Renamed by Admin", timeoutSeconds: 123, endpoint: snapshot.endpoint, model: "trial-model" });
  account.apply({ ...snapshot, user: { id: "user-two", email: "second@example.test" } });
  expect(useOpsStore().models.find(m => m.source === "official")?.name).toBe("trial-model");
});

it("waits for GitHub authorization without passing codes or tokens through frontend state", async () => {
  const account = useAccountStore(); vi.mocked(invoke).mockResolvedValueOnce({ status: "pending" });
  await account.githubStart(); expect(account.githubPending).toBe(true);
  expect(invoke).toHaveBeenLastCalledWith("account_request", { operation: "github_login" });
  vi.mocked(invoke).mockResolvedValueOnce({ status: "pending" }); await account.githubComplete();
  expect(account.current).toBeNull(); expect(account.githubPending).toBe(true);
  vi.mocked(invoke).mockResolvedValueOnce(snapshot); await account.githubComplete();
  expect(account.current?.user.id).toBe(snapshot.user.id); expect(account.githubPending).toBe(false);
});
