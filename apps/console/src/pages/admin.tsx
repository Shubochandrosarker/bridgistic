/** Platform admin: the owner's console across every organization. */

import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, fmtDateTime } from "../lib/api";
import { Badge, Btn, Card, ErrorNote, Field, inputClass, Modal, PageHead, Spinner, Stat, Table, Td, Toast, useToast } from "../components/ui";

type Row = Record<string, unknown>;
type Rows = Row[];

function useAdminList<T>(path: string): [T[] | null, string | null, () => Promise<void>] {
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.get<{ [k: string]: T[] }>(path);
      const first = Object.values(r)[0];
      setRows((Array.isArray(first) ? first : []) as T[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed.");
      setRows([]);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return [rows, error, load];
}

export function AdminOverview() {
  const [stats, setStats] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<Row>("/api/admin/stats").then(setStats).catch((e) => setError(e instanceof Error ? e.message : "Stats failed."));
  }, []);
  if (error) return <ErrorNote error={error} />;
  if (!stats) return <Spinner />;
  const byPlan = (stats.by_plan as { plan: string; n: number }[] | undefined) ?? [];
  return (
    <>
      <PageHead title="Platform overview" sub="Everything across Bridgistic, at a glance." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Users" value={String(stats.users)} />
        <Stat label="Organizations" value={String(stats.orgs)} />
        <Stat label="Sites" value={String(stats.sites)} />
        <Stat label="Active licenses" value={String(stats.licenses_active)} />
        <Stat label="Live activations" value={String(stats.activations)} />
        <Stat label="Skills listed" value={String(stats.skills)} />
        <Stat label="Total installs" value={String(stats.installs)} />
        <Stat label="Plans" value={byPlan.map((p) => `${p.plan}:${p.n}`).join(" ") || "—"} sub="active by plan" />
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <QuickCard title="Sell" body="Stripe is the default checkout. Paddle remains optional. Issue or review licenses here." to="/admin/licenses" link="Licenses" />
        <QuickCard title="AI routing" body="Set the OpenAI-compatible endpoint, model and OpenRouter key the website agents use." to="/admin/ai" link="AI configuration" />
      </div>
    </>
  );
}

function QuickCard({ title, body, to, link }: { title: string; body: string; to: string; link: string }) {
  return (
    <Card className="p-4">
      <h2 className="text-sm font-bold text-navy">{title}</h2>
      <p className="mt-1 text-sm text-navy/60">{body}</p>
      <a href={to} className="mt-2 inline-block text-xs font-semibold text-navy underline">{link}</a>
    </Card>
  );
}

export function AdminOrgs() {
  const [orgs, error, load] = useAdminList<Row>("/api/admin/orgs");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [plan, setPlan] = useState("free");
  const [toast, showToast] = useToast();
  return (
    <>
      <PageHead title="Organizations" sub="Every customer workspace." actions={<Btn onClick={() => setOpen(true)}>Add organization</Btn>} />
      {error && <ErrorNote error={error} />}
      <Table head={["Name", "Owner", "Plan", "Status", "Sites", "Members", "Created", ""]} empty={orgs !== null && orgs.length === 0}>
        {(orgs ?? []).map((o) => (
          <tr key={String(o.id)}>
            <Td className="font-semibold">{String(o.name)}</Td>
            <Td>{String(o.owner_email ?? "—")}</Td>
            <Td><Badge tone={o.plan === "free" ? "neutral" : "gold"}>{String(o.plan)}</Badge></Td>
            <Td>
              <select
                defaultValue={String(o.status)}
                className="rounded border border-navy/15 bg-white px-1.5 py-0.5 text-xs"
                onChange={(e) => void (async () => {
                  await api.patch(`/api/admin/orgs/${String(o.id)}`, { status: e.target.value });
                  showToast("Organization updated.");
                  await load();
                })()}
              >
                <option value="active">active</option>
                <option value="suspended">suspended</option>
              </select>
            </Td>
            <Td>{String(o.site_count ?? 0)}</Td>
            <Td>{String(o.member_count ?? 0)}</Td>
            <Td>{fmtDate(String(o.created_at ?? ""))}</Td>
            <Td>
              <Btn small variant="ghost" onClick={() => void (async () => {
                const next = String(o.plan) === "free" ? "lifetime" : String(o.plan) === "lifetime" ? "monthly" : "free";
                await api.patch(`/api/admin/orgs/${String(o.id)}`, { plan: next });
                showToast(`Plan → ${next}`);
                await load();
              })()}>Cycle plan</Btn>
            </Td>
          </tr>
        ))}
      </Table>
      <Modal open={open} onClose={() => setOpen(false)} title="Add organization">
        <div className="space-y-3">
          <Field label="Name"><input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Plan">
            <select className={inputClass} value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option value="free">free</option>
              <option value="monthly">monthly</option>
              <option value="yearly">yearly</option>
              <option value="lifetime">lifetime</option>
            </select>
          </Field>
          <Btn onClick={() => void (async () => {
            await api.post("/api/admin/orgs", { name, plan });
            setOpen(false);
            setName("");
            await load();
            showToast("Organization created.");
          })()}>Create</Btn>
        </div>
      </Modal>
      <Toast message={toast} />
    </>
  );
}

