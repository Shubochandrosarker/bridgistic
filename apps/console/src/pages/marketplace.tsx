/**
 * Skills marketplace — public directory (free skills only, clawhub-style dark
 * layout), gated Pro collection, and the skill detail page with CLI | npx
 * skills | Prompt install tabs.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { Btn, Spinner, inputClass, useToast, Toast } from "../components/ui";

interface SkillMeta {
  slug: string;
  name: string;
  description: string;
  category: string;
  author: string;
  handle: string;
  tier: string;
  version: string;
  installs: number;
  updated: string;
}

/* ── Marketplace theme (dark, applied on the public host) ─────────────────── */

const M = {
  shell: "min-h-full bg-[#05070D] text-[#EDEFF5]",
  header: "sticky top-0 z-30 border-b border-white/10 bg-[#05070D]/90 backdrop-blur",
  container: "mx-auto w-full max-w-6xl px-4 sm:px-6",
  card: "group rounded-lg border border-white/10 bg-[#0B101B] p-4 transition hover:border-[#C9A227]/60",
  chip: (active: boolean) =>
    `whitespace-nowrap rounded-full border px-3 py-1 text-xs transition ${
      active ? "border-[#C9A227] bg-[#C9A227]/15 text-[#E8CE7A]" : "border-white/15 text-white/60 hover:border-white/35 hover:text-white"
    }`,
  badge: "rounded-full border border-[#C9A227]/50 bg-[#C9A227]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#E8CE7A]",
  freeBadge: "rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300",
  search:
    "w-full rounded-[50px] border border-white/15 bg-white/[0.04] px-5 py-3 text-sm text-white placeholder:text-white/35 outline-none focus:border-[#C9A227]/70 focus:ring-2 focus:ring-[#C9A227]/20",
  mono: "font-mono text-[11px]",
};

function MarketLogo() {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <img src="/brand/icon.png" alt="Bridgistic" className="h-7 w-7" />
      <span className="text-sm font-bold tracking-wide text-white">
        Bridgistic<span className="text-[#C9A227]"> Skills</span>
      </span>
    </Link>
  );
}

function MarketHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <header className={M.header}>
      <div className={`${M.container} flex h-14 items-center justify-between`}>
        <MarketLogo />
        <nav className="flex items-center gap-4 text-xs">
          <Link to="/" className="text-white/70 hover:text-white">Directory</Link>
          <Link to="/pro" className="text-white/70 hover:text-white">Pro</Link>
          <a href="https://bridgistic.app/#pricing" className="hidden text-white/70 hover:text-white sm:block">Pricing</a>
          <a href="https://admin.bridgistic.app/" className="hidden text-white/70 hover:text-white sm:block">Console</a>
          {signedIn ? (
            <a href="/installed" className="rounded-full bg-white/10 px-3 py-1.5 font-semibold text-white hover:bg-white/15">My account</a>
          ) : (
            <a href="https://dashboard.bridgistic.app/sign-in" className="rounded-full bg-[#C9A227] px-3.5 py-1.5 font-semibold text-[#05070D] hover:brightness-110">Sign in</a>
          )}
        </nav>
      </div>
    </header>
  );
}

/* ── Card grid ────────────────────────────────────────────────────────────── */

function SkillCard({ item, handle }: { item: SkillMeta; handle?: string }) {
  const href = handle ? `/marketplace/${item.handle}/${item.slug}` : `/marketplace/${item.slug}`;
  return (
    <Link to={href} className={M.card}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="truncate text-sm font-semibold text-white group-hover:text-[#E8CE7A]">{item.name}</h3>
        <span className={item.tier === "pro" ? M.badge : M.freeBadge}>{item.tier}</span>
      </div>
      <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-white/55">{item.description}</p>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11px] text-white/40">@{item.handle}</span>
        <span className={`${M.mono} text-white/45`}>{item.installs.toLocaleString()} installs</span>
      </div>
    </Link>
  );
}

function useMarketItems(tier: "free" | "pro") {
  const [items, setItems] = useState<SkillMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [gate, setGate] = useState<"none" | "signin" | "license">("none");
  useEffect(() => {
    setItems(null);
    const params = new URLSearchParams({ tier });
    if (category) params.set("category", category);
    if (q.trim()) params.set("q", q.trim());
    api
      .get<{ items: SkillMeta[] }>(`/api/market/items?${params.toString()}`)
      .then((r) => setItems(r.items))
      .catch((e) => {
        setItems([]);
        setError(e.message);
        if (e.name === "ApiError" || String(e.message).toLowerCase().includes("sign in")) setGate("signin");
        if (String(e.message).toLowerCase().includes("license")) setGate("license");
      });
  }, [tier, category, q]);
  return { items, error, gate, category, setCategory, q, setQ };
}

