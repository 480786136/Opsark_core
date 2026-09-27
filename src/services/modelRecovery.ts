/** Core-owned identity shared by one model operation and all of its automatic repairs. */
export interface ModelRecoveryContext {
  operationId: string;
  startedAtMs: number;
  maxGenerations?: number;
  maxTransportAttempts?: number;
  maxElapsedMs?: number;
  maxTotalTokens?: number;
}

export function createModelRecoveryContext(): ModelRecoveryContext {
  return { operationId: `model-operation-${crypto.randomUUID()}`, startedAtMs: Date.now() };
}

function parseContext(context: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(context || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* Keep legacy free-form context intact in a field. */ }
  return { originalContext: context };
}

export function recoveryFromContext(context: string): ModelRecoveryContext | undefined {
  return parseContext(context)._modelRecovery as ModelRecoveryContext | undefined;
}

/** Never mutate a reusable RuntimeModel or attach a permanent budget to a task. */
export function ensureModelRecoveryContext(context: string, recovery?: ModelRecoveryContext): string {
  const parsed = parseContext(context);
  // Rust validates and freezes the context. Do not replace an invalid supplied
  // identity with a fresh budget on the frontend.
  const existing = Object.prototype.hasOwnProperty.call(parsed, "_modelRecovery");
  return JSON.stringify({ ...parsed, _modelRecovery: recovery !== undefined ? recovery
    : existing ? parsed._modelRecovery : createModelRecoveryContext() });
}