export function AdminUsers() {
  const [users, error, load] = useAdminList<Row>("/api/admin/users");
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("member");
  const [toast, showToast] = useToast();
  return (
    <>
      <PageHead title="Users" sub="Every account on the platform." actions={<Btn onClick={() => setOpen(true)}>Add user</Btn>} />
      {error && <ErrorNote error={error} />}
      <Table head={["Name", "Email", "Role", "Status", "Billing", "Orgs", "Created", ""]} empty={users !== null && users.length === 0}>
        {(users ?? []).map((u) => (
          <tr key={String(u.id)}>
            <Td className="font-semibold">{String(u.name)}</Td>
            <Td>{String(u.email)}</Td>
            <Td>
              <select
                defaultValue={String(u.role)}
                className="rounded border border-navy/15 bg-white px-1.5 py-0.5 text-xs"
                onChange={(e) => void (async () => {
                  await api.patch(`/api/admin/users/${String(u.id)}`, { role: e.target.value });
                  showToast("Role updated.");
                  await load();
                })()}
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
                <option value="owner">owner</option>
              </select>
            </Td>
            <Td>
              <select
                defaultValue={String(u.status)}
                className="rounded border border-navy/15 bg-white px-1.5 py-0.5 text-xs"
                onChange={(e) => void (async () => {
                  await api.patch(`/api/admin/users/${String(u.id)}`, { status: e.target.value });
                  showToast("Status updated.");
                  await load();
                })()}
              >
                <option value="active">active</option>
                <option value="disabled">disabled</option>
              </select>
            </Td>
            <Td>
              <span
                title={u.billing_synced_at ? `Synced ${fmtDate(String(u.billing_synced_at))}` : "Not synced yet (refreshes when the user opens Billing)"}
                className={`rounded px-1.5 py-0.5 text-xs font-semibold ${String(u.billing_provider) === "stripe" ? "bg-indigo-100 text-indigo-800" : "bg-amber-100 text-amber-800"}`}
              >
                {String(u.billing_provider ?? "paddle") === "stripe" ? "Stripe" : "Paddle"}
              </span>
            </Td>
            <Td>{String(u.org_count ?? 0)}</Td>
            <Td>{fmtDate(String(u.created_at ?? ""))}</Td>
            <Td>
              <Btn small variant="danger" onClick={() => void (async () => {
                await api.patch(`/api/admin/users/${String(u.id)}`, { status: String(u.status) === "active" ? "disabled" : "active" });
                showToast("User updated.");
                await load();
              })()}>{u.status === "active" ? "Disable" : "Enable"}</Btn>
            </Td>
          </tr>
        ))}
      </Table>
      <Modal open={open} onClose={() => setOpen(false)} title="Add user">
        <div className="space-y-3">
          <Field label="Email"><input className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Name"><input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Password" hint="Leave blank to auto-generate — the temporary password is shown once.">
            <input className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Role">
            <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">member</option>
              <option value="admin">admin</option>
              <option value="owner">owner</option>
            </select>
          </Field>
          <Btn onClick={() => void (async () => {
            const r = await api.post<{ temp_password?: string }>("/api/admin/users", { email, name, password: password || undefined, role });
            setOpen(false);
            setEmail("");
            setName("");
            setPassword("");
            if (r.temp_password) showToast(`Created. Temporary password: ${r.temp_password}`);
            else showToast("User created.");
            await load();
          })()}>Create user</Btn>
        </div>
      </Modal>
      <Toast message={toast} />
    </>
  );
}

