import { describe, expect, it } from "vitest";
import {
  appendCommandCompletion,
  appendTerminalBlock,
  appendTerminalStream,
  isTerminalProgressFrame,
} from "@/features/agent/terminalBuffer";
import { appendTerminalOutput } from "@/utils/terminal";

describe("terminal buffer", () => {
  it("replaces carriage-return download frames and bounds retained output", () => {
    let output = appendTerminalOutput("downloading\n10%", "\r20%");
    output = appendTerminalOutput(output, "\r30%\nready\n");
    expect(output).toBe("downloading\n30%\nready\n");

    expect(appendTerminalOutput("old-line\n", "new-line-that-is-long", 12)).toBe("that-is-long");
  });

  it("recognizes and replaces adjacent percentage progress frames", () => {
    const lines = ["downloading", "10%"];
    appendTerminalStream(lines, "20%\nfile ready\n");

    expect(isTerminalProgressFrame("### 42.5%")).toBe(true);
    expect(lines).toEqual(["downloading", "20%", "file ready"]);
  });

  it("keeps only the exit line after streamed output", () => {
    const lines = ["streamed output"];
    appendCommandCompletion(lines, "$ command\nstreamed output\n[exit: 0]", true);
    expect(lines).toEqual(["streamed output", "[exit: 0]"]);
  });

  it("removes the duplicated prompt when no stream was emitted", () => {
    const lines = ["$ command"];
    appendCommandCompletion(lines, "$ command\nresult\n[exit: 0]", false);
    expect(lines).toEqual(["$ command", "result", "[exit: 0]"]);
  });

  it("applies the same capacity limit to streams and blocks", () => {
    const lines = ["old-1", "old-2"];
    appendTerminalStream(lines, "new-1\nnew-2", 3);
    expect(lines).toEqual(["old-2", "new-1", "new-2"]);

    appendTerminalBlock(lines, "validation", "line-1\nline-2", 3);
    expect(lines).toEqual(["validation", "line-1", "line-2"]);
  });
});
