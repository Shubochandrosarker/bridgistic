/**
 * Bridgistic account session, shared with the console at admin.bridgistic.app.
 *
 * The console sets its session cookie with Domain=.bridgistic.app, so one
 * sign-in works on dashboard., admin. and marketplace. subdomains. The
 * browser holds the cookie; this module only carries display state.
 */

const CONSOLE_API = "https://admin.bridgistic.app";
const ACCOUNT_KEY = "bridgistic.account.v1";

export interface Account {
  email: string;
  name: string;
  role: string;
}

export function loadAccount(): Account | null {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? "null");
  } catch {
    return null;
  }
}

function saveAccount(account: Account | null): void {
  if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  else localStorage.removeItem(ACCOUNT_KEY);
}

interface ApiResponse {
  ok?: boolean;
  user?: Account;
  error?: string;
  message?: string;
}

/** Verify the shared session against the console and cache who we are. */
export async function refreshAccount(): Promise<Account | null> {
  try {
    const res = await fetch(`${CONSOLE_API}/api/me`, { credentials: "include", cache: "no-store" });
    if (!res.ok) {
      saveAccount(null);
      return null;
    }
    const json = (await res.json()) as ApiResponse;
    if (!json.user) {
      saveAccount(null);
      return null;
    }
    const account: Account = { email: json.user.email, name: json.user.name, role: json.user.role };
    saveAccount(account);
    return account;
  } catch {
    // A cached account is display-only state. Never treat it as proof of a
    // valid session when the authority endpoint is unavailable.
    saveAccount(null);
    return null;
  }
}

export async function signIn(email: string, password: string): Promise<Account> {
  const res = await fetch(`${CONSOLE_API}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify({ email, password }),
  });
  const json = (await res.json().catch(() => null)) as ApiResponse | null;
  if (!res.ok || !json?.user) throw new Error(json?.message ?? "Email or password is incorrect.");
  const account: Account = { email: json.user.email, name: json.user.name, role: json.user.role };
  saveAccount(account);
  return account;
}

export async function signUp(email: string, password: string, name: string): Promise<Account> {
  const res = await fetch(`${CONSOLE_API}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify({ email, password, name }),
  });
  const json = (await res.json().catch(() => null)) as ApiResponse | null;
  if (!res.ok || !json?.user) throw new Error(json?.message ?? "Sign up failed.");
  const account: Account = { email: json.user.email, name: json.user.name, role: json.user.role };
  saveAccount(account);
  return account;
}

export async function signOutAccount(): Promise<void> {
  // Bound the round-trip. A stalled request used to leave this promise pending
  // forever, so the caller's hard navigation to /sign-in never ran and the
  // dashboard stayed on screen. With a timeout the call always settles, local
  // state clears, and the redirect happens even when the network hangs.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    await fetch(`${CONSOLE_API}/api/auth/signout`, { method: "POST", credentials: "include", signal: controller.signal });
  } catch {
    // Local display state clears regardless; the session expires on its own.
  } finally {
    clearTimeout(timer);
  }
  saveAccount(null);
}
