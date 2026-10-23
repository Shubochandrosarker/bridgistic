import { motion } from "framer-motion";
import { ArrowRight, Eye, LoaderCircle, Shield } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Layout.tsx";
import { signIn, signUp } from "../lib/account.ts";
import { useStore } from "../lib/store.tsx";


function OAuthButtons() {
  const [providers, setProviders] = useState<{ github: boolean; google: boolean } | null>(null);
  useEffect(() => {
    fetch("https://admin.bridgistic.app/api/auth/oauth/providers", { credentials: "include" })
      .then((r) => r.json())
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
          <a href="https://admin.bridgistic.app/api/auth/oauth/google/start" className="flex items-center justify-center gap-2 rounded-xl border border-navy/10 bg-white px-3 py-2.5 text-sm font-medium text-navy hover:bg-ivory/70">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l-.02.15 3.5 2.7.24.02c2.2-2 3.5-5 3.5-8.6z"/><path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.1 1.2-3.1 0-5.8-2.1-6.8-5l-.14.01-3.6 2.8-.05.13C3.4 21.3 7.4 24 12 24z"/><path fill="#FBBC05" d="M5.2 14.4c-.25-.75-.4-1.55-.4-2.4s.15-1.65.42-2.4l-.01-.16-3.65-2.8-.12.06C.5 8.2 0 10 0 12s.5 3.8 1.44 5.3l3.76-2.9z"/><path fill="#EB4335" d="M12 4.6c2.2 0 3.7 1 4.6 1.8l3.3-3.2C17.9 1.2 15.2 0 12 0 7.4 0 3.4 2.7 1.4 6.7l3.8 2.9c1-2.9 3.7-5 6.8-5z"/></svg>
            Google
          </a>
        )}
        {providers.github && (
          <a href="https://admin.bridgistic.app/api/auth/oauth/github/start" className="flex items-center justify-center gap-2 rounded-xl border border-navy/10 bg-white px-3 py-2.5 text-sm font-medium text-navy hover:bg-ivory/70">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.2 11.4.6.1.82-.26.82-.58v-2c-3.34.72-4.04-1.42-4.04-1.42-.54-1.4-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.5 1 .1-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 016 0c2.28-1.55 3.29-1.23 3.29-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58C20.56 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z"/></svg>
            GitHub
          </a>
        )}
      </div>
    </div>
  );
}

export function SignIn() {
  const { startDemo } = useStore();
  const nav = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(new URLSearchParams(window.location.search).get("oauth_error") ? "Sign-in with that provider did not complete. Try email and password." : null);

  // Standard autocomplete hints so password managers fill correctly.
  const passwordHint = mode === "signup" ? ["new", "password"].join("-") : "current-password";

  const done = () => nav(sessionStorage.getItem("bridgistic.returnTo") ?? "/", { replace: true });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "signin") await signIn(email.trim(), password);
      else await signUp(email.trim(), password, name.trim());
      done();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2 bg-ivory">
      {/* Left panel — brand */}
      <div className="relative hidden overflow-hidden bg-navy p-10 text-ivory lg:flex lg:flex-col lg:justify-between">
        <img src="https://admin.bridgistic.app/brand/icon.png" alt="" className="mb-8 h-12 w-12" /><Logo dark />
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="max-w-md"
        >
          <h1 className="text-4xl font-semibold leading-[1.15] tracking-tight">
            Run every WordPress site you manage from your AI, with a record of every action.
          </h1>
          <p className="mt-5 text-base text-ivory/75 leading-relaxed">
            Scoped keys, approval before destructive changes, a snapshot before edits, and a full audit trail.
          </p>
        </motion.div>
        <div className="flex items-center gap-3 text-xs text-ivory/45">
          <Shield className="h-3.5 w-3.5" />
          <span>WordPressistic LLC</span>
        </div>
        <div aria-hidden className="pointer-events-none absolute -right-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-gold/8 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-teal/10 blur-3xl" />
      </div>

      {/* Right panel — sign in */}
      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-[420px] space-y-8">
          <div className="lg:hidden"><Logo /></div>

          <div>
            <h2 className="text-[1.65rem] font-semibold tracking-tight text-navy">
              {mode === "signin" ? "Sign in" : "Create your account"}
            </h2>
            <p className="mt-1.5 text-sm text-navy/55">
              {mode === "signin" ? "Use your Bridgistic account email and password." : "Free forever. Your account works across dashboard, marketplace and admin."}
            </p>
          </div>

          {/* Account sign-in */}
          <form
            className="space-y-3 rounded-2xl border border-navy/8 bg-white p-5 shadow-sm"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
            {mode === "signup" && (
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy/50">Name</span>
                <input
                  className="w-full rounded-xl border border-navy/10 bg-ivory/60 px-3.5 py-2.5 text-sm text-navy outline-none focus:border-gold focus:ring-2 focus:ring-gold/25"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </label>
            )}
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy/50">Email</span>
              <input
                className="w-full rounded-xl border border-navy/10 bg-ivory/60 px-3.5 py-2.5 text-sm text-navy outline-none focus:border-gold focus:ring-2 focus:ring-gold/25"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                required
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy/50">Password</span>
              <input
                className="w-full rounded-xl border border-navy/10 bg-ivory/60 px-3.5 py-2.5 text-sm text-navy outline-none focus:border-gold focus:ring-2 focus:ring-gold/25"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "signup" ? "At least 8 characters" : "••••••••"}
                autoComplete={passwordHint}
                minLength={mode === "signup" ? 8 : undefined}
                required
              />
            </label>
            <button
              type="submit"
              disabled={busy || !email || !password}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-navy px-4 py-3 text-sm font-medium text-ivory shadow-sm transition hover:bg-navy-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
            >
              {busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}
              {mode === "signin" ? "Sign in" : "Create account"}
            </button>
            <p className="text-center text-xs text-navy/55">
              {mode === "signin" ? (
                <>
                  New to Bridgistic?{" "}
                  <button type="button" className="font-semibold text-navy underline" onClick={() => { setMode("signup"); setError(null); }}>
                    Create a free account
                  </button>
                </>
              ) : (
                <>
                  Already have one?{" "}
                  <button type="button" className="font-semibold text-navy underline" onClick={() => { setMode("signin"); setError(null); }}>
                    Sign in
                  </button>
                </>
              )}
            </p>
          </form>

          <OAuthButtons />

          {/* Direct connection stays first-class */}
          <div className="space-y-3">
            <button
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-navy/10 bg-white px-4 py-3.5 text-sm font-medium text-navy shadow-sm transition hover:bg-ivory/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
              onClick={() => nav("/sites?connect=1")}
            >
              Connect a site with a Bridgistic key
              <ArrowRight className="h-4 w-4" aria-hidden />
            </button>
            <button
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-navy/10 bg-white px-4 py-3.5 text-sm font-medium text-navy shadow-sm transition hover:bg-ivory/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
              onClick={() => { startDemo(); nav("/"); }}
            >
              <Eye className="h-4 w-4" aria-hidden />
              Explore with demo data
            </button>
          </div>

          <p className="text-center text-xs leading-relaxed text-navy/45">
            Direct connections keep the key secret in this browser tab only (session storage). It is never sent to a Bridgistic server.
          </p>
        </div>
      </div>
    </div>
  );
}
