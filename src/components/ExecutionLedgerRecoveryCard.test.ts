// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { backend } from "@/services/backend";
import ExecutionLedgerRecoveryCard from "./ExecutionLedgerRecoveryCard.vue";
import type { ExecutionLedgerRecovery } from "@/features/agent/executionLedgerRecovery";

const recovery = (): ExecutionLedgerRecovery => ({ version: "execution-ledger-recovery@1", items: [
  { kind: "uncertain", operationId: "operation-original", attemptId: "attempt-original", cancelRequested: true,
    summary: "派发已登记，原进程是否结束待核对。", knownFacts: ["原始证据已保留"], action: "reconcile" },
  { kind: "recorded_result", operationId: "operation-success", attemptId: "attempt-success", summary: "主命令成功，等待复核",
    knownFacts: ["成功结果已记录"], action: "verify" },
  { kind: "storage_failed", operationId: "operation-commit", attemptId: "attempt-commit", summary: "结果已返回，台账提交失败",
    knownFacts: ["远端结果已返回"], action: "retry_storage" },
] });

it("shows distinct recovery states, original attempt identities and bounded action buttons", async () => {
  const host = document.createElement("div"), onAction = vi.fn();
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": {}, en: {} } });
  const app = createApp(ExecutionLedgerRecoveryCard, { recovery: recovery(), onAction }).use(i18n);
  app.mount(host);
  try {
    expect(host.textContent).toContain("执行结果待核对");
    expect(host.textContent).toContain("任务结果待确认");
    expect(host.textContent).toContain("记录提交失败");
    expect(host.textContent).toContain("不代表远端操作已停止");
    expect(host.textContent).toContain("attempt-original");
    const buttons = host.querySelectorAll<HTMLButtonElement>("button");
    buttons.forEach(button => button.click());
    expect(onAction.mock.calls.map(call => call[0])).toEqual(["reconcile", "verify", "retry_storage"]);
    expect(host.textContent).not.toMatch(/重新部署|重发命令|已安全取消/);
    i18n.global.locale.value = "en";
    await nextTick();
    expect(host.textContent).toContain("Execution result needs reconciliation");
    expect(host.textContent).toContain("Retry saving record");
  } finally { app.unmount(); }
});

it("blocks duplicate recovery requests while showing the pending attempt and exact failure", () => {
  const host = document.createElement("div"), data = recovery();
  data.busyAttemptId = "attempt-original";
  data.error = "原目标身份变化，尚未执行只读核对。";
  const app = createApp(ExecutionLedgerRecoveryCard, { recovery: data }).use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": {} } }));
  app.mount(host);
  try {
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].every(button => button.disabled)).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(data.error);
    expect(host.querySelectorAll(".spin")).toHaveLength(1);
  } finally { app.unmount(); }
});

it("does not add execution claims to old tasks with no ledger", () => {
  const host = document.createElement("div");
  const app = createApp(ExecutionLedgerRecoveryCard).use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": {} } }));
  app.mount(host);
  try { expect(host.querySelector("section")).toBeNull(); }
  finally { app.unmount(); }
});

it("shows saved reads as collapsed history and reads local evidence without a verification action", async () => {
  const data: ExecutionLedgerRecovery = { version: "execution-ledger-recovery@1", items: [], recordedReads: [{
    operationId: "op-read", attemptId: "read-attempt", stepId: "read-step", title: "检查磁盘", status: "succeeded",
    late: false, recordedAt: 1000, evidenceRefs: ["saved-proof"],
  }] };
  const read = vi.spyOn(backend, "readTaskEvidence").mockResolvedValue({ text: "saved disk result" });
  const host = document.createElement("div");
  const app = createApp(ExecutionLedgerRecoveryCard, { recovery: data, taskId: "original-task" })
    .use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": {} } }));
  app.mount(host);
  try {
    expect(host.querySelector(".ledger-recovery-item")).toBeNull();
    expect(host.querySelector<HTMLDetailsElement>("details")!.open).toBe(false);
    expect(host.textContent).toContain("已保存的检查结果（1）");
    expect(host.querySelector('[data-ledger-action="verify"]')).toBeNull();
    host.querySelector<HTMLButtonElement>("button")!.click();
    await nextTick(); await nextTick();
    expect(read).toHaveBeenCalledWith("original-task", "saved-proof", 0, 8000);
    expect(host.textContent).toContain("saved disk result");
  } finally { app.unmount(); read.mockRestore(); }
});
