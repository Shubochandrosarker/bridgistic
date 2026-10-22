/** Marketplace: public directory + skill detail (free account for free zips, license for paid). */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { Badge, Btn, Card, ErrorNote, PageHead, Spinner, inputClass, useToast, Toast } from "../components/ui";

interface SkillMeta {
  slug: string;
  name: string;
  description: string;
  category: string;
  author: string;
  handle: string;
  tier: "free" | "paid";
  version: string;
  installs: number;
  updated: string;
}

export function MarketDirectory() {
  const [items, setItems] = useState<SkillMeta[] | null>(null);
  const [tier, setTier] = useState<"all" | "free" | "paid">("all");
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [categories, setCategories] = useState<{ category: string; n: number }[]>([]);

  useEffect(() => {
    api
      .get<{ categories: { category: string; n: number }[] }>("/api/market/categories")
      .then((r) => {
        const byName = new Map<string, number>();
        for (const row of r.categories) byName.set(row.category, (byName.get(row.category) ?? 0) + row.n);
        setCategories([...byName.entries()].map(([category, n]) => ({ category, n })).sort((a, b) => b.n - a.n));
      })
      .catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    setItems(null);
    const params = new URLSearchParams();
    if (tier !== "all") params.set("tier", tier);
    if (category) params.set("category", category);
    if (q.trim()) params.set("q", q.trim());
    api
      .get<{ items: SkillMeta[] }>(`/api/market/items?${params.toString()}`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, [tier, category, q]);

  return (
    <>
      <PageHead
        title="Skills marketplace"
        sub="Instruction skills for your AI agents — free under @wordpressistic, Pro packs for license holders."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <input className={`${inputClass} w-52`} placeholder="Search skills…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.category} value={c.category}>
                  {c.category} ({c.n})
                </option>
              ))}
            </select>
            <div className="flex overflow-hidden rounded-lg border border-navy/15">
              {(["all", "free", "paid"] as const).map((t) => (
                <button key={t} onClick={() => setTier(t)} className={`px-3 py-1.5 text-sm capitalize ${tier === t ? "bg-navy font-semibold text-white" : "bg-white text-navy/60"}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        }
      />
      {items === null ? (
        <Spinner label="Loading the directory…" />
      ) : items.length === 0 ? (
        <Card className="p-8 text-center text-sm text-navy/50">No skills match. Try a different search.</Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <Link key={item.slug} to={`/marketplace/${item.slug}`}>
              <Card className="h-full p-4 transition hover:border-gold">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-sm font-bold text-navy">{item.name}</h2>
                  <Badge tone={item.tier === "paid" ? "gold" : "good"}>{item.tier}</Badge>
                </div>
                <p className="mt-1 line-clamp-3 text-xs text-navy/60">{item.description}</p>
                <div className="mt-3 flex items-center justify-between text-[11px] text-navy/40">
                  <span>@{item.handle} · v{item.version}</span>
                  <span>{item.installs} installs</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

interface FileEntry {
  path: string;
  size: number;
  text?: string;
}

export function SkillDetail() {
  const { slug } = useParams();
  const { paidUnlock, user } = useSession();
  const [meta, setMeta] = useState<SkillMeta | null>(null);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [toast, showToast] = useToast();

  useEffect(() => {
    if (!slug) return;
    api.get<{ item: SkillMeta }>(`/api/market/item/${slug}`).then((r) => setMeta(r.item)).catch(() => setError("Skill not found."));
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
  }, [slug, paidUnlock.unlocked]);

  if (error) return <ErrorNote error={error} />;
  if (!meta) return <Spinner />;

  const installCommand = `bridgistic skills install @${meta.handle}/${meta.slug}`;
  const npxCommand = `npx skills add https://marketplace.bridgistic.app/${meta.handle}/${meta.slug}`;
  const promptText = (files ?? []).find((f) => f.path === "SKILL.md")?.text ?? "";

  return (
    <>
      <PageHead
        title={meta.name}
        sub={`${meta.description}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={meta.tier === "paid" ? "gold" : "good"}>{meta.tier}</Badge>
            <Badge tone="neutral">v{meta.version}</Badge>
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-bold text-navy">Files</h2>
          {files === null ? (
            <Spinner />
          ) : authorized && files.length > 0 ? (
            <div className="space-y-3">
              {files.map((f) => (
                <div key={f.path}>
                  <div className="mb-1 flex items-center justify-between text-xs text-navy/50">
                    <span className="font-mono">{f.path}</span>
                    <span>{f.size} bytes</span>
                  </div>
                  <pre className="max-h-72 overflow-auto rounded-lg bg-navy p-3 text-[11px] leading-relaxed text-white/85">{f.text}</pre>
                </div>
              ))}
            </div>
          ) : meta.tier === "paid" ? (
            <div className="rounded-lg border border-dashed border-gold bg-gold-soft/40 p-6 text-center">
              <p className="font-semibold text-navy">This is a Pro pack.</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-navy/60">Activate a Bridgistic license on your account to read and install it. The Lifetime Deal is $49.99 one time.</p>
              <div className="mt-3 flex justify-center gap-2">
                <a href="https://pay.bridgistic.app/" target="_blank" rel="noreferrer"><Btn variant="gold">Get Pro</Btn></a>
                <Link to="/license"><Btn variant="ghost">I have a key</Btn></Link>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-navy/25 p-6 text-center">
              <p className="font-semibold text-navy">Free download needs a free account.</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-navy/60">Sign in or create an account — the prompt tab below works without one.</p>
              <div className="mt-3 flex justify-center gap-2">
                <Link to="/signin"><Btn>Sign in</Btn></Link>
                <Link to="/signup"><Btn variant="ghost">Create account</Btn></Link>
              </div>
            </div>
          )}
        </Card>
        <div className="space-y-4">
          <Card className="p-4">
            <h3 className="mb-2 text-sm font-bold text-navy">Install</h3>
            <CopyLine label="CLI" value={installCommand} />
            <CopyLine label="npx" value={npxCommand} />
            <div className="mt-3 flex gap-2">
              {authorized ? (
                <Btn small onClick={() => void (async () => {
                  try {
                    await api.post(`/api/market/install/${meta.slug}`);
                    showToast("Installed — it shows under Installed.");
                  } catch (e) {
                    showToast(e instanceof Error ? e.message : "Install failed.");
                  }
                })()}>Install to account</Btn>
              ) : (
                <Btn small variant="ghost" onClick={() => void (async () => {
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
                })()} disabled={!user}>Download zip</Btn>
              )}
            </div>
          </Card>
          <Card className="p-4">
            <h3 className="mb-2 text-sm font-bold text-navy">Prompt tab (no account)</h3>
            <p className="mb-2 text-xs text-navy/50">Copy the skill straight into your assistant.</p>
            <Btn small variant="ghost" disabled={!promptText} onClick={() => {
              void navigator.clipboard.writeText(promptText);
              setPromptCopied(true);
              setTimeout(() => setPromptCopied(false), 2000);
            }}>{promptCopied ? "Copied ✓" : "Copy skill as prompt"}</Btn>
          </Card>
          <Card className="p-4 text-xs text-navy/60">
            <div>Author: <b>@{meta.handle}</b> ({meta.author})</div>
            <div>Category: {meta.category}</div>
            <div>{meta.installs} installs · updated {meta.updated}</div>
            <div className="mt-2 text-navy/40">Skills are instruction text, not executed code.</div>
          </Card>
        </div>
      </div>
      <Toast message={toast} />
    </>
  );
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mb-2">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-navy/40">{label}</div>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
        className="w-full truncate rounded-lg bg-navy/[0.05] px-3 py-2 text-left font-mono text-xs text-navy hover:bg-navy/10"
      >
        {copied ? "Copied ✓" : value}
      </button>
    </div>
  );
}
