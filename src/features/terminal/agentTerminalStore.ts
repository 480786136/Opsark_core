import { defineStore } from "pinia";
import type { AgentSessionRef, ExecutionScope, OpsTask } from "@/types";

export interface AgentTerminalEntry {
  id: number;
  taskId: string;
  executionId?: string;
  kind: "command" | "validation" | "output" | "system";
  text: string;
  scope?: ExecutionScope;
  exitCode?: number;
  createdAt: string;
}

const MAX_ENTRIES_PER_TASK = 800;

export const useAgentTerminalStore = defineStore("agentTerminals", {
  state: () => ({
    sessionsByTask: {} as Record<string, AgentSessionRef>,
    entriesByTask: {} as Record<string, AgentTerminalEntry[]>,
    activeTaskByServer: {} as Record<string, string | undefined>,
    hiddenTaskIdsByServer: {} as Record<string, string[]>,
    sequence: 0,
  }),
  actions: {
    registerSession(session: AgentSessionRef) {
      const previous = this.sessionsByTask[session.taskId];
      if (previous && previous.serverId !== session.serverId
        && this.activeTaskByServer[previous.serverId] === session.taskId) {
        this.activeTaskByServer[previous.serverId] = undefined;
      }
      this.sessionsByTask[session.taskId] = structuredClone(session);
      // Open a newly-created Agent terminal once. Context updates and transport
      // generation changes must never steal focus back from a user-owned Shell.
      if (!previous && !this.isTaskHidden(session.serverId, session.taskId)) {
        this.activeTaskByServer[session.serverId] = session.taskId;
      }
    },
    restoreHistoricalTask(task: OpsTask) {
      if (!task.agentSessionId || this.sessionsByTask[task.id]) return;
      this.sessionsByTask[task.id] = {
        id: task.agentSessionId,
        serverId: task.executionTargetServerId ?? task.serverId,
        taskId: task.id,
        generation: task.agentSessionGeneration ?? 0,
        state: "closed",
        context: { environment: {}, sourceFiles: [], shell: "bash", revision: 0 },
        createdAt: task.createdAt,
        closedAt: task.updatedAt,
      };
      const entries = this.entriesByTask[task.id] ??= [];
      if (!entries.length) {
        for (const step of task.plan) {
          if (!step.output) continue;
          entries.push({
            id: ++this.sequence,
            taskId: task.id,
            kind: step.kind === "observe" ? "command" : "output",
            text: step.output,
            scope: step.executionScope,
            exitCode: step.result?.exitCode,
            createdAt: step.startedAt ?? task.updatedAt,
          });
        }
      }
    },
    activateTask(serverId: string, taskId?: string) {
      if (taskId) {
        this.hiddenTaskIdsByServer[serverId] = (this.hiddenTaskIdsByServer[serverId] ?? [])
          .filter((id) => id !== taskId);
      }
      this.activeTaskByServer[serverId] = taskId;
    },
    isTaskHidden(serverId: string, taskId: string) {
      return (this.hiddenTaskIdsByServer[serverId] ?? []).includes(taskId);
    },
    dismissTask(serverId: string, taskId: string) {
      const hidden = this.hiddenTaskIdsByServer[serverId] ??= [];
      if (!hidden.includes(taskId)) hidden.push(taskId);
      if (this.activeTaskByServer[serverId] === taskId) {
        this.activeTaskByServer[serverId] = undefined;
      }
    },
    begin(taskId: string, executionId: string, text: string, scope: ExecutionScope, validation = false) {
      this.append(taskId, {
        executionId,
        kind: validation ? "validation" : "command",
        text,
        scope,
      });
      const session = this.sessionsByTask[taskId];
      if (session) session.state = "busy";
    },
    output(taskId: string, executionId: string, text: string) {
      if (!text) return;
      const entries = this.entriesByTask[taskId] ??= [];
      const previous = entries[entries.length - 1];
      if (previous?.kind === "output" && previous.executionId === executionId && previous.exitCode === undefined) {
        previous.text += text;
        return;
      }
      this.append(taskId, { executionId, kind: "output", text });
    },
    finish(taskId: string, executionId: string, exitCode: number) {
      const entries = this.entriesByTask[taskId] ??= [];
      const target = [...entries].reverse().find((entry) => entry.executionId === executionId);
      if (target) target.exitCode = exitCode;
      const session = this.sessionsByTask[taskId];
      if (session) session.state = "ready";
    },
    invalidateSession(taskId: string, sessionId: string, generation?: number) {
      const session = this.sessionsByTask[taskId];
      if (!session || session.id !== sessionId || session.state === "closed"
        || (generation !== undefined && generation < session.generation)) return;
      if (generation !== undefined) session.generation = generation;
      // The command slot was released, but remote connectivity is not verified.
      // Do not invent an exit code for the interrupted execution.
      session.state = "recovering";
    },
    system(taskId: string, text: string) {
      this.append(taskId, { kind: "system", text });
    },
    append(taskId: string, entry: Omit<AgentTerminalEntry, "id" | "taskId" | "createdAt">) {
      const entries = this.entriesByTask[taskId] ??= [];
      entries.push({ id: ++this.sequence, taskId, createdAt: new Date().toISOString(), ...entry });
      if (entries.length > MAX_ENTRIES_PER_TASK) entries.splice(0, entries.length - MAX_ENTRIES_PER_TASK);
    },
    close(taskId: string) {
      const session = this.sessionsByTask[taskId];
      if (!session) return;
      session.state = "closed";
      session.closedAt = new Date().toISOString();
      if (this.activeTaskByServer[session.serverId] === taskId) this.activeTaskByServer[session.serverId] = undefined;
    },
  },
});
