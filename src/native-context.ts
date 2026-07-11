/**
 * Native platform context forwarding.
 *
 * The SDK forwards platform-identity context (run/build/actor identifiers)
 * as a JSON header; the API maps it to scraper identity server-side.
 * Filtering is pattern-based, not vendor-based, so supporting a new
 * platform requires no SDK release — any runner exposing `*_ID` variables
 * works. Nothing outside these patterns ever leaves the process.
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

/**
 * Collect native running context into a JSON header value.
 * Forwards only platform-identity-shaped names (ALLOWED_NAME) that are
 * not credential-shaped in name (DENYLIST) or value (CREDENTIAL_VALUE).
 * Returns undefined when there is nothing to send.
 */
export function buildNativeContext(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const context: Record<string, string> = {};

  const names = Object.keys(env)
    .filter((name) => ALLOWED_NAME.test(name) && !DENYLIST.test(name))
    .sort();

  for (const name of names) {
    const value = env[name];
    if (!value || value.length > MAX_VALUE_LENGTH) continue;
    if (CREDENTIAL_VALUE.test(value)) continue;

    const candidate = { ...context, [name]: value };
    if (JSON.stringify(candidate).length > MAX_HEADER_LENGTH) break;
    context[name] = value;
  }

  if (Object.keys(context).length === 0) return undefined;
  return JSON.stringify(context);
}

/**
 * The platform's native build identifier, used by `refreshOnRebuild` to key
 * knowledge to the current scraper version.
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
