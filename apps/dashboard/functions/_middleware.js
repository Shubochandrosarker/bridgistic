// Pages middleware: dashboard.bridgistic.app is the main dashboard address.
// Requests to the old app.bridgistic.app host get a 301 to the same path and
// query on dashboard.bridgistic.app. Every other host (dashboard, *.pages.dev
// previews) passes through to the static app unchanged.
//
// Shuvo can replace this with a zone-level Cloudflare Redirect Rule (see
// DEPLOY.md); once that rule is live this file can be deleted.
export const LEGACY_HOSTS = new Set(["app.bridgistic.app"]);
export const CANONICAL_ORIGIN = "https://dashboard.bridgistic.app";

export function redirectFor(urlString) {
  const url = new URL(urlString);
  if (!LEGACY_HOSTS.has(url.hostname)) return null;
  return `${CANONICAL_ORIGIN}${url.pathname}${url.search}`;
}

export async function onRequest(context) {
  const target = redirectFor(context.request.url);
  if (target) {
    return new Response(null, { status: 301, headers: { Location: target, "Cache-Control": "public, max-age=3600" } });
  }
  return context.next();
}
