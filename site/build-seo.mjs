#!/usr/bin/env node
/**
 * Rebuild Bridgistic crawl files from the public HTML pages.
 *
 *   node scripts/build-seo.mjs [--source dir] [--out dir]
 *
 * Writes, next to the source pages and also into --out when set:
 *   sitemap.xml, sitemap.html, robots.txt, llms.txt, llms-full.txt
 *
 * scripts/build-site.sh runs this on every site build, so a content edit
 * cannot ship with a stale sitemap or LLM summary. Output is deterministic:
 * dates come from each source file's last git commit, not from the clock.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ORIGIN = "https://bridgistic.app";
const PAGES = [
  { file: "index.html", path: "/", changefreq: "weekly", priority: "1.0" },
  { file: "features.html", path: "/features", changefreq: "weekly", priority: "0.8" },
  { file: "docs.html", path: "/docs", changefreq: "weekly", priority: "0.8" },
  { file: "terms.html", path: "/terms", changefreq: "monthly", priority: "0.5" },
  { file: "privacy.html", path: "/privacy", changefreq: "monthly", priority: "0.5" },
  { file: "refund-policy.html", path: "/refund-policy", changefreq: "monthly", priority: "0.4" },
  { file: "how-purchases-work.html", path: "/how-purchases-work", changefreq: "monthly", priority: "0.5" },
];
const SECTIONS = [
  ["how", "How it works"],
  ["security", "Security model"],
  ["features", "Features"],
  ["clients", "AI clients"],
  ["pricing", "Pricing"],
  ["faq", "Questions and answers"],
  ["publisher", "Who publishes Bridgistic"],
];

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const source = resolve(arg("--source", process.cwd()));
const out = args.includes("--out") ? resolve(arg("--out", "")) : "";

const read = (file) => readFileSync(join(source, file), "utf8");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const strip = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/__BRIDGISTIC_[A-Z0-9_]+__/g, "the latest release")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, " ")
  .trim();
const meta = (html, name) => {
  const m = html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, "i"))
    || html.match(new RegExp(`<meta\\s+content="([^"]*)"\\s+name="${name}"`, "i"));
  return m ? strip(m[1]) : "";
};
const tag = (html, name) => {
  const m = html.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? strip(m[1]) : "";
};
const lastmod = (file) => {
  try {
    const iso = execFileSync("git", ["-C", source, "log", "-1", "--format=%cI", "--", file], { encoding: "utf8" }).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10);
  } catch { /* file may be new */ }
  return new Date().toISOString().slice(0, 10);
};

const pages = PAGES.map((page) => {
  const html = read(page.file);
  const faqs = page.file === "index.html" ? [...html.matchAll(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>\s*<div class="faq-body">([\s\S]*?)<\/div>\s*<\/details>/gi)]
    .map((m) => ({ q: strip(m[1]), a: strip(m[2]) })) : [];
  const headings = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => strip(m[1])).filter(Boolean);
  return {
    ...page,
    loc: `${ORIGIN}${page.path}`,
    lastmod: lastmod(page.file),
    title: tag(html, "title").replace(/\s+·\s+Bridgistic$/, "").replace(/^Bridgistic — /, "Bridgistic: ") || page.path,
    description: meta(html, "description"),
    h1: tag(html, "h1"),
    headings: [...new Set(headings)].slice(0, 12),
    faqs,
  };
});
const updated = pages.map((p) => p.lastmod).sort().at(-1);

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url>
    <loc>${esc(p.loc)}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join("\n")}
  <url>
    <loc>${ORIGIN}/sitemap.html</loc>
    <lastmod>${updated}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.3</priority>
  </url>
</urlset>
`;

const robots = `# Bridgistic — ${ORIGIN}
# Regenerated from the public pages. Last content date: ${updated}
# Human sitemap: ${ORIGIN}/sitemap.html
# Machine sitemap: ${ORIGIN}/sitemap.xml
# Answer-engine summary: ${ORIGIN}/llms.txt
# Full answer-engine context: ${ORIGIN}/llms-full.txt
#
# Policy: this public marketing site may be indexed by search engines,
# cited in AI Overviews and answer engines, and used as model context.
# Private product surfaces are not on this host.

User-agent: *
Allow: /
Disallow: /api/

# Search
User-agent: Googlebot
Allow: /

User-agent: Googlebot-Image
Allow: /

User-agent: Bingbot
Allow: /

User-agent: DuckDuckBot
Allow: /

User-agent: Applebot
Allow: /

User-agent: YandexBot
Allow: /

# AI Overviews, grounding and answer engines
User-agent: Google-Extended
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: Claude-User
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Perplexity-User
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: Amazonbot
Allow: /

User-agent: Meta-ExternalAgent
Allow: /

User-agent: cohere-ai
Allow: /

User-agent: Bytespider
Allow: /

User-agent: CCBot
Allow: /

Sitemap: ${ORIGIN}/sitemap.xml
`;

const home = pages[0];
const llms = `# Bridgistic

