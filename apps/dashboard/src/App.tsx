import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.tsx";
import { usePairedSitesSync } from "./lib/sites-sync.ts";
import { useStore } from "./lib/store.tsx";
import { Approvals } from "./pages/Approvals.tsx";
import { Audit } from "./pages/Audit.tsx";
import { Billing } from "./pages/Billing.tsx";
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
  const { mode, sites, account, syncPairedSites } = useStore();

  // Auto-pairing: the plugin pushes its dashboard key to the license server at
  // activation, and licensed sites appear here with zero manual steps.
  usePairedSitesSync(account !== null && mode !== "demo", syncPairedSites);

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
        <Route path="billing" element={<Billing />} />
        <Route path="coming-soon" element={<ComingSoon />} />
        <Route path="roadmap" element={<Roadmap />} />
        <Route path="*" element={<div className="py-20 text-center"><p className="text-lg font-medium">Page not found</p></div>} />
      </Route>
    </Routes>
  );
}
