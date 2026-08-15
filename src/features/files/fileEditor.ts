export type LineEnding = "LF" | "CRLF" | "CR" | "Mixed" | "None";
export type TextFileError = "too_large" | "binary" | "invalid_utf8";

export interface DecodedTextFile {
  content: string;
  encoding: "UTF-8";
  lineEnding: LineEnding;
  hasBom: boolean;
  size: number;
}

export const MAX_EDITABLE_TEXT_SIZE = 2 * 1024 * 1024;

function detectLineEnding(content: string): LineEnding {
  const crlfCount = (content.match(/\r\n/g) ?? []).length;
  const withoutCrlf = content.replace(/\r\n/g, "");
  const lfCount = (withoutCrlf.match(/\n/g) ?? []).length;
  const crCount = (withoutCrlf.match(/\r/g) ?? []).length;
  const kinds = [crlfCount, lfCount, crCount].filter((count) => count > 0).length;
  if (kinds > 1) return "Mixed";
  if (crlfCount) return "CRLF";
  if (lfCount) return "LF";
  if (crCount) return "CR";
  return "None";
}

/** 仅解码明确的 UTF-8 文本，避免将二进制或其他编码误写回远程文件。 */
export function decodeTextFile(data: Uint8Array): DecodedTextFile | TextFileError {
  if (data.byteLength > MAX_EDITABLE_TEXT_SIZE) return "too_large";
  if (data.includes(0)) return "binary";
  const hasBom = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return {
      content,
      encoding: "UTF-8",
      lineEnding: detectLineEnding(content),
      hasBom,
      size: data.byteLength,
    };
  } catch {
    return "invalid_utf8";
  }
}

export function encodeTextFile(content: string, lineEnding: LineEnding, hasBom: boolean) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const converted = lineEnding === "Mixed" || lineEnding === "None"
    ? content
    : lineEnding === "CRLF"
    ? normalized.replace(/\n/g, "\r\n")
    : lineEnding === "CR"
      ? normalized.replace(/\n/g, "\r")
      : normalized;
  const encoded = new TextEncoder().encode(converted);
  if (!hasBom) return encoded;
  const result = new Uint8Array(encoded.length + 3);
  result.set([0xef, 0xbb, 0xbf]);
  result.set(encoded, 3);
  return result;
}
