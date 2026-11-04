/** Agency screens: team, bulk, LTD desk, roadmap. */

import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { Badge, Btn, Card, ErrorNote, Field, inputClass, Modal, PageHead, Table, Td, Toast, useToast } from "../components/ui";

export function AgencyTeam() {
  const { org } = useSession();
  const [team, setTeam] = useState<{ id: string; email: string; name: string; role: string; status: string }[] | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [error, setError] = useState<string | null>(null);
  const [toast, showToast] = useToast();

  const load = useCallback(async () => {
    if (!org) return;
    try {
      const r = await api.get<{ team: typeof team }>(`/api/orgs/${org.id}/team`);
      setTeam(r.team ?? []);
    } catch {
      setTeam([]);
    }
  }, [org]);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!org) return;
    setError(null);
    try {
      await api.post(`/api/orgs/${org.id}/team`, { email, member_role: role });
      setOpen(false);
      setEmail("");
      await load();
      showToast("Teammate added.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the teammate.");
    }
  };

  return (
    <>
      <PageHead title="Team" sub="People who can operate this workspace." actions={<Btn onClick={() => setOpen(true)}>Add teammate</Btn>} />
      <Table head={["Name", "Email", "Role", "Status"]} empty={team !== null && team.length === 0}>
        {(team ?? []).map((m) => (
          <tr key={m.id}>
            <Td className="font-semibold">{m.name}</Td>
            <Td>{m.email}</Td>
            <Td><Badge tone={m.role === "owner" ? "gold" : "neutral"}>{m.role}</Badge></Td>
            <Td><Badge tone={m.status === "active" ? "good" : "bad"}>{m.status}</Badge></Td>
          </tr>
        ))}
      </Table>
      <Modal open={open} onClose={() => setOpen(false)} title="Add a teammate">
        <div className="space-y-4">
          <ErrorNote error={error} />
          <Field label="Their Bridgistic account email" hint="They need an account first — invite them to sign up free.">
            <input className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" />
          </Field>
          <Field label="Role">
            <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="viewer">Viewer — read-only</option>
              <option value="approver">Approver — can decide the queue</option>
              <option value="operator">Operator — can run actions</option>
            </select>
          </Field>
          <Btn onClick={add} disabled={!email}>Add</Btn>
        </div>
      </Modal>
      <Toast message={toast} />
    </>
  );
}

export function AgencyBulk() {
  const { sites } = useSession();
  return (
    <>
      <PageHead title="Bulk" sub="One action across many sites." />
      <Card className="p-6 text-center text-sm text-navy/60">
        Bulk operations across {sites.length} connected site{sites.length === 1 ? "" : "s"} ship with the agency tier. Queue a playbook per site today from Playbooks, or use Schedules to stagger the work.
      </Card>
    </>
  );
}

export function AgencyDeals() {
  return (
    <>
      <PageHead title="LTD desk" sub="The Lifetime Deal: $69 one time, 1 site, all future updates, limited time offer." />
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-5">
          <Badge tone="gold">Lifetime</Badge>
          <div className="mt-2 text-2xl font-bold text-navy">$69</div>
          <p className="text-sm text-navy/60">one payment · 1 website · the three shipped license gates</p>
          <a href="https://pay.bridgistic.app/" target="_blank" rel="noreferrer"><Btn variant="gold" className="mt-3">Buy the LTD</Btn></a>
        </Card>
        <Card className="p-5">
          <Badge tone="neutral">Monthly</Badge>
          <div className="mt-2 text-2xl font-bold text-navy">$12<span className="text-sm font-normal">/mo</span></div>
          <p className="text-sm text-navy/60">1 license · 3 sites · subscription</p>
        </Card>
        <Card className="p-5">
          <Badge tone="neutral">Yearly</Badge>
          <div className="mt-2 text-2xl font-bold text-navy">$99<span className="text-sm font-normal">/yr</span></div>
          <p className="text-sm text-navy/60">1 license · 3 sites · subscription</p>
        </Card>
      </div>
      <Card className="mt-4 p-4 text-xs text-navy/50">
        White-label and Cloud Agent credits are excluded from the lifetime deal. 14-day refund guarantee via support@wpistic.com.
      </Card>
    </>
  );
}

export function Roadmap() {
  const items = [
    ["Shipped", "Signed bridge, approvals, snapshots, audit, playbooks, schedules, Woo, license gates"],
    ["Shipped", "Console: accounts, workspaces, marketplace (100 free / 62 Pro packs), platform admin"],
    ["Next", "Hosted execution: api.bridgistic.app write routes and the managed scheduler"],
    ["Next", "Bulk agency operations and white-label"],
    ["Later", "Cloud Agent credits and social publishing"],
  ];
  return (
    <>
      <PageHead title="Roadmap" sub="What shipped and what is next." />
      <div className="space-y-2">
        {items.map(([phase, text]) => (
          <Card key={text} className="flex items-center gap-3 p-4">
            <Badge tone={phase === "Shipped" ? "good" : phase === "Next" ? "warn" : "neutral"}>{phase}</Badge>
            <span className="text-sm text-navy/80">{text}</span>
          </Card>
        ))}
      </div>
    </>
  );
}
