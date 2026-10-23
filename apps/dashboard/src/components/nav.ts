import { Activity, Archive, BookOpen, Boxes, CalendarClock, Database, FileText, FolderTree, Gauge, Globe, Image, KeyRound, LayoutDashboard, ListChecks, Map, Puzzle, ScrollText, Settings2, ShieldCheck, ShoppingBag, Sparkles, Users, Brain, type LucideIcon } from "lucide-react";

export interface NavItem { to: string; label: string; icon: LucideIcon; soon?: boolean; href?: string }
export const NAV: { group: string; items: NavItem[] }[] = [
  { group: "Workspace", items: [
    { to: "/", label: "Overview", icon: LayoutDashboard },
    { to: "/sites", label: "Sites", icon: Globe },
    { to: "/keys", label: "Keys & scopes", icon: KeyRound },
    { to: "/approvals", label: "Approvals", icon: ListChecks },
    { to: "/audit", label: "Audit log", icon: ScrollText },
    { to: "/snapshots", label: "Snapshots", icon: Archive },
    { to: "/usage", label: "Usage", icon: Gauge },
  ]},
  { group: "Content & site", items: [
    { to: "/posts", label: "Posts & pages", icon: FileText },
    { to: "/media", label: "Media", icon: Image },
    { to: "/users", label: "Users", icon: Users },
    { to: "/plugins", label: "Plugins", icon: Puzzle },
    { to: "/options", label: "Options", icon: Settings2 },
    { to: "/files", label: "Files", icon: FolderTree },
    { to: "/database", label: "Database", icon: Database },
  ]},
  { group: "Automation", items: [
    { to: "/playbooks", label: "Playbooks", icon: BookOpen },
    { to: "/schedules", label: "Schedules", icon: CalendarClock },
    { to: "/memory", label: "Memory", icon: Brain },
    { to: "/woocommerce", label: "WooCommerce", icon: ShoppingBag },
  ]},
  { group: "Account", items: [
    { to: "/license", label: "License", icon: ShieldCheck },
    { to: "/marketplace", label: "Skills marketplace", icon: Boxes, href: "https://marketplace.bridgistic.app/" },
    { to: "/roadmap", label: "Roadmap", icon: Map },
  ]},
];
export { Activity, Boxes };
