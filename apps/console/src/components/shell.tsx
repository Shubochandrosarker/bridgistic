/** Console shell: dark sidebar (zip control-plane nav), topbar, outlet. */

import { type ReactNode, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  Bot,
  Boxes,
  Building2,
  Calendar,
  ChevronDown,
  CreditCard,
  Database,
  FileClock,
  FileText,
  Files,
  Globe,
  HardDrive,
  HeartPulse,
  Home,
  Image,
  KeyRound,
  LayoutDashboard,
  Layers,
  LifeBuoy,
  Link2,
  LogOut,
  Menu,
  Package,
  Plug,
  RefreshCcw,
  Radar,
  Receipt,
  Repeat,
  ScrollText,
  Settings,
  Share2,
  Shield,
  Store,
  Users,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useSession } from "../lib/session";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const DASHBOARD_NAV: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { to: "/", label: "Overview", icon: <Home size={15} /> },
      { to: "/sites", label: "Sites", icon: <Globe size={15} /> },
      { to: "/keys", label: "Keys & scopes", icon: <KeyRound size={15} /> },
      { to: "/approvals", label: "Approvals", icon: <Shield size={15} /> },
      { to: "/audit", label: "Audit log", icon: <ScrollText size={15} /> },
      { to: "/snapshots", label: "Snapshots", icon: <FileClock size={15} /> },
      { to: "/usage", label: "Usage", icon: <Activity size={15} /> },
    ],
  },
  {
    label: "Content & site",
    items: [
      { to: "/posts", label: "Posts & pages", icon: <FileText size={15} /> },
      { to: "/media", label: "Media", icon: <Image size={15} /> },
      { to: "/users", label: "Users", icon: <Users size={15} /> },
      { to: "/plugins", label: "Plugins", icon: <Package size={15} /> },
      { to: "/options", label: "Options", icon: <Settings size={15} /> },
      { to: "/files", label: "Files", icon: <Files size={15} /> },
      { to: "/database", label: "Database", icon: <Database size={15} /> },
    ],
  },
  {
    label: "Automation",
    items: [
      { to: "/actions", label: "Actions", icon: <Zap size={15} /> },
      { to: "/automations", label: "Automations", icon: <Bot size={15} /> },
      { to: "/playbooks", label: "Playbooks", icon: <Layers size={15} /> },
      { to: "/schedules", label: "Schedules", icon: <Calendar size={15} /> },
      { to: "/memory", label: "Memory", icon: <HardDrive size={15} /> },
      { to: "/woocommerce", label: "WooCommerce", icon: <ShoppingCartIcon /> },
    ],
  },
  {
    label: "Agents",
    items: [
      { to: "/agent-hub", label: "Hub", icon: <Bot size={15} /> },
      { to: "/seo", label: "SEO", icon: <Radar size={15} /> },
      { to: "/manage-agents", label: "Management", icon: <Wrench size={15} /> },
      { to: "/update-agents", label: "Updates", icon: <RefreshCcw size={15} /> },
      { to: "/audit-agents", label: "Audit", icon: <Shield size={15} /> },
      { to: "/content-agents", label: "Content writer", icon: <FileText size={15} /> },
      { to: "/social-agents", label: "Social", icon: <Share2 size={15} /> },
      { to: "/ops-agents", label: "Operations", icon: <LifeBuoy size={15} /> },
    ],
  },
  {
    label: "Marketplace",
    items: [
      { to: "/marketplace", label: "Skills directory", icon: <Store size={15} /> },
      { to: "/installed", label: "Installed", icon: <Boxes size={15} /> },
    ],
  },
  {
    label: "Connectors",
    items: [
      { to: "/connectors/mcp", label: "MCP servers", icon: <Plug size={15} /> },
      { to: "/connectors/social", label: "Social", icon: <Share2 size={15} /> },
      { to: "/connectors/bridge", label: "WordPress bridge", icon: <Link2 size={15} /> },
    ],
  },
  {
    label: "Agency",
    items: [
      { to: "/agency/team", label: "Team", icon: <Users size={15} /> },
      { to: "/agency/bulk", label: "Bulk", icon: <Layers size={15} /> },
      { to: "/license", label: "License", icon: <KeyRound size={15} /> },
      { to: "/agency/deals", label: "LTD desk", icon: <CreditCard size={15} /> },
      { to: "/agency/roadmap", label: "Roadmap", icon: <MapIcon /> },
    ],
  },
  {
    label: "Settings",
    items: [
      { to: "/settings", label: "Workspace", icon: <Settings size={15} /> },
      { to: "/security", label: "Security", icon: <Shield size={15} /> },
      { to: "/billing", label: "Billing", icon: <CreditCard size={15} /> },
      { to: "/profile", label: "Profile", icon: <Users size={15} /> },
    ],
  },
];

function ShoppingCartIcon() {
  return <Package size={15} />;
}

function MapIcon() {
  return <FileText size={15} />;
}

