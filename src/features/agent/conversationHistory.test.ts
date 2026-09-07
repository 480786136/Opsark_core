import { expect, it } from "vitest";
import { conversationHistoryRounds } from "./conversationHistory";
import { restoreConversationLinks } from "./conversationHistory";
import type { AuditEvent } from "@/types";
import type { OpsTask } from "@/types";
const task = (id: string, createdAt: string, conversationId?: string) => ({ id, conversationId, createdAt, updatedAt: createdAt,
  title: id, permission: "safe", modelId: "model", serverId: "server", status: "completed", plan: [], messages: [{ id, role: "user", kind: "message", content: id, createdAt }],
  summary: `${id} result` } as OpsTask);
it("shows prior tasks in the same conversation without merging execution state", () => {
  const java = task("java", "2026-09-06T01:00:00Z");
  const mysql = task("mysql", "2026-09-06T02:00:00Z", "java");
  const unrelated = task("other", "2026-09-06T00:00:00Z");
  const tasks = [mysql, unrelated, java];
  const before = structuredClone(tasks);
  const rows = conversationHistoryRounds(tasks, mysql);
  expect(rows.map(row => row.requirement)).toEqual(["java"]);
  expect(rows[0].summary).toBe("java result");
  expect(conversationHistoryRounds(tasks, mysql)).toEqual(rows);
  expect(conversationHistoryRounds(tasks, java)).toEqual([]);
  expect(tasks).toEqual(before);
});
it("does not mix servers or independent conversations", () => {
  const active = task("active", "2026-09-06T02:00:00Z", "conversation");
  const other = { ...task("old", "2026-09-06T01:00:00Z", "conversation"), serverId: "other" };
  expect(conversationHistoryRounds([active, other], active)).toEqual([]);
});
it("restores explicit legacy links without guessing from timestamps", () => {
  const java = task("java", "2026-09-06T01:00:00Z");
  const mysql = task("mysql", "2026-09-06T02:00:00Z");
  const other = task("other", "2026-09-06T03:00:00Z");
  const events = [{ title: "独立目标已创建新任务", createdAt: mysql.createdAt,
    detail: JSON.stringify({ previousTaskId: "java", newTaskId: "mysql" }) }] as AuditEvent[];
  restoreConversationLinks([java, mysql, other], events);
  expect(mysql.conversationId).toBe("java");
  expect(other.conversationId).toBeUndefined();
});
