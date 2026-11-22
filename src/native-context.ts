/**
 * Native platform context forwarding.
 *
 * The SDK forwards platform-identity context (run/build/actor identifiers)
 * as a JSON header; the API maps it to scraper identity server-side.
 * Filtering is pattern-based, not vendor-based, so supporting a new
 * platform requires no SDK release — any runner exposing `*_ID` variables
 * works. No other environment variables are forwarded.
 */

/**
 * Only platform-identity-shaped names are forwarded: vars ending in `_ID`
 * (run/build/actor identifiers on any platform) plus NODE_ENV, REGION, CI.
 */
const ALLOWED_NAME = /_ID$|^(NODE_ENV|REGION|CI)$/;

/** Credential-shaped names never leave the process, even if `*_ID`-shaped. */
const DENYLIST = /TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY|AUTH|COOKIE/i;

/** Credential-shaped values (JWTs, URLs embedding user:pass) never leave either. */
const CREDENTIAL_VALUE =
  /^[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$|\/\/[^/\s@]+:[^/\s@]+@/;

const MAX_VALUE_LENGTH = 256;
const MAX_HEADER_LENGTH = 2048;

/** Env var (and header key) carrying a user-chosen scraper name. */
export const SCRAPER_NAME_VAR = "FETCHBRAIN_SCRAPER_ID";

/**
 * Scraper names: lowercase letters, digits, '.', '_', '-'; max 64; not
 * starting with '_' (reserved for the shared default memory). Mirrors the API.
 */
const SCRAPER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Normalize a scraper name (trim + lowercase); invalid names yield undefined. */
export function normalizeScraperName(raw?: string): string | undefined {
  const name = raw?.trim().toLowerCase();
  return name && SCRAPER_NAME.test(name) ? name : undefined;
}

/** Where a scraper name came from: the `scraper` option or the env var. */
export type ScraperNameSource = "option" | typeof SCRAPER_NAME_VAR;

/**
 * Resolve the scraper name: the `scraper` option, else the
 * FETCHBRAIN_SCRAPER_ID env var. An empty or invalid option falls through to
 * the env var rather than hiding it. `rejected` lists each non-empty value
 * that was invalid, so the caller can warn about it.
 */
export function resolveScraperName(
  option: string | undefined,
  env: Record<string, string | undefined> = process.env,
): { name?: string; rejected: ScraperNameSource[] } {
  const rejected: ScraperNameSource[] = [];
  const candidates: [ScraperNameSource, string | undefined][] = [
    ["option", option],
    [SCRAPER_NAME_VAR, env[SCRAPER_NAME_VAR]],
  ];
  for (const [source, raw] of candidates) {
    if (raw === undefined || raw.trim() === "") continue;
    const name = normalizeScraperName(raw);
    if (name) return { name, rejected };
    rejected.push(source);
  }
  return { rejected };
}

/**
 * Collect native running context into a JSON header value.
 * Forwards only platform-identity-shaped names (ALLOWED_NAME) that are
 * not credential-shaped in name (DENYLIST) or value (CREDENTIAL_VALUE).
 * `scraper` is the name from resolveScraperName (the env var is not re-read
 * here, so the header always matches what the client resolved and warned
 * about). It goes in first so the header budget can never drop it; an invalid
 * one is omitted.
 * Returns undefined when there is nothing to send.
 */
export function buildNativeContext(
  env: Record<string, string | undefined> = process.env,
  scraper?: string,
): string | undefined {
  const context: Record<string, string> = {};

  const name = normalizeScraperName(scraper);
  if (name) context[SCRAPER_NAME_VAR] = name;

  const names = Object.keys(env)
    .filter((n) => n !== SCRAPER_NAME_VAR && ALLOWED_NAME.test(n) && !DENYLIST.test(n))
    .sort();

  for (const varName of names) {
    const value = env[varName];
    if (!value || value.length > MAX_VALUE_LENGTH) continue;
    if (CREDENTIAL_VALUE.test(value)) continue;

    const candidate = { ...context, [varName]: value };
    if (JSON.stringify(candidate).length > MAX_HEADER_LENGTH) break;
    context[varName] = value;
  }

  if (Object.keys(context).length === 0) return undefined;
  return JSON.stringify(context);
}

/**
 * The platform's native build identifier, used by `refreshOnRebuild` to key
 * memory to the current scraper version.
 *
 * Scans for any env var whose name ends with `BUILD_ID` (e.g.
 * `CI_BUILD_ID`, `SCRAPER_BUILD_ID`). This keeps the SDK platform-agnostic —
 * works on any runner that sets a `*_BUILD_ID` variable.
 */
export function getPlatformBuildId(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const key = Object.keys(env).find((name) => name.endsWith("BUILD_ID"));
  return key ? env[key] || undefined : undefined;
}
