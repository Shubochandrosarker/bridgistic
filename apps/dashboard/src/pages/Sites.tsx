import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Globe, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { normalizeSiteUrl } from "@bridgistic/wp-client";
import { BridgeClient } from "../lib/api/bridge.ts";
import { ApiError } from "../lib/api/errors.ts";
import { Badge, Card, ComingSoonPanel, EmptyState, ErrorState, PageHeader } from "../components/ui.tsx";
import { useStore } from "../lib/store.tsx";

export function ConnectForm({ onDone }: { onDone?: () => void }) {
  const { addSite } = useStore();
  const [f, setF] = useState({ alias: "", siteUrl: "", keyId: "", secret: "" });
  const [step, setStep] = useState<"form" | "testing" | "ok">("form");
  const [err, setErr] = useState<ApiError | null>(null);
  const [urlErr, setUrlErr] = useState<string | null>(null);
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setUrlErr(null); setKeyErr(null);
    if (!f.keyId.trim().startsWith("wpk_")) { setKeyErr("A key ID starts with wpk_ — mint one in WP Admin → Bridgistic → Keys (your email is not the key)."); return; }
    let siteUrl: string;
    try { siteUrl = normalizeSiteUrl(f.siteUrl); } catch (x) { setUrlErr(x instanceof Error ? x.message : "Invalid URL"); return; }
    setStep("testing");
    const conn = { siteUrl, keyId: f.keyId.trim(), secret: f.secret.trim(), id: "test", alias: f.alias.trim() || new URL(siteUrl).host };
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
        {["Install and activate the Bridgistic plugin (1.5.3 or later).", "In WP Admin → Bridgistic → Keys, mint a key with the scopes you want.", "Paste the site URL, key ID and secret below. The secret is shown once in WP Admin."].map((t, i) => (
          <li key={i} className="rounded-xl bg-ivory p-3"><span className="mb-1 block text-xs font-semibold text-gold">Step {i + 1}</span>{t}</li>))}
      </ol>
      <div className="grid gap-4 sm:grid-cols-2">
        <label><span className="label">Site URL</span><input required className="input" value={f.siteUrl} onChange={set("siteUrl")} placeholder="https://example.com" inputMode="url" aria-invalid={!!urlErr} />{urlErr && <span className="mt-1 block text-xs text-red-800">{urlErr}</span>}</label>
        <label><span className="label">Name (optional)</span><input className="input" value={f.alias} onChange={set("alias")} placeholder="Client store" /></label>
        <label><span className="label">Key ID</span><input required className="input font-mono" value={f.keyId} onChange={set("keyId")} placeholder="wpk_…" autoComplete="off" aria-invalid={!!keyErr} /><span className="mt-1 block text-xs text-navy/50">Starts with <code>wpk_</code> — mint one in WP Admin → Bridgistic → Keys. Your email is not the key.</span>{keyErr && <span className="mt-1 block text-xs text-red-800">{keyErr}</span>}</label>
        <label><span className="label">Key secret</span><input required type="password" className="input font-mono" value={f.secret} onChange={set("secret")} placeholder="wps_…" autoComplete="off" /></label>
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
                <div className="min-w-0 flex-1"><p className="font-medium">{s.alias}</p><p className="truncate text-xs text-navy/55">{s.siteUrl} · key {s.keyId}</p></div>
                {s.id === activeId ? <Badge tone="ok">active</Badge> : <button className="btn-ghost" onClick={() => setActive(s.id)}>Make active</button>}
                <button className="btn-danger" aria-label={`Disconnect ${s.alias}`} onClick={() => removeSite(s.id)}><Trash2 className="h-4 w-4" aria-hidden /></button>
              </li>))}
          </ul>)}
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card><div className="p-4"><h3 className="text-sm font-semibold">Licensed sites connect themselves</h3><p className="mt-1 text-sm text-navy/65">Sites with an active license pair automatically: sign in on any device and they appear here — no keys to copy. Activate in WP Admin → Bridgistic → Premium Features.</p></div></Card>
        <ComingSoonPanel title="Bulk onboarding" body="Connect many sites from one CSV with per-site scope presets." />
      </div>
    </div>
  );
}
