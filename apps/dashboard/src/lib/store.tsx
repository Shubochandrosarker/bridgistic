import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BridgeClient } from "./api/bridge.ts";
import type { BridgisticClient } from "./api/client.ts";
import { DemoClient } from "./api/demo.ts";
import { loadAccount, refreshAccount, signOutAccount, type Account } from "./account.ts";
import type { SiteConnection } from "./api/types.ts";

/**
 * Site connections live in sessionStorage and are dropped when the tab closes.
 * Each bridge call carries the key through the console relay (server-side
 * signing; the relay never stores it) because some hosts answer browser
 * preflights without CORS headers, which blocks every direct call. See
 * lib/api/bridge.ts.
 *
 * The signed-in account lives here (not in a leaf component) so signing out
 * re-renders the router and lands on /sign-in immediately.
 */
const KEY = "bridgistic.sites.v1";
const MODE = "bridgistic.mode.v1";
type Mode = "demo" | "live" | null;

interface Store {
  mode: Mode;
  sites: SiteConnection[];
  activeId: string | null;
  client: BridgisticClient | null;
  account: Account | null;
  startDemo(): void;
  signOut(): Promise<void>;
  addSite(s: Omit<SiteConnection, "id">): SiteConnection;
  removeSite(id: string): void;
  /** Replace every paired site with the server's current list (manual sites untouched). */
  syncPairedSites(paired: Omit<SiteConnection, "id">[]): void;
  setActive(id: string): void;
}
const Ctx = createContext<Store | null>(null);
const load = (): SiteConnection[] => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? "[]"); } catch { return []; } };

export function StoreProvider({ children, initialMode }: { children: ReactNode; initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode ?? ((sessionStorage.getItem(MODE) as Mode) || null));
  const [sites, setSites] = useState<SiteConnection[]>(load);
  const [activeId, setActiveId] = useState<string | null>(() => load()[0]?.id ?? null);
  const [account, setAccount] = useState<Account | null>(loadAccount);
  const persist = (next: SiteConnection[]) => { setSites(next); sessionStorage.setItem(KEY, JSON.stringify(next)); };

  useEffect(() => {
    let live = true;
    void refreshAccount().then((a) => {
      if (live) setAccount(a);
    });
    return () => { live = false; };
  }, []);

  const startDemo = useCallback(() => { setMode("demo"); sessionStorage.setItem(MODE, "demo"); }, []);
  const signOut = useCallback(async () => {
    try {
      await signOutAccount();
    } finally {
      // Even when the network call fails or times out, the local session must
      // clear and the browser must leave the dashboard. This runs first in the
      // finally block so a thrown error can never strand the user here.
      setAccount(null);
      setMode(null);
      sessionStorage.clear();
      setSites([]);
      setActiveId(null);
      // Hard navigation guarantees no stale route state keeps the shell alive.
      window.location.assign("/sign-in");
    }
  }, []);
  const addSite = useCallback((s: Omit<SiteConnection, "id">) => {
    const site = { ...s, id: crypto.randomUUID() };
    const next = [...load(), site];
    persist(next); setActiveId(site.id); setMode("live"); sessionStorage.setItem(MODE, "live");
    return site;
  }, []);
  const removeSite = useCallback((id: string) => { const next = load().filter((s) => s.id !== id); persist(next); setActiveId(next[0]?.id ?? null); }, []);
  const syncPairedSites = useCallback((paired: Omit<SiteConnection, "id">[]) => {
    const current = load();
    const next = mergePairedSites(current, paired);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    persist(next);
    setActiveId((a) => (a && next.some((s) => s.id === a) ? a : next[0]?.id ?? null));
    if (next.length) { setMode((m) => m ?? "live"); if (!sessionStorage.getItem(MODE)) sessionStorage.setItem(MODE, "live"); }
  }, []);

  const client = useMemo<BridgisticClient | null>(() => {
    if (mode === "demo") return new DemoClient();
    const s = sites.find((x) => x.id === activeId);
    return s ? new BridgeClient(s) : null;
  }, [mode, sites, activeId]);

  return <Ctx.Provider value={{ mode, sites, activeId, client, account, startDemo, signOut, addSite, removeSite, syncPairedSites, setActive: setActiveId }}>{children}</Ctx.Provider>;
}
/** Paired sites keep a stable id (the activation id); manual sites are kept as they are. */
export function mergePairedSites(current: SiteConnection[], paired: Omit<SiteConnection, "id">[]): SiteConnection[] {
  const manual = current.filter((s) => !s.pairedSiteId);
  const prev = new Map(current.filter((s) => s.pairedSiteId).map((s) => [s.pairedSiteId, s]));
  const fromServer = paired.map((p) => ({ ...p, id: `paired:${p.pairedSiteId}`, alias: prev.get(p.pairedSiteId)?.alias ?? p.alias, secret: "" }));
  // A manual connection to the same URL is superseded by the paired one.
  const urls = new Set(fromServer.map((p) => p.siteUrl));
  return [...fromServer, ...manual.filter((m) => !urls.has(m.siteUrl))];
}

export function useStore() { const s = useContext(Ctx); if (!s) throw new Error("StoreProvider missing"); return s; }
