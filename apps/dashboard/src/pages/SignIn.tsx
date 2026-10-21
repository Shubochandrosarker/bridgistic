import { motion } from "framer-motion";
import { ArrowRight, Eye, Lock, Shield } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Layout.tsx";
import { ComingSoonBadge } from "../components/ui.tsx";
import { useStore } from "../lib/store.tsx";

export function SignIn() {
  const { startDemo } = useStore();
  const nav = useNavigate();

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
            <h2 className="text-[1.65rem] font-semibold tracking-tight text-navy">Sign in</h2>
            <p className="mt-1.5 text-sm text-navy/55">Choose how to open the dashboard.</p>
          </div>

          {/* Account coming soon — quieter */}
          <div className="rounded-2xl border border-navy/8 bg-white/60 p-5 shadow-sm backdrop-blur-sm">
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm font-medium text-navy">
                <Lock className="h-4 w-4 text-navy/40" aria-hidden />
                Bridgistic account
              </p>
              <ComingSoonBadge />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-navy/50">
              Email and team sign-in arrive with the hosted API at api.bridgistic.app. Until then, connect a site directly.
            </p>
            <input
              className="mt-3 w-full rounded-xl border border-navy/10 bg-ivory/50 px-3.5 py-2.5 text-sm text-navy/40 placeholder:text-navy/30"
              placeholder="you@company.com"
              disabled
              aria-label="Email (not yet available)"
            />
          </div>

          {/* Primary actions */}
          <div className="space-y-3">
            <button
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-navy px-4 py-3.5 text-sm font-medium text-ivory shadow-sm transition hover:bg-navy-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
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
