/** Native-only rejection contract for the final SSH exec payload preflight.
 * Decode this only at the SSH/Agent command invoke rejection boundaries. Remote
 * stdout, model text, generic errors and persisted plain objects are not proof
 * that an operation was never dispatched.
 */
const PREFLIGHT_PREFIX = "OPSARK_SSH_EXEC_PREFLIGHT_V1:";
const PAYLOAD_LIMIT_EXCLUSIVE = 34_744;
const trustedErrors = new WeakSet<object>();

export interface SshExecPayloadDiagnostic {
  readonly version: 1;
  readonly origin: "core";
  readonly code: "SSH_EXEC_PAYLOAD_TOO_LARGE";
  readonly stage: "exec_preflight";
  readonly dispatchCertainty: "not_dispatched";
  readonly retryable: false;
  readonly payloadBytes: number;
  readonly payloadLimitExclusive: 34744;
}

const DIAGNOSTIC_FIELDS = ["version", "origin", "code", "stage", "dispatchCertainty", "retryable", "payloadBytes", "payloadLimitExclusive"];

export class SshExecPayloadError extends Error {
  readonly diagnostic: Readonly<SshExecPayloadDiagnostic>;

  private constructor(payloadBytes: number) {
    super(`SSH 请求超过发送长度限制，命令未派发（${payloadBytes} 字节，须小于 ${PAYLOAD_LIMIT_EXCLUSIVE} 字节）`);
    this.name = "SshExecPayloadError";
    // Reconstruct the allowlisted contract: never retain the rejected value,
    // expanded command, credentials, arbitrary native fields, or an error cause.
    this.diagnostic = Object.freeze({ version: 1, origin: "core", code: "SSH_EXEC_PAYLOAD_TOO_LARGE",
      stage: "exec_preflight", dispatchCertainty: "not_dispatched", retryable: false,
      payloadBytes, payloadLimitExclusive: PAYLOAD_LIMIT_EXCLUSIVE });
    trustedErrors.add(this);
    Object.freeze(this);
  }

  get code() { return this.diagnostic.code; }
  get payloadBytes() { return this.diagnostic.payloadBytes; }
  get payloadLimitExclusive() { return this.diagnostic.payloadLimitExclusive; }

  /** Tauri's Rust Result<_, String> rejection is a string, not an Error wrapper. */
  static fromInvokeRejection(value: unknown): SshExecPayloadError | undefined {
    if (typeof value !== "string" || value.length > 1024 || !value.startsWith(PREFLIGHT_PREFIX)) return undefined;
    const serialized = value.slice(PREFLIGHT_PREFIX.length);
    let parsed: unknown;
    try { parsed = JSON.parse(serialized); } catch { return undefined; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const item = parsed as Record<string, unknown>;
    if (Object.keys(item).length !== DIAGNOSTIC_FIELDS.length
      || !DIAGNOSTIC_FIELDS.every(key => Object.prototype.hasOwnProperty.call(item, key))) return undefined;
    if (item.version !== 1 || item.origin !== "core" || item.code !== "SSH_EXEC_PAYLOAD_TOO_LARGE"
      || item.stage !== "exec_preflight" || item.dispatchCertainty !== "not_dispatched" || item.retryable !== false
      || item.payloadLimitExclusive !== PAYLOAD_LIMIT_EXCLUSIVE
      || typeof item.payloadBytes !== "number" || !Number.isSafeInteger(item.payloadBytes)
      || item.payloadBytes < PAYLOAD_LIMIT_EXCLUSIVE) return undefined;
    // Native serde emits a compact flat object. Requiring its exact JSON form
    // rejects duplicate keys, alternate numeric spellings and trailing material.
    // Key ordering is immaterial, provided it is identical to the parsed object.
    if (JSON.stringify(item) !== serialized) return undefined;
    return new SshExecPayloadError(item.payloadBytes);
  }
}

export function isSshExecPayloadError(error: unknown): error is SshExecPayloadError {
  return error instanceof SshExecPayloadError && trustedErrors.has(error);
}

/** The caller must be the known SSH invoke rejection handler, never a text parser. */
export function normalizeSshCommandInvokeError(error: unknown): unknown {
  return SshExecPayloadError.fromInvokeRejection(error) ?? error;
}