export function AdminNav() {
  const groups: NavGroup[] = [
    {
      label: "Platform admin",
      items: [
        { to: "/admin", label: "Overview", icon: <LayoutDashboard size={15} /> },
        { to: "/admin/organizations", label: "Organizations", icon: <Building2 size={15} /> },
        { to: "/admin/users", label: "Users", icon: <Users size={15} /> },
        { to: "/admin/sites", label: "Sites", icon: <Globe size={15} /> },
        { to: "/admin/plans", label: "Plans", icon: <CreditCard size={15} /> },
        { to: "/admin/licenses", label: "Licenses", icon: <KeyRound size={15} /> },
        { to: "/admin/sync-logs", label: "Sync logs", icon: <ScrollText size={15} /> },
        { to: "/admin/reports", label: "Reports", icon: <Receipt size={15} /> },
        { to: "/admin/usage", label: "Usage", icon: <Activity size={15} /> },
        { to: "/admin/health", label: "System health", icon: <HeartPulse size={15} /> },
        { to: "/admin/marketplace", label: "Marketplace", icon: <Store size={15} /> },
        { to: "/admin/ai", label: "AI configuration", icon: <Bot size={15} /> },
        { to: "/admin/settings", label: "Settings", icon: <Settings size={15} /> },
      ],
    },
  ];
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-widest text-white/35">{group.label}</div>
          {group.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/admin"}
              className={({ isActive }) =>
                `mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] ${isActive ? "bg-white/10 font-semibold text-white" : "text-white/70 hover:bg-white/5 hover:text-white"}`
              }
            >
              {item.icon}
              {item.label}
            </NavLink>
          ))}
        </div>
      ))}
    </div>
  );
}

export function Shell({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, orgs, org, setOrg, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const sidebar = (
    <div className="flex h-full flex-col bg-navy text-white">
      <div className="flex items-center justify-between px-4 py-4">
        <Link to="/" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gold text-sm font-black text-navy">B</span>
          <span className="text-sm font-bold tracking-wide">Bridgistic</span>
        </Link>
        <button className="text-white/60 lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu">
          <X size={18} />
        </button>
      </div>
      {orgs.length > 0 && !admin && (
        <div className="px-3 pb-2">
          <div className="relative">
            <select
              value={org?.id ?? ""}
              onChange={(e) => setOrg(e.target.value)}
              className="w-full appearance-none rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs text-white outline-none"
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id} className="text-navy">
                  {o.name} · {o.plan}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-2.5 text-white/50" />
          </div>
        </div>
      )}
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {admin ? (
          <AdminNav />
        ) : !user ? (
          <div>
            <div className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-widest text-white/35">Marketplace</div>
            <NavLink
              to="/marketplace"
              className={({ isActive }) =>
                `mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] ${isActive ? "bg-white/10 font-semibold text-white" : "text-white/70 hover:bg-white/5 hover:text-white"}`
              }
            >
              <Store size={15} /> Skills directory
            </NavLink>
            <NavLink
              to="/signin"
              className={({ isActive }) =>
                `mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] ${isActive ? "bg-white/10 font-semibold text-white" : "text-white/70 hover:bg-white/5 hover:text-white"}`
              }
            >
              <KeyRound size={15} /> My workspace
            </NavLink>
          </div>
        ) : (
          DASHBOARD_NAV.map((group) => (
            <div key={group.label}>
              <div className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-widest text-white/35">{group.label}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    `mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] ${isActive ? "bg-white/10 font-semibold text-white" : "text-white/70 hover:bg-white/5 hover:text-white"}`
                  }
                >
                  {item.icon}
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))
        )}
      </nav>
      <div className="border-t border-white/10 px-3 py-3">
        {!user && (
          <div className="space-y-1 px-1">
            <Link to="/signin" className="block rounded-lg bg-white/10 px-3 py-1.5 text-center text-[13px] font-semibold text-white hover:bg-white/15">
              Sign in
            </Link>
            <Link to="/signup" className="block px-3 py-1 text-center text-[12px] text-white/60 hover:text-white">
              Create a free account
            </Link>
          </div>
        )}
        {user && user.role === "owner" && (
          <Link
            to={admin ? "/" : "/admin"}
            className="mb-1 flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-gold hover:bg-white/5"
          >
            <Building2 size={15} /> {admin ? "Open customer dashboard" : "Owner console"}
          </Link>
        )}
        {user && (
          <div className="flex items-center justify-between rounded-lg px-3 py-1.5">
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold text-white/90">{user.name}</div>
              <div className="truncate text-[11px] text-white/50">{user.email}</div>
            </div>
            <button
              onClick={async () => {
                await signOut();
                navigate("/signin");
              }}
              className="ml-2 text-white/50 hover:text-white"
              aria-label="Sign out"
            >
              <LogOut size={15} />
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="absolute inset-0 bg-navy/50" onClick={() => setOpen(false)} />
          <div className="relative z-10 h-full w-64">{sidebar}</div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-navy/10 bg-white px-4 py-2.5 lg:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open menu" className="text-navy">
            <Menu size={20} />
          </button>
          <span className="text-sm font-bold text-navy">Bridgistic {admin ? "Admin" : "Console"}</span>
        </header>
        <main className={`flex-1 overflow-y-auto p-4 md:p-7 ${location.pathname.startsWith("/admin") ? "" : ""}`}>
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
