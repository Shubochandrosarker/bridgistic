import type { ReactNode } from "react";
import type { BridgisticClient } from "../lib/api/client.ts";
import { useStore } from "../lib/store.tsx";
import { useAsync, type AsyncState } from "../lib/useAsync.ts";
import { Card, EmptyState, ErrorState, Skeleton } from "./ui.tsx";

/** Loads data from the active client and renders loading / error / empty / data states. */
export function Resource<T>({ load, deps = [], children, empty, isEmpty }: {
  load: (c: BridgisticClient) => Promise<T>;
  deps?: unknown[];
  children: (data: T, state: AsyncState<T>) => ReactNode;
  empty?: { title: string; body?: string };
  isEmpty?: (d: T) => boolean;
}) {
  const { client } = useStore();
  const state = useAsync(client ? () => load(client) : null, [client, ...deps]);
  if (!client) return <Card><EmptyState title="No site connected" body="Connect a site from the Sites screen to load this view." /></Card>;
  if (state.loading && !state.data) return <Card><Skeleton /></Card>;
  if (state.error) {
    // A 409 "WooCommerce is not installed" is an expected state, not a failure —
    // show it as an information card without a retry loop.
    const e = state.error as { status?: number; message?: string };
    if (e.status === 409) {
      return <Card><EmptyState title="WooCommerce is not active on this site" body="Install and activate WooCommerce to use the store tools. Everything else keeps working." /></Card>;
    }
    return <Card><ErrorState error={state.error} onRetry={state.reload} /></Card>;
  }
  const d = state.data as T;
  const blank = isEmpty ? isEmpty(d) : Array.isArray(d) && d.length === 0;
  if (blank) return <Card><EmptyState title={empty?.title ?? "Nothing here yet"} body={empty?.body} /></Card>;
  return <>{children(d, state)}</>;
}
