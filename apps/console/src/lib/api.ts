/** Console API client — same-origin fetch with JSON envelopes and error unwrap. */

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = json as { error?: string; message?: string } | null;
    throw new ApiError(res.status, err?.error ?? "error", err?.message ?? `Request failed (HTTP ${res.status}).`);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body?: unknown) => call<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => call<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => call<T>("PATCH", path, body ?? {}),
  delete: <T>(path: string) => call<T>("DELETE", path),
};

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
}

export interface OrgRow {
  id: string;
  name: string;
  plan: string;
  status: string;
  membership_role: string;
}

export interface Me {
  user: SessionUser;
  orgs: OrgRow[];
  paid_unlock: { unlocked: boolean; plan: string | null };
}

export interface SiteRow {
  id: string;
  org_id: string;
  url: string;
  name: string;
  wp_version: string;
  php_version: string;
  key_id: string;
  key_mask: string;
  scopes: string[];
  status: string;
  last_seen: string | null;
  created_at: string;
}

export async function me(): Promise<Me | null> {
  try {
    return await api.get<Me>("/api/me");
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

/** A proxied, HMAC-signed call to a connected WordPress site. */
export async function siteCall<T>(siteId: string, method: "GET" | "POST" | "PUT" | "DELETE", route: string, body?: Record<string, unknown>): Promise<T> {
  const result = await api.post<{ ok: boolean; data: T; error?: { code: string; message: string } }>(`/api/sites/${siteId}/call`, { method, path: route, body });
  if (!result.ok) throw new ApiError(502, result.error?.code ?? "site_error", result.error?.message ?? "The site refused the call.");
  return result.data;
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value.includes("T") || value.includes("Z") ? value : value.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value.includes("T") || value.includes("Z") ? value : value.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
