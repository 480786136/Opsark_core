import { ToolExecutionError } from "./toolFailure";

export interface PackedProbeSource {
  readonly version: 1;
  readonly encoding: "zlib-base64";
  readonly data: string;
  readonly sourceBytes: number;
  readonly sourceSha256: string;
}

export type ProbeDeliveryFailure =
  | { version: 1; code: "PROBE_DECODER_UNAVAILABLE"; stage: "decoder_import" }
  | { version: 1; code: "PROBE_SOURCE_INVALID"; stage: "source_decode" };

const PREFIX = "OPSARK_PROBE_DELIVERY ";
const UNAVAILABLE: ProbeDeliveryFailure = { version: 1, code: "PROBE_DECODER_UNAVAILABLE", stage: "decoder_import" };
const INVALID: ProbeDeliveryFailure = { version: 1, code: "PROBE_SOURCE_INVALID", stage: "source_decode" };
const frame = (failure: ProbeDeliveryFailure) => PREFIX + JSON.stringify(failure);

/** A delivery receipt proves remote execution, never local not-dispatched. */
export function parseProbeDeliveryFailure(stdout: unknown, stderr: unknown, exitCode: unknown): ProbeDeliveryFailure | undefined {
  if (exitCode !== 125 || typeof stdout !== "string" || stderr !== "") return undefined;
  // Match the complete fixed frame, including its exact field set and values. Do not search mixed output.
  for (const failure of [UNAVAILABLE, INVALID]) {
    const expected = frame(failure);
    if (stdout === expected || stdout === expected + "\n" || stdout === expected + "\r\n") return { ...failure };
  }
  return undefined;
}

export class ProbeDeliveryError extends ToolExecutionError {
  constructor(failure: ProbeDeliveryFailure, receipt: Record<string, unknown>) {
    super(failure.code === "PROBE_DECODER_UNAVAILABLE" ? "远端 Python 缺少探针解码所需标准库，采集未开始"
      : "远端探针源码完整性校验失败，采集未开始",
    failure.code === "PROBE_DECODER_UNAVAILABLE" ? "unavailable" : "output", "sent", undefined,
    { ...receipt, deliveryFailure: failure }, failure.code);
    this.name = "ProbeDeliveryError";
  }
}

/** Python 3.6+; no probe collection executes until the exact original bytes are verified. */
export function buildProbeDecoder(source: PackedProbeSource): string {
  if (source.version !== 1 || source.encoding !== "zlib-base64"
    || !Number.isSafeInteger(source.sourceBytes) || source.sourceBytes < 1 || source.sourceBytes > 1024 * 1024
    || !/^[a-f0-9]{64}$/.test(source.sourceSha256) || source.data.length > 2 * 1024 * 1024
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data) || !source.data) {
    throw new Error("探针打包元数据无效");
  }
  const decoder = `def _opsark_fail(frame):
    print(frame, flush=True)
    raise SystemExit(125)
try:
    import base64, zlib, hashlib
except Exception:
    _opsark_fail(${JSON.stringify(frame(UNAVAILABLE))})
try:
    _packed = base64.b64decode(${JSON.stringify(source.data)}, validate=True)
    _inflater = zlib.decompressobj()
    _source = _inflater.decompress(_packed, ${source.sourceBytes + 1})
    if (len(_source) != ${source.sourceBytes} or not _inflater.eof or _inflater.unused_data
            or _inflater.unconsumed_tail or hashlib.sha256(_source).hexdigest() != ${JSON.stringify(source.sourceSha256)}):
        raise ValueError("probe source integrity")
    _code = compile(_source, "<string>", "exec")
except Exception:
    _opsark_fail(${JSON.stringify(frame(INVALID))})
exec(_code, _opsark_target, _opsark_target)
`;
  // Evaluate the copy before entering the helper namespace: no decoder variables leak into the probe.
  // Keep -c globals/argv, without claiming sys.modules['__main__'].__dict__ object identity.
  return `exec(${JSON.stringify(decoder)}, {"__builtins__": __builtins__, "_opsark_target": globals().copy()})`;
}
