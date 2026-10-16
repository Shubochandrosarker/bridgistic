export const fmtNum = (n: number) => new Intl.NumberFormat("en-US").format(n);
export const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
/** Plugin timestamps are MySQL DATETIME in UTC. Shown in the viewer's IANA zone, with the zone named. */
export function fmtTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return s;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: tz })} ${tz}`;
}
export const shortHash = (h: string) => (h.length > 12 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h);
