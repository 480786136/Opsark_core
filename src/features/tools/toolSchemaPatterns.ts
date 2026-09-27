// ECMAScript whitespace, written explicitly because Python/Rust \s differ
// for BOM, NEL and some control characters. Exported schemas contain literals.
export const schemaWhitespace = "\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
export const schemaNonWhitespace = `[^${schemaWhitespace}]`;

// JS/Python $ may match before a final newline; Rust's default differs.
// The portable negative lookahead requires the actual end of the string.
export const fullSchemaPattern = (body: string) => `^(?:${body})$(?![\\s\\S])`;