export function AdminSites() {
  const [sites, error] = useAdminList<Row>("/api/admin/sites");
  return (
    <>
      <PageHead title="Sites" sub="Every connected WordPress site." />
      {error && <ErrorNote error={error} />}
      <Table head={["Site", "Organization", "WP", "PHP", "Key", "Status", "Last seen"]} empty={sites !== null && sites.length === 0}>
        {(sites ?? []).map((s) => (
          <tr key={String(s.id)}>
            <Td>
              <div className="font-semibold">{String(s.name ?? "")}</div>
              <div className="text-xs text-navy/50">{String(s.url ?? "")}</div>
            </Td>
            <Td>{String(s.org_name ?? "")}</Td>
            <Td>{String(s.wp_version ?? "—")}</Td>
            <Td>{String(s.php_version ?? "—")}</Td>
            <Td><span className="font-mono text-xs">{String(s.key_mask ?? "")}</span></Td>
            <Td><Badge tone="good">{String(s.status ?? "")}</Badge></Td>
            <Td>{fmtDateTime(s.last_seen as string | null)}</Td>
          </tr>
        ))}
      </Table>
    </>
  );
}

export function AdminPlans() {
  const [plans, error, load] = useAdminList<Row>("/api/admin/plans");
  const [toast, showToast] = useToast();
  const save = async (slug: string, patch: Record<string, unknown>) => {
    await api.patch(`/api/admin/plans/${slug}`, patch);
    showToast("Plan saved.");
    await load();
  };
  return (
    <>
      <PageHead title="Plans" sub="Price and caps. Editing here does not charge a card." />
      {error && <ErrorNote error={error} />}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {(plans ?? []).map((p) => {
          const slug = String(p.slug);
          return (
            <Card key={slug} className="p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold capitalize text-navy">{String(p.name)}</h2>
                <Badge tone={p.status === "active" ? "good" : "neutral"}>{String(p.status)}</Badge>
              </div>
              <div className="mt-2 space-y-2 text-xs text-navy/60">
                <PlanInput label="Monthly $" value={Number(p.price_monthly ?? 0)} onSave={(v) => void save(slug, { price_monthly: v })} />
                <PlanInput label="Yearly $" value={Number(p.price_yearly ?? 0)} onSave={(v) => void save(slug, { price_yearly: v })} />
                <PlanInput label="One-time $" value={Number(p.price_onetime ?? 0)} onSave={(v) => void save(slug, { price_onetime: v })} />
                <PlanInput label="Sites max" value={Number(p.sites_max ?? 1)} onSave={(v) => void save(slug, { sites_max: v })} />
                <PlanInput label="Seats" value={Number(p.seats ?? 1)} onSave={(v) => void save(slug, { seats: v })} />
              </div>
            </Card>
          );
        })}
      </div>
      <Toast message={toast} />
    </>
  );
}

function PlanInput({ label, value, onSave }: { label: string; value: number; onSave: (v: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-20 shrink-0">{label}</span>
      <input
        className="w-full rounded border border-navy/15 px-1.5 py-0.5 text-xs"
        defaultValue={String(value)}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n) && n !== value) onSave(n);
        }}
      />
    </div>
  );
}

