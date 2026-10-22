import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { Btn, ErrorNote, Field, inputClass } from "../components/ui";

function AuthLayout({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-navy p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gold text-xl font-black text-navy">B</span>
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
