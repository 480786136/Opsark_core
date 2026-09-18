// Production-bundle UI smoke with an isolated browser profile; no account, SSH or model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../../Opsark_admin/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const root = fileURLToPath(new URL("../", import.meta.url));
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore" });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch { /* local preview startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, "Core preview did not start");
  browser = await chromium.launch({ headless: true, ...(process.env.OPSARK_SMOKE_BROWSER ? { channel: process.env.OPSARK_SMOKE_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], cloudCalls = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().includes("/api/core/") || request.url().includes("/v1/chat/")) cloudCalls.push(request.url()); });
  await page.goto(base);
  await page.locator('.rail-bottom a[href="#/account"]').waitFor();
  assert.equal(await page.locator('nav a[href="#/tools"]').count(), 0);
  await page.goto(base + "/#/skills");
  await page.locator(".skill-add-button").click();
  await page.locator(".skill-remove-button").waitFor();
  assert.equal(await page.getByText("终端 SSH 跳转", { exact: true }).count(), 0);
  await page.locator(".skill-remove-button").click();
  await page.getByRole("alertdialog").waitFor();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await page.locator(".skill-remove-button").count(), 1);
  await page.locator(".skill-remove-button").click();
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await page.locator(".skill-remove-button").waitFor({ state: "detached" });
  await page.goto(base + "/#/tools");
  await page.getByRole("heading", { name: "执行权限", exact: true }).waitFor();
  await page.getByLabel("允许 Agent 执行 Shell", { exact: false }).uncheck();
  await page.getByRole("button", { name: "保存权限", exact: true }).click();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("opsark.executionPermissions")).allowShell), false);
  await page.goto(base + "/#/support");
  await page.locator("#feedback-title").fill("Synthetic offline feedback");
  await page.locator("#feedback-message").fill("No login required to preview a problem.");
  assert.ok(await page.getByRole("button", { name: "提交反馈", exact: true }).isEnabled());
  await page.getByLabel("您的联系方式", { exact: false }).fill("feedback@example.test");
  for (const contact of ["zgkjkj", "zgkj@zgspace.cn", "智明"]) assert.ok(await page.getByText(contact, { exact: true }).isVisible());
  const feedback = await page.locator(".feedback-card").boundingBox();
  const contact = await page.locator(".contact-card").boundingBox();
  assert.ok(feedback.x < contact.x && Math.abs(feedback.y - contact.y) < 2);
  const png = { name: "issue.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII=", "base64") };
  await page.locator('input[type="file"]').setInputFiles([png, png, png]);
  await page.locator(".image-preview").nth(2).waitFor();
  assert.equal(await page.getByRole("button", { name: "添加图片", exact: true }).count(), 0);
  await page.getByRole("button", { name: "移除图片 2", exact: true }).click();
  assert.equal(await page.locator(".image-preview").count(), 2);
  await page.screenshot({ path: "/tmp/opsark-support-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 960, height: 780 });
  assert.ok(await page.locator(".support-layout").evaluate(el => el.scrollWidth <= el.clientWidth));
  await page.screenshot({ path: "/tmp/opsark-support-compact.png", fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(cloudCalls, []);
  console.log("PASS: production Core account entry, hidden system tools/Skills, local Skill confirmation, saved permissions, public feedback form, contact defaults, two-column layout, image selection/removal; no cloud/model requests or page errors.");
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise(resolve => child.once("exit", resolve)); child.kill(); await stopped;
  }
}
