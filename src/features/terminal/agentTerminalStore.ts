import { defineStore } from "pinia";
import type { AgentSessionRef, ExecutionScope, OpsTask, PlanStep } from "@/types";

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
const VALIDATION_OUTPUT_HEADER = /^--- 独立校验(?:（首次未通过）)? ---$/;

interface HistoricalOutputSection {
  kind: "command" | "validation";
  text: string;
}

interface HistoricalExecution {
  kind: "command" | "validation";
  command: string;
  output: string;
  exitCode?: number;
  scope?: ExecutionScope;
}

function splitHistoricalOutput(output: string): HistoricalOutputSection[] {
  const sections: Array<{ kind: HistoricalOutputSection["kind"]; lines: string[] }> = [
    { kind: "command", lines: [] },
  ];
  for (const line of output.replace(/\r\n?/g, "\n").split("\n")) {
    if (VALIDATION_OUTPUT_HEADER.test(line.trim())) {
      sections.push({ kind: "validation", lines: [] });
      continue;
    }
    sections[sections.length - 1].lines.push(line);
  }
  return sections.map(({ kind, lines }) => ({ kind, text: lines.join("\n") }));
}

function unwrapHistoricalOutput(
  text: string,
  command: string,
  fallbackExitCode?: number,
): { output: string; exitCode?: number } {
  let normalized = text.replace(/\r\n?/g, "\n");
  const normalizedCommand = command.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const echoedCommand = normalizedCommand ? `$ ${normalizedCommand}` : "";

  // Persisted step output contains a display envelope (`$ command` and
  // `[exit: n]`). The Agent terminal renders those pieces itself, so retain
  // only the server's stdout/stderr here.
  if (echoedCommand && (normalized === echoedCommand || normalized.startsWith(`${echoedCommand}\n`))) {
    normalized = normalized.slice(echoedCommand.length).replace(/^\n/, "");
  } else {
    const lines = normalized.split("\n");
    const firstContentLine = lines.findIndex((line) => line.trim() !== "");
    if (firstContentLine >= 0 && lines[firstContentLine].startsWith("$ ")) {
      lines.splice(firstContentLine, 1);
      normalized = lines.join("\n");
    }
  }

  const lines = normalized.split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const exitMatch = lines[lines.length - 1]?.trim().match(/^\[exit:\s*(-?\d+)\]$/);
  const exitCode = exitMatch ? Number(exitMatch[1]) : fallbackExitCode;
  if (exitMatch) lines.pop();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  while (lines.length && lines[0].trim() === "") lines.shift();

  const output = lines.join("\n");
  return { output: output ? `${output}\n` : "", exitCode };
}

function restoreStepExecutions(step: PlanStep): HistoricalExecution[] {
  if (!step.output) return [];
  return splitHistoricalOutput(step.output).flatMap((section, index) => {
    const command = (section.kind === "validation" ? step.validation : step.command) ?? "";
    const restored = unwrapHistoricalOutput(
      section.text,
      command,
      index === 0 ? step.result?.exitCode : undefined,
    );
    if (!command.trim() && !restored.output && restored.exitCode === undefined) return [];
    return [{
      kind: section.kind,
      command,
      output: restored.output,
      exitCode: restored.exitCode,
      scope: section.kind === "validation" ? step.validationScope : step.executionScope,
    }];
  });
}

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
          restoreStepExecutions(step).forEach((execution, index) => {
            const executionId = `history:${step.id}:${index}`;
            if (execution.command.trim()) {
              entries.push({
                id: ++this.sequence,
                taskId: task.id,
                executionId,
                kind: execution.kind,
                text: execution.command,
                scope: execution.scope,
                createdAt: step.startedAt ?? task.updatedAt,
              });
            }
            if (execution.output || execution.exitCode !== undefined) {
              entries.push({
                id: ++this.sequence,
                taskId: task.id,
                executionId,
                kind: "output",
                text: execution.output,
                scope: execution.scope,
                exitCode: execution.exitCode,
                createdAt: step.startedAt ?? task.updatedAt,
              });
            }
          });
        }
        if (entries.length > MAX_ENTRIES_PER_TASK) entries.splice(0, entries.length - MAX_ENTRIES_PER_TASK);
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
    completionOutput(taskId: string, executionId: string, text: string) {
      const entries = this.entriesByTask[taskId] ??= [];
      const commandEntry = [...entries].reverse().find((entry) => (
        entry.executionId === executionId
        && (entry.kind === "command" || entry.kind === "validation")
      ));
      const completedEntry = [...entries].reverse().find((entry) => (
        entry.executionId === executionId && entry.exitCode !== undefined
      ));
      const restored = unwrapHistoricalOutput(text, commandEntry?.text ?? "");
      const exitCode = completedEntry?.exitCode ?? restored.exitCode;

      if (restored.output) {
        if (completedEntry) delete completedEntry.exitCode;
        this.output(taskId, executionId, restored.output);
        const outputEntry = [...(this.entriesByTask[taskId] ?? [])].reverse().find((entry) => (
          entry.executionId === executionId && entry.kind === "output"
        ));
        if (outputEntry && exitCode !== undefined) outputEntry.exitCode = exitCode;
      } else if (!completedEntry && commandEntry && exitCode !== undefined) {
        commandEntry.exitCode = exitCode;
      }
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
