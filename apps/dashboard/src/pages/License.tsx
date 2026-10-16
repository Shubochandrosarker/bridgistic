import { motion } from "framer-motion";
import { KeyRound, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { useState } from "react";
import { Badge, Card, ErrorState, PageHeader, Skeleton } from "../components/ui.tsx";
import { ACCOUNT_URL, LICENSE_API, PAY_URL } from "../lib/config.ts";
import { ApiError } from "../lib/api/errors.ts";
import type { LicenseStatus } from "../lib/api/types.ts";
import { fmtTime } from "../lib/format.ts";
import { useStore } from "../lib/store.tsx";
import { useAsync } from "../lib/useAsync.ts";

export function License() {
  const { client } = useStore();
  const st = useAsync(client ? () => client.license() : null, [client]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [override, setOverride] = useState<LicenseStatus | null>(null);
  const lic = override ?? st.data;
  const run = async (fn: () => Promise<LicenseStatus>) => { setBusy(true); setErr(null); try { setOverride(await fn()); } catch (e) { setErr(e instanceof ApiError ? e : new ApiError(String(e), "server")); } finally { setBusy(false); } };

  return (
    <div className="space-y-6">
      <PageHeader title="License" description="Your Bridgistic license is issued and verified by the WPistic license server. The site activates it, so the activation is bound to that site's domain and installation." />
      {st.loading ? <Card><Skeleton /></Card> : st.error && !override ? <Card><ErrorState error={st.error} onRetry={st.reload} /></Card> : lic && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="flex items-center gap-3">
              <motion.div initial={{ scale: 0.8 }} animate={{ scale: 1 }} className={`flex h-12 w-12 items-center justify-center rounded-2xl ${lic.connected ? "bg-teal-soft text-teal" : "bg-navy/5 text-navy/50"}`}><ShieldCheck className="h-6 w-6" aria-hidden /></motion.div>
              <div><p className="text-lg font-semibold">{lic.connected ? `${lic.plan.charAt(0).toUpperCase()}${lic.plan.slice(1)} license` : "No license activated"}</p><Badge tone={lic.status}>{lic.status}</Badge></div>
            </div>
            <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
              {[["Key", lic.key_mask ?? "—"], ["Activated domain", lic.domain ?? "—"], ["Expires", lic.connected ? (lic.expires_at ? fmtTime(lic.expires_at) : "Never (lifetime)") : "—"], ["Last verified", fmtTime(lic.validated_at)]].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-ivory p-3"><dt className="text-xs text-navy/55">{k}</dt><dd className="mt-0.5 font-medium">{v}</dd></div>))}
            </dl>
            {lic.connected ? (
              <div className="mt-5 flex flex-wrap gap-2">
                <button className="btn-ghost" disabled={busy} onClick={() => client && run(() => client.validateLicense())}><RefreshCw className="h-4 w-4" aria-hidden />Check now</button>
                <button className="btn-danger" disabled={busy} onClick={() => client && run(() => client.deactivateLicense())}><Unplug className="h-4 w-4" aria-hidden />Deactivate on this site</button>
              </div>
            ) : (
              <form className="mt-5 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (client && key.trim()) void run(() => client.activateLicense(key.trim())); }}>
                <label className="flex-1"><span className="sr-only">License key</span><input className="input font-mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your license key" autoComplete="off" /></label>
                <button className="btn-primary" disabled={busy || !key.trim()}><KeyRound className="h-4 w-4" aria-hidden />{busy ? "Activating…" : "Activate"}</button>
              </form>
            )}
            {err && <ErrorState error={err} />}
          </Card>
          <Card delay={0.05}>
            <h2 className="text-sm font-semibold">Lifetime Deal</h2>
            <p className="mt-1 text-3xl font-semibold">$29.99 <span className="text-sm font-normal text-navy/55">one time</span></p>
            <p className="mt-2 text-sm text-navy/65">Lifetime use with all future updates included.</p>
            <a href={PAY_URL} className="btn-primary mt-4 w-full justify-center">View the offer</a>
            <a href={ACCOUNT_URL} className="mt-3 block text-center text-xs text-navy/55 underline">Manage licenses at WPistic</a>
          </Card>
        </div>)}
      <Card>
        <h2 className="text-sm font-semibold">How activation works</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-navy/70">
          <li>The dashboard asks the plugin to activate (POST bridgistic/v1/license/activate, scope license:manage).</li>
          <li>The plugin sends the key with its domain and installation ID to {LICENSE_API}/activate.</li>
          <li>The server returns an activation token and a verification key. The plugin stores them; the raw key is not stored.</li>
          <li>Every later status is HMAC-signed by the server and verified by the plugin before it is trusted.</li>
        </ol>
      </Card>
    </div>
  );
}