> Bridgistic is a WordPress plugin and local MCP bridge from WordPressistic LLC. It lets Claude, ChatGPT, Codex, Gemini, Cursor and other MCP clients act on WordPress through signed, scoped requests, with approvals, snapshots and an audit log. The administrator password is not the credential.

Bridgistic is published by WordPressistic LLC, doing business as WPistic, at 1209 Mountain Road PL NE, STE N, Albuquerque, NM 87110, US. Support: support@wpistic.com. The free plugin is GPL-2.0-or-later and the source is public. Paid plans are sold by Paddle as merchant of record. This file is rebuilt from the live pages whenever the site is built. Content date: ${updated}.

## Pages
${pages.map((p) => `- [${p.title}](${p.loc}): ${p.description}`).join("\n")}
- [Sitemap](${ORIGIN}/sitemap.html): Every public page on bridgistic.app.

## On the homepage
${SECTIONS.map(([id, label]) => `- [${label}](${ORIGIN}/#${id})`).join("\n")}

## Pricing (as published)
- Free: $0. Local MCP bridge, GPL-2.0-or-later.
- Pro Lifetime Deal, while the welcome offer is open: $49.99 once, 1 license · 1 site, through 31 December 2026 or 100 licenses, whichever comes first.
- Pro Monthly: $12 USD per month, 1 license · 3 sites.
- Pro Yearly: $99 USD per year, 1 license · 3 sites.
- Every purchase has a 7-day refund guarantee. Taxes are calculated by Paddle at checkout.

