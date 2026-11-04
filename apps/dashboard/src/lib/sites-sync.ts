import { useEffect, useRef } from "react";
import { ACCOUNT_URL } from "./config.ts";
import type { PairedSiteStatus, SiteConnection } from "./api/types.ts";

/** One row of GET /api/me/sites (the console merges api.wpistic.com activations with pairings). */
export interface MySite {
  id: string; site_url: string; domain: string; status: PairedSiteStatus; plan: string;
  license_mask: string; paired: boolean; key_id: string | null; last_validated_at: string | null;
}

export const SITES_REFRESH_MS = 60_000;

/** Every site on the account's licenses, mapped to dashboard connections (no secrets). */
export async function fetchPairedSites(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<Omit<SiteConnection, "id">[] | null> {
  const res = await fetchImpl(`${ACCOUNT_URL}/api/me/sites`, { credentials: "include", cache: "no-store" });
  if (!res.ok) return null;
  const data = (await res.json()) as { sites?: MySite[] };
  return (data.sites ?? []).map((s) => ({
    alias: s.domain || hostOf(s.site_url),
    siteUrl: s.site_url,
    keyId: s.key_id ?? "",
    secret: "",
    pairedSiteId: s.id,
    status: s.paired || s.status !== "activated" ? s.status : "activated",
    plan: s.plan,
    licenseMask: s.license_mask,
    lastValidatedAt: s.last_validated_at,
  }));
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/**
 * Keep the site list live: fetch on sign-in, whenever the tab regains focus or
 * becomes visible, and every minute while open — so activating or deactivating
 * in WP Admin shows up without a reload.
 */
export function usePairedSitesSync(enabled: boolean, sync: (paired: Omit<SiteConnection, "id">[]) => void, fetchImpl?: typeof fetch): void {
  const syncRef = useRef(sync);
  syncRef.current = sync;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let inFlight = false;
    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const list = await fetchPairedSites(fetchImpl);
        if (live && list) syncRef.current(list);
      } catch {
        // console unreachable — keep what we have; the manual flow still works
      } finally {
        inFlight = false;
      }
    };
    void run();
    const onFocus = () => void run();
    const onVisible = () => { if (document.visibilityState === "visible") void run(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void run(); }, SITES_REFRESH_MS);
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [enabled, fetchImpl]);
}
