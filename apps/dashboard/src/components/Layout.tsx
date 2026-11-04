import { AnimatePresence, motion } from "framer-motion";
import { LogOut, Menu, UserRound, X } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useStore } from "../lib/store.tsx";
import { NAV } from "./nav.ts";

export function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <span className={`flex items-center gap-2 font-semibold tracking-tight ${dark ? "text-ivory" : "text-navy"}`}>
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden><rect width="32" height="32" rx="8" fill={dark ? "#F4F1EA" : "#0B1F3A"} /><path d="M6 21c4-8 16-8 20 0" stroke="#C6A15B" strokeWidth="2.4" fill="none" strokeLinecap="round" /><path d="M9 21v-4M16 21v-6M23 21v-4" stroke={dark ? "#0B1F3A" : "#F4F1EA"} strokeWidth="2" strokeLinecap="round" /></svg>
      Bridgistic
    </span>
  );
}

export function DemoBanner() {
  return (
    <div role="note" className="sticky top-0 z-30 flex items-center justify-center gap-2 bg-gold px-4 py-1.5 text-center text-xs font-medium text-navy">
      Demo data. Every number on these screens is sample data, not from a real site.
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { signOut, mode, account } = useStore();
  const handleSignOut = () => {
    void signOut();
  };
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-6 overflow-y-auto bg-navy px-4 py-6 text-ivory">
      <div className="px-2"><Logo dark /><p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-ivory/45">MCP Server dashboard</p></div>
      {NAV.map((g) => (
        <div key={g.group}>
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-ivory/40">{g.group}</p>
          <ul className="space-y-0.5">
            {g.items.map(({ to, label, icon: Icon, soon, href }) => (
              <li key={href ?? to}>
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer" onClick={onNavigate}
                    className="group relative flex items-center gap-3 rounded-xl px-2 py-2 text-sm transition text-ivory/70 hover:bg-white/5 hover:text-ivory">
                    <Icon className="h-4 w-4" aria-hidden />{label}
                  </a>
                ) : (
                  <NavLink to={to} end={to === "/"} onClick={onNavigate}
                    className={({ isActive }) => `group relative flex items-center gap-3 rounded-xl px-2 py-2 text-sm transition ${isActive ? "bg-white/10 text-ivory" : "text-ivory/70 hover:bg-white/5 hover:text-ivory"}`}>
                    {({ isActive }) => (<>
                      {isActive && <motion.span layoutId="nav-active" className="absolute left-0 top-1.5 h-6 w-0.5 rounded bg-gold" />}
                      <Icon className="h-4 w-4" aria-hidden />{label}
                      {soon && <span className="ml-auto rounded-full bg-gold/20 px-1.5 text-[10px] text-gold">soon</span>}
                    </>)}
                  </NavLink>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {account ? (
        <div className="mt-auto space-y-1 border-t border-white/10 px-2 pt-4">
          {account.role === "owner" && (
            <a href="https://admin.bridgistic.app/admin" className="flex items-center gap-2 rounded-xl px-2 py-2 text-sm text-gold hover:bg-white/5">
              <UserRound className="h-4 w-4" aria-hidden />Owner console
            </a>
          )}
          <div className="px-2">
            <p className="truncate text-xs font-semibold text-ivory/90">{account.name || account.email}</p>
            <p className="truncate text-[11px] text-ivory/50">{account.email}</p>
          </div>
        </div>
      ) : (
        <a href="https://admin.bridgistic.app/signin" className="mt-auto flex items-center gap-2 rounded-xl px-2 py-2 text-sm text-ivory/60 hover:text-ivory">
          <UserRound className="h-4 w-4" aria-hidden />Sign in to Bridgistic
        </a>
      )}
      <button onClick={handleSignOut} className="flex items-center gap-2 rounded-xl px-2 py-2 text-sm text-ivory/60 hover:text-ivory">
        <LogOut className="h-4 w-4" aria-hidden />{mode === "demo" ? "Leave demo" : "Sign out"}
      </button>
    </nav>
  );
}

export function Layout() {
  const { mode } = useStore();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  return (
    <div className="min-h-screen bg-ivory">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-2">Skip to content</a>
      {mode === "demo" && <DemoBanner />}
      <div className="flex">
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 lg:block"><Sidebar /></aside>
        <AnimatePresence>
          {open && (
            <motion.div className="fixed inset-0 z-40 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="absolute inset-0 bg-navy/50" onClick={() => setOpen(false)} />
              <motion.aside initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }} className="absolute inset-y-0 left-0 w-64">
                <button aria-label="Close menu" onClick={() => setOpen(false)} className="absolute right-3 top-5 z-10 text-ivory"><X className="h-5 w-5" /></button>
                <Sidebar onNavigate={() => setOpen(false)} />
              </motion.aside>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 border-b border-navy/10 bg-ivory/80 px-4 py-3 backdrop-blur lg:hidden">
            <button aria-label="Open menu" onClick={() => setOpen(true)}><Menu className="h-5 w-5" /></button><Logo />
          </div>
          <main id="main" className="mx-auto max-w-7xl px-4 py-8 sm:px-8">
            <motion.div key={loc.pathname} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
              <Outlet />
            </motion.div>
          </main>
        </div>
      </div>
    </div>
  );
}
