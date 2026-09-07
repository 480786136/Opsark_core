import { describe, expect, it } from "vitest";
import { decodeTextFile, encodeTextFile, MAX_EDITABLE_TEXT_SIZE } from "./fileEditor";

describe("fileEditor", () => {
  it("识别 UTF-8 BOM 和 CRLF 换行", () => {
    const data = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a\r\nb\r\n")]);
    expect(decodeTextFile(data)).toMatchObject({ content: "a\r\nb\r\n", hasBom: true, lineEnding: "CRLF" });
  });

  it("拒绝二进制、非法 UTF-8 和超限文件", () => {
    expect(decodeTextFile(new Uint8Array([1, 0, 2]))).toBe("binary");
    expect(decodeTextFile(new Uint8Array([0xc3, 0x28]))).toBe("invalid_utf8");
    expect(decodeTextFile(new Uint8Array(MAX_EDITABLE_TEXT_SIZE + 1))).toBe("too_large");
  });

  it("保留 BOM 并按选择的换行符编码", () => {
    const encoded = encodeTextFile("a\nb\n", "CRLF", true);
    expect([...encoded.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(encoded)).toBe("a\r\nb\r\n");
  });
});
