import { motion } from "framer-motion";
import { ArrowRight, Eye, LoaderCircle, Shield } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Layout.tsx";
import { signIn, signUp } from "../lib/account.ts";
import { useStore } from "../lib/store.tsx";

export function SignIn() {
  const { startDemo } = useStore();
  const nav = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <Logo dark />
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
