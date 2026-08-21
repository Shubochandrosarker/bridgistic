# Pricing

The ladder mirrors the one Post Bridge proved works — a legible free tier, an
obviously-best middle plan, and a concrete yearly offer — but it meters what
actually costs us. Post Bridge can afford "unlimited posts" because a post is
nearly free. A tool call against a WordPress site is not: it costs a Worker
invocation, a D1 write, egress, and a snapshot.

| | Free | Starter | Agency | Scale |
|---|---|---|---|---|
| Price | $0 | **$29/mo** | $79/mo | $199/mo |
| Connected sites | 1 | 3 | 25 | Unlimited |
| Actions / month | 500 | 10 000 | 100 000 | 500 000 |
| Local self-hosted MCP | ✔ | ✔ | ✔ | ✔ |
| Hosted MCP (`bridgistic.app/mcp`) | ✔ | ✔ | ✔ | ✔ |
| Scheduler jobs | 1 | 10 | 100 | Unlimited |
| Minimum interval | daily | hourly | 15 min | 5 min |
| Snapshot retention | 7 d | 30 d | 90 d | 365 d |
| Audit retention | 30 d | 90 d | 1 y | 2 y |
| Approvals + rollback | ✔ | ✔ | ✔ | ✔ |
| `db:write` · `fs:write` · `plugins:manage` · `php:execute` | — | — | ✔ (approval always) | ✔ |
| Team seats | 1 | 1 | 5 | Unlimited |
| White-label | — | — | — | ✔ |

The numbers live in `packages/types/src/plans.ts` and are asserted by tests.
This table is generated from that file's shape; if the two disagree, the file is
right and this table is stale.

## Terms

- **Yearly = one month free.** Eleven months' price for twelve. Concrete beats
  "save 17%", and the test in `packages/types` fails if the arithmetic drifts.
- **7-day trial, $0 due today.** 7-day refund window. Both stated in plain words
  on the pricing page, not in a footnote.
- **API add-on: $5/mo · $50/yr**, and only alongside an active subscription. It
  converts the developer segment without discounting the core plan.
- **The local self-hosted MCP server stays free on every tier, including Free**,
  and stays GPL. `docs/FREE_VS_PAID.md` in the public repo promises this and the
  promise is an asset.

## The metering rule, published

Customers should be able to predict their bill. The rule:

| | Actions |
|---|---|
| A read | 1 |
| A content or operational write | 2 |
| A destructive call (`db:write`, `fs:write`, `plugins:manage`, `php:execute`) | 5 |
| A call that reached the site and failed | 1 |
| A call we denied — no scope, no plan, rate-limited | **0** |
| A call waiting on approval | **0** (charged when it runs) |
| A platform-local call, e.g. listing your sites | **0** |

Two principles behind it: the customer is never billed for our refusal or our
failure to start, and writes cost more because they cost us more — a write drags
a snapshot, an approval record and an audit row behind it.

A `SELECT` run by a key that only holds `db:read` is metered as a **read**, not
as a destructive write, even though it goes through the same tool.

Soft limit at 80% (email + dashboard banner). Hard limit at 100%: a 429 carrying
`X-Bridgistic-Quota-Reset` and a clear upgrade CTA. A multi-action call is
admitted or refused whole, so nobody lands at 100.4% of their plan.

## Why the buyer is different from Post Bridge's

Their buyer is a creator and their risk is a bad tweet. Ours is an agency running
10–200 client sites, and the risk is `php:execute` on a live store. That means:

- Higher ACV, lower churn, and teams and white-label are needed early rather
  than as a Scale-tier afterthought.
- An **enterprise trust story** — the published independent security review, a
  public incident policy — is a pricing-page asset, not a compliance chore. None
  of ManageWP, MainWP or WP Remote lead with one.