export function AdminLicenses() {
  const [licenses, error, load] = useAdminList<Row>("/api/admin/licenses");
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState("lifetime");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [siteLimit, setSiteLimit] = useState("1");
  const [issued, setIssued] = useState<{ key: string; plan: string; email: string } | null>(null);
  const [toast, showToast] = useToast();
  return (
    <>
      <PageHead title="Licenses" sub="Issue, cap, suspend and revoke. The full key is shown once at issuance." actions={<Btn onClick={() => setOpen(true)}>Issue license</Btn>} />
      {error && <ErrorNote error={error} />}
      <Table head={["Key", "Plan", "Status", "Owner", "Sites", "Issued", "Expires", ""]} empty={licenses !== null && licenses.length === 0}>
        {(licenses ?? []).map((l) => (
          <tr key={String(l.id)}>
            <Td className="font-mono text-xs">{String(l.key_mask ?? "")}</Td>
            <Td><Badge tone={l.plan === "lifetime" ? "gold" : "neutral"}>{String(l.plan)}</Badge></Td>
            <Td><Badge tone={l.status === "active" ? "good" : l.status === "suspended" ? "warn" : "bad"}>{String(l.status)}</Badge></Td>
            <Td>{String(l.owner_email ?? "—")}</Td>
            <Td>{String(l.active_sites ?? 0)}/{String(l.site_limit ?? 1)}</Td>
            <Td>{fmtDate(String(l.issued_at ?? ""))}</Td>
            <Td>{l.expires_at ? fmtDate(String(l.expires_at)) : "never"}</Td>
            <Td>
              <div className="flex gap-1.5">
                <Btn small variant="ghost" onClick={() => void (async () => {
                  await api.post(`/api/admin/licenses/${String(l.id)}/regenerate`);
                  showToast("Key regenerated — old activations released.");
                  await load();
                })()}>Regen</Btn>
                <Btn small variant="danger" onClick={() => void (async () => {
                  await api.patch(`/api/admin/licenses/${String(l.id)}`, { status: l.status === "revoked" ? "active" : "revoked" });
                  showToast(l.status === "revoked" ? "Restored." : "Revoked — activations released.");
                  await load();
                })()}>{l.status === "revoked" ? "Restore" : "Revoke"}</Btn>
              </div>
            </Td>
          </tr>
        ))}
      </Table>
      <Modal open={open} onClose={() => setOpen(false)} title="Issue a license">
        {issued ? (
          <div className="space-y-3">
            <p className="text-sm text-navy/70">Issued a <b>{issued.plan}</b> license for <b>{issued.email || "unassigned"}</b>. Copy the key now — it is not shown again:</p>
            <code className="block rounded-lg bg-navy p-3 text-center font-mono text-sm text-gold">{issued.key}</code>
            <Btn onClick={() => { setIssued(null); setOpen(false); void load(); }}>Done</Btn>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Plan">
              <select className={inputClass} value={plan} onChange={(e) => { setPlan(e.target.value); setSiteLimit(e.target.value === "lifetime" ? "1" : "5"); }}>
                <option value="lifetime">lifetime (AppSumo / legacy)</option>
                <option value="monthly">monthly ($12)</option>
                <option value="yearly">yearly ($99)</option>
              </select>
            </Field>
            <Field label="Owner email" hint="Where the customer will paste the key; also unlocks the paid marketplace.">
              <input className={inputClass} value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="customer@example.com" />
            </Field>
            <Field label="Site limit"><input className={inputClass} value={siteLimit} onChange={(e) => setSiteLimit(e.target.value)} /></Field>
            <Btn onClick={() => void (async () => {
              const r = await api.post<{ key: string; license: Row }>("/api/admin/licenses", {
                plan,
                owner_email: ownerEmail,
                site_limit: Number(siteLimit) || 1,
                notes: "manual issue",
                expires_at: plan === "monthly" ? new Date(Date.now() + 31 * 86400000).toISOString() : plan === "yearly" ? new Date(Date.now() + 366 * 86400000).toISOString() : null,
              });
              setIssued({ key: r.key, plan, email: ownerEmail });
              setOwnerEmail("");
            })()}>Issue</Btn>
          </div>
        )}
      </Modal>
      <Toast message={toast} />
    </>
  );
}

