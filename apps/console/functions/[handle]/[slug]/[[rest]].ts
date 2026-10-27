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
 * Any other path under /<handle>/<slug>/ falls through to the SPA.
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

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const handle = String(context.params.handle ?? "");
  const slug = String(context.params.slug ?? "");
  const rest = (Array.isArray(context.params.rest) ? context.params.rest : [context.params.rest ?? ""]).map(String).filter(Boolean);

  if (rest[0] !== ".well-known" || !WELL_KNOWN.has(rest[1] ?? "")) return context.next();

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
