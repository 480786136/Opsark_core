const SECRET_PATTERN = /\$\{secret\.([A-Z0-9_]+)\}/g;
const SECRET_CANDIDATE_PATTERN = /\$\{secret\.[^}]*\}/g;

export function redactExecutionOutput(value: string, secretValues: Record<string, string>) {
  let output = Object.values(secretValues).reduce(
    (current, secret) => secret ? current.split(secret).join("••••••••") : current,
    value,
  );
  output = output.replace(
    /^(\s*[\w.-]*(?:password|passwd|pwd|api[_-]?key|access[_-]?token|secret)[\w.-]*\s*[:=]\s*).+$/gim,
    "$1••••••••",
  );
  return output.replace(
    /([?&](?:password|passwd|pwd|api[_-]?key|access[_-]?token|secret)=)[^&\s]+/gi,
    "$1••••••••",
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
