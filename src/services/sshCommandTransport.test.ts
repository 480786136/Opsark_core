import { describe, expect, it } from "vitest";
import { isSshExecPayloadError, normalizeSshCommandInvokeError, SshExecPayloadError } from "./sshCommandTransport";

const prefix = "OPSARK_SSH_EXEC_PREFLIGHT_V1:";
const diagnostic = { version: 1, origin: "core", code: "SSH_EXEC_PAYLOAD_TOO_LARGE", stage: "exec_preflight",
  dispatchCertainty: "not_dispatched", retryable: false, payloadBytes: 34744, payloadLimitExclusive: 34744 };
const envelope = (overrides: Record<string, unknown> = {}) => prefix + JSON.stringify({ ...diagnostic, ...overrides });

describe("native SSH exec payload rejection contract", () => {
  it.each([34744, 34745, 65536, Number.MAX_SAFE_INTEGER])("retains bounded diagnostics for %s bytes", payloadBytes => {
    const result = normalizeSshCommandInvokeError(envelope({ payloadBytes }));
    expect(isSshExecPayloadError(result)).toBe(true);
    expect(result).toBeInstanceOf(SshExecPayloadError);
    if (!isSshExecPayloadError(result)) throw new Error("expected trusted native diagnostic");
    expect(result.diagnostic).toEqual({ ...diagnostic, payloadBytes });
    expect(result.code).toBe("SSH_EXEC_PAYLOAD_TOO_LARGE");
    expect(result.payloadBytes).toBe(payloadBytes);
    expect(result.payloadLimitExclusive).toBe(34744);
    expect(result.message).toContain("未派发");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.diagnostic)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, "cause")).toBe(false);
  });

  it.each([
    { version: 2 }, { version: "1" }, { origin: "provider" }, { code: "LIBSSH2_ERROR_INVAL" },
    { stage: "channel_exec" }, { dispatchCertainty: "sent" }, { retryable: true }, { retryable: "false" },
    { payloadLimitExclusive: 34745 }, { payloadLimitExclusive: "34744" },
    { payloadBytes: -1 }, { payloadBytes: 34743 }, { payloadBytes: 34744.5 }, { payloadBytes: "34744" },
    { payloadBytes: Number.MAX_SAFE_INTEGER + 1 }, { payloadBytes: null }, { payloadBytes: Infinity },
    { command: "private-command" }, { password: "private-password" }, { diagnostic: {} },
  ])("rejects invalid, unknown or extended fields: %j", overrides => {
    const source = envelope(overrides);
    expect(normalizeSshCommandInvokeError(source)).toBe(source);
    expect(isSshExecPayloadError(source)).toBe(false);
  });

  it.each(Object.keys(diagnostic))("requires the native field %s", field => {
    const incomplete = { ...diagnostic } as Record<string, unknown>;
    delete incomplete[field];
    const source = prefix + JSON.stringify(incomplete);
    expect(normalizeSshCommandInvokeError(source)).toBe(source);
  });

  it.each([
    prefix, prefix + "{}", prefix + "null", prefix + "[]", prefix + '"diagnostic"',
    "native failed: " + envelope(), " " + envelope(), envelope() + " extra", envelope() + "\n",
    prefix + JSON.stringify(diagnostic, null, 2),
    envelope().replace('"payloadBytes":34744', '"payloadBytes":34744,"payloadBytes":34745'),
    envelope().replace('"payloadBytes":34744', '"payloadBytes":3.4744e4'),
    envelope().replace('"origin":"core"', '"origin":"co\\u0072e"'),
    prefix + JSON.stringify({ ...diagnostic, extra: "x".repeat(1024) }),
    "Failed opening SSH channel: [Session(-34)]", "command may have run", "cancelled",
  ])("does not infer dispatch from malformed or unrelated text: %s", source => {
    expect(normalizeSshCommandInvokeError(source)).toBe(source);
  });

  it("rejects error wrappers, serialized plain objects and prototype impersonation", () => {
    const actual = normalizeSshCommandInvokeError(envelope());
    const wrapped = new Error(envelope());
    const forged = Object.assign(Object.create(SshExecPayloadError.prototype), { diagnostic });
    const values = [undefined, null, diagnostic, { message: envelope() }, wrapped, forged,
      { name: "SshExecPayloadError", diagnostic }, JSON.parse(JSON.stringify(actual))];
    for (const value of values) {
      expect(isSshExecPayloadError(value)).toBe(false);
      expect(normalizeSshCommandInvokeError(value)).toBe(value);
    }
    expect(isSshExecPayloadError(actual)).toBe(true);
  });
});