function Gate({ kind }: { kind: "signin" | "license" }) {
  return (
    <div className="mx-auto max-w-md rounded-xl border border-[#C9A227]/30 bg-[#C9A227]/[0.06] p-8 text-center">
      <p className="text-sm font-semibold text-white">{kind === "signin" ? "Sign in to open the Pro collection" : "The Pro collection is part of Bridgistic Pro"}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-white/55">
        {kind === "signin"
          ? "A free account unlocks all 100 free skills. Pro members get the battle-tested Pro collection."
          : "30 battle-tested production skills, exclusive to license holders. The Lifetime Deal is $69 one time."}
      </p>
      <div className="mt-4 flex justify-center gap-2">
        {kind === "signin" ? (
          <a href="https://dashboard.bridgistic.app/sign-in"><Btn variant="gold" small>Sign in</Btn></a>
        ) : (
          <>
            <a href="https://pay.bridgistic.app/" target="_blank" rel="noreferrer"><Btn variant="gold" small>Get Pro · $69</Btn></a>
            <a href="/license"><Btn variant="ghost" small className="!bg-transparent !text-white">I have a key</Btn></a>
          </>
        )}
      </div>
    </div>
  );
}

function DirectoryBody({ tier, title, sub }: { tier: "free" | "pro"; title: string; sub: string }) {
  const { items, gate, category, setCategory, q, setQ } = useMarketItems(tier);
  const [categories, setCategories] = useState<{ category: string; n: number }[]>([]);
  useEffect(() => {
    api
      .get<{ categories: { category: string; n: number; tier: string }[] }>("/api/market/categories")
      .then((r) => {
        const byName = new Map<string, number>();
        for (const row of r.categories) {
          if (row.tier !== tier) continue;
          byName.set(row.category, (byName.get(row.category) ?? 0) + row.n);
        }
        setCategories([...byName.entries()].map(([category, n]) => ({ category, n })).sort((a, b) => b.n - a.n));
      })
      .catch(() => setCategories([]));
  }, [tier]);

  return (
    <>
      <section className={`${M.container} pb-2 pt-10`}>
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">{title}</h1>
          <p className="mt-2 text-sm text-white/55">{sub}</p>
          <div className="mt-5">
            <input className={M.search} placeholder="Search skills… (e.g. seo, pdf, cloudflare)" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
      </section>
      <div className="sticky top-14 z-20 border-y border-white/5 bg-[#05070D]/95 backdrop-blur">
        <div className={`${M.container} flex gap-2 overflow-x-auto py-2.5`}>
          <button className={M.chip(category === "")} onClick={() => setCategory("")}>All</button>
          {categories.map((c) => (
            <button key={c.category} className={M.chip(category === c.category)} onClick={() => setCategory(c.category)}>
              {c.category} <span className="ml-1 text-white/35">{c.n}</span>
            </button>
          ))}
        </div>
      </div>
      <section className={`${M.container} py-6`}>
        {items === null ? (
          <Spinner label="Loading skills…" />
        ) : gate !== "none" && items.length === 0 ? (
          <Gate kind={gate} />
        ) : items.length === 0 ? (
          <p className="py-16 text-center text-sm text-white/45">No skills match that search.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <SkillCard key={item.slug} item={item} />
            ))}
          </div>
        )}
      </section>
      <footer className="border-t border-white/5 py-8 text-center text-[11px] text-white/35">
        Bridgistic — signed, scoped, approved, reversible AI access for WordPress · <a className="underline hover:text-white/60" href="https://bridgistic.app/">bridgistic.app</a> · <Link className="underline hover:text-white/60" to="/install-guide">How to install skills</Link>
      </footer>
    </>
  );
}

export function MarketDirectory() {
  const { user } = useSession();
  return (
    <div className={M.shell}>
      <MarketHeader signedIn={Boolean(user)} />
      <DirectoryBody
        tier="free"
        title="Skills for your AI agents"
        sub="100 free, production-ready instruction skills for Claude, Codex, Gemini, ChatGPT and any MCP client. Free under @wordpressistic — no account needed to browse."
      />
    </div>
  );
}

