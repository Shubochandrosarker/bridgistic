import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.tsx";
import { loadAccount, refreshAccount, type Account } from "./lib/account.ts";
import { BridgeClient } from "./lib/api/bridge.ts";
import { useStore } from "./lib/store.tsx";
import { Approvals } from "./pages/Approvals.tsx";
import { Audit } from "./pages/Audit.tsx";
import { Database, Files, Media, Memory, Options, Playbooks, Plugins, Posts, Schedules, UsersPage, WooCommerce } from "./pages/Features.tsx";
import { Keys } from "./pages/Keys.tsx";
import { License } from "./pages/License.tsx";
import { Overview } from "./pages/Overview.tsx";
import { ComingSoon, Roadmap } from "./pages/Roadmap.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { Sites } from "./pages/Sites.tsx";
import { Snapshots } from "./pages/Snapshots.tsx";
import { Usage } from "./pages/Usage.tsx";

export function App() {
  const { mode, sites, addSite } = useStore();
  // An account session (shared cookie with the console) or a direct bridge
  // session both open the dashboard; the cache is validated against the API.
  const [account, setAccount] = useState<Account | null>(loadAccount);
  useEffect(() => {
    let live = true;
    void refreshAccount().then((a) => {
      if (live) setAccount(a);
    });
    return () => {
      live = false;
    };
  }, []);
  // Auto-pairing: the plugin pushes its dashboard key to the license server at
  // activation, and licensed sites appear here with zero manual steps.
  useEffect(() => {
    if (!account) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("https://admin.bridgistic.app/api/me/site-connections", { credentials: "include" });
        if (!res.ok) return;
        const data = (await res.json()) as { connections?: { site_url: string; key_id: string; secret: string }[] };
        for (const c of data.connections ?? []) {
          if (!live) return;
          const existing = JSON.parse(sessionStorage.getItem("bridgistic.sites.v1") ?? "[]") as { siteUrl?: string }[];
          if (existing.some((s) => s.siteUrl === c.site_url)) continue;
          const conn = { id: "pair-test", alias: new URL(c.site_url).host, siteUrl: c.site_url, keyId: c.key_id, secret: c.secret };
          try {
            await new BridgeClient(conn).siteInfo();
          } catch {
            continue; // site offline or key rotated — skip instead of blocking
          }
          if (!live) return;
          addSite({ alias: conn.alias, siteUrl: c.site_url, keyId: c.key_id, secret: c.secret });
        }
      } catch {
        // console unreachable — the manual connect flow still works
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.email]);
  const signedIn = account !== null || mode === "demo" || sites.length > 0;
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      {!signedIn && <Route path="/sites" element={<Layout />}><Route index element={<Sites />} /></Route>}
      <Route element={signedIn ? <Layout /> : <Navigate to="/sign-in" replace />}>
        <Route index element={<Overview />} />
        <Route path="sites" element={<Sites />} />
        <Route path="keys" element={<Keys />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="audit" element={<Audit />} />
        <Route path="snapshots" element={<Snapshots />} />
        <Route path="usage" element={<Usage />} />
        <Route path="posts" element={<Posts />} />
        <Route path="media" element={<Media />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="plugins" element={<Plugins />} />
        <Route path="options" element={<Options />} />
        <Route path="files" element={<Files />} />
        <Route path="database" element={<Database />} />
        <Route path="playbooks" element={<Playbooks />} />
        <Route path="schedules" element={<Schedules />} />
        <Route path="memory" element={<Memory />} />
        <Route path="woocommerce" element={<WooCommerce />} />
        <Route path="license" element={<License />} />
        <Route path="coming-soon" element={<ComingSoon />} />
        <Route path="roadmap" element={<Roadmap />} />
        <Route path="*" element={<div className="py-20 text-center"><p className="text-lg font-medium">Page not found</p></div>} />
      </Route>
    </Routes>
  );
}
