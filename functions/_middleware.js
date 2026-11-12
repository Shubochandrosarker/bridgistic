// Git-integrated Pages deployment copy of the dashboard host redirect.
// The dashboard Pages project builds from the monorepo root so its Functions
// directory must also be at the repository root. The nested copy under
// apps/dashboard/functions/ is kept for the manual deploy path.
const LEGACY_HOSTS = new Set(["app.bridgistic.app"]);
const CANONICAL_ORIGIN = "https://dashboard.bridgistic.app";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (!LEGACY_HOSTS.has(url.hostname)) return context.next();
  return new Response(null, {
    status: 301,
    headers: {
      Location: `${CANONICAL_ORIGIN}${url.pathname}${url.search}`,
      "Cache-Control": "public, max-age=3600",
    },
  });
}
