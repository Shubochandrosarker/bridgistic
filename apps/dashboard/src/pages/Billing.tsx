import { CreditCard, ExternalLink, FileText } from "lucide-react";
import { useState } from "react";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "../components/ui.tsx";
import { cadence, fetchBilling, fmtMoney, openStripePortal, PROVIDER_LABEL, renewalLine, SUPPORT_EMAIL, type BillingSubscription } from "../lib/billing.ts";
import { PAY_URL } from "../lib/config.ts";
import { fmtTime } from "../lib/format.ts";
import { useAsync } from "../lib/useAsync.ts";

/** One billing UI for Stripe-billed accounts and directly issued licenses. Only the "Manage" action differs. */
export function Billing() {
  const st = useAsync(() => fetchBilling(), []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const manage = async (s: BillingSubscription) => {
    setErr(null);
    if (s.manage.type === "support") {
      window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Bridgistic license " + s.subscription_id)}`;
      return;
    }
    if (s.manage.type === "paddle_portal") {
      if (s.manage.url) window.open(s.manage.url, "_blank", "noopener");
      else setErr("Open the link in your receipt email to manage this subscription.");
      return;
    }
    setBusy(true);
    try {
      window.location.assign(await openStripePortal(`${window.location.origin}/billing`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const data = st.data;
  return (
    <div className="space-y-6">
      <PageHeader title="Billing" description="Your plan, renewal and invoices." />
      {err && <Card><p className="text-sm text-red-700" role="alert">{err}</p></Card>}
      {st.loading ? <Card><Skeleton /></Card> : st.error ? (
        <Card><p className="text-sm text-navy/70">{String((st.error as Error).message ?? st.error)}</p></Card>
      ) : data && data.subscriptions.length === 0 ? (
        <Card>
          <EmptyState
            title={data.upstream_error ? "Billing is unavailable right now" : "No paid plan yet"}
            body={data.upstream_error ? "Try again in a minute." : "Pro adds snapshots, exports and skills on up to 3 sites."}
            action={data.upstream_error ? undefined : <a className="btn-primary" href={PAY_URL}>See plans</a>}
          />
        </Card>
      ) : data && (
        <div className="space-y-4">
          {data.subscriptions.map((s, i) => (
            <Card key={s.subscription_id} delay={i * 0.05}>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-soft text-teal"><CreditCard className="h-6 w-6" aria-hidden /></div>
                  <div>
                    <p className="text-lg font-semibold">
                      Bridgistic {s.plan_name} {s.amount > 0 && <span className="text-sm font-normal text-navy/60">{fmtMoney(s.amount, s.currency)} {cadence(s.interval)}</span>}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-navy/65">
                      <Badge tone={s.status}>{s.status.replace("_", " ")}</Badge>
                      <span>{renewalLine(s, fmtTime)}</span>
                      <span className="text-xs text-navy/45">Billed by {PROVIDER_LABEL[s.billing_provider]}</span>
                    </div>
                  </div>
                </div>
                {s.status !== "refunded" && (
                  <button className="btn-ghost shrink-0" disabled={busy} onClick={() => void manage(s)}>
                    <ExternalLink className="h-4 w-4" aria-hidden />
                    {busy && s.manage.type === "stripe_portal" ? "Opening…" : s.status === "lifetime" ? "Billing details" : "Manage subscription"}
                  </button>
                )}
              </div>
              <div className="mt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-navy/50">Invoices</h3>
                {s.invoices.length === 0 ? (
                  <p className="mt-2 text-sm text-navy/60">{s.billing_provider === "license" ? `This license was issued directly. Email ${SUPPORT_EMAIL} for a receipt.` : s.billing_provider === "paddle" ? "Invoices for this legacy purchase were emailed to you." : "No invoices yet."}</p>
                ) : (
                  <ul className="mt-2 divide-y divide-navy/5 text-sm">
                    {s.invoices.map((inv) => (
                      <li key={inv.id} className="flex items-center justify-between py-2">
                        <span>{fmtTime(inv.paid_at ?? inv.created_at)}</span>
                        <span className="flex items-center gap-3">
                          <span className="font-medium">{fmtMoney(inv.amount_paid || inv.amount_due, inv.currency)}</span>
                          <Badge tone={inv.status}>{inv.status}</Badge>
                          {(inv.pdf_url || inv.hosted_invoice_url) && (
                            <a className="inline-flex items-center gap-1 text-teal hover:underline" href={inv.pdf_url ?? inv.hosted_invoice_url ?? "#"} target="_blank" rel="noopener noreferrer">
                              <FileText className="h-4 w-4" aria-hidden />Invoice
                            </a>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
