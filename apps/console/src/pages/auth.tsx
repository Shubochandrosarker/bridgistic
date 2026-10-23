import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { Btn, ErrorNote, Field, inputClass } from "../components/ui";

function OAuthButtons() {
  const [providers, setProviders] = useState<{ github: boolean; google: boolean } | null>(null);
  useEffect(() => {
    api
      .get<{ providers: { github: boolean; google: boolean } }>("/api/auth/oauth/providers")
      .then((r) => setProviders(r.providers))
      .catch(() => setProviders({ github: false, google: false }));
  }, []);
  if (!providers || (!providers.github && !providers.google)) return null;
  return (
    <div className="space-y-2">
      <div className="relative py-1 text-center">
        <span className="relative z-10 bg-white px-3 text-[11px] uppercase tracking-widest text-navy/40">or continue with</span>
        <div className="absolute inset-x-0 top-1/2 h-px bg-navy/10" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {providers.google && (
          <a href="/api/auth/oauth/google/start" className="flex items-center justify-center gap-2 rounded-lg border border-navy/15 bg-white px-3 py-2.5 text-sm font-medium text-navy hover:bg-navy/5">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l-.02.15 3.5 2.7.24.02c2.2-2 3.5-5 3.5-8.6z"/><path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.1 1.2-3.1 0-5.8-2.1-6.8-5l-.14.01-3.6 2.8-.05.13C3.4 21.3 7.4 24 12 24z"/><path fill="#FBBC05" d="M5.2 14.4c-.25-.75-.4-1.55-.4-2.4s.15-1.65.42-2.4l-.01-.16-3.65-2.8-.12.06C.5 8.2 0 10 0 12s.5 3.8 1.44 5.3l3.76-2.9z"/><path fill="#EB4335" d="M12 4.6c2.2 0 3.7 1 4.6 1.8l3.3-3.2C17.9 1.2 15.2 0 12 0 7.4 0 3.4 2.7 1.4 6.7l3.8 2.9c1-2.9 3.7-5 6.8-5z"/></svg>
            Google
          </a>
        )}
        {providers.github && (
          <a href="/api/auth/oauth/github/start" className="flex items-center justify-center gap-2 rounded-lg border border-navy/15 bg-white px-3 py-2.5 text-sm font-medium text-navy hover:bg-navy/5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.2 11.4.6.1.82-.26.82-.58v-2c-3.34.72-4.04-1.42-4.04-1.42-.54-1.4-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.5 1 .1-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 016 0c2.28-1.55 3.29-1.23 3.29-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58C20.56 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z"/></svg>
            GitHub
          </a>
        )}
      </div>
    </div>
  );
}

function AuthLayout({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-navy p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <img src="/brand/icon-240.png" alt="Bridgistic" className="mx-auto mb-3 h-14 w-14 rounded-xl" />
          <h1 className="text-xl font-bold text-white">{title}</h1>
          <p className="mt-1 text-sm text-white/60">{sub}</p>
        </div>
        <div className="rounded-2xl bg-white p-6 shadow-xl">{children}</div>
        <p className="mt-4 text-center text-xs text-white/40">
          Bridgistic — signed, scoped, approved, reversible AI access for WordPress.
        </p>
      </div>
    </div>
  );
}

export function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { refresh } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [search] = useSearchParams();

  useEffect(() => {
    if (search.get("oauth_error")) setError("Sign-in with that provider did not complete. Try email and password.");
  }, [search]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/signin", { email, password });
      await refresh();
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? "/", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Sign in to Bridgistic" sub="Your sites, agents, skills and licenses in one console.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <ErrorNote error={error} />
        <Field label="Email">
          <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
        </Field>
        <Field label="Password">
          <input className={inputClass} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
        </Field>
        <Btn type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Btn>
        <OAuthButtons />
        <p className="text-center text-sm text-navy/60">
          New here?{" "}
          <Link to="/signup" className="font-semibold text-navy underline">
            Create a free account
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}

export function SignUp() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { refresh } = useSession();
  const navigate = useNavigate();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/signup", { name, email, password, setup_token: setupToken || undefined });
      await refresh();
      navigate(setupToken ? "/admin" : "/", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign up failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Create your account" sub="Free forever for the local bridge. Pro unlocks the marketplace and more.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <ErrorNote error={error} />
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
        </Field>
        <Field label="Email">
          <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <input className={inputClass} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </Field>
        <button type="button" className="text-xs text-navy/50 underline" onClick={() => setShowToken((v) => !v)}>
          I have a setup or platform token
        </button>
        {showToken && (
          <Field label="Platform token" hint="Only for the platform owner's first sign-in.">
            <input className={inputClass} value={setupToken} onChange={(e) => setSetupToken(e.target.value)} placeholder="Paste the owner setup token" />
          </Field>
        )}
        <Btn type="submit" disabled={busy} className="w-full">
          {busy ? "Creating…" : "Create account"}
        </Btn>
        <OAuthButtons />
        <p className="text-center text-sm text-navy/60">
          Already have one?{" "}
          <Link to="/signin" className="font-semibold text-navy underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
