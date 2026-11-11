import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Globe, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { normalizeSiteUrl } from "@bridgistic/wp-client";
import { BridgeClient } from "../lib/api/bridge.ts";
import { ApiError } from "../lib/api/errors.ts";
import { Badge, Card, EmptyState, ErrorState, PageHeader } from "../components/ui.tsx";
import { useStore } from "../lib/store.tsx";
import { ACCOUNT_URL } from "../lib/config.ts";
import { fetchPairedSites } from "../lib/sites-sync.ts";
import type { PairedSiteStatus } from "../lib/api/types.ts";

const STATUS_TONE: Record<PairedSiteStatus, "ok" | "pending" | "error"> = { activated: "ok", deactivated: "pending", expired: "error", suspended: "error" };
const STATUS_LABEL: Record<PairedSiteStatus, string> = { activated: "license active", deactivated: "deactivated", expired: "license expired", suspended: "license suspended" };

export function ConnectForm({ onDone }: { onDone?: () => void }) {
  const { addSite, syncPairedSites } = useStore();
  const [f, setF] = useState({ alias: "", siteUrl: "", keyId: "", secret: "" });
  const [step, setStep] = useState<"form" | "testing" | "ok">("form");
  const [err, setErr] = useState<ApiError | null>(null);
  const [urlErr, setUrlErr] = useState<string | null>(null);
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setUrlErr(null); setKeyErr(null);
    // A license key (anything that is not a wpk_ bridge key) is claimed for
    // this account — it may have been bought under another email — and every
    // site activated with it appears from /api/me/sites. No secret comes back.
    const pasted = f.keyId.trim();
    if (pasted && !pasted.startsWith("wpk_")) {
      setStep("testing");
      try {
        const res = await fetch(`${ACCOUNT_URL}/api/me/claim-license`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: pasted }),
        });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
        if (!res.ok || !body?.ok) {
          setKeyErr(body?.message ?? "This license key could not be added. Check the key and that you are signed in.");
          setStep("form");
          return;
        }
        const paired = await fetchPairedSites();
        if (paired) syncPairedSites(paired);
        if (!paired?.length) {
          setKeyErr("License added. No site is activated with it yet — activate it in WP Admin → Bridgistic → Premium Features and it appears here automatically.");
          setStep("form");
          return;
        }
        setStep("ok"); setTimeout(() => onDone?.(), 700);
      } catch (x) {
        setErr(x instanceof ApiError ? x : new ApiError(String(x), "server"));
        setStep("form");
      }
      return;
    }
    if (!pasted.startsWith("wpk_")) { setKeyErr("Paste a key ID (wpk_…) or your license key (BRG-…) and we connect the licensed site for you."); return; }
    if (!f.siteUrl.trim()) { setUrlErr("The site URL is required with a wpk_ key."); return; }
    if (!f.secret.trim()) { setKeyErr("The key secret is required with a wpk_ key. It is shown once in WP Admin → Bridgistic → Keys."); return; }
    let siteUrl: string;
    try { siteUrl = normalizeSiteUrl(f.siteUrl); } catch (x) { setUrlErr(x instanceof Error ? x.message : "Invalid URL"); return; }
    setStep("testing");
    const conn = { siteUrl, keyId: pasted, secret: f.secret.trim(), id: "test", alias: f.alias.trim() || new URL(siteUrl).host };
    try {
      await new BridgeClient(conn).siteInfo();
      addSite({ alias: conn.alias, siteUrl, keyId: conn.keyId, secret: conn.secret });
      setStep("ok"); setTimeout(() => onDone?.(), 700);
    } catch (x) { setErr(x instanceof ApiError ? x : new ApiError(String(x), "server")); setStep("form"); }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form onSubmit={submit} className="space-y-4" aria-describedby="connect-help">
      <ol id="connect-help" className="grid gap-2 text-sm text-navy/70 sm:grid-cols-3">
        {["Have a license (BRG-…)? Paste it as the Key ID below — the licensed site connects itself.", "No license? In WP Admin → Bridgistic → Keys, mint a key (wpk_…) and paste it with its secret.", "Everything is verified against the live site before it is saved."].map((t, i) => (
          <li key={i} className="rounded-xl bg-ivory p-3"><span className="mb-1 block text-xs font-semibold text-gold">Step {i + 1}</span>{t}</li>))}
      </ol>
      <div className="grid gap-4 sm:grid-cols-2">
        <label><span className="label">Site URL</span><input className="input" value={f.siteUrl} onChange={set("siteUrl")} placeholder="https://example.com (not needed with a license key)" inputMode="url" aria-invalid={!!urlErr} />{urlErr && <span className="mt-1 block text-xs text-red-800">{urlErr}</span>}</label>
        <label><span className="label">Name (optional)</span><input className="input" value={f.alias} onChange={set("alias")} placeholder="Client store" /></label>
        <label><span className="label">License key or Key ID</span><input required className="input font-mono" value={f.keyId} onChange={set("keyId")} placeholder="BRG-… (license) or wpk_… (key)" autoComplete="off" aria-invalid={!!keyErr} />{keyErr && <span className="mt-1 block text-xs text-red-800">{keyErr}</span>}</label>
        <label><span className="label">Key secret <span className="font-normal text-navy/40">(leave empty with a license key)</span></span><input type="password" className="input font-mono" value={f.secret} onChange={set("secret")} placeholder="wps_…" autoComplete="off" /></label>
      </div>
      {err && <div className="rounded-xl ring-1 ring-red-800/20"><ErrorState error={err} /></div>}
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={step !== "form"}>{step === "testing" ? "Testing connection…" : "Test and connect"}</button>
        <AnimatePresence>{step === "ok" && <motion.span initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-1 text-sm text-teal"><CheckCircle2 className="h-4 w-4" aria-hidden />Connected</motion.span>}</AnimatePresence>
      </div>
    </form>
  );
}

