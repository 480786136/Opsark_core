import type { ToolResult } from "./types";
import { ToolArgumentValidationError } from "./toolArgumentProtocol";

export type ToolFailureCategory = "arguments" | "unavailable" | "authentication" | "permission" | "network" | "timeout" | "rate_limit" | "business" | "output";
export type ToolDispatchState = "not_sent" | "sent" | "unknown";

/** Only adapters may assert dispatch state. Model-authored text cannot grant replay. */
export class ToolExecutionError extends Error {
  constructor(message: string, readonly category: ToolFailureCategory, readonly dispatchState: ToolDispatchState = "unknown", readonly retryAfterMs?: number, readonly partialData?: Record<string, unknown>) {
    super(message);
    this.name = "ToolExecutionError";
  }
}
export function toolFailure(error: unknown, started: boolean): NonNullable<ToolResult["error"]> {
  if (error instanceof ToolArgumentValidationError) return {
    code: "INVALID_ARGUMENTS", category: "arguments", dispatchState: "not_sent", argumentPath: error.argumentPath, message: error.message,
  };
  if (error instanceof ToolExecutionError) return {
    code: `TOOL_${error.category.toUpperCase()}`, category: error.category, dispatchState: error.dispatchState,
    message: error.message, retryAfterMs: error.retryAfterMs,
  };
  const message = String(error);
  // These stable executor prefixes describe a failure before a command/channel is sent.
  if (/^(?:Error: )?SSH (?:网络连接失败|握手失败|会话创建失败)[：:]/.test(message)) {
    return { code: "TOOL_NETWORK", category: "network", dispatchState: "not_sent", message };
  }
  if (/^(?:Error: )?SSH (?:用户名或密码不正确|身份认证失败)/.test(message)) {
    return { code: "TOOL_AUTHENTICATION", category: "authentication", dispatchState: "not_sent", message };
  }
  return { code: started ? "TOOL_EXECUTION_FAILED" : "TOOL_UNAVAILABLE", category: started ? "business" : "unavailable", dispatchState: started ? "unknown" : "not_sent", message };
}
