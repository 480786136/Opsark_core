import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { cloudRequest } from "@/features/account/cloudClient";
import { useUpdateStore } from "./updateStore";
vi.mock("@/features/account/cloudClient", () => ({ cloudRequest: vi.fn() }));
beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()); vi.mocked(cloudRequest).mockReset(); Object.assign(window, { __TAURI_INTERNALS__: {} }); });
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
const info = { current_version: "0.3.0", support_email: "", support_url: "", feedback_retention_days: 30, min_cloud_version: "0.0.0", update_required: false,
  latest: { id: "release-one", version: "0.3.1", platform: "macos", arch: "aarch64", notes: "notes", download_url: "https://download.example.test/core" } };
it("checks publicly without login and only opens a release after explicit user action", async () => {
  vi.mocked(cloudRequest).mockResolvedValue(info);
  const store = useUpdateStore(); await store.check();
  expect(cloudRequest).toHaveBeenCalledExactlyOnceWith("client_info");
  await store.download();
  expect(cloudRequest).toHaveBeenLastCalledWith("open_download", { id: "release-one" });
});
it("snoozes the current release but displays a newly published one", async () => {
  vi.mocked(cloudRequest).mockResolvedValue(info);
  const store = useUpdateStore(); await store.check(); store.later(); await store.check();
  expect(store.dismissed).toBe(true);
  vi.mocked(cloudRequest).mockResolvedValue({ ...info, latest: { ...info.latest, version: "0.3.2" } }); await store.check();
  expect(store.dismissed).toBe(false);
});
it("network failures do not prevent the local workspace from running", async () => {
  vi.mocked(cloudRequest).mockRejectedValue("offline");
  const store = useUpdateStore(); await expect(store.check()).resolves.toBeUndefined();
  expect(store.busy).toBe(false); expect(store.error).toContain("offline");
});
it("starts with defaults and persists changed Admin contacts across offline restarts", async () => {
  const store = useUpdateStore();
  expect(store.contact).toMatchObject({ support_wechat: "zgkjkj", support_email: "zgkj@zgspace.cn", developer_name: "智明" });
  vi.mocked(cloudRequest).mockResolvedValue({ ...info, support_wechat: "new-wechat", support_email: "new@example.test", developer_name: "新开发者" });
  await store.check();
  const cached = localStorage.getItem("opsark.supportContact");
  expect(store.contact.support_wechat).toBe("new-wechat");
  const set = vi.spyOn(Storage.prototype, "setItem"); set.mockClear();
  await store.check();
  expect(set.mock.calls.filter(([key]) => key === "opsark.supportContact")).toHaveLength(0);
  set.mockRestore();
  setActivePinia(createPinia()); vi.mocked(cloudRequest).mockRejectedValue("offline");
  const restarted = useUpdateStore(); await restarted.check();
  expect(restarted.contact.support_email).toBe("new@example.test");
  expect(localStorage.getItem("opsark.supportContact")).toBe(cached);
});
it("retains cached contacts when an older server omits the new contact fields", async () => {
  localStorage.setItem("opsark.supportContact", JSON.stringify({ support_wechat: "saved-wechat", developer_name: "saved-dev" }));
  vi.mocked(cloudRequest).mockResolvedValue(info);
  const store = useUpdateStore(); await store.check();
  expect(store.contact.support_wechat).toBe("saved-wechat"); expect(store.contact.developer_name).toBe("saved-dev");
  expect(store.contact.support_email).toBe("zgkj@zgspace.cn");
});
