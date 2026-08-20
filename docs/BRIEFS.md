# The source briefs — deliberately not committed yet

Three documents drove this scaffold:

| File | What it is |
|---|---|
| `MASTER-PROMPT-Bridgistic-App.md` | The platform brief: tenancy, plans, metering, the scheduler, GTM, the four hard gates. |
| `Bridgistic-vs-PostBridge-Teardown.md` | Competitive audit of post-bridge.com and the pricing/positioning blueprint drawn from it. |
| `MASTER-PROMPT-Unified-Ecosystem-Licensing.md` | The WPistic one-key licensing brief that the ecosystem-key adapter has to interoperate with. |

The brief says to put them in the repo root, and they belong there — **once this
repository is private.**

## Why they are withheld while the repo is public

The licensing brief names **unpatched vulnerabilities by finding id** in a live
system: fail-open signature verification in shipped clients, `__return_true`
filter bypasses, an activation endpoint that returns `success:true` for any
string, and `PLAT-17` — a symmetric `verification_key` a licensee can use to
forge signed validation responses. Publishing that on a public repository is
disclosing a working attack against production licensing for every WPistic
product, to anyone who reads it, before the fix has shipped.

The other two are less severe but still internal: unannounced pricing, a
competitor teardown, and an honest list of what is not yet built.

## What to do

1. Settle the visibility decision in [LICENSING-DECISION.md](LICENSING-DECISION.md).
2. When the repository is private, commit all three at the root and remove the
   corresponding lines from `.gitignore`.
3. If the repository stays public, they stay out permanently — and
   `MASTER-PROMPT-Unified-Ecosystem-Licensing.md` plus
   `WPistic-Licensing-Deep-Audit.md` should live only in the private WPistic
   platform repository, not here.

Nothing in the committed code depends on these files. The decisions they drove
are restated in `docs/` in a form that is safe to publish:
architecture, scheduler design, pricing, metering, hard gates and WPistic
interop are all documented without naming an unpatched finding.
