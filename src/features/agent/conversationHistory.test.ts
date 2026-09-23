import { expect, it } from "vitest";
import {
  archivedConversationTimeline,
  conversationHistoryRounds,
  currentConversationTimeline,
  restoreConversationLinks,
} from "./conversationHistory";
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

it("keeps a prior task's full round messages when a new goal continues the conversation", () => {
  const previous = task("previous", "2026-09-06T01:00:00.000Z");
  previous.currentRoundId = "round-previous";
  previous.messages = [
    { id: "goal", role: "user", kind: "message", content: "deploy", requirementRelation: "new_goal",
      createdAt: "2026-09-06T01:00:00.000Z" },
    { id: "continue", role: "user", kind: "message", content: "continue", requirementRelation: "continue",
      createdAt: "2026-09-06T01:01:00.000Z" },
    { id: "side", role: "user", kind: "message", content: "status?", requirementRelation: "side_question",
      createdAt: "2026-09-06T01:02:00.000Z" },
    { id: "answer", role: "assistant", kind: "message", content: "halfway",
      createdAt: "2026-09-06T01:02:01.000Z" },
  ];
  previous.phaseHistory = [{ id: "phase", roundId: previous.currentRoundId, archivedBeforeMessageId: "continue",
    requirement: "deploy", reason: "replan", plan: [], createdAt: previous.createdAt,
    completedAt: previous.messages[1].createdAt }];
  const next = task("next", "2026-09-06T02:00:00.000Z", previous.id);

  const [round] = conversationHistoryRounds([next, previous], next);
  expect(round.messages?.map(message => message.id)).toEqual(["goal", "continue", "side", "answer"]);
  expect(archivedConversationTimeline(round).map(entry => entry.type === "message" ? entry.message.id : entry.phase.id))
    .toEqual(["goal", "phase", "continue", "side", "answer"]);
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

it("orders active-round phases before the continue message that archived them", () => {
  const active = task("active", "2026-09-06T01:00:00.000Z");
  active.currentRoundId = "round-current";
  active.messages = [
    { id: "original", role: "user", kind: "message", content: "deploy", requirementRelation: "new_goal",
      createdAt: "2026-09-06T01:00:00.000Z" },
    { id: "old-progress", role: "assistant", kind: "message", content: "已生成 2 个执行步骤。请检查风险、命令和预期结果后确认计划。",
      createdAt: "2026-09-06T01:01:00.000Z" },
    { id: "checkpoint", role: "assistant", kind: "message", content: "原步骤已停止。",
      createdAt: "2026-09-06T01:05:00.000Z" },
    { id: "continue", role: "user", kind: "message", content: "继续执行", requirementRelation: "continue",
      createdAt: "2026-09-06T01:05:00.000Z" },
    { id: "new-progress", role: "assistant", kind: "message", content: "已生成 1 个执行步骤。请检查风险、命令和预期结果后确认计划。",
      createdAt: "2026-09-06T01:05:30.000Z" },
    { id: "question", role: "user", kind: "message", content: "进展如何？", requirementRelation: "side_question",
      createdAt: "2026-09-06T01:06:00.000Z" },
  ];
  active.phaseHistory = [{
    id: "old-phase", roundId: active.currentRoundId, archivedBeforeMessageId: "continue",
    requirement: "deploy", reason: "replan", plan: [],
    createdAt: "2026-09-06T01:01:00.000Z", completedAt: active.messages[3].createdAt,
  }];

  const timeline = currentConversationTimeline(active);
  expect(timeline.map(entry => entry.type === "message" ? entry.message.id : entry.phase.id))
    .toEqual(["original", "checkpoint", "old-phase", "continue", "new-progress", "question"]);
});
