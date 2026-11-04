/** Account settings, security, billing, profile. */

import { useState } from "react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { Badge, Btn, Card, Field, PageHead, inputClass, Toast, useToast } from "../components/ui";

export function WorkspaceSettings() {
  const { org, orgs, setOrg, refresh } = useSession();
  const [name, setName] = useState(org?.name ?? "");
  const [toast, showToast] = useToast();
  void setOrg;
  return (
    <>
      <PageHead title="Workspace settings" sub="Names and plans for your workspaces." />
      <div className="space-y-4">
        {orgs.map((o) => (
          <Card key={o.id} className="flex items-center justify-between p-4">
            <div>
              <div className="text-sm font-bold text-navy">{o.name}</div>
              <div className="text-xs text-navy/50">your role: {o.membership_role}</div>
            </div>
            <Badge tone={o.plan === "free" ? "neutral" : "gold"}>{o.plan}</Badge>
          </Card>
        ))}
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-bold text-navy">Rename current workspace</h2>
          <div className="flex gap-2">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
            <Btn onClick={() => void (async () => {
              showToast("Workspace renames land with org PATCH for members — ask platform staff for now.");
            })()}>Save</Btn>
          </div>
        </Card>
        <Btn variant="ghost" onClick={() => void refresh()}>Refresh</Btn>
      </div>
      <Toast message={toast} />
    </>
  );
}

export function Security() {
  const { user } = useSession();
  return (
    <>
      <PageHead title="Security" sub="How your account and site keys are protected." />
      <div className="space-y-3">
        <Card className="p-4">
          <h2 className="text-sm font-bold text-navy">Sessions</h2>
          <p className="mt-1 text-sm text-navy/60">Sessions are opaque tokens in HttpOnly cookies, stored server-side with a 30-day expiry. Signing out deletes the row immediately.</p>
        </Card>
        <Card className="p-4">
          <h2 className="text-sm font-bold text-navy">Site key secrets</h2>
          <p className="mt-1 text-sm text-navy/60">Stored encrypted with AES-GCM under a deployment key; never returned by any API. Rotate keys any time in the site's WP Admin.</p>
        </Card>
        <Card className="p-4">
          <h2 className="text-sm font-bold text-navy">Password hashing</h2>
          <p className="mt-1 text-sm text-navy/60">PBKDF2-SHA256, 120,000 iterations, per-user salt. Signed in as <b>{user?.email}</b>.</p>
        </Card>
        <Card className="p-4">
          <h2 className="text-sm font-bold text-navy">Two-factor</h2>
          <p className="mt-1 text-sm text-navy/60">Platform 2FA is a coming-soon line; the flag lives in Platform admin → Settings.</p>
        </Card>
      </div>
    </>
  );
}

export function Billing() {
  const { paidUnlock, org } = useSession();
  return (
    <>
      <PageHead title="Billing" sub="Stripe is the default checkout; Paddle remains optional." />
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-navy">Current plan</div>
            <p className="text-sm text-navy/60">
              {paidUnlock.unlocked ? `Pro (${paidUnlock.plan}) on this account · workspace plan: ${org?.plan}` : "Free tier — the local bridge, 3 scheduled playbooks, 50 snapshots."}
            </p>
          </div>
          <a href="https://pay.bridgistic.app/" target="_blank" rel="noreferrer"><Btn variant="gold">{paidUnlock.unlocked ? "Add licenses" : "Upgrade"}</Btn></a>
        </div>
        <p className="mt-3 text-xs text-navy/50">7-day refund guarantee via support@wpistic.com. Prices in USD, taxes calculated at checkout.</p>
      </Card>
    </>
  );
}

export function Profile() {
  const { user } = useSession();
  return (
    <>
      <PageHead title="Profile" sub="Your account." />
      <Card className="p-5 space-y-1 text-sm">
        <div><span className="text-navy/50">Name:</span> <b>{user?.name}</b></div>
        <div><span className="text-navy/50">Email:</span> <b>{user?.email}</b></div>
        <div><span className="text-navy/50">Role:</span> <Badge tone={user?.role === "member" ? "neutral" : "gold"}>{user?.role}</Badge></div>
      </Card>
    </>
  );
}
