const STORAGE_KEY = "opsark.feature.agentSandboxTerminalV1";

/**
 * The sandbox route is the production default. Setting the localStorage value
 * to "0" keeps Agent execution on the independent stateless SSH executor for
 * one-version rollback; neither branch may write into a user TerminalPanel.
 */
export const DEFAULT_AGENT_SANDBOX_TERMINAL_V1 = true;

export function agentSandboxTerminalV1Enabled(storage: Pick<Storage, "getItem"> = localStorage) {
  const override = storage.getItem(STORAGE_KEY);
  if (override === "0") return false;
  if (override === "1") return true;
  return DEFAULT_AGENT_SANDBOX_TERMINAL_V1;
}

export function setAgentSandboxTerminalV1Override(
  enabled: boolean | undefined,
  storage: Pick<Storage, "setItem" | "removeItem"> = localStorage,
) {
  if (enabled === undefined) storage.removeItem(STORAGE_KEY);
  else storage.setItem(STORAGE_KEY, enabled ? "1" : "0");
}

export const AGENT_SANDBOX_TERMINAL_V1_STORAGE_KEY = STORAGE_KEY;
