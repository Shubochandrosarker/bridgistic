import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { SessionProvider, useSession } from "./lib/session";
import { Shell } from "./components/shell";
import { Spinner } from "./components/ui";
import { dashboardUrlFor, isMarketplaceHost } from "./lib/hosts";
import { SignIn, SignUp } from "./pages/auth";
import { Overview, Sites, Keys, Approvals, AuditLog, Snapshots, Usage, LicensePage } from "./pages/workspace";
import { Posts, Media, SiteUsers, Plugins, Options, FilesScreen, DatabaseScreen } from "./pages/content";
import { Playbooks, Schedules, Memory, WooCommerce } from "./pages/automation";
import { AgentHub, AgentPage } from "./pages/agents";
import { MarketDirectory, ProHub, SkillDetail } from "./pages/marketplace";
import { InstallGuide } from "./pages/install-guide";
import { Installed } from "./pages/installed";
import { Connectors, Social, Bridge } from "./pages/connectors";
import { AgencyTeam, AgencyBulk, AgencyDeals, Roadmap } from "./pages/agency";
import { WorkspaceSettings, Security, Billing, Profile } from "./pages/settings";
import {
  AdminOverview,
  AdminOrgs,
  AdminUsers,
  AdminSites,
  AdminPlans,
  AdminLicenses,
  AdminSyncLogs,
  AdminReports,
  AdminUsage,
  AdminHealth,
  AdminMarketplace,
  AdminAi,
  AdminSettings,
} from "./pages/admin";


function HostTitle() {
  useEffect(() => {
    document.title = isMarketplaceHost(window.location.hostname) ? "Bridgistic Skills" : "Bridgistic Console";
  }, []);
  return null;
}

function RedirectToDashboard({ suffix }: { suffix?: string }) {
  const location = useLocation();
  const target = suffix
    ? dashboardUrlFor(suffix, location.search, location.hash)
    : dashboardUrlFor(location.pathname, location.search, location.hash);
  useEffect(() => {
    window.location.replace(target);
  }, [target]);
  return <Spinner label="Taking you to your dashboard…" />;
}

function RequireAuth({ children, staff = false }: { children: React.ReactNode; staff?: boolean }) {
  const { loading, user } = useSession();
  const location = useLocation();
  if (loading) return <Spinner label="Loading your workspace…" />;
  if (!user) return <Navigate to="/signin" state={{ from: location.pathname }} replace />;
  if (staff && user.role !== "owner") return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** On the marketplace host the root is the public directory; for platform
 * staff the root is the master dashboard; members are sent to the member
 * dashboard host — the admin console is staff-only. */
function RootRoute() {
  const { user } = useSession();
  if (window.location.hostname.startsWith("marketplace")) return <MarketDirectory />;
  if (user && user.role !== "owner") {
    window.location.replace("https://dashboard.bridgistic.app/");
    return <Spinner label="Taking you to your dashboard…" />;
  }
  if (user) return <Navigate to="/admin" replace />;
  return (
    <RequireAuth>
      <Shell>
        <Overview />
      </Shell>
    </RequireAuth>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <HostTitle />
      <Routes>
        <Route path="/signin" element={isMarketplaceHost(window.location.hostname) ? <RedirectToDashboard suffix="/sign-in" /> : <SignIn />} />
        <Route path="/signup" element={isMarketplaceHost(window.location.hostname) ? <RedirectToDashboard suffix="/sign-in" /> : <SignUp />} />
        {/* Public marketplace — anonymous visitors browse; gated actions ask for an account. */}
        <Route path="/marketplace" element={<MarketDirectory />} />
        <Route path="/pro" element={<ProHub />} />
        <Route path="/install-guide" element={<InstallGuide />} />
        <Route path="/docs/install" element={<InstallGuide />} />
        <Route path="/marketplace/:handle/:slug" element={<SkillDetail />} />
        <Route path="/marketplace/:slug" element={<SkillDetail />} />
        <Route path="/" element={<RootRoute />} />
        <Route
          path="*"
          element={
            isMarketplaceHost(window.location.hostname) ? (
              <RedirectToDashboard />
            ) : (
            <RequireAuth>
              <Shell>
                <Routes>
                  <Route path="/sites" element={<Sites />} />
                  <Route path="/keys" element={<Keys />} />
                  <Route path="/approvals" element={<Approvals />} />
                  <Route path="/audit" element={<AuditLog />} />
                  <Route path="/snapshots" element={<Snapshots />} />
                  <Route path="/usage" element={<Usage />} />
                  <Route path="/license" element={<LicensePage />} />
                  <Route path="/posts" element={<Posts />} />
                  <Route path="/media" element={<Media />} />
                  <Route path="/users" element={<SiteUsers />} />
                  <Route path="/plugins" element={<Plugins />} />
                  <Route path="/options" element={<Options />} />
                  <Route path="/files" element={<FilesScreen />} />
                  <Route path="/database" element={<DatabaseScreen />} />
                  <Route path="/playbooks" element={<Playbooks />} />
                  <Route path="/schedules" element={<Schedules />} />
                  <Route path="/memory" element={<Memory />} />
                  <Route path="/woocommerce" element={<WooCommerce />} />
                  <Route path="/agent-hub" element={<AgentHub />} />
                  <Route path="/seo" element={<AgentPage kind="seo" />} />
                  <Route path="/manage-agents" element={<AgentPage kind="manage" />} />
                  <Route path="/update-agents" element={<AgentPage kind="updates" />} />
                  <Route path="/audit-agents" element={<AgentPage kind="audit" />} />
                  <Route path="/content-agents" element={<AgentPage kind="content" />} />
                  <Route path="/social-agents" element={<AgentPage kind="social" />} />
                  <Route path="/ops-agents" element={<AgentPage kind="ops" />} />
                  <Route path="/installed" element={<Installed />} />
                  <Route path="/connectors" element={<Connectors />} />
                  <Route path="/connectors/mcp" element={<Connectors />} />
                  <Route path="/connectors/social" element={<Social />} />
                  <Route path="/connectors/bridge" element={<Bridge />} />
                  <Route path="/agency/team" element={<AgencyTeam />} />
                  <Route path="/agency/bulk" element={<AgencyBulk />} />
                  <Route path="/agency/deals" element={<AgencyDeals />} />
                  <Route path="/agency/roadmap" element={<Roadmap />} />
                  <Route path="/settings" element={<WorkspaceSettings />} />
                  <Route path="/security" element={<Security />} />
                  <Route path="/billing" element={<Billing />} />
                  <Route path="/profile" element={<Profile />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Shell>
            </RequireAuth>
            )
          }
        />
        <Route
          path="/admin/*"
          element={
            <RequireAuth staff>
              <Shell admin>
                <Routes>
                  <Route path="/" element={<AdminOverview />} />
                  <Route path="/organizations" element={<AdminOrgs />} />
                  <Route path="/users" element={<AdminUsers />} />
                  <Route path="/sites" element={<AdminSites />} />
                  <Route path="/plans" element={<AdminPlans />} />
                  <Route path="/licenses" element={<AdminLicenses />} />
                  <Route path="/sync-logs" element={<AdminSyncLogs />} />
                  <Route path="/reports" element={<AdminReports />} />
                  <Route path="/usage" element={<AdminUsage />} />
                  <Route path="/health" element={<AdminHealth />} />
                  <Route path="/marketplace" element={<AdminMarketplace />} />
                  <Route path="/ai" element={<AdminAi />} />
                  <Route path="/settings" element={<AdminSettings />} />
                </Routes>
              </Shell>
            </RequireAuth>
          }
        />
      </Routes>
    </SessionProvider>
  );
}
