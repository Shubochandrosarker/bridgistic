/** Workspace screens: overview, sites, keys, approvals, audit, snapshots, usage, license. */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDate, fmtDateTime, siteCall, type SiteRow } from "../lib/api";
import { useSession, useCurrentSite } from "../lib/session";
import { Badge, Btn, Card, ErrorNote, Field, inputClass, Modal, PageHead, Stat, Table, Td, Toast, useToast } from "../components/ui";
import { RequireSite, SiteList, SitePicker, type Row, type Rows } from "../components/sitelist";

const RISKY = new Set(["fs:write", "db:write", "php:execute", "users:write", "options:write", "snapshot:manage", "plugins:manage", "woo:orders:write", "woo:products:write"]);

export function Overview() {
  const { org, sites, paidUnlock } = useSession();
  const [approvals, setApprovals] = useState<Rows>([]);
  const [audit, setAudit] = useState<Rows>([]);
  useEffect(() => {
    let live = true;
    const site = sites[0];
    if (site) {
      siteCall<unknown>(site.id, "GET", "approvals")
        .catch(() => null)
        .then((p) => {
          if (live && Array.isArray(p)) setApprovals(p as Rows);
        });
      siteCall<unknown>(site.id, "GET", "audit?filter=all")
        .catch(() => null)
        .then((p) => {
          if (live && Array.isArray(p)) setAudit((p as Rows).slice(0, 8));
        });
    }
    return () => {
      live = false;
    };
  }, [sites]);
  const pending = approvals.filter((a) => a.status === "pending");

  return (
    <>
      <PageHead
        title={`Welcome back${org ? `, ${org.name}` : ""}`}
        sub="One console for every site, agent and skill."
        actions={paidUnlock.unlocked ? <Badge tone="gold">Pro · {paidUnlock.plan}</Badge> : <Link to="/license"><Btn variant="gold" small>Upgrade</Btn></Link>}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sites" value={sites.length} sub="connected" />
        <Stat label="Pending approvals" value={pending.length} sub={pending.length ? "needs a person" : "all clear"} tone={pending.length ? "text-amber-600" : undefined} />
        <Stat label="Skills" value={<Link to="/marketplace" className="underline">Browse</Link>} sub="marketplace" />
        <Stat label="Plan" value={org?.plan ?? "free"} sub={paidUnlock.unlocked ? "license active" : "free tier"} />
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-bold text-navy">Recent activity</h2>
          {audit.length === 0 ? (
            <p className="text-sm text-navy/50">Site audit entries appear here once a site is connected.</p>
          ) : (
            <ul className="space-y-2">
              {audit.map((a, i) => (
                <li key={i} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate">
                    <span className="font-mono text-xs text-navy/70">{String(a.action ?? "")}</span>
                    <span className="ml-2 text-navy/50">{String(a.summary ?? "")}</span>
                  </span>
                  <Badge tone={String(a.status) === "allowed" ? "good" : "neutral"}>{String(a.status ?? "")}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-bold text-navy">Awaiting approval</h2>
          {pending.length === 0 ? (
            <p className="text-sm text-navy/50">Nothing is waiting on a human decision.</p>
          ) : (
            <ul className="space-y-2">
              {pending.slice(0, 6).map((a, i) => (
                <li key={i} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate">{String(a.action ?? "")} — {String(a.summary ?? "")}</span>
                  <Link to="/approvals" className="text-xs font-semibold text-navy underline">Review</Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

export function Sites() {
  const { org, sites, refresh } = useSession();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [toast, showToast] = useToast();

  const connect = async () => {
    if (!org) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/orgs/${org.id}/sites`, { url, key_id: keyId, secret, name });
      setOpen(false);
      setUrl("");
      setKeyId("");
      setSecret("");
      setName("");
      await refresh();
      showToast("Site connected and verified.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connect failed.");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!confirmId) return;
    await api.delete(`/api/sites/${confirmId}`);
    setConfirmId(null);
    await refresh();
  };

  return (
    <>
      <PageHead title="Sites" sub="Connected WordPress sites. Key secrets are encrypted at rest; every call is signed." actions={<Btn onClick={() => setOpen(true)}>Connect site</Btn>} />
      <Table head={["Site", "WordPress", "PHP", "Key", "Status", "Last seen", ""]} empty={sites.length === 0}>
        {sites.map((s) => (
          <tr key={s.id}>
            <Td>
              <div className="font-semibold text-navy">{s.name}</div>
              <div className="text-xs text-navy/50">{s.url}</div>
            </Td>
            <Td>{s.wp_version || "—"}</Td>
            <Td>{s.php_version || "—"}</Td>
            <Td><span className="font-mono text-xs">{s.key_mask}</span></Td>
            <Td><Badge tone="good">{s.status}</Badge></Td>
            <Td>{fmtDateTime(s.last_seen)}</Td>
            <Td><Btn variant="ghost" small onClick={() => setConfirmId(s.id)}>Disconnect</Btn></Td>
          </tr>
        ))}
      </Table>
      <Modal open={open} onClose={() => setOpen(false)} title="Connect a WordPress site">
        <div className="space-y-4">
          <ErrorNote error={error} />
          <ol className="list-inside list-decimal space-y-1 rounded-lg bg-navy/[0.04] p-3 text-xs text-navy/70">
            <li><b>Have a license (BRG-…)?</b> Paste it as the Key ID below — the licensed site connects itself, no secret needed.</li>
            <li>No license? In WP Admin open <b>Bridgistic → Keys</b>, mint a scoped key (starts wpk_) and paste the key ID and secret here.</li>
          </ol>
          <Field label="Site URL" hint="Not needed with a license key."><input className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" /></Field>
          <Field label="Display name"><input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="My blog" /></Field>
          <Field label="License key or Key ID"><input className={inputClass} value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="BRG-LTD-… (license) or wpk_… (key)" /></Field>
          <Field label="Key secret" hint="Leave empty with a license key."><input className={inputClass} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Shown once when the key was minted" /></Field>
          <Btn onClick={connect} disabled={busy || !keyId || (keyId.trim().startsWith("BRG-") ? false : !url || !secret)}>{busy ? "Verifying with the site…" : "Verify & connect"}</Btn>
        </div>
      </Modal>
      <Modal open={Boolean(confirmId)} onClose={() => setConfirmId(null)} title="Disconnect this site?">
        <p className="text-sm text-navy/70">The console loses access immediately. The key stays valid on the site until you revoke it in WP Admin.</p>
        <div className="mt-4 flex gap-2">
          <Btn variant="danger" onClick={disconnect}>Disconnect</Btn>
          <Btn variant="ghost" onClick={() => setConfirmId(null)}>Cancel</Btn>
        </div>
      </Modal>
      <Toast message={toast} />
    </>
  );
}

export function Keys() {
  return (
    <>
      <PageHead title="Keys & scopes" sub="What each connected key may do. Minting and rotation stay in the site's WP Admin by design." />
      <RequireSite>
        {(site) => (
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-navy">{site.name}</div>
                <div className="text-xs text-navy/50">{site.url} · key <span className="font-mono">{site.key_mask}</span></div>
              </div>
              <Badge tone="good">{site.status}</Badge>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(Array.isArray(site.scopes) ? site.scopes : []).map((s) => (
                <Badge key={s} tone={RISKY.has(s) ? "warn" : "neutral"}>{s}</Badge>
              ))}
            </div>
            <p className="mt-3 text-xs text-navy/50">A key can never widen itself: minting, rotation and revocation live in WP Admin → Bridgistic → Keys.</p>
          </Card>
        )}
      </RequireSite>
    </>
  );
}

export function Approvals() {
  return (
    <>
      <PageHead title="Approvals" sub="Write and destructive actions wait here for a person. The AI can approve nothing." />
      <RequireSite>
        {() => (
          <SiteList
            route="approvals"
            head={["Action", "Summary", "Key", "Status", "Created"]}
            cell={(row, key) => {
              if (key === "Status") return <Badge tone={row.status === "pending" ? "warn" : row.status === "approved" ? "good" : "bad"}>{String(row.status ?? "")}</Badge>;
              if (key === "Created") return fmtDateTime(String(row.created ?? ""));
              if (key === "Action") return <span className="font-mono text-xs">{String(row.action ?? "")}</span>;
              return <span>{String(row[key.toLowerCase()] ?? "")}</span>;
            }}
          />
        )}
      </RequireSite>
    </>
  );
}

export function AuditLog() {
  return (
    <>
      <PageHead title="Audit log" sub="Every signed call the bridge made, newest first." actions={<SitePicker />} />
      <RequireSite>
        {() => (
          <SiteList
            route="audit?filter=all"
            head={["When", "Action", "Summary", "Status", "IP"]}
            cell={(row, key) => {
              if (key === "When") return fmtDateTime(String(row.created_at ?? ""));
              if (key === "Status") return <Badge tone={String(row.status) === "allowed" ? "good" : "warn"}>{String(row.status ?? "")}</Badge>;
              if (key === "Action") return <span className="font-mono text-xs">{String(row.action ?? "")}</span>;
              return <span>{String(row[key.toLowerCase()] ?? "")}</span>;
            }}
          />
        )}
      </RequireSite>
    </>
  );
}

export function Snapshots() {
  const [open, setOpen] = useState(false);
  const [toast, showToast] = useToast();
  return (
    <>
      <PageHead title="Snapshots" sub="Pre-destruction captures with one-click rollback." actions={<><SitePicker /><Btn onClick={() => setOpen(true)}>Take snapshot</Btn></>} />
      <RequireSite>
        {(site) => (
          <>
            <SnapshotList site={site} onChanged={() => showToast("Done.")} onFail={(m) => showToast(m)} />
            <SnapshotModal site={site} open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); showToast("Snapshot taken."); }} onFail={(m) => showToast(m)} />
          </>
        )}
      </RequireSite>
      <Toast message={toast} />
    </>
  );
}

function SnapshotList({ site, onFail, onChanged }: { site: SiteRow; onFail: (msg: string) => void; onChanged: () => void }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 15000);
    return () => clearInterval(timer);
  }, []);
  return (
    <SiteList
      route="snapshot"
      refreshKey={tick}
      head={["Label", "Type", "Target", "Created", ""]}
      cell={(row, key) => {
        if (key === "Label") return <span className="font-semibold">{String(row.label ?? "—")}</span>;
        if (key === "Created") return fmtDate(String(row.created_at ?? row.created ?? ""));
        if (key === "") {
          return (
            <div className="flex gap-1.5">
              <Btn small variant="ghost" onClick={() => void (async () => {
                try {
                  await siteCall(site.id, "POST", "snapshot/restore", { snapshot_id: row.id });
                  onChanged();
                } catch (e) {
                  onFail(e instanceof Error ? e.message : "Restore failed.");
                }
              })()}>Restore</Btn>
              <Btn small variant="danger" onClick={() => void (async () => {
                try {
                  await siteCall(site.id, "POST", "snapshot/delete", { snapshot_id: row.id });
                  onChanged();
                } catch (e) {
                  onFail(e instanceof Error ? e.message : "Delete failed.");
                }
              })()}>Delete</Btn>
            </div>
          );
        }
        return <span className={key === "Target" ? "font-mono text-xs" : ""}>{String(row[key.toLowerCase()] ?? "")}</span>;
      }}
    />
  );
}

function SnapshotModal({ site, open, onClose, onDone, onFail }: { site: SiteRow; open: boolean; onClose: () => void; onDone: () => void; onFail: (msg: string) => void }) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState("post");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const take = async () => {
    setBusy(true);
    try {
      const t = target.trim();
      const payload = type === "option" ? { name: t } : type === "tables" ? { tables: t.split(",").map((x) => x.trim()) } : type === "file" ? { path: t } : { id: Number(t) };
      await siteCall(site.id, "POST", "snapshot", { type, target: payload, label });
      onDone();
      setLabel("");
      setTarget("");
    } catch (e) {
      onFail(e instanceof Error ? e.message : "Snapshot failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Take a snapshot">
      <div className="space-y-4">
        <Field label="Label"><input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Before the redesign" /></Field>
        <Field label="Type">
          <select className={inputClass} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="post">Post</option>
            <option value="option">Option</option>
            <option value="tables">Tables</option>
            <option value="file">File</option>
          </select>
        </Field>
        <Field label="Target" hint="Post ID, option name, comma-separated tables or file path."><input className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
        <Btn onClick={take} disabled={busy || !target}>{busy ? "Capturing…" : "Take snapshot"}</Btn>
      </div>
    </Modal>
  );
}

export function Usage() {
  const [info, setInfo] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <PageHead title="Usage" sub="Metered actions on the connected site." />
      <RequireSite>
        {(site) => <UsageBody siteId={site.id} onInfo={setInfo} onError={setError} />}
      </RequireSite>
      {error && <ErrorNote error={error} />}
      {info && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Period" value={String(info.period ?? "—")} />
            <Stat label="Used" value={String(info.used ?? info.actions ?? "—")} />
            <Stat label="Limit" value={String(info.limit ?? "—")} />
            <Stat label="Remaining" value={String(info.remaining ?? "—")} />
          </div>
          <pre className="mt-4 overflow-x-auto rounded-xl bg-navy p-4 text-xs text-white/80">{JSON.stringify(info, null, 2)}</pre>
        </>
      )}
    </>
  );
}

function UsageBody({ siteId, onInfo, onError }: { siteId: string; onInfo: (info: Row) => void; onError: (msg: string) => void }) {
  useEffect(() => {
    siteCall<Row>(siteId, "GET", "usage")
      .then(onInfo)
      .catch((e) => onError(e instanceof Error ? e.message : "Usage failed."));
  }, [siteId, onInfo, onError]);
  return <p className="mb-3 text-sm text-navy/50">Reading the live meter…</p>;
}

export function LicensePage() {
  const { paidUnlock, refresh, user, org } = useSession();
  const [site] = useCurrentSite();
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<Row | null>(null);
  const [toast, showToast] = useToast();
  const [busy, setBusy] = useState(false);
  const staff = user?.role === "owner" || user?.role === "admin";

  const activate = async () => {
    if (!site) {
      showToast("Connect a site first — licenses activate on a site.");
      return;
    }
    setBusy(true);
    try {
      setStatus(await siteCall<Row>(site.id, "POST", "license/activate", { key: key.trim() }));
      showToast("License activated on the site.");
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Activation failed.");
    } finally {
      setBusy(false);
    }
  };

  const validateNow = async () => {
    if (!site) return;
    try {
      setStatus(await siteCall<Row>(site.id, "POST", "license/validate", {}));
      showToast("Validated with the license server.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Validation failed.");
    }
  };

  return (
    <>
      <PageHead title="License" sub="A live WPistic license opens unlimited schedules, advanced snapshots and audit export on the site." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-bold text-navy">Activate on the connected site</h2>
          <Field label="License key"><input className={inputClass} value={key} onChange={(e) => setKey(e.target.value)} placeholder="BRG-LTD-…" /></Field>
          <div className="mt-3 flex gap-2">
            <Btn onClick={activate} disabled={busy || !key}>{busy ? "Activating…" : "Activate"}</Btn>
            <Btn variant="ghost" onClick={validateNow}>Check now</Btn>
          </div>
          {status && <pre className="mt-4 overflow-x-auto rounded-lg bg-navy/[0.04] p-3 text-xs">{JSON.stringify(status, null, 2)}</pre>}
        </Card>
        <Card className="p-5">
          {staff ? (
            <>
              <h2 className="mb-2 text-sm font-bold text-navy">Master account</h2>
              <p className="text-sm text-navy/70">
                You administer the platform, so no license is needed on this account. Issue, cap, suspend and revoke
                customer licenses from <b>Platform admin → Licenses</b> — every issuance is shown once and tracked in sync logs.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <a href="/admin/licenses"><Btn>Open license management</Btn></a>
                <a href="/admin/sync-logs"><Btn variant="ghost">View sync logs</Btn></a>
              </div>
              <p className="mt-3 text-xs text-navy/50">Workspace plan: <b className="capitalize">{org?.plan ?? "platform"}</b> · purchases by customers are billed through Paddle and issued automatically by the webhook.</p>
            </>
          ) : (
            <>
              <h2 className="mb-2 text-sm font-bold text-navy">Your account</h2>
              <p className="text-sm text-navy/70">
                {paidUnlock.unlocked ? (
                  <>Pro is active on this account (<b>{paidUnlock.plan}</b>) — the paid skills marketplace is unlocked.</>
                ) : (
                  <>No license is attached to this account yet. The Lifetime Deal is $49.99 one time with all future updates.</>
                )}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <a href="https://pay.bridgistic.app/" target="_blank" rel="noreferrer"><Btn variant="gold">Get the Lifetime Deal · $49.99</Btn></a>
                <a href="https://bridgistic.app/#pricing" target="_blank" rel="noreferrer"><Btn variant="ghost">Compare plans</Btn></a>
              </div>
              <p className="mt-3 text-xs text-navy/50">Licenses are issued and managed in Platform admin → Licenses, and activations follow the WPistic license contract.</p>
            </>
          )}
        </Card>
      </div>
      <Toast message={toast} />
    </>
  );
}
