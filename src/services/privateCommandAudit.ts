/** The public descriptor contains credential references; private material exists
 * only on the transport path. This is not an authorization or risk override. */
export interface PrivateCommandAudit {
  displayCommand: string;
  secretValues: string[];
}

export function privateCommandRedactor(command: string, audit: PrivateCommandAudit) {
  if (!audit.displayCommand.trim() || audit.displayCommand.length > 16384
    || !Array.isArray(audit.secretValues) || audit.secretValues.some(value => typeof value !== "string")) {
    throw new Error("私密探针缺少有效的公开审计描述");
  }
  const values = [...new Set(audit.secretValues.filter(Boolean))].sort((a, b) => b.length - a.length);
  // Include shell-quoted spellings: a quote in a password changes the echoed
  // representation, and exact raw-value replacement alone would miss it.
  const variants = [...new Set(values.flatMap(value => [value, value.replace(/'/g, "'\"'\"'"), JSON.stringify(value).slice(1, -1)]))]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  const redact = (value: string) => variants.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
  const display = redact(audit.displayCommand);
  return (value: string) => redact(command ? value.split(command).join(display) : value);
}
