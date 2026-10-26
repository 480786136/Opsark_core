/** Finite rewrite-module return subset. Declaration only: Nginx may generate
 * or suppress response bytes (e.g. 204/304/HEAD); no observed body is inferred.
 * Redirects, 444 and Nginx-internal status codes require distinct semantics.
 * https://nginx.org/en/docs/http/ngx_http_rewrite_module.html#return */
export const NGINX_UNSUPPORTED_RETURN_CODES = [301, 302, 303, 307, 308, 444, 494, 495, 496, 497, 498, 499] as const;
export function nginxLiteralReturn(args: readonly string[]): { statusCode: number; declaredText?: string } | undefined {
  if (args.length < 1 || args.length > 2 || !/^[2-5][0-9]{2}$/.test(args[0] ?? "")) return;
  const statusCode = Number(args[0]);
  if ((NGINX_UNSUPPORTED_RETURN_CODES as readonly number[]).includes(statusCode)) return;
  if (args.length === 2 && (args[1]!.includes("$") || args[1]!.includes("\0") || new TextEncoder().encode(args[1]!).length > 4096)) return;
  return { statusCode, ...(args.length === 2 ? { declaredText: args[1]! } : {}) };
}
