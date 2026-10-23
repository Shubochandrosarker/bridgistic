import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { BridgeClient } from "./api/bridge.ts";
import type { BridgisticClient } from "./api/client.ts";
import { DemoClient } from "./api/demo.ts";
import type { SiteConnection } from "./api/types.ts";

/**
 * Site connections live in sessionStorage and are dropped when the tab closes.
 * Each bridge call carries the key through the console relay (server-side
 * signing; the relay never stores it) because some hosts answer browser
 * preflights without CORS headers, which blocks every direct call. See
 * lib/api/bridge.ts.
 */
const KEY = "bridgistic.sites.v1";
const MODE = "bridgistic.mode.v1";
type Mode = "demo" | "live" | null;

interface Store {
  mode: Mode;
  sites: SiteConnection[];
  activeId: string | null;
  client: BridgisticClient | null;
  startDemo(): void;
  signOut(): void;
  addSite(s: Omit<SiteConnection, "id">): SiteConnection;
  removeSite(id: string): void;
  setActive(id: string): void;
}
const Ctx = createContext<Store | null>(null);
const load = (): SiteConnection[] => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? "[]"); } catch { return []; } };

export function StoreProvider({ children, initialMode }: { children: ReactNode; initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode ?? ((sessionStorage.getItem(MODE) as Mode) || null));
  const [sites, setSites] = useState<SiteConnection[]>(load);
  const [activeId, setActiveId] = useState<string | null>(() => load()[0]?.id ?? null);
  const persist = (next: SiteConnection[]) => { setSites(next); sessionStorage.setItem(KEY, JSON.stringify(next)); };

  const startDemo = useCallback(() => { setMode("demo"); sessionStorage.setItem(MODE, "demo"); }, []);
  const signOut = useCallback(() => { setMode(null); sessionStorage.clear(); setSites([]); setActiveId(null); }, []);
  const addSite = useCallback((s: Omit<SiteConnection, "id">) => {
    const site = { ...s, id: crypto.randomUUID() };
    const next = [...load(), site];
    persist(next); setActiveId(site.id); setMode("live"); sessionStorage.setItem(MODE, "live");
    return site;
  }, []);
  const removeSite = useCallback((id: string) => { const next = load().filter((s) => s.id !== id); persist(next); setActiveId(next[0]?.id ?? null); }, []);

  const client = useMemo<BridgisticClient | null>(() => {
    if (mode === "demo") return new DemoClient();
    const s = sites.find((x) => x.id === activeId);
    return s ? new BridgeClient(s) : null;
  }, [mode, sites, activeId]);

  return <Ctx.Provider value={{ mode, sites, activeId, client, startDemo, signOut, addSite, removeSite, setActive: setActiveId }}>{children}</Ctx.Provider>;
}
export function useStore() { const s = useContext(Ctx); if (!s) throw new Error("StoreProvider missing"); return s; }
