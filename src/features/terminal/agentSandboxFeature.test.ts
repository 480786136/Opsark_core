import { describe, expect, it } from "vitest";
import {
  AGENT_SANDBOX_TERMINAL_V1_STORAGE_KEY,
  DEFAULT_AGENT_SANDBOX_TERMINAL_V1,
  agentSandboxTerminalV1Enabled,
  setAgentSandboxTerminalV1Override,
} from "./agentSandboxFeature";

describe("agent sandbox terminal feature switch", () => {
  it("uses the sandbox route by default", () => {
    expect(DEFAULT_AGENT_SANDBOX_TERMINAL_V1).toBe(true);
    expect(agentSandboxTerminalV1Enabled({ getItem: () => null })).toBe(true);
  });

  it("supports a one-version stateless SSH rollback without selecting user PTY", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    setAgentSandboxTerminalV1Override(false, storage);
    expect(values.get(AGENT_SANDBOX_TERMINAL_V1_STORAGE_KEY)).toBe("0");
    expect(agentSandboxTerminalV1Enabled(storage)).toBe(false);
    setAgentSandboxTerminalV1Override(undefined, storage);
    expect(agentSandboxTerminalV1Enabled(storage)).toBe(true);
  });
});
