import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./api/errors.ts";

export interface AsyncState<T> { data: T | null; error: ApiError | null; loading: boolean; reload(): void }
export function useAsync<T>(fn: (() => Promise<T>) | null, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!fn) { setLoading(false); return; }
    let live = true;
    setLoading(true); setError(null);
    fn().then((d) => { if (live) setData(d); })
      .catch((e: unknown) => { if (live) setError(e instanceof ApiError ? e : new ApiError(String(e), "server")); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
