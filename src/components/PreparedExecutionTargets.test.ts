// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { createApp, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import PreparedExecutionTargets from "./PreparedExecutionTargets.vue";
import type { ExecutionTargetRef } from "@/types";

it("shows both bound endpoints and overwrite scope without credential identifiers", async () => {
  const targets: ExecutionTargetRef[] = [
    { role: "source", serverId: "source-id", host: "source.example", port: 22, username: "deploy", path: "/data/archive" },
    { role: "target", serverId: "target-id", host: "target.example", port: 2222, username: "backup", path: "/backup/archive", overwrite: true,
      credentialRef: "private-credential-ref", passwordSecretKey: "PRIVATE_KEY_NAME" },
  ];
  const host = document.createElement("div");
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": {}, "en-US": {} } });
  const app = createApp(PreparedExecutionTargets, { targets }).use(i18n);
  app.mount(host);
  try {
    expect(host.textContent).toContain("来源");
    expect(host.textContent).toContain("deploy@source.example:22");
    expect(host.textContent).toContain("backup@target.example:2222");
    expect(host.textContent).toContain("/backup/archive");
    expect(host.textContent).toContain("允许覆盖");
    expect(host.textContent).not.toMatch(/private-credential-ref|PRIVATE_KEY_NAME|source-id|target-id|sha256/);
    i18n.global.locale.value = "en-US";
    await nextTick();
    expect(host.textContent).toContain("Destination");
    expect(host.textContent).toContain("Overwrite allowed");
  } finally { app.unmount(); }
});

it("formats IPv6 and protected accounts, preserves false overwrite, and shows bound working directory", () => {
  const targets: ExecutionTargetRef[] = [{ role: "execution", host: "2001:db8::1", port: 22,
    username: "${secret.USERNAME}", overwrite: false,
    agentSession: { id: "session-private", generation: 8, contextRevision: 3, cwd: "/opt/app" } }];
  const host = document.createElement("div");
  const app = createApp(PreparedExecutionTargets, { targets }).use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": {} } }));
  app.mount(host);
  try {
    expect(host.textContent).toContain("已确认账户@[2001:db8::1]:22");
    expect(host.textContent).toContain("不覆盖已有文件");
    expect(host.textContent).toContain("工作目录: /opt/app");
    expect(host.textContent).not.toMatch(/USERNAME|session-private|generation|contextRevision/);
  } finally { app.unmount(); }
});

it("adds no invented target to historical steps without a preparation snapshot", () => {
  const host = document.createElement("div");
  const app = createApp(PreparedExecutionTargets).use(createI18n({ legacy: false, locale: "en", messages: { en: {} } }));
  app.mount(host);
  try { expect(host.querySelector(".prepared-targets")).toBeNull(); }
  finally { app.unmount(); }
});
