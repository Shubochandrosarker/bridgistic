import { motion } from "framer-motion";
import { ArrowRight, Eye, Lock } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Layout.tsx";
import { ComingSoonBadge } from "../components/ui.tsx";
import { useStore } from "../lib/store.tsx";

export function SignIn() {
  const { startDemo } = useStore();
  const nav = useNavigate();
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-navy p-12 text-ivory lg:flex lg:flex-col lg:justify-between">
        <Logo dark />
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
          <h1 className="max-w-md text-4xl font-semibold leading-tight">Run every WordPress site you manage from your AI, with a record of every action.</h1>
          <p className="mt-4 max-w-md text-ivory/70">Scoped keys, approval before destructive changes, a snapshot before edits, and a full audit trail.</p>
        </motion.div>
        <p className="text-xs text-ivory/40">WordPressistic LLC</p>
        <motion.div aria-hidden className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-gold/10 blur-3xl" animate={{ scale: [1, 1.08, 1] }} transition={{ duration: 8, repeat: Infinity }} />
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="lg:hidden"><Logo /></div>
          <div>
            <h2 className="text-2xl font-semibold text-navy">Sign in</h2>
            <p className="mt-1 text-sm text-navy/60">Choose how to open the dashboard.</p>
          </div>
          <div className="card space-y-3 p-5 opacity-70">
            <div className="flex items-center justify-between"><p className="flex items-center gap-2 font-medium"><Lock className="h-4 w-4" aria-hidden />Bridgistic account</p><ComingSoonBadge /></div>
            <p className="text-sm text-navy/60">Email and team sign-in arrive with the hosted API at api.bridgistic.app. Until then, connect a site directly.</p>
            <input className="input" placeholder="you@company.com" disabled aria-label="Email (not yet available)" />
          </div>
          <button className="btn-primary w-full justify-center py-3" onClick={() => nav("/sites?connect=1")}>Connect a site with a Bridgistic key <ArrowRight className="h-4 w-4" aria-hidden /></button>
          <button className="btn-ghost w-full justify-center py-3" onClick={() => { startDemo(); nav("/"); }}><Eye className="h-4 w-4" aria-hidden />Explore with demo data</button>
          <p className="text-xs text-navy/50">Direct connections keep the key secret in this browser tab only (session storage). It is never sent to a Bridgistic server.</p>
        </div>
      </div>
    </div>
  );
}
