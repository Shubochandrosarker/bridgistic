# Hard gates

**Nothing ships to a paying customer until all four are true.** They are listed
in the order they are likely to slip, not in the order they are likely to be
finished.

## 1. An independent security review of the OAuth relay and the tenant store

`docs/CLOUD_CONNECTOR.md` in the free repo already names this as the biggest
remaining gap:

> An independent security review of the OAuth relay and the D1 tenant store —
> this Worker holds a live Bridgistic credential for every connected WordPress
> site. This is the biggest remaining gap.

You cannot charge agencies to put their clients' sites behind a relay that holds
root-equivalent credentials and has never been reviewed. The equivalent risk for
a social scheduler is a bad post; here it is a destroyed production store.

**This is the gate most likely to slip**, because it is the only one that
depends on someone outside the team and on a budget line rather than on a merge.
Two things to do about it now, before any code is ready for it:

- Book and pay for the review on a date, not "after Phase 8". A reviewer with a
  slot in three months is a reason to sequence the work; a reviewer you will
  find later is a reason to slip.
- Give them a smaller, earlier surface: the credential envelope, the tenant
  store, and the OAuth flow are reviewable *before* the dashboard exists. Scope
  the first engagement to those and re-review the delta later.

The published review is also the strongest thing on an agency-facing pricing
page. Treat the spend as marketing as well as security.

## 2. Metering is server-side and billing-grade

- The counter is a Durable Object per (org, month), not KV.
- `KeyStore::create` no longer accepts a customer-supplied `$tier`.
- Gate: 1 000 concurrent calls produce exactly 1 000 counted actions.

See [METERING.md](METERING.md).

## 3. A real end-to-end test on a live site

Recorded in the docs, not asserted from memory:

WordPress OAuth consent → tenant provisioned → a real MCP client calls a tool →
a scheduled job runs unattended → an approval pauses a destructive step → a
rollback restores.

This is still open in the free repo today. It is the one gate that cannot be
satisfied by any amount of unit testing, because every interesting failure in
this product lives in the seam between the Worker, the plugin and a real host.

## 4. Load and abuse testing against a staging Worker

Including the **DNS-rebinding gap** that `cloud/src/url-guard.ts` documents as
unmitigated: a hostname that resolves to a private address at fetch time cannot
be caught before the fetch, because Workers cannot resolve a name first. The
guard is honest about this. Load testing is where you find out what it costs.

Also in scope: quota exhaustion under concurrency, the scheduler's behaviour
when a customer's host starts timing out on every request, and what happens when
one org schedules 100 jobs against 25 sites on the same shared host.