export function AdminSyncLogs() {
  const [logs, error] = useAdminList<Row>("/api/admin/synclogs");
  return (
    <>
      <PageHead title="Sync logs" sub="Every license activate / validate / deactivate the server handled." />
      {error && <ErrorNote error={error} />}
      <Table head={["When", "Action", "Key", "Domain", "Detail"]} empty={logs !== null && logs.length === 0}>
        {(logs ?? []).map((l) => (
          <tr key={String(l.id)}>
            <Td>{fmtDateTime(String(l.at ?? ""))}</Td>
            <Td><Badge tone={l.action === "activate" ? "good" : l.action === "deactivate" ? "warn" : "neutral"}>{String(l.action)}</Badge></Td>
            <Td className="font-mono text-xs">{String(l.key_mask ?? "")}</Td>
            <Td>{String(l.domain ?? "")}</Td>
            <Td className="text-xs text-navy/60">{String(l.detail ?? "")}</Td>
          </tr>
        ))}
      </Table>
    </>
  );
}

export function AdminReports() {
  const [stats, setStats] = useState<Row | null>(null);
  useEffect(() => {
    api.get<Row>("/api/admin/stats").then(setStats).catch(() => setStats({}));
  }, []);
  if (!stats) return <Spinner />;
  return (
    <>
      <PageHead title="Reports" sub="Commercial snapshot from the ledger." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Lifetime value sold" value={`$${(((Number(stats.licenses_active) || 0) * 69)).toFixed(2)}`} sub="at LTD price" />
        <Stat label="Active licenses" value={String(stats.licenses_active)} />
        <Stat label="Marketplace installs" value={String(stats.installs)} />
        <Stat label="Skills" value={String(stats.skills)} />
      </div>
      <Card className="mt-4 p-4 text-sm text-navy/60">
        Stripe is the default gateway for new checkout flows. Paddle remains available for customers who choose it; both providers feed the same license ledger.
      </Card>
    </>
  );
}

