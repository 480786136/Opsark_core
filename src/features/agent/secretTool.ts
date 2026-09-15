const SECRET_PATTERN = /\$\{secret\.([A-Z0-9_]+)\}/g;
const SECRET_CANDIDATE_PATTERN = /\$\{secret\.[^}]*\}/g;
const MIN_UNSCOPED_EXACT_SECRET_LENGTH = 8;
const SENSITIVE_FIELD_NAME = /(?:password|passwd|pwd|api[_-]?key|access[_-]?token|secret|credential|user(?:name)?|login|account)/i;

export interface ExecutionRedactionOptions {
  /** Secrets injected into the current command must be masked even when short. */
  exactSecretKeys?: Iterable<string>;
  marker?: string;
}

function canSafelyMatchEverywhere(secret: string) {
  const normalized = secret.trim();
  return normalized.length >= MIN_UNSCOPED_EXACT_SECRET_LENGTH
    // Dates, versions, IP-like values and identifiers made only from numbers
    // and separators are common evidence, even when they are fairly long.
    && !/^[\d\s.,:/_+\-]+$/u.test(normalized);
}

export function redactExecutionOutput(
  value: string,
  secretValues: Record<string, string>,
  options: ExecutionRedactionOptions = {},
) {
  const exactSecretKeys = new Set(options.exactSecretKeys ?? []);
  const marker = options.marker ?? "••••••••";
  // Unreferenced short/common values are unsafe as global search terms: a saved
  // value such as "1" would otherwise corrupt timestamps, CPU counts and sizes.
  // A value injected into this execution remains fail-closed regardless of size.
  const exactSecrets = Object.entries(secretValues)
    .filter(([key, secret]) => secret
      && (exactSecretKeys.has(key) || canSafelyMatchEverywhere(secret)))
    .map(([, secret]) => secret)
    .sort((left, right) => right.length - left.length);
  let output = exactSecrets.reduce(
    (current, secret) => current.split(secret).join(marker),
    value,
  );
  if (!SENSITIVE_FIELD_NAME.test(output)) return output;
  output = output.replace(
    /^(\s*[\w.-]*(?:password|passwd|pwd|api[_-]?key|access[_-]?token|secret|credential|user(?:name)?|login|account)[\w.-]*\s*[:=]\s*).+$/gim,
    (_match, prefix: string) => `${prefix}${marker}`,
  );
  output = output.replace(
    /(["']?[\w.-]*(?:password|passwd|pwd|api[_-]?key|access[_-]?token|secret|credential|user(?:name)?|login|account)[\w.-]*["']?\s*[:=]\s*["'])[^"'\r\n]+(["'])/gi,
    (_match, prefix: string, suffix: string) => `${prefix}${marker}${suffix}`,
  );
  return output.replace(
    /([?&](?:password|passwd|pwd|api[_-]?key|access[_-]?token|secret|credential|user(?:name)?|login|account)=)[^&\s]+/gi,
    (_match, prefix: string) => `${prefix}${marker}`,
  );
}

export function findSecretKeys(value: string): string[] {
  return [...value.matchAll(SECRET_PATTERN)].map((match) => match[1]);
}

export function findInvalidSecretPlaceholders(value: string): string[] {
  return [...value.matchAll(SECRET_CANDIDATE_PATTERN)]
    .map((match) => match[0])
    .filter((candidate) => !/^\$\{secret\.[A-Z0-9_]+\}$/.test(candidate));
}

export function mergeSecretPlaceholders(value: string, secretValues: Record<string, string>): string {
  return value.replace(SECRET_PATTERN, (_match, key: string) => secretValues[key] ?? "");
}
