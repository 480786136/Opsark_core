import { describe, expect, it } from "vitest";
import { buildProbeDecoder, parseProbeDeliveryFailure, ProbeDeliveryError } from "./probeDelivery";
import { toolFailure } from "./toolFailure";
import packed from "./operations_probe.py?opsark-probe";

const unavailable = { version: 1, code: "PROBE_DECODER_UNAVAILABLE", stage: "decoder_import" };
const invalid = { version: 1, code: "PROBE_SOURCE_INVALID", stage: "source_decode" };
const frame = failure => "OPSARK_PROBE_DELIVERY " + JSON.stringify(failure);

describe("探针交付诊断只接受完整固定帧", () => {
  it("两个固定诊断在空stderr/exit125时是已派发失败，保留完整回执", () => {
    for (const failure of [unavailable, invalid]) for (const ending of ["", "\n", "\r\n"]) {
      const receipt = { stdout: frame(failure) + ending, stderr: "", exitCode: 125 };
      const parsed = parseProbeDeliveryFailure(receipt.stdout, receipt.stderr, receipt.exitCode);
      expect(parsed).toEqual(failure);
      const error = new ProbeDeliveryError(parsed, receipt);
      expect(toolFailure(error, true)).toMatchObject({ code: failure.code, dispatchState: "sent",
        category: failure === unavailable ? "unavailable" : "output" });
      expect(error.partialData).toEqual({ ...receipt, deliveryFailure: failure });
    }
  });

  it("缺流、stderr、异常字段、混帧、输出尾随及非125不能被提升为可信delivery诊断", () => {
    const original = frame(unavailable);
    for (const [stdout, stderr, exitCode] of [
      [undefined, "", 125], [original, undefined, 125], [original, " ", 125], [original, "error", 125],
      [original, "", 0], [original, "", "125"], [original, "", undefined],
      [original + "\n\n", "", 125], [" " + original, "", 125], [original + "garbage", "", 125],
      [original + "\n" + original, "", 125], [original + "\nOPSARK_RESULT {}", "", 125],
      ["OPSARK_CAPABILITIES {}\n" + original, "", 125], [frame({ ...unavailable, extra: true }), "", 125],
      [frame({ ...unavailable, version: 2 }), "", 125], [frame({ ...unavailable, stage: "source_decode" }), "", 125],
      [frame({ ...unavailable, code: "SSH_EXEC_PAYLOAD_TOO_LARGE" }), "", 125],
    ]) expect(parseProbeDeliveryFailure(stdout, stderr, exitCode)).toBeUndefined();
  });

  it("构建期元数据非法时不构造任意Python表达式", () => {
    for (const patch of [{ sourceBytes: 0 }, { sourceBytes: 1.5 }, { sourceBytes: 1024 * 1024 + 1 },
      { version: 2 }, { encoding: "raw" }, { sourceSha256: "bad'code" }, { data: "" }, { data: "a'\nprint(1)" }]) {
      expect(() => buildProbeDecoder({ ...packed, ...patch })).toThrow("元数据");
    }
  });
});
