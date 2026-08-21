# Licence and repository visibility — an open decision

This is flagged rather than decided, because it is the owner's call and because
getting it wrong is expensive to undo.

## Update, Phase 3 — two things have changed since this was written

This document was written during the Phase 0 scaffold and said the visibility
flip had to happen **before Phase 1 starts**. Phases 1 through 3 have since
landed. Two facts are now true that the text below assumes are not, and both
raise the cost of Option A.

**1. `package.json` and `LICENSE` disagree.** `package.json` declared
`"license": "UNLICENSED"` while `LICENSE` is the GPL-2.0-or-later text. A
recipient of a public repository relies on the LICENSE file, so the metadata was
simply wrong; it now says `GPL-2.0-or-later` to match. That records what this
repository already is. **It does not decide what it should be** — if the answer
is proprietary, both change together, along with point 2.

**2. Five platform files are derived from the GPL engine.** They carry a
`Ported from…` header naming the source:

| File | Ported from |
|---|---|
| `packages/crypto/src/envelope.ts` | `cloud/src/crypto.ts` |
| `packages/identity/src/pkce.ts` | `cloud/src/pkce.ts` |
| `packages/url-guard/src/url.ts` | `cloud/src/url-guard.ts` |
| `packages/wp-client/src/client.ts` | `cloud/src/services/wp-client.ts` |
| `packages/wp-client/src/signer.ts` | `cloud/src/services/signer.ts` |

The engine is `GPL-2.0-or-later`. Derived work carries the same terms, so these
five are GPL regardless of what this repository declares. Under Option A they
would have to be removed, independently rewritten, or accepted as keeping the
platform GPL. `packages/wp-client/src/signer.ts` is the awkward one: it must
match the plugin's HMAC canonicalisation byte for byte, and a rewrite that
avoided the original would still have to produce the same bytes.

None of this is an argument for either option. It is the part of the bill that
was not on the table when the recommendation below was made, and it grows with
every phase that ports more.

## The situation

- `LICENSE` in this repository is **GPL-2.0-or-later**, inherited from when the
  repository held the WordPress plugin.
- The code in `legacy/` is genuinely GPL — it was published under it, and that
  cannot be retracted for copies already distributed.
- The brief calls for the hosted platform to live in a **private** repository
  (`Wordpressistic/bridgistic-app`), which implies a proprietary licence.
- This repository is currently **public**.

## Why the scaffolding commit did not change it

Three reasons, any one of which is enough:

1. Relicensing is an ownership decision, not a refactor.
2. The public promise in `docs/FREE_VS_PAID.md` on the marketplace repo — *"no
   billing code, no account system, no nag walls in the free plugin"*, *"security
   fixes always land in the free version"* — is a marketing asset. Nothing here
   breaks it, but a visibility change is the moment people re-read it, so it
   should be a deliberate announcement rather than a side effect.
3. A GPL licence file sitting above proprietary platform code is worse than
   either option cleanly chosen. Fixing it wrongly is worse than leaving it
   visible and labelled.

## The two options

### A. Repurpose this repository (what the scaffold assumes)

Make `Shubochandrosarker/bridgistic` **private**, replace `LICENSE` with a
proprietary licence, and keep `legacy/` under its original GPL with a
`legacy/LICENSE` of its own.

- Keeps the history, the stars, the issue links and the existing CI.
- Needs the visibility flip **before** any secret, customer identifier or Stripe
  configuration lands. Nothing in the scaffold contains one; that stops being
  true the moment Phase 1 starts.
- The `bridgistic` name matching `bridgistic.app` is a genuine small benefit.

### B. Archive this repository, create `Wordpressistic/bridgistic-app` private

What the brief literally says. Archive this one with a README pointing at both
the free repo and the new private one.

- Cleanest licence story: a new repository starts proprietary with no GPL
  history above it.
- Loses this repository's history and links, and needs the org-level repo to be
  created before any of this can move.
- The scaffold in this branch transplants to a new repository unchanged — it has
  no dependency on this repository's identity beyond the `repository` field in
  `package.json`.

## Recommendation

**Option A**, executed in this order:

1. Decide, and say so in `CHANGELOG.md`.
2. Flip the repository to private.
3. Replace the root `LICENSE`; move a copy of the GPL text to `legacy/LICENSE`
   and note in `legacy/README.md` that everything under it stays GPL.
4. Only then begin Phase 1, which is the first phase that touches real customer
   data and real secrets.

Do not start step 4 before step 2.
