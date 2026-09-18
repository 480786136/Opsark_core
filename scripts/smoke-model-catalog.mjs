// Isolated browser UI check using synthetic public responses/account state, never real credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../../Opsark_admin/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const root = fileURLToPath(new URL("../", import.meta.url));
const socket = createServer();
await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore" });
const screenshots = mkdtempSync(join(tmpdir(), "opsark-model-catalog-"));
let browser;
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch { /* local dev startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready);
  browser = await chromium.launch({ headless: true, ...(process.env.OPSARK_SMOKE_BROWSER ? { channel: process.env.OPSARK_SMOKE_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const models = [{ id: "official-general", name: "OpsArk 通用模型" }, { id: "official-reasoning", name: "OpsArk 推理模型" }];
  let state = "fresh", calls = 0;
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/core/v1/official-models", async route => {
    calls++;
    assert.equal(route.request().headers().authorization, undefined);
    assert.equal(route.request().headers().cookie, undefined);
    await route.fulfill({ status: state === "offline" ? 503 : 200, json: { models: state === "empty" ? [] : models } });
  });
  await page.context().addCookies([{ name: "opsark_session", value: "synthetic-not-to-be-sent", url: base }]);
  await page.addInitScript(() => {
    if (!localStorage.getItem("opsark.models")) localStorage.setItem("opsark.models", JSON.stringify([{ id: "local-test", name: "我的自定义模型", model: "custom", provider: "Compatible", endpoint: "https://example.test/v1", enabled: true, hasApiKey: false, timeoutSeconds: 180 }]));
  });
  await page.goto(base + "/#/models");
  await page.locator(".official-model-lock").first().waitFor();
  assert.equal(await page.locator(".official-model-card").count(), 2);
  assert.match(await page.locator(".model-grid > :first-child").textContent(), /OpsArk 通用模型/);
  assert.equal(await page.getByText("从 Admin 刷新官方模型", { exact: true }).count(), 0);
  await page.screenshot({ path: join(screenshots, "signed-out.png") });
  await page.locator(".official-model-lock").first().click();
  await page.waitForURL("**/#/account");
  await page.goto(base + "/#/models");
  await page.waitForFunction(() => document.querySelectorAll(".official-model-card").length === 2);
  assert.ok(calls >= 2);
  await page.evaluate(async models => {
    const { useAccountStore } = await import("/src/features/account/accountStore.ts");
    const account = useAccountStore();
    account.refresh = async () => {}; // This smoke exercises UI states, not native authentication.
    account.apply({ user: { id: "smoke-user", email: "smoke@example.test" }, balance: { available: 12000, reserved: 0, revision: 1, unit: "tokens" }, models, endpoint: "https://platform.example.test/v1" });
  }, models);
  await page.locator(".official-model-lock").waitFor({ state: "detached" });
  await page.locator(".official-model-open").first().click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(await dialog.locator(".connection-fields input").count(), 1);
  assert.equal(await dialog.getByText("配置名称", { exact: true }).count(), 0);
  await dialog.locator('input[type="number"]').first().fill("240");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.match(await page.locator(".official-model-card").first().textContent(), /240s/);
  await page.screenshot({ path: join(screenshots, "signed-in.png") });
  state = "offline";
  await page.reload();
  await page.getByText("暂时无法更新，正在显示已缓存的官方模型目录。", { exact: true }).waitFor();
  assert.equal(await page.locator(".official-model-lock").count(), 2);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("opsark.models")).length), 1);
  state = "empty";
  await page.goto(base + "/#/support");
  await page.getByRole("heading", { name: "联系、反馈与更新", exact: true }).waitFor();
  await page.goto(base + "/#/models");
  await page.getByText("暂无已开放的官方模型。", { exact: true }).waitFor();
  assert.equal(await page.locator(".official-model-card").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: public catalogue on entry, credential-free request, official ordering/masks/login link, read-only name, timeout preferences, offline persistent cache, withdrawn-model removal.");
  console.log("Screenshots: " + screenshots);
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise(resolve => child.once("exit", resolve)); child.kill(); await stopped;
  }
}
