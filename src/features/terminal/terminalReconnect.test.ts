import { describe, expect, it } from "vitest";
import { shouldHandleTerminalGeneration } from "./terminalReconnect";

describe("terminalReconnect", () => {
  it("忽略旧会话代次的延迟状态事件", () => {
    expect(shouldHandleTerminalGeneration(8, 8)).toBe(true);
    expect(shouldHandleTerminalGeneration(8, 7)).toBe(false);
    expect(shouldHandleTerminalGeneration(undefined, 8)).toBe(false);
  });
});