## Optional
- [Full context](${ORIGIN}/llms-full.txt): Page summaries, headings and the FAQ, rebuilt with the site.
- [XML sitemap](${ORIGIN}/sitemap.xml)
- [Robots](${ORIGIN}/robots.txt)
- [GitHub](https://github.com/Wordpressistic/bridgistic)
- [Dashboard](https://dashboard.bridgistic.app/)
- [WPistic](https://wpistic.com/)
`;

const full = `# Bridgistic — full context for answer engines

Publisher: WordPressistic LLC (dba WPistic), 1209 Mountain Road PL NE, STE N, Albuquerque, NM 87110, US.
Contact: support@wpistic.com. General: hello@insightistic.com.
Source: https://github.com/Wordpressistic/bridgistic
License: GPL-2.0-or-later for the free plugin.
Content date: ${updated}. This file is generated by scripts/build-seo.mjs from the public HTML. Do not treat it as a separate source of prices or policies. If it and the page differ, the page wins.

## What Bridgistic is
${home.h1} ${home.description}

Bridgistic connects MCP clients to WordPress without handing over a WordPress administrator password. A site owner mints a scoped key. Requests are HMAC-signed. Writes can require human approval. Destructive operations can be snapshotted and restored. The local connection is the recommended default. Bridgistic Cloud is a public beta and has not completed an independent third-party security review.

## Pricing
Free is $0. The Lifetime Deal welcome offer is $49.99 once for 1 license · 1 site, available until 31 December 2026 or 100 licenses, whichever comes first. Pro Monthly is $12 USD per month for 1 license · 3 sites. Pro Yearly is $99 USD per year for 1 license · 3 sites. Paddle is the merchant of record. Every purchase has a 7-day refund guarantee.

${pages.map((p) => `## ${p.title}
URL: ${p.loc}
Updated: ${p.lastmod}
${p.description}

${p.h1 ? `${p.h1}\n\n` : ""}${p.headings.length ? `Sections:\n${p.headings.map((h) => `- ${h}`).join("\n")}\n` : ""}`).join("\n")}
## Questions people ask
${home.faqs.map((f) => `### ${f.q}\n${f.a}\n`).join("\n")}
## Entity
- Product: Bridgistic
- Site: ${ORIGIN}
- Legal entity: WordPressistic LLC
- Trade name: WPistic
- Address: 1209 Mountain Road PL NE, STE N, Albuquerque, NM 87110, US
- Governing law stated on the terms: United States and the State of New Mexico
- Dashboard: https://dashboard.bridgistic.app/
- Platform admin is a separate host and is not part of this public site
`;

const itemList = pages.map((p, i) => `        {
          "@type": "ListItem",
          "position": ${i + 1},
          "name": ${JSON.stringify(p.title)},
          "url": ${JSON.stringify(p.loc)}
        }`).join(",\n");

const sitemapHtml = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0B1F3A" />
  <meta name="color-scheme" content="dark light" />
  <meta name="robots" content="index,follow" />
  <title>Sitemap · Bridgistic</title>
  <meta name="description" content="Every public page on bridgistic.app, plus the XML sitemap, robots.txt and LLM summaries. Rebuilt from the site pages." />
  <link rel="canonical" href="${ORIGIN}/sitemap.html" />
  <link rel="icon" type="image/png" href="/assets/bridgistic-icon.png" />
  <link rel="stylesheet" href="/assets/legal.css" />
  <link rel="sitemap" type="application/xml" title="Sitemap" href="${ORIGIN}/sitemap.xml" />
  <script>(function(){try{var t=localStorage.getItem('bridgistic-theme');if(!t&&window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)t='light';if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": "Bridgistic sitemap",
    "url": "${ORIGIN}/sitemap.html",
    "isPartOf": { "@type": "WebSite", "name": "Bridgistic", "url": "${ORIGIN}/" },
    "publisher": {
      "@type": "Organization",
      "name": "WordPressistic LLC",
      "url": "https://wpistic.com/"
    },
    "mainEntity": {
      "@type": "ItemList",
      "itemListElement": [
${itemList}
      ]
    }
  }
  </script>
</head>
<body>
  <a class="skip" href="#content">Skip to content</a>
  <header class="top">
    <div class="wrap top-in">
      <a class="brand" href="/"><img src="/assets/bridgistic-icon.png" alt="" width="28" height="28" /><b class="word">Bridg<span>istic</span></b></a>
      <nav class="top-nav" aria-label="Site"><a href="/#pricing">Pricing</a><a href="https://dashboard.bridgistic.app/">Dashboard</a>
        <button class="theme" type="button" id="themeToggle" aria-label="Switch colour theme">Theme</button></nav>
    </div>
  </header>
  <main id="content" class="wrap doc">
    <nav class="doc-nav" aria-label="On this page"><a href="#pages" aria-current="page">Pages</a><a href="#sections">Homepage</a><a href="#machines">For crawlers</a><a href="#publisher">Publisher</a></nav>
    <article>
      <p class="eyebrow">Sitemap</p>
      <h1>Sitemap</h1>
      <p class="meta">Public pages on bridgistic.app. Rebuilt from the site whenever it is built. Content date ${esc(updated)}.</p>
      <div class="lead"><p>Use this page to find every public Bridgistic page. Search engines should use <a href="/sitemap.xml">sitemap.xml</a>. Answer engines should start at <a href="/llms.txt">llms.txt</a>.</p></div>

      <section id="pages"><h2>Pages</h2>
        <ul>
${pages.map((p) => `          <li><a href="${esc(p.path)}">${esc(p.title)}</a> — ${esc(p.description)} <span class="meta">Updated ${esc(p.lastmod)}.</span></li>`).join("\n")}
        </ul>
      </section>

      <section id="sections"><h2>Homepage sections</h2>
        <ul>
${SECTIONS.map(([id, label]) => `          <li><a href="/#${id}">${esc(label)}</a></li>`).join("\n")}
        </ul>
      </section>

      <section id="machines"><h2>For search engines and answer engines</h2>
        <ul>
          <li><a href="/sitemap.xml">sitemap.xml</a> — URL list for Google, Bing and other crawlers.</li>
          <li><a href="/sitemap.html">sitemap.html</a> — this page.</li>
          <li><a href="/robots.txt">robots.txt</a> — crawl policy. Public pages are allowed, including AI Overview and answer-engine crawlers.</li>
          <li><a href="/llms.txt">llms.txt</a> — short summary for AI platforms.</li>
          <li><a href="/llms-full.txt">llms-full.txt</a> — headings, pricing and FAQ taken from the pages.</li>
        </ul>
      </section>

      <section id="publisher"><h2>Publisher</h2>
        <address class="company">WordPressistic LLC<br>1209 Mountain Road PL NE, STE N<br>Albuquerque, NM 87110, US</address>
        <p>Bridgistic is a product of WordPressistic LLC, doing business as WPistic. Support and refunds: <a href="mailto:support@wpistic.com">support@wpistic.com</a>. The free plugin is licensed GPL-2.0-or-later. Source: <a href="https://github.com/Wordpressistic/bridgistic">GitHub</a>.</p>
      </section>
    </article>
  </main>
  <footer class="foot">
    <div class="wrap foot-in">
      <span>© 2026 WordPressistic LLC. Bridgistic is licensed GPL-2.0-or-later.</span>
      <nav aria-label="Legal"><a href="/terms">Terms of Service</a><a href="/privacy">Privacy Policy</a><a href="/refund-policy">Refund Policy</a><a href="/how-purchases-work">How purchases work</a><a href="/sitemap.html">Sitemap</a></nav>
    </div>
  </footer>
  <script>
    document.getElementById('themeToggle').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('bridgistic-theme', next); } catch (e) {}
    });
  </script>
</body>
</html>
`;

const files = {
  "sitemap.xml": xml,
  "sitemap.html": sitemapHtml,
  "robots.txt": robots,
  "llms.txt": llms,
  "llms-full.txt": full,
};

const write = (dir) => {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`);
  }
};

write(source);
if (out && resolve(out) !== source) write(out);

const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<!doctype[^>]*>/gi, " ").replace(/<[^>]+>/g, " ");
if (/!/.test(`${llms}\n${full}\n${visible(sitemapHtml)}`)) {
  console.error("::error::Generated public copy contains an exclamation mark");
  process.exit(1);
}
console.log(`SEO files rebuilt (${updated}) → ${source}${out ? ` and ${out}` : ""}`);
