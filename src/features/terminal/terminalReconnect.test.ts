import { describe, expect, it } from "vitest";
import {
  MAX_TERMINAL_RECONNECT_ATTEMPTS,
  reconnectDelay,
  shouldHandleTerminalGeneration,
} from "./terminalReconnect";

describe("terminalReconnect", () => {
  it("使用有上限的指数退避", () => {
    expect(reconnectDelay(1)).toBe(1_000);
    expect(reconnectDelay(2)).toBe(2_000);
    expect(reconnectDelay(3)).toBe(4_000);
    expect(reconnectDelay(MAX_TERMINAL_RECONNECT_ATTEMPTS + 1)).toBeUndefined();
  });

  it("忽略旧会话代次的延迟状态事件", () => {
    expect(shouldHandleTerminalGeneration(8, 8)).toBe(true);
    expect(shouldHandleTerminalGeneration(8, 7)).toBe(false);
    expect(shouldHandleTerminalGeneration(undefined, 8)).toBe(false);
  });
});
