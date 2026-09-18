export const TOKENS_PER_CREDIT = 10_000;

/** User-facing credits always round a partial 10,000-token unit upward. */
export function tokensToCredits(tokens: number) {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.ceil(tokens / TOKENS_PER_CREDIT);
}

export function formatCredits(tokens: number, locale?: string) {
  return tokensToCredits(tokens).toLocaleString(locale);
}
