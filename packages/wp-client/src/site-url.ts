/**
 * Site URL normalisation.
 *
 * One row per site in `sites` keyed on this normalised form: `example.com` and
 * `https://Example.com/` must not become two sites in one org, and must not let
 * a second org claim the "same" site under a different spelling.
 *
 * This is NOT the SSRF guard. `cloud/src/url-guard.ts` in the free repo is the
 * reviewed, 59-test guard and it moves here verbatim in Phase 0 — do not write
 * a second, weaker one. See docs/MIGRATION-PHASE-0.md.
 */

export class InvalidSiteUrlError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "InvalidSiteUrlError";
    this.reason = reason;
  }
}

/** Returns `https://host[:port]` with no trailing slash, no path, no credentials. */
export function normalizeSiteUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") throw new InvalidSiteUrlError("Site URL is empty.");

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new InvalidSiteUrlError(`"${input}" is not a URL.`);
  }

  if (url.protocol !== "https:") {
    throw new InvalidSiteUrlError("Only https:// site URLs are accepted — the key travels over this transport.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new InvalidSiteUrlError("Site URL must not carry credentials.");
  }
  if (url.hostname === "") {
    throw new InvalidSiteUrlError("Site URL has no host.");
  }

  const port = url.port === "" || url.port === "443" ? "" : `:${url.port}`;
  return `https://${url.hostname.toLowerCase()}${port}`;
}

export function isSameSite(a: string, b: string): boolean {
  try {
    return normalizeSiteUrl(a) === normalizeSiteUrl(b);
  } catch {
    return false;
  }
}