export function ProHub() {
  const { user, paidUnlock } = useSession();
  return (
    <div className={M.shell}>
      <MarketHeader signedIn={Boolean(user)} />
      {user && !paidUnlock.unlocked ? (
        <div className="py-16">
          <Gate kind="license" />
        </div>
      ) : (
        <DirectoryBody
          tier="pro"
          title="The Pro collection"
          sub="30 battle-tested production skills from the WPistic environment — agent operations, market intelligence, document pipelines and research automation."
        />
      )}
    </div>
  );
}

/* ── Detail page (clawhub-style, install tabs) ────────────────────────────── */

interface FileEntry {
  path: string;
  size: number;
  text?: string;
}

function CopyBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className="group flex w-full items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/40 px-4 py-3 text-left font-mono text-xs text-white/85 transition hover:border-white/25"
    >
      <span className="truncate">{copied ? "Copied ✓" : value}</span>
      <span className="shrink-0 rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-white/50 group-hover:text-white">copy</span>
    </button>
  );
}

export function SkillDetail() {
  const params = useParams();
  const slug = params.slug ?? "";
  const navigate = useNavigate();
  const { user, paidUnlock } = useSession();
  const [meta, setMeta] = useState<SkillMeta | null>(null);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [tab, setTab] = useState<"cli" | "npx" | "prompt">("cli");
  const [notFound, setNotFound] = useState(false);
  const [toast, showToast] = useToast();

  useEffect(() => {
    if (!slug) return;
    api.get<{ item: SkillMeta }>(`/api/market/item/${slug}`).then((r) => setMeta(r.item)).catch(() => setNotFound(true));
  }, [slug]);

  useEffect(() => {
    if (!slug) return;
    api
      .get<{ authorized: boolean; files: FileEntry[] }>(`/api/market/content/${slug}`)
      .then((r) => {
        setAuthorized(r.authorized);
        setFiles(r.files);
      })
      .catch(() => {
        setAuthorized(false);
        setFiles([]);
      });
  }, [slug, paidUnlock.unlocked, user]);

  const skillText = useMemo(() => (files ?? []).find((f) => f.path === "SKILL.md")?.text ?? "", [files]);

  if (notFound) {
    return (
      <div className={M.shell}>
        <MarketHeader signedIn={Boolean(user)} />
        <div className={`${M.container} py-24 text-center`}>
          <p className="text-lg font-semibold text-white">Skill not found</p>
          <Btn variant="ghost" small className="mt-4 !bg-transparent !text-white" onClick={() => navigate("/")}>Back to the directory</Btn>
        </div>
      </div>
    );
  }
  if (!meta) {
    return (
      <div className={M.shell}>
        <MarketHeader signedIn={Boolean(user)} />
        <Spinner label="Loading skill…" />
      </div>
    );
  }

  const cliCommand = `bridgistic skills install @${meta.handle}/${meta.slug}`;
  const npxCommand = `npx skills add https://marketplace.bridgistic.app/${meta.handle}/${meta.slug}`;
  const locked = !authorized;

  return (
    <div className={M.shell}>
      <MarketHeader signedIn={Boolean(user)} />
      <div className={`${M.container} max-w-5xl py-8`}>
        <nav className="mb-5 flex items-center gap-2 text-xs text-white/40">
          <Link to="/" className="hover:text-white/70">Skills</Link>
          <span>/</span>
          <Link to={`/?category=${encodeURIComponent(meta.category)}`} className="hover:text-white/70">{meta.category}</Link>
          <span>/</span>
          <span className="text-white/70">{meta.name}</span>
        </nav>

        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-white">{meta.name}</h1>
              <span className={meta.tier === "pro" ? M.badge : M.freeBadge}>{meta.tier}</span>
            </div>
            <p className="mt-1.5 text-xs text-white/45">
              @{meta.handle} · v{meta.version} · updated {meta.updated}
            </p>
            <p className="mt-4 text-sm leading-relaxed text-white/70">{meta.description}</p>

            {/* Install methods */}
            <div className="mt-7">
              <h2 className="mb-2.5 text-xs font-bold uppercase tracking-widest text-white/45">Install</h2>
              <div className="mb-3 inline-flex overflow-hidden rounded-full border border-white/15">
                {(["cli", "npx", "prompt"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-4 py-1.5 text-xs font-semibold transition ${tab === t ? "bg-[#C9A227] text-[#05070D]" : "bg-transparent text-white/60 hover:text-white"}`}
                  >
                    {t === "cli" ? "CLI" : t === "npx" ? "npx skills" : "Prompt"}
                  </button>
                ))}
              </div>
              {!locked ? (
                tab === "cli" ? (
                  <div>
                    <CopyBlock value={cliCommand} />
                    <p className="mt-2 text-[11px] text-white/45">
                      The <span className="font-mono">bridgistic</span> CLI is not published yet. Use <button className="underline" onClick={() => setTab("npx")}>npx skills</button>, Download zip, or the <Link className="underline" to="/install-guide">install guide</Link>.
                    </p>
                  </div>
                ) : tab === "npx" ? (
                  <CopyBlock value={npxCommand} />
                ) : (
                  <div>
                    <CopyBlock value={skillText.slice(0, 400) || "Load the skill first (sign in for free skills)."} />
                    <Btn
                      small
                      variant="ghost"
                      className="mt-2 !bg-white/10 !text-white"
                      onClick={() => {
                        void navigator.clipboard.writeText(skillText);
                        showToast("Full SKILL.md copied — paste it into your assistant.");
                      }}
                      disabled={!skillText}
                    >
                      Copy full skill as prompt
                    </Btn>
                  </div>
                )
              ) : (
                <Gate kind={user ? "license" : "signin"} />
              )}
            </div>

            {/* Files preview */}
            {!locked && files && files.length > 0 && (
              <div className="mt-8">
                <h2 className="mb-2.5 text-xs font-bold uppercase tracking-widest text-white/45">Files</h2>
                <div className="space-y-3">
                  {files.map((f) => (
                    <details key={f.path} className="rounded-lg border border-white/10 bg-[#0B101B]" open={f.path === "SKILL.md"}>
                      <summary className="flex cursor-pointer items-center justify-between px-4 py-2.5 text-xs text-white/70">
                        <span className="font-mono">{f.path}</span>
                        <span className="text-white/35">{f.size.toLocaleString()} bytes</span>
                      </summary>
                      <pre className="max-h-96 overflow-auto border-t border-white/10 bg-black/40 p-4 text-[11px] leading-relaxed text-white/80">{f.text}</pre>
                    </details>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <aside className="space-y-4">
            <div className="rounded-lg border border-white/10 bg-[#0B101B] p-4">
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between"><dt className="text-white/40">Author</dt><dd className="text-white/85">@{meta.handle}</dd></div>
                <div className="flex justify-between"><dt className="text-white/40">Category</dt><dd className="text-white/85">{meta.category}</dd></div>
                <div className="flex justify-between"><dt className="text-white/40">Version</dt><dd className={M.mono + " text-white/85"}>{meta.version}</dd></div>
                <div className="flex justify-between"><dt className="text-white/40">Installs</dt><dd className={M.mono + " text-white/85"}>{meta.installs.toLocaleString()}</dd></div>
                <div className="flex justify-between"><dt className="text-white/40">Updated</dt><dd className="text-white/85">{meta.updated}</dd></div>
              </dl>
            </div>
            {!locked && (
              <Btn
                className="w-full"
                variant="gold"
                onClick={() => void (async () => {
                  try {
                    await api.post(`/api/market/install/${meta.slug}`);
                    showToast("Installed — it shows under Installed in your console.");
                  } catch (e) {
                    showToast(e instanceof Error ? e.message : "Install failed.");
                  }
                })()}
              >
                Install to my account
              </Btn>
            )}
            {!locked && (
              <Btn
                className="w-full"
                variant="ghost"
                onClick={() => void (async () => {
                  try {
                    const res = await fetch(`/api/market/download/${meta.slug}`, { credentials: "same-origin" });
                    if (!res.ok) {
                      const body = (await res.json()) as { message?: string };
                      throw new Error(body.message ?? "Download failed.");
                    }
                    const blob = await res.blob();
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = `${meta.slug}.zip`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                  } catch (e) {
                    showToast(e instanceof Error ? e.message : "Download failed.");
                  }
                })()}
              >
                Download zip
              </Btn>
            )}
            <p className="text-[11px] leading-relaxed text-white/35">
              Skills are instruction text, not executed code. WordPress writes still pass Plugin Guard and the approval queue.
            </p>
          </aside>
        </div>
      </div>
      <footer className="border-t border-white/5 py-8 text-center text-[11px] text-white/35">
        <Link className="underline hover:text-white/60" to="/install-guide">How to install skills</Link>
      </footer>
      <Toast message={toast} />
    </div>
  );
}
