/**
 * Agent Skills well-known discovery for `npx skills add`.
 *
 *   npx skills add https://marketplace.bridgistic.app/<handle>/<slug>
 *
 * The `skills` CLI (vercel-labs) probes `<url>/.well-known/agent-skills/index.json`
 * and `<url>/.well-known/skills/index.json` (v1 schema), then fetches
 * `<url>/.well-known/<path>/<name>/<file>` for each listed file.
 *
 * Only FREE skills are served here (the CLI cannot authenticate). Pro skills
 * return 404 so the CLI reports "No skills found"; they stay behind the console.
 * Implemented as a root middleware that matches ONLY the well-known path
 * pattern. (A `functions/[handle]/[slug]/[[rest]].ts` route took precedence
 * over `functions/api/[[path]].ts` for /api/a/b/... and returned the SPA HTML,
 * which emptied the marketplace list and hid the OAuth buttons — incident
 * 2026-10-28.) Every other request goes straight to context.next().
 */
import { gunzipSync } from "fflate";

interface Env {
  DB: D1Database;
}

type SkillFile = { path: string; size: number; text: string };

function parseFiles(raw: string): SkillFile[] {
  const value = raw.startsWith("gz:") ? new TextDecoder().decode(gunzipSync(Uint8Array.from(atob(raw.slice(3)), (c) => c.charCodeAt(0)))) : raw;
  return JSON.parse(value);
}

const WELL_KNOWN = new Set(["agent-skills", "skills"]);

/**
 * The SPA shell ships one <title> for every host. Crawlers that do not run
 * JavaScript saw "Bridgistic Console" on the public marketplace, and the
 * private owner console was indexable. Fix both at the edge.
 */
async function decorate(response: Response, url: URL): Promise<Response> {
  if (url.hostname === "admin.bridgistic.app") {
    const out = new Response(response.body, response);
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
    return out;
  }
  if (url.hostname !== "marketplace.bridgistic.app" || !(response.headers.get("content-type") ?? "").includes("text/html")) return response;
  const title = "Bridgistic Skills · Free AI agent skills for WordPress and beyond";
  const description = "Browse 100 free instruction skills for AI agents from @wordpressistic. Install with one command or copy as a prompt. Bridgistic Pro unlocks 30 production skills.";
  const canonical = `https://marketplace.bridgistic.app${url.pathname === "/" ? "/" : url.pathname}`;
  return new HTMLRewriter()
    .on("title", { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', { element(el) { el.setAttribute("content", description); } })
    .on("head", { element(el) { el.append(`<link rel="canonical" href="${canonical}" /><meta property="og:title" content="${title}" /><meta property="og:description" content="${description}" /><meta property="og:url" content="${canonical}" />`, { html: true }); } })
    .transform(response);
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const pass = async () => decorate(await context.next(), url);
  if (context.request.method !== "GET" && context.request.method !== "HEAD") return pass();
  const match = url.pathname.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)\/(\.well-known\/.*)$/);
  if (!match || match[1] === "api") return pass();
  const [, handle, slug, tail] = match;
  const rest = tail.split("/").filter(Boolean).map(decodeURIComponent);
  if (!WELL_KNOWN.has(rest[1] ?? "")) return pass();

  const notFound = () => Response.json({ error: "not_found" }, { status: 404 });
  const item = await context.env.DB.prepare("SELECT slug, description, handle, tier, files FROM skills WHERE slug = ? AND handle = ?")
    .bind(slug, handle)
    .first<{ slug: string; description: string; handle: string; tier: string; files: string }>();
  if (!item || item.tier !== "free") return notFound();
  const files = parseFiles(item.files);
  const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" };

  // /<handle>/<slug>/.well-known/skills/index.json
  if (rest.length === 3 && rest[2] === "index.json") {
    return Response.json(
      { skills: [{ name: item.slug, description: item.description || item.slug, files: files.map((f) => f.path) }] },
      { headers },
    );
  }

  // /<handle>/<slug>/.well-known/skills/<slug>/<file path…>
  if (rest.length >= 4 && rest[2] === item.slug) {
    const path = rest.slice(3).join("/");
    const file = files.find((f) => f.path === path);
    if (!file) return notFound();
    const type = path.endsWith(".md") ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
    return new Response(file.text, { headers: { ...headers, "Content-Type": type } });
  }
  return notFound();
};
