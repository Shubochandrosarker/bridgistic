import { motion } from "framer-motion";
import { AlertTriangle, Inbox, PlugZap, RefreshCw, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import type { ApiError } from "../lib/api/errors.ts";

export function PageHeader({ title, description, actions, badge }: { title: string; description?: string; actions?: ReactNode; badge?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div className="flex items-center gap-3"><h1 className="text-2xl font-semibold tracking-tight text-navy">{title}</h1>{badge}</div>
        {description && <p className="mt-1 max-w-2xl text-sm text-navy/65">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </header>
  );
}

export function Card({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay, ease: "easeOut" }} className={`card p-5 ${className}`}>
      {children}
    </motion.section>
  );
}

export function Stat({ label, value, hint, delay = 0 }: { label: string; value: ReactNode; hint?: string; delay?: number }) {
  return (
    <Card delay={delay}>
      <p className="text-xs font-semibold uppercase tracking-wider text-navy/55">{label}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums text-navy">{value}</p>
      {hint && <p className="mt-1 text-xs text-navy/55">{hint}</p>}
    </Card>
  );
}

const tones: Record<string, string> = {
  ok: "bg-teal-soft text-teal", approved: "bg-teal-soft text-teal", active: "bg-teal-soft text-teal", publish: "bg-teal-soft text-teal", completed: "bg-teal-soft text-teal",
  pending: "bg-gold/15 text-[#7a5f2b]", pending_approval: "bg-gold/15 text-[#7a5f2b]", draft: "bg-gold/15 text-[#7a5f2b]", processing: "bg-gold/15 text-[#7a5f2b]", grace_period: "bg-gold/15 text-[#7a5f2b]",
  lifetime: "bg-teal-soft text-teal", paid: "bg-teal-soft text-teal", past_due: "bg-gold/15 text-[#7a5f2b]", cancelled: "bg-navy/5 text-navy/70", refunded: "bg-red-50 text-red-800",
  denied: "bg-red-50 text-red-800", error: "bg-red-50 text-red-800", expired: "bg-red-50 text-red-800", revoked: "bg-red-50 text-red-800",
};
export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  const t = tones[tone ?? String(children)] ?? "bg-navy/5 text-navy/70";
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${t}`}>{children}</span>;
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-3">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="shimmer h-10 rounded-xl" />)}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <Inbox className="h-8 w-8 text-navy/30" aria-hidden />
      <p className="font-medium text-navy">{title}</p>
      {body && <p className="max-w-md text-sm text-navy/60">{body}</p>}
      {action}
    </div>
  );
}

const errCopy: Record<string, { title: string; body: string }> = {
  network: { title: "Could not reach the site", body: "Check that the site is online, the Bridgistic plugin is active, and that the plugin allows this dashboard's origin (CORS)." },
  auth: { title: "The site rejected this key", body: "The key may be revoked or the secret mistyped. Mint a new key in WP Admin → Bridgistic → Keys and reconnect." },
  scope: { title: "This key lacks the scope for this screen", body: "Grant the scope in WP Admin → Bridgistic → Keys, or connect a key that has it." },
  needs_plugin_update: { title: "Needs a plugin update", body: "This screen uses a route added in the companion plugin change (bridgistic/v1 audit, approvals, license). Your site runs an earlier plugin version." },
  rate_limited: { title: "Rate limit reached", body: "The key's per-minute limit was hit. Wait a moment and retry." },
};
export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const c = errCopy[error.kind] ?? { title: "Something went wrong", body: error.message };
  const Icon = error.kind === "needs_plugin_update" ? PlugZap : AlertTriangle;
  return (
    <div role="alert" className="flex flex-col items-center gap-2 py-10 text-center">
      <Icon className="h-8 w-8 text-gold" aria-hidden />
      <p className="font-medium text-navy">{c.title}</p>
      <p className="max-w-md text-sm text-navy/60">{c.body}</p>
      {error.status > 0 && <p className="text-xs text-navy/40">HTTP {error.status}</p>}
      {onRetry && <button className="btn-ghost mt-2" onClick={onRetry}><RefreshCw className="h-4 w-4" aria-hidden />Retry</button>}
    </div>
  );
}

export function ComingSoonBadge() {
  return <span className="inline-flex items-center gap-1 rounded-full bg-navy/5 px-2.5 py-0.5 text-xs font-medium text-navy/60 ring-1 ring-gold/40"><Sparkles className="h-3 w-3 text-gold" aria-hidden />Coming soon</span>;
}

export function ComingSoonPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-dashed border-gold/50 bg-ivory/60 p-5">
      <div className="flex items-center justify-between gap-2"><p className="font-medium text-navy">{title}</p><ComingSoonBadge /></div>
      <p className="mt-1 text-sm text-navy/60">{body}</p>
    </div>
  );
}

export function DataTable({ rows, columns, caption, render }: { rows: Record<string, unknown>[]; columns?: string[]; caption: string; render?: Record<string, (v: unknown, row: Record<string, unknown>) => ReactNode> }) {
  const cols = columns ?? Array.from(new Set(rows.slice(0, 20).flatMap((r) => Object.keys(r)))).slice(0, 7);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead><tr className="border-b border-navy/10 text-xs uppercase tracking-wider text-navy/50">{cols.map((c) => <th key={c} scope="col" className="px-3 py-2 font-semibold">{c.replace(/_/g, " ")}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <motion.tr key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i * 0.02, 0.4) }} className="border-b border-navy/5 hover:bg-ivory/70">
              {cols.map((c) => <td key={c} className="px-3 py-2.5 align-top text-navy/85">{render?.[c] ? render[c]!(r[c], r) : cell(r[c])}</td>)}
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function cell(v: unknown): ReactNode {
  if (v === null || v === undefined || v === "") return <span className="text-navy/30">—</span>;
  if (typeof v === "boolean") return <Badge tone={v ? "ok" : undefined}>{v ? "yes" : "no"}</Badge>;
  if (typeof v === "object") return <code className="text-xs text-navy/60">{JSON.stringify(v).slice(0, 80)}</code>;
  return String(v);
}
