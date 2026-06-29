import type { RawRequest } from "../types";

/** Mirror of the API's normalizeUrl (apps/api/src/utils/hash.ts). Keep in sync. */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let normalized = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}`;
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    normalized += path;
    if (parsed.searchParams.toString()) {
      const sorted = new URLSearchParams(
        [...parsed.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      );
      normalized += `?${sorted.toString()}`;
    }
    if (parsed.hash) normalized += parsed.hash;
    return normalized;
  } catch {
    return url;
  }
}

/**
 * Mirror of the API's identity rule. Identity = (method, url, uniqueKey); the
 * request body is deliberately excluded. The mock/oracle keys its store by this
 * string (no hashing needed — internal consistency is what matters).
 */
export function deriveIdentity(req: RawRequest): string {
  const method = (req.method ?? "GET").toUpperCase();
  const url = normalizeUrl(req.url);
  return `${method} ${url} ${req.uniqueKey ?? url}`;
}
