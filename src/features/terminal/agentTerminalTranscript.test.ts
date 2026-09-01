import { describe, expect, it } from "vitest";
import type { AgentTerminalEntry } from "./agentTerminalStore";
import { buildAgentTerminalTranscript, toXtermData } from "./agentTerminalTranscript";

function entry(input: Partial<AgentTerminalEntry> & Pick<AgentTerminalEntry, "id" | "kind" | "text">): AgentTerminalEntry {
  return {
    taskId: "task-1",
    createdAt: "2026-08-30T00:00:00.000Z",
    ...input,
  };
}

describe("Agent terminal transcript", () => {
  it("renders only server commands, raw output and exit status", () => {
    const transcript = buildAgentTerminalTranscript([
      entry({ id: 1, kind: "system", text: "执行 获取主机名：hostname" }),
      entry({ id: 2, kind: "command", text: "hostname", executionId: "exec-1", scope: "isolated_exec" }),
      entry({ id: 3, kind: "output", text: "bogon\n", executionId: "exec-1", exitCode: 0 }),
    ]);

    expect(transcript).toBe("[Agent] $ hostname\nbogon\n[Agent] process exited with code 0\n");
    expect(transcript).not.toContain("执行 获取主机名");
    expect(transcript).not.toContain("isolated_exec");
  });

  it("renders multiline commands as terminal continuation input", () => {
    const transcript = buildAgentTerminalTranscript([
      entry({ id: 1, kind: "validation", text: "test -d /opt\necho OK", exitCode: 1 }),
    ]);

    expect(transcript).toBe([
      "[Agent 验证] $ test -d /opt",
      "[Agent 验证] > echo OK",
      "[Agent] process exited with code 1",
      "",
    ].join("\n"));
  });

  it("normalizes terminal newlines without duplicating carriage returns", () => {
    expect(toXtermData("one\ntwo\r\nthree")).toBe("one\r\ntwo\r\nthree");
  });
});
