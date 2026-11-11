import { WP_NAMESPACE } from "./constants.js";

const CLIENT_ID = "bridgistic-cloud";

export interface WpTokenResult {
  site_url: string;
  key_id: string;
  key_secret: string;
  scopes: string[];
}

/** Build the URL that sends the admin's browser to their own site's consent screen. */
export function buildWpAuthorizeUrl(
  siteUrl: string,
  redirectUri: string,
  codeChallenge: string,
  state: string
): string {
  const url = new URL(`${siteUrl}/wp-admin/admin.php`);
  url.searchParams.set("page", "bridgistic-oauth-authorize");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Server-to-server call: exchange the code WordPress just issued (via its
 * consent-screen redirect) for a real Bridgistic key. No client secret here
 * by design - the Worker is a public OAuth client to every WP site it has
 * never talked to before (RFC 6749 section 2.1), so PKCE is the security
 * boundary, not a pre-shared secret. See Bridgistic\Oauth's docblock.
 */
export async function exchangeWpCode(
  siteUrl: string,
  code: string,
  redirectUri: string,
  codeVerifier: string
): Promise<WpTokenResult> {
  const res = await fetch(`${siteUrl}/wp-json/${WP_NAMESPACE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`WordPress returned a non-JSON response (HTTP ${res.status}) from the token endpoint.`);
  }

  if (!res.ok) {
    const err = parsed as { code?: string; message?: string };
    throw new Error(err.message || `WordPress rejected the token exchange (HTTP ${res.status}).`);
  }

  return parsed as WpTokenResult;
}
