import { motion } from "framer-motion";
import { Badge, ComingSoonBadge, PageHeader } from "../components/ui.tsx";
import { ROADMAP } from "../lib/roadmap.ts";

const AREAS = ["Addons", "Advanced tools", "Specialised agent", "Platform"] as const;

export function Roadmap() {
  return (
    <div>
      <PageHeader title="Roadmap" description="What we plan to build next. None of this is available yet, and no dates are promised. Pro subscribers receive these updates when they ship." />
      <div className="grid gap-6 lg:grid-cols-2">
        {AREAS.map((a, ai) => (
          <section key={a} aria-labelledby={`r-${ai}`}>
            <h2 id={`r-${ai}`} className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-navy/55">{a}</h2>
            <ul className="space-y-3">
              {ROADMAP.filter((r) => r.area === a).map((r, i) => (
                <motion.li key={r.title} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: ai * 0.08 + i * 0.05 }} className="card p-4">
                  <div className="flex items-center justify-between gap-2"><p className="font-medium">{r.title}</p><Badge>{r.stage}</Badge></div>
                  <p className="mt-1 text-sm text-navy/65">{r.body}</p>
                </motion.li>))}
            </ul>
          </section>))}
      </div>
    </div>
  );
}

export function ComingSoon() {
  return (
    <div>
      <PageHeader title="Coming soon" description="Preview of upcoming areas. These sections are not functional yet." badge={<ComingSoonBadge />} />
      <div className="grid gap-4 md:grid-cols-3">
        {ROADMAP.filter((r) => r.stage === "Planned").map((r, i) => (
          <motion.div key={r.title} initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * 0.05 }} className="relative overflow-hidden rounded-2xl border border-dashed border-gold/50 bg-white/70 p-5">
            <div className="mb-3 h-20 rounded-xl bg-gradient-to-br from-navy/5 to-gold/10" aria-hidden />
            <div className="flex items-center justify-between gap-2"><p className="font-medium">{r.title}</p><ComingSoonBadge /></div>
            <p className="mt-1 text-xs uppercase tracking-wider text-navy/45">{r.area}</p>
            <p className="mt-2 text-sm text-navy/65">{r.body}</p>
          </motion.div>))}
      </div>
    </div>
  );
}