export function AdminUsage() {
  const [logs, error] = useAdminList<Row>("/api/admin/audit");
  const counts = new Map<string, number>();
  for (const row of logs ?? []) {
    const action = String(row.action ?? "");
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  return (
    <>
      <PageHead title="Usage" sub="Platform action counts from the audit log." />
      {error && <ErrorNote error={error} />}
      <Table head={["Action", "Events"]}>
        {top.map(([action, n]) => (
          <tr key={action}>
            <Td className="font-mono text-xs">{action}</Td>
            <Td>{n}</Td>
          </tr>
        ))}
      </Table>
    </>
  );
}

export function AdminHealth() {
  const [health, setHealth] = useState<"up" | "down" | "checking">("checking");
  useEffect(() => {
    api.get("/api/health").then(() => setHealth("up")).catch(() => setHealth("down"));
  }, []);
  return (
    <>
      <PageHead title="System health" sub="Console API and dependencies." />
      <div className="grid gap-3 md:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs font-semibold uppercase text-navy/50">Console API</div>
          <div className="mt-1 text-lg font-bold"><Badge tone={health === "up" ? "good" : health === "down" ? "bad" : "neutral"}>{health}</Badge></div>
        </Card>
        <Card className="p-4">
          <div className="text-xs font-semibold uppercase text-navy/50">Database</div>
          <div className="mt-1"><Badge tone={health === "up" ? "good" : "neutral"}>{health === "up" ? "D1 reachable" : "unknown"}</Badge></div>
        </Card>
        <Card className="p-4">
          <div className="text-xs font-semibold uppercase text-navy/50">License server</div>
          <div className="mt-1"><Badge tone={health === "up" ? "good" : "neutral"}>{health === "up" ? "issuing on this deployment" : "unknown"}</Badge></div>
        </Card>
      </div>
      <Card className="mt-4 p-4 text-sm text-navy/60">
        The marketing site, dashboard, pay page and MCP endpoint are separate deployments; their status pages stay on their own dashboards.
      </Card>
    </>
  );
}

export function AdminMarketplace() {
  const [items, error, load] = useAdminList<Row>("/api/market/items");
  const [toast, showToast] = useToast();
  return (
    <>
      <PageHead title="Marketplace" sub="Flip a pack between free and Pro; installs update instantly." />
      {error && <ErrorNote error={error} />}
      <Table head={["Skill", "Tier", "Installs", ""]} empty={items !== null && items.length === 0}>
        {(items ?? []).map((s) => (
          <tr key={String(s.slug)}>
            <Td>
              <div className="font-semibold">{String(s.name)}</div>
              <div className="truncate text-xs text-navy/50">{String(s.description).slice(0, 90)}</div>
            </Td>
            <Td><Badge tone={s.tier === "paid" ? "gold" : "good"}>{String(s.tier)}</Badge></Td>
            <Td>{String(s.installs ?? 0)}</Td>
            <Td>
              <Btn small variant="ghost" onClick={() => void (async () => {
                showToast("Tier flips are a listing-editor action — edit the skills table tier column, then refresh.");
              })()}>View</Btn>
            </Td>
          </tr>
        ))}
      </Table>
      <Toast message={toast} />
      <Btn className="mt-3" variant="ghost" onClick={() => void load()}>Refresh</Btn>
    </>
  );
}

export function AdminAi() {
  const [ai, setAi] = useState<{ provider_order: string[]; openai_model: string; key_set: boolean; key_mask: string | null } | null>(null);
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [toast, showToast] = useToast();
  useEffect(() => {
    api.get<{ ai: typeof ai }>("/api/admin/ai").then((r) => {
      setAi(r.ai);
      setModel(r.ai?.openai_model ?? "");
    });
  }, []);
  if (!ai) return <Spinner />;
  return (
    <>
      <PageHead title="AI configuration" sub="Fixed provider order; keys are never stored in the browser." />
      <div className="max-w-xl space-y-4">
        <Card className="p-4">
          <Field label="Model (OpenRouter slug)" hint="Used by the website agents, e.g. openai/gpt-4o-mini.">
            <input className={inputClass} value={model} onChange={(e) => setModel(e.target.value)} />
          </Field>
          <Field label="Provider API key" hint={ai.key_set ? `A key is set (${ai.key_mask}). Paste a new one to replace it.` : "Paste an OpenRouter key (sk-or-v1-…). Stored server-side only."}>
            <input className={inputClass} type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={ai.key_set ? "•••••••• (unchanged)" : "sk-or-v1-…"} />
          </Field>
          <Btn className="mt-3" onClick={() => void (async () => {
            await api.put("/api/admin/ai", { openai_model: model, ...(key ? { openrouter_key: key } : {}) });
            setKey("");
            const r = await api.get<{ ai: typeof ai }>("/api/admin/ai");
            setAi(r.ai);
            showToast("AI configuration saved.");
          })()}>Save</Btn>
        </Card>
        <Card className="p-4 text-xs text-navy/60">
          <div className="mb-1 font-bold text-navy">Routing order</div>
          <ol className="list-inside list-decimal space-y-0.5">
            {(ai.provider_order ?? []).map((p, i) => <li key={i}>{p}</li>)}
          </ol>
        </Card>
      </div>
      <Toast message={toast} />
    </>
  );
}

export function AdminSettings() {
  const [settings, setSettings] = useState<Row | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [toast, showToast] = useToast();
  useEffect(() => {
    api.get<{ settings: Row }>("/api/admin/settings").then((r) => {
      setSettings(r.settings);
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.settings)) flat[k] = v === null || v === undefined ? "" : String(v);
      setForm(flat);
    });
  }, []);
  if (!settings) return <Spinner />;
  const fields: [string, string][] = [
    ["support_email", "Support contact"],
    ["timezone", "Timezone"],
    ["billing_email", "Billing mail"],
    ["sync_email", "Sync mail"],
    ["default_site_limit", "Default site limit"],
    ["session_days", "Session length (days)"],
    ["maintenance_mode", "Maintenance mode (on/off)"],
  ];
  return (
    <>
      <PageHead title="Settings" sub="Platform-wide configuration." />
      <div className="max-w-xl space-y-3">
        <Card className="p-4 space-y-3">
          {fields.map(([key, label]) => (
            <Field key={key} label={label}>
              <input className={inputClass} value={form[key] ?? ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
            </Field>
          ))}
          <Btn onClick={() => void (async () => {
            await api.put("/api/admin/settings", form);
            showToast("Settings saved.");
          })()}>Save settings</Btn>
        </Card>
      </div>
      <Toast message={toast} />
    </>
  );
}
