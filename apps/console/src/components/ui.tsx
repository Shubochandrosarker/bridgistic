/** Shared UI primitives for the console. */

import { type ReactNode, useState } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-navy/10 bg-white shadow-sm ${className}`}>{children}</div>;
}

export function Btn({
  children,
  onClick,
  variant = "primary",
  disabled,
  type = "button",
  className = "",
  small,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger" | "gold";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
  small?: boolean;
}) {
  const styles: Record<string, string> = {
    primary: "bg-navy text-white hover:bg-navy-700 disabled:bg-navy/30",
    ghost: "border border-navy/15 bg-white text-navy hover:bg-navy/5",
    danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300",
    gold: "bg-gold text-navy hover:brightness-105 disabled:opacity-50",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition ${small ? "px-2.5 py-1.5 text-xs" : "px-4 py-2 text-sm"} ${styles[variant]} ${className} disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy/60">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-navy/50">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-navy/15 bg-white px-3 py-2 text-sm outline-none focus:border-gold focus:ring-2 focus:ring-gold/30";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "gold" }) {
  const tones: Record<string, string> = {
    neutral: "bg-navy/10 text-navy",
    good: "bg-emerald-100 text-emerald-800",
    warn: "bg-amber-100 text-amber-800",
    bad: "bg-red-100 text-red-700",
    gold: "bg-gold-soft text-[#7a6410]",
  };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function PageHead({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-navy">{title}</h1>
        {sub && <p className="mt-0.5 text-sm text-navy/60">{sub}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: boolean }) {
  if (empty) return <div className="rounded-xl border border-dashed border-navy/20 p-8 text-center text-sm text-navy/50">Nothing here yet.</div>;
  return (
    <div className="overflow-x-auto rounded-xl border border-navy/10 bg-white">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-navy/10 bg-navy/[0.03]">
            {head.map((h) => (
              <th key={h} className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-navy/50">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-navy/5">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 align-middle ${className}`}>{children}</td>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: string; tone?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-navy/50">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tone ?? "text-navy"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-navy/50">{sub}</div>}
    </Card>
  );
}

export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="fixed bottom-5 right-5 z-50 rounded-lg bg-navy px-4 py-2.5 text-sm text-white shadow-lg">{message}</div>;
}

export function useToast(): [string | null, (msg: string) => void] {
  const [message, setMessage] = useState<string | null>(null);
  const show = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(null), 3500);
  };
  return [message, show];
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</div>;
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-navy/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-navy">{title}</h2>
          <button onClick={onClose} className="text-navy/40 hover:text-navy" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return <div className="p-8 text-center text-sm text-navy/50">{label}</div>;
}
