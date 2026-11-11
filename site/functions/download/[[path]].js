// Public, sanitized plugin download for the marketing site.
// Route: GET /download/bridgistic-plugin.zip
// The request path is never reflected: only one fixed allowlisted key is served,
// streamed from the R2 binding so the bucket stays private.
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const name = (url.pathname.split("/").pop() || "").toLowerCase();

  const ALLOWED = "bridgistic-plugin.zip";
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  if (name !== ALLOWED) {
    return new Response("Not found", { status: 404 });
  }
  if (!env.PLUGINS) {
    return new Response("Storage not configured", { status: 503 });
  }

  const object = await env.PLUGINS.get("bridgistic-wordpress-plugin-1.5.11.zip");
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const headers = {
    "Content-Type": "application/zip",
    "Content-Disposition": 'attachment; filename="bridgistic-wordpress-plugin-1.5.11.zip"',
    "Content-Length": String(object.size),
    "Cache-Control": "public, max-age=300",
    "X-Robots-Tag": "noindex",
  };
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}
