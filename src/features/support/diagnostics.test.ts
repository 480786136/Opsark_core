import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { collectTaskLogs, redactSupportText, taskDiagnostic } from "./diagnostics";
import type { AuditEvent, DeveloperLogEntry, OpsTask } from "@/types";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.resetAllMocks(); });
it("collects complete selected-task files and live logs beyond the old excerpt limits", async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  const task = { id: "task-one", status: "failed", plan: [{ status: "completed" }, { status: "failed" }] } as OpsTask;
  expect(taskDiagnostic(task)).toEqual({ taskId: "task-one", status: "failed", stepCount: 2, completedSteps: 1, failedSteps: 1 });
  vi.mocked(invoke).mockResolvedValue({ taskId: task.id, files: [{ name: "model-calls-1.jsonl", content: `full model response ${"z".repeat(18000)} synthetic-secret` }] });
  const logs = Array.from({ length: 25 }, (_, i) => ({ taskId: task.id, title: `event-${i}`, request: "full model request", response: "full response" })) as DeveloperLogEntry[];
  logs.push({ taskId: "another-task", title: "unrelated content" } as DeveloperLogEntry);
  const result = await collectTaskLogs(task, [{ taskId: task.id, detail: "audit detail" }] as AuditEvent[], logs, { key: "synthetic-secret" });
  expect(invoke).toHaveBeenCalledWith("collect_support_task_logs", { taskId: task.id });
  for (const text of ["event-24", "full model request", "full model response", "audit detail", "[REDACTED]"]) expect(result).toContain(text);
  expect(result.length).toBeGreaterThan(18000);
  expect(result).not.toContain("unrelated content"); expect(result).not.toContain("synthetic-secret");
});
it("does not pass off partial in-memory records as complete logs on disk failure", async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.mocked(invoke).mockRejectedValue(new Error("disk unavailable"));
  await expect(collectTaskLogs({ id: "one" } as OpsTask, [], [], {})).rejects.toThrow("disk unavailable");
});
it("redacts known secrets, tokens and private-key blocks, while retaining secret references", () => {
  const output = redactSupportText(`synthetic-secret\nBearer ${"b".repeat(30)}\n-----BEGIN PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----\npassword=example123\n\${secret.PASSWORD}`, { password: "synthetic-secret" });
  for (const text of ["synthetic-secret", "example123", "body"]) expect(output).not.toContain(text);
  expect(output).toContain("[REDACTED]"); expect(output).toContain("${secret.PASSWORD}");
});
