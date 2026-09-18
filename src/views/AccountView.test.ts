import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import AccountView from "./AccountView.vue";
import { useAccountStore } from "@/features/account/accountStore";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ locale: { value: "zh-CN" } }) }));
vi.mock("@/features/account/cloudClient", () => ({ cloudRequest: vi.fn().mockResolvedValue({ enabled: true }) }));

afterEach(() => { document.body.innerHTML = ""; });

it("shows a compact linked GitHub state and hides a zero reservation", async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const account = useAccountStore();
  account.initialized = true;
  account.config = { configured: true };
  account.current = {
    githubLinked: true,
    billingMode: "direct",
    user: { id: "user-one", email: "user@example.test" },
    balance: { available: 1_000_000, reserved: 0, revision: 1, unit: "tokens" },
    models: [{ id: "official-model", name: "OpsArk Pro" }],
    endpoint: "https://zgspace.cn/v1",
  };
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(AccountView).use(pinia);
  app.mount(host);
  await Promise.resolve();

  expect(host.textContent).toContain("GitHub 已绑定");
  expect(host.textContent).not.toContain("同邮箱的已有账号不会自动合并");
  expect(host.textContent).not.toContain("待结算预留");
  expect(host.textContent).toContain("100积分");
  expect(host.textContent).not.toContain("1,000,000");
  expect(host.textContent).not.toContain("每 10,000 Token");
  app.unmount();
});

it("offers the contact popover below ten credits and copies the support WeChat ID", async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const account = useAccountStore();
  account.initialized = true;
  account.config = { configured: true };
  account.current = {
    user: { id: "user-low", email: "low@example.test" },
    balance: { available: 11_000, reserved: 0, revision: 1, unit: "tokens" },
    models: [{ id: "official-model", name: "OpsArk Pro" }], endpoint: "https://zgspace.cn/v1",
  };
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const host = document.createElement("div"); document.body.append(host);
  const app = createApp(AccountView).use(pinia); app.mount(host); await nextTick();
  expect(host.textContent).toContain("2积分");
  expect(host.textContent).toContain("还想继续体验");
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "联系我们")!.click();
  await nextTick();
  expect(document.body.textContent).toContain("zgkjkj");
  expect(document.body.textContent).toContain("zgkj@zgspace.cn");
  expect(document.body.textContent).toContain("开发者智明");
  document.querySelector<HTMLButtonElement>('[aria-label="复制微信号"]')!.click(); await Promise.resolve(); await nextTick();
  expect(writeText).toHaveBeenCalledWith("zgkjkj");
  expect(document.body.textContent).toContain("微信号已复制");
  app.unmount();
});
