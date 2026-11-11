import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Logo } from "../components/Layout.tsx";
import { confirmEmail, refreshAccount, requestPasswordReset, resetPassword } from "../lib/account.ts";
import { useStore } from "../lib/store.tsx";

const tokenParam = () => new URLSearchParams(window.location.search).get("token") ?? "";
const inputClass = "w-full rounded-xl border border-navy/10 bg-ivory/60 px-3.5 py-2.5 text-sm text-navy outline-none focus:border-gold focus:ring-2 focus:ring-gold/25";
const buttonClass = "flex w-full items-center justify-center gap-2 rounded-xl bg-navy px-4 py-3 text-sm font-medium text-ivory shadow-sm transition hover:bg-navy-700 disabled:cursor-not-allowed disabled:opacity-50";

function Shell({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => { document.title = `${title} · Bridgistic`; }, [title]);
  return (
    <main className="flex min-h-screen items-center justify-center bg-ivory p-6 text-navy">
      <div className="w-full max-w-[420px] space-y-6">
        <Logo />
        <h1 className="text-[1.5rem] font-semibold tracking-tight">{title}</h1>
        <div className="space-y-4 rounded-2xl border border-navy/8 bg-white p-5 shadow-sm">{children}</div>
        <p className="text-center text-xs text-navy/55"><Link className="font-semibold underline" to="/sign-in">Back to sign in</Link></p>
      </div>
    </main>
  );
}

function Notice({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <p role="status" className={`rounded-lg px-3 py-2 text-sm ${ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{children}</p>;
}

export function VerifyEmail() {
  const { setAccount } = useStore();
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const token = tokenParam();
    if (!token) { setState({ ok: false, message: "This confirmation link is incomplete. Open the link from your email again." }); return; }
    void confirmEmail(token).then(async (r) => {
      setState(r.ok ? { ok: true, message: "Your email is confirmed. Your licenses, billing and sites are now available." } : r);
      if (r.ok) setAccount(await refreshAccount());
    });
  }, [setAccount]);
  return (
    <Shell title="Confirm your email">
      {state ? <Notice ok={state.ok}>{state.message}</Notice> : <p className="flex items-center gap-2 text-sm text-navy/60" role="status"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />Confirming…</p>}
      {state?.ok && <Link to="/" className={buttonClass}>Open your dashboard</Link>}
    </Shell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  return (
    <Shell title="Reset your password">
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setState(await requestPasswordReset(email.trim())); setBusy(false); }}>
        {state && <Notice ok={state.ok}>{state.ok ? "If an account uses that email, a reset link is on its way. It expires in 1 hour." : state.message}</Notice>}
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy/50">Email</span>
          <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required placeholder="you@company.com" />
        </label>
        <button type="submit" className={buttonClass} disabled={busy || !email}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}Send reset link</button>
      </form>
    </Shell>
  );
}

export function ResetPassword() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  const token = tokenParam();
  return (
    <Shell title="Choose a new password">
      {!token ? <Notice ok={false}>This reset link is incomplete. <Link className="underline" to="/forgot-password">Ask for a new one</Link>.</Notice> : state?.ok ? (
        <>
          <Notice ok>{state.message}</Notice>
          <Link to="/sign-in" className={buttonClass}>Sign in</Link>
        </>
      ) : (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setState(await resetPassword(token, password)); setBusy(false); }}>
          {state && <Notice ok={false}>{state.message}</Notice>}
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy/50">New password</span>
            <input className={inputClass} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={["new", "password"].join("-")} minLength={8} required placeholder="At least 8 characters" />
          </label>
          <button type="submit" className={buttonClass} disabled={busy || password.length < 8}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}Save new password</button>
        </form>
      )}
    </Shell>
  );
}
