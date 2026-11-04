/** Session context: current user, orgs, selected org, site list for the org. */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, me as fetchMe, type Me, type SiteRow } from "./api";

interface SessionCtx {
  loading: boolean;
  user: Me["user"] | null;
  orgs: Me["orgs"];
  org: Me["orgs"][number] | null;
  setOrg: (id: string) => void;
  paidUnlock: Me["paid_unlock"];
  sites: SiteRow[];
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgIdState] = useState<string>(() => localStorage.getItem("brg_org") ?? "");

  const refresh = useCallback(async () => {
    const result = await fetchMe();
    setData(result);
    if (result && !result.orgs.some((o) => o.id === orgId) && result.orgs.length > 0) {
      setOrgIdState(result.orgs[0].id);
    }
  }, [orgId]);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const setOrg = useCallback((id: string) => {
    localStorage.setItem("brg_org", id);
    setOrgIdState(id);
  }, []);

  const org = useMemo(() => data?.orgs.find((o) => o.id === orgId) ?? data?.orgs[0] ?? null, [data, orgId]);

  const [sites, setSites] = useState<SiteRow[]>([]);
  useEffect(() => {
    let live = true;
    if (org) {
      api
        .get<{ sites: SiteRow[] }>(`/api/orgs/${org.id}/sites`)
        .then((r) => live && setSites(r.sites))
        .catch(() => live && setSites([]));
    } else {
      setSites([]);
    }
    return () => {
      live = false;
    };
  }, [org]);

  const signOut = useCallback(async () => {
    try {
      await api.post("/api/auth/signout");
    } finally {
      // A failed logout request must not leave the authenticated shell or
      // account-owned site list rendered in this tab.
      setData(null);
      setSites([]);
    }
  }, []);

  const value: SessionCtx = {
    loading,
    user: data?.user ?? null,
    orgs: data?.orgs ?? [],
    org,
    setOrg,
    paidUnlock: data?.paid_unlock ?? { unlocked: false, plan: null },
    sites,
    refresh: async () => {
      await refresh();
    },
    signOut,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}

/** The site a workspace screen targets; persisted per browser. */
export function useCurrentSite(): [SiteRow | null, (id: string) => void] {
  const { sites } = useSession();
  const [siteId, setSiteId] = useState<string>(() => localStorage.getItem("brg_site") ?? "");
  const site = sites.find((s) => s.id === siteId) ?? sites[0] ?? null;
  const setSiteIdPersist = useCallback((id: string) => {
    localStorage.setItem("brg_site", id);
    setSiteId(id);
  }, []);
  return [site, setSiteIdPersist];
}
