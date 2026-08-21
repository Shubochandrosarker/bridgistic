# apps/dashboard — app.bridgistic.app

The customer-facing control plane. **Phase 5.**

The test it has to pass: *an agency can onboard 25 sites and see every run in
one place.* Everything below follows from that one sentence.

## Screens

| Screen | Must show |
|---|---|
| Sites | Every connected site, health, plugin version, last successful run, seat usage against `bridgistic.sites.max`. |
| Site detail | Every scope granted, **with a last-used time and a one-click revoke** (INVARIANT 10). Health timeline. |
| Jobs | Schedule, timezone (the IANA name, not an offset), next run, last status, overlap and catch-up policy. |
| Run history | Per-step outcome, filterable, exportable, one-click re-run with the original vars. |
| Approvals | What will happen, who asked, when it expires. Step-up auth on the decision. |
| Audit | `action_log`, digests only. Never an argument body. |
| Team | Seats against the plan. Roles: owner / admin / member / viewer. |
| Billing | Plan, usage against quota, the soft-limit banner at 80%, invoices, the upgrade CTA at 100%. |

## Things that are easy to get wrong here

- **Never render a raw key.** Masked, and shown in full exactly once at mint time.
- **Never render request arguments.** The audit table stores digests; a UI that
  wants to "just show the SQL" is asking for the one thing that was deliberately
  never stored.
- **Show the timezone, not the offset.** A job says `02:00 Asia/Dhaka`, never
  `02:00 UTC+6`, because the second one is a lie twice a year in half the world.
- **Seat exhaustion and expiry get an email**, not just a banner. A banner is
  only seen by someone already logged in, which is not the person who needs it.