export function Sites() {
  const { sites, activeId, setActive, removeSite, mode } = useStore();
  const [params] = useSearchParams();
  const [open, setOpen] = useState(params.get("connect") === "1" || (mode !== "demo" && sites.length === 0));
  const nav = useNavigate();
  return (
    <div className="space-y-6">
      <PageHeader title="Sites" description="WordPress sites connected through the Bridgistic plugin." actions={<button className="btn-primary" onClick={() => setOpen(!open)}><Plus className="h-4 w-4" aria-hidden />Connect site</button>} />
      <AnimatePresence>{open && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden"><Card><ConnectForm onDone={() => { setOpen(false); nav("/"); }} /></Card></motion.div>}</AnimatePresence>
      <Card>
        {mode === "demo" ? (
          <ul className="divide-y divide-navy/5"><li className="flex items-center gap-3 py-3"><Globe className="h-5 w-5 text-teal" aria-hidden /><div className="flex-1"><p className="font-medium">Demo Store (sample)</p><p className="text-xs text-navy/55">https://demo.example</p></div><Badge tone="ok">active</Badge></li></ul>
        ) : sites.length === 0 ? <EmptyState title="No sites connected" body="Connect your first site to load real data." /> : (
          <ul className="divide-y divide-navy/5">
            {sites.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
                <Globe className="h-5 w-5 text-teal" aria-hidden />
                <div className="min-w-0 flex-1"><p className="font-medium">{s.alias}</p><p className="truncate text-xs text-navy/55">{s.siteUrl}{s.pairedSiteId ? ` · ${s.plan ?? ""} ${s.licenseMask ?? ""}`.trimEnd() : ` · key ${s.keyId}`}{s.lastValidatedAt ? ` · checked ${new Date(s.lastValidatedAt).toLocaleString()}` : ""}</p></div>
                {s.status && <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>}
                {s.pairedSiteId && s.status === "activated" && !s.keyId && <Badge tone="pending">waiting for key — Check now in WP Admin</Badge>}
                {s.id === activeId ? <Badge tone="ok">active</Badge> : <button className="btn-ghost" onClick={() => setActive(s.id)}>Make active</button>}
                {!s.pairedSiteId && <button className="btn-danger" aria-label={`Disconnect ${s.alias}`} onClick={() => removeSite(s.id)}><Trash2 className="h-4 w-4" aria-hidden /></button>}
              </li>))}
          </ul>)}
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card><div className="p-4"><h3 className="text-sm font-semibold">Licensed sites connect themselves</h3><p className="mt-1 text-sm text-navy/65">Sites with an active license pair automatically: sign in on any device and they appear here — no keys to copy. Activate in WP Admin → Bridgistic → Premium Features.</p></div></Card>
      </div>
    </div>
  );
}
