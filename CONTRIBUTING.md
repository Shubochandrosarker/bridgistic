# Contributing

## Before you start

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the twelve invariants at
the bottom of it. They are not style preferences. Every one of them exists
because this platform holds a root-equivalent credential for somebody's
production website.

## Setup

```bash
npm install     # Node 22+
npm run verify  # migrations + typecheck + tests
```

`npm run verify` is what CI runs. Run it before you push.

## Rules that are actually enforced

- **Digests, not bodies.** Nothing that could hold a request argument, a
  password, a customer's email or a row of their database goes into a log line,
  a table, or an error message. `packages/tools/src/digest.ts` is how you get a
  digest; there is no approved way to store the other thing.
- **Additive migrations only.** A migration that drops or rewrites a column
  needs the same treatment as `legacy/0002_drop_tenants.sql`: its own file, its
  preconditions written down, and a human running it deliberately.
- **`@bridgistic/types` is the single source of truth for every enum.** If a
  status string exists in a `CHECK` constraint and in TypeScript, the TypeScript
  is generated from the same list, not retyped next to it.
- **No test may assert current buggy behaviour.** If a test blocks a fix, fix the
  test and say so in the PR.
- **Never edit a client site directly.** Client sites receive released, tagged
  builds. `guns2ammo.com` and every other client site are out of scope for every
  change in this repository.

## Scope changes

Adding a scope means touching three places in one commit, or it is wrong in at
least one of them:

1. `includes/security/class-scopes.php` in the free plugin — the wire name.
2. `packages/types/src/scopes.ts` — the risk class.
3. `packages/tools/src/catalog.ts` — the tool that consumes it.

A test fails if a tool references a scope that does not exist, and another fails
if a scope exists that no tool consumes.

## Migrations

Every change under `db/migrations/` must keep `npm run lint:sql` green. That
script applies every file to a real in-memory SQLite database — D1 is SQLite —
and asserts that the constraints bite. If you add a constraint, add the
assertion that proves it.

## Commits and PRs

- One logical change per commit. A migration and the code that reads it belong
  together; a refactor and a behaviour change do not.
- Say what the change does and why the alternative was rejected. The "why not"
  is the part that is expensive to reconstruct later.
