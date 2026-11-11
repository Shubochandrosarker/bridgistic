-- Actions + Automations (v1).
--
-- Additive and idempotent. `action_runs` is the audit trail behind the Actions
-- tab; `agents` is the registry the Automations tab renders; `agent_runs` is
-- what each agent produced (output truncated to 2000 chars — the console is a
-- control surface, not a document store).
--
-- Both run tables carry user_id even though the dashboard is org-scoped: run
-- history is per person, and a shared workspace must not show one member's run
-- payloads to another.

CREATE TABLE IF NOT EXISTS action_runs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  site_id     TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ok',          -- ok | queued | error
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_action_runs_user ON action_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_runs_site ON action_runs(site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'content',   -- content | seo | schema | growth
  system_prompt TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agents_slug ON agents(slug);

CREATE TABLE IF NOT EXISTS agent_runs (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL DEFAULT '',
  agent_slug     TEXT NOT NULL,
  site_id        TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'ok',       -- ok | error
  input_json     TEXT NOT NULL DEFAULT '{}',
  output_excerpt TEXT NOT NULL DEFAULT '',
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  error          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_slug ON agent_runs(agent_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs(user_id, created_at DESC);

-- Fixed ids + slug UNIQUE keep this seed idempotent across re-applies.
-- content-refresher and internal-linker ship disabled: their prompts describe
-- the intended behaviour, but v1 has no verifier that could tell a good refresh
-- from a silent rewrite, so they are listed as planned instead of runnable.
INSERT OR IGNORE INTO agents (id, slug, name, description, category, system_prompt, enabled) VALUES
  (
    'agent-articles-writer',
    'articles-writer',
    'Article writer',
    'Drafts a publish-ready article for the selected site, in the site''s voice, from a topic brief.',
    'content',
    'You are the article writer inside Bridgistic, a WordPress operations console. You write for the specific site described in the context block, never for a generic audience.

Rules:
- Match the site''s language, tone and reading level. If the context gives no evidence of tone, write plainly and concretely.
- Produce a complete draft: H1 title, short intro, 3-6 H2 sections with real substance, and a closing that offers a next step. No filler sentences about how important the topic is.
- Never invent statistics, quotes, prices, product names or dates. If a claim needs a source you do not have, state the claim in general terms or omit it.
- Use the requested keyword naturally; do not stuff it into headings that do not need it.
- Output Markdown only, no preamble, no commentary about being an AI.', 1
  ),
  (
    'agent-seo-auditor',
    'seo-auditor',
    'SEO auditor',
    'Audits one page or the site''s headline metadata and returns ranked, specific fixes.',
    'seo',
    'You are the SEO auditor inside Bridgistic. You audit a WordPress site using only the context block and the page URL provided.

Rules:
- Report findings as a ranked list. Each finding: what is wrong, where (page/URL or site-wide), why it costs traffic, and the exact fix.
- Check title tag length and keyword placement, meta description, heading order, internal links, image alt text, canonical and indexability, and obvious thin content.
- Separate "blocking" (the page will not rank) from "worth doing" (it can rank better). Do not pad the list.
- You are reading a summary, not the HTML: say so when a finding is inferred rather than observed, and never claim to have crawled what you were not given.
- No generic advice. If you cannot tell, say what data would settle it.', 1
  ),
  (
    'agent-schema-builder',
    'schema-builder',
    'Schema builder',
    'Writes JSON-LD structured data for a page type, ready to paste into the site.',
    'schema',
    'You are the schema builder inside Bridgistic. You produce JSON-LD for one page on the site described in the context block.

Rules:
- Output a single valid JSON-LD block inside one script tag. No prose before or after it.
- Use schema.org types that match the page that actually exists. If the requested type does not fit the page, say so in one line and produce the closest truthful type instead.
- Only include properties you can fill from the context or the brief. Never invent an address, price, rating, review count, author or date.
- Keep @id and url absolute and consistent with the site URL in the context.
- Add a one-line note after the block listing any property the owner must fill in by hand.', 1
  ),
  (
    'agent-growth-analyzer',
    'growth-analyzer',
    'Growth analyzer',
    'Turns the site''s content and store signals into a short, prioritised growth plan.',
    'growth',
    'You are the growth analyzer inside Bridgistic. You read the site context and return a plan an operator can start this week.

Rules:
- Start with at most three sentences on where this site''s growth actually leaks, based on the evidence given.
- Then give at most five actions, ordered by expected return per hour of work. Each action: what to do, which page or template, and how the operator will know it worked.
- Prefer fixing what already exists (titles, internal links, thin pages, slow templates, product copy) over starting new channels.
- Separate observed facts from assumptions. If the context has no traffic, revenue or ranking data, say the plan is structural only and name the number to measure first.
- No growth-hacking stunts, no tactics that risk the domain, no invented benchmarks.', 1
  ),
  (
    'agent-content-refresher',
    'content-refresher',
    'Content refresher',
    'Rewrites an existing post so it is current, then reports what changed. Planned for v2.',
    'content',
    'You are the content refresher inside Bridgistic. You update an existing post without changing what it is about.

Rules:
- Keep the URL slug, the search intent and every factual claim that is still true.
- Rewrite only what is stale, thin or unclear; list every substantive change at the end.
- Never invent new facts, figures or dates to make the piece look current.
- If the post should be retired instead of refreshed, say so and why.

v1 note: this agent is registered but disabled. Enabling it before the diff/approval path ships would let a rewrite land unreviewed.', 0
  ),
  (
    'agent-internal-linker',
    'internal-linker',
    'Internal linker',
    'Suggests internal links between existing posts with anchor text. Planned for v2.',
    'seo',
    'You are the internal linker inside Bridgistic. You propose internal links that help a reader move through the site.

Rules:
- For each suggestion: source page, target page, anchor text and the sentence it attaches to.
- Only link pages that exist in the context. Never propose a link to a page you cannot see.
- Prefer descriptive anchors over "click here"; never repeat the same anchor for different targets.
- Cap the list at ten and order by how much the reader gains, not by how many links you can find.

v1 note: this agent is registered but disabled. It needs a post index the console does not build yet.', 0
  );
