import type { ObservationProbeResult } from "@/features/agent/observationRuntime";
import type { HealthObservationRequest } from "./healthObservation";

const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const safeId = (id: string) => { if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("观察探针身份无效"); return id; };

/** Fixed GET; no Python, shell interpolation, retries, redirects, curlrc or body capture. */
export function buildHealthObservationProbe(request: HealthObservationRequest, executionId: string, timeoutMs: number) {
  const id = safeId(executionId);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new Error("观察探针期限无效");
  return `if ! command -v curl >/dev/null 2>&1; then
  printf '%s\\n' ${quote("OPSARK_HEALTH_UNSUPPORTED " + id)}
else
  printf '%s\\n' ${quote("OPSARK_HEALTH_STARTED " + id)}
  opsark_health_code=$(command curl -q --silent --show-error --globoff --noproxy '*' --proxy '' --request GET --output /dev/null --max-time ${(timeoutMs / 1000).toFixed(3)} --write-out '%{http_code}' -- ${quote(request.url)})
  opsark_health_exit=$?
  printf '\\nOPSARK_HEALTH_RESULT %s %s %s\\n' ${quote(id)} "$opsark_health_exit" "$opsark_health_code"
fi`;
}

/** Only exact lines from the fixed probe can start observation time. */
export function healthProbeStartReader(executionId: string, onStarted: () => void) {
  const marker = "OPSARK_HEALTH_STARTED " + safeId(executionId);
  let buffer = "", marked = false;
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    if (buffer.length > 1024) buffer = "";
    for (const line of lines) if (line === marker && !marked) { marked = true; onStarted(); }
  };
}

export function parseHealthObservationProbe(request: HealthObservationRequest, executionId: string,
  receipt: { success: boolean; exitCode?: number; stdout?: string; stdoutTruncated?: boolean }): ObservationProbeResult {
  const base = { executionId, matched: false, facts: { protocol: "curl-status-v1" } };
  if (!receipt.success || receipt.exitCode !== 0 || receipt.stdoutTruncated || typeof receipt.stdout !== "string" || receipt.stdout.length > 2048) {
    return { ...base, status: "invalid", facts: { ...base.facts, reason: "incomplete_remote_receipt",
      ...(Number.isInteger(receipt.exitCode) && receipt.exitCode! >= 0 && receipt.exitCode! <= 255 ? { remoteExitCode: receipt.exitCode } : {}) } };
  }
  const lines = receipt.stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length === 1 && lines[0] === "OPSARK_HEALTH_UNSUPPORTED " + executionId) return { ...base, status: "unsupported", facts: { ...base.facts, reason: "curl_unavailable", remoteExitCode: 0 } };
  if (lines.length !== 2 || lines[0] !== "OPSARK_HEALTH_STARTED " + executionId) return { ...base, status: "invalid", facts: { ...base.facts, reason: "probe_protocol_invalid", remoteExitCode: 0 } };
  const result = lines[1].match(/^OPSARK_HEALTH_RESULT ([A-Za-z0-9_-]+) ([0-9]{1,3}) ([0-9]{3})$/);
  if (!result || result[1] !== executionId) return { ...base, status: "invalid", facts: { ...base.facts, reason: "probe_identity_invalid", remoteExitCode: 0 } };
  const code = Number(result[2]), httpStatus = Number(result[3]);
  // 6/7/28 are completed DNS/connect/transfer attempts. Local option/config/TLS
  // failures retain their code but never become a successful observation window.
  const valid = code === 0 ? httpStatus >= 100 && httpStatus <= 599 : [6, 7, 28].includes(code) && (httpStatus === 0 || httpStatus >= 100 && httpStatus <= 599);
  return { executionId, status: valid ? "valid" : "invalid", matched: valid && code === 0 && httpStatus === request.expectedStatus,
    facts: { protocol: "curl-status-v1", curlExitCode: code, httpStatus: httpStatus || null, remoteExitCode: 0,
      ...(!valid ? { reason: "curl_not_a_valid_observation" } : {}) } };
}
