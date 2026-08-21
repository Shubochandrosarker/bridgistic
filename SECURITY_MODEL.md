# Bridgistic security model

Bridgistic holds a signed, root-equivalent credential for every connected
WordPress site. The threat model has to start from that fact: a tenant
isolation failure here is not a data leak, it is remote code execution on
somebody else's business.

This document is normative. Code that contradicts it is a bug.

## 1. Default deny

A missing permission, scope, grant, entitlement, approval, or consent **denies
execution**. There is no path where absence of a record means "allowed".

Concretely, every one of these must be present and affirmative, or the call is
refused:

- an authenticated actor
- a membership binding that actor to the organization
- a role on that membership that permits the operation
- a site row owned by that organization
- a site-level grant for the scope
- a plan entitlement covering the scope's class
- an organization policy that has not disabled the tool
- the tool's own safety policy satisfied (approval, snapshot, step-up)
- a valid, unexpired consent for the grant the token was issued under

## 2. Effective permission

```
effective = requested
          ∩ actor role permissions
          ∩ organization policy
          ∩ site grant
          ∩ plan entitlement
          ∩ tool safety policy
          ∩ current consent
```

Intersection only. **A requested scope can never widen any term.** A client
asking for `php:execute` on a Free plan does not get it, does not get a
partially-honoured variant, and does not get a different error than a client
asking for a scope that does not exist — both are `scope_denied`.

Unknown scope names are dropped, never forwarded. A client must not be able to
invent a scope name the plugin might honour in a future version.

## 3. Risk classes

Seven classes. The class decides the gate, and the gate is not configurable
per-customer.

| Class | Examples | Gate |
|---|---|---|
| `safe_read` | site metadata, published posts, media list | scope + grant |
| `sensitive_read` | `db:read`, `fs:read`, `users:read`, `options:read`, `woo:orders:read`, `woo:customers:read` | scope + grant + **paid plan** + audit with digest |
| `content_write` | posts, media, memory | scope + grant + audit |
| `operational` | users:write, options:write, order status, scheduling | scope + grant + **snapshot** + audit |
| `destructive` | `db:write`, `plugins:manage` | scope + grant + **approval + snapshot + step-up auth**, every time |
| `credential` | key rotation, connection revocation | **owner/admin role + step-up auth**, never available to a machine token |
| `code_execution` | `php:execute`, `fs:write` | approval + snapshot + step-up + explicit per-site opt-in |

### Why `sensitive_read` exists (BR-002)

Before Phase 0, the Free plan carried the whole `read` class. That class
contained `fs:read`, described as "read files inside ABSPATH". `wp-config.php`
lives in `ABSPATH`. It contains the database credentials and the eight
authentication salts. It also contained `woo:customers:read` and
`users:read` — customer PII — and `db:read`, arbitrary `SELECT`.

A free, unverified signup could therefore read a connected site's database
credentials and its customer list. Splitting `read` into `safe_read` and
`sensitive_read`, and giving Free only `safe_read`, closes that.

Read is not automatically safe. Exfiltration is the most common real-world
outcome of an over-broad integration, and it leaves no trace in the content.

## 4. Snapshots are not one operation

`snapshot:manage` is three different risks and must not be one gate:

- **create** — operational. Costs storage; cannot destroy anything.
- **restore** — destructive. Silently discards every change since the
  snapshot. Requires approval + step-up, and takes a snapshot of the *current*
  state first so a mistaken restore is itself reversible.
- **delete** — destructive. Removes the rollback path for other operations, so
  it requires approval and is refused while any pending approval references it.

## 5. Credentials

- No raw WordPress password or API secret is ever stored. Only the AES-256-GCM
  envelope, `v2.aes256gcm.{ivB64}.{ctB64}`.
- Credentials are **versioned and immutable**. Rotation writes a new version; it
  never mutates a row in place.
- Jobs, queue messages, approvals and audit rows carry a **credential
  reference** (`site_id` + `version`), never the material.
- Rotating a site's credential invalidates every OAuth grant and session bound
  to the previous version. A grant is bound to the version it was issued
  against; it is never silently rebound.
- `TENANT_ENC_KEY` rotation does **not** migrate rows. The decrypt-all,
  re-encrypt walk in `docs/KEY-ROTATION.md` must run first or every connected
  site is locked out simultaneously.

### Never in a log, table, payload, error, or notification

Passwords, API keys, HMAC secrets, OAuth tokens or codes, PKCE verifiers, full
request bodies, full WordPress responses, customer content, PII.

Audit rows store `sha256(canonical(args))` — a digest, not the arguments.

## 6. Transport

The WordPress plugin is the **only** execution authority on the site. The
transport is not a proxy and must never become one: the caller cannot choose
the destination, only the site, and the site's origin comes from a server-side
row.

Required properties:

- HMAC-SHA256 over `METHOD\nPATH\nTIMESTAMP\nNONCE\nsha256(body)`
- constant-time signature comparison
- timestamp window + nonce replay rejection, both sides
- response signature validated before the body is parsed
- timeout and response-size ceilings, enforced by the client
- redirects not followed to a different origin
- SSRF guard on every connection attempt, not only at onboarding

### SSRF and DNS rebinding (BR-005)

`checkSiteUrl` rejects private and obfuscated literals at parse time. It cannot
see DNS, so a public hostname that resolves to `10.0.0.5` at fetch time passes.
The layered mitigation, landing across Phases 1 and 3:

1. **Pre-resolve** the hostname over DoH at connection time and reject if any
   A/AAAA record is private. Closes the static case.
2. **Response-signature binding.** Every response must carry a valid HMAC from
   the site's stored credential. An internal service reached by a rebind cannot
   produce one, so a rebind yields an error, not a disclosure. This is the
   control that actually holds, because it does not depend on winning a race
   with DNS.
3. **Origin pinning.** A site's origin is fixed at connection time; later calls
   never take a caller-supplied URL.

Residual risk after all three: a blind request to an internal address whose
side effect matters. Documented, accepted, monitored.

## 7. Tenancy

Every query and every mutation is scoped by organization, server-side. No route
trusts a client-supplied `organizationId`, `userId`, `siteId`, plan, or scope.

The authorization decision is derived from the token, then the resource is
loaded *filtered by* that organization — never loaded and then checked, which
leaks existence through timing and error shape.

Cross-organization access returns the same response as a missing resource.

## 8. Idempotency

Unsafe writes require an idempotency key. The key is claimed **before** the
WordPress call, bound to `(org, site, actor, tool, sha256(request))`, and
carries state through `pending → succeeded | failed | expired`.

A unique index alone is not enough: it prevents a duplicate *row*, not a
duplicate *external mutation*. The claim has to exist before the side effect.

Reuse of a key with different request metadata is a conflict, not a replay.

## 9. Metering is server-authoritative

Cost, limit, period, plan, entitlement and site count are derived server-side
from canonical data. A caller cannot supply any of them. Reservations expire
and are recovered, so a crashed call does not burn quota forever.

Rate limits and concurrency limits are **separate** from the monthly quota. A
monthly quota is a billing construct; it is not an abuse control.

## 10. AI-originated actions

The AI Gateway and Brain never receive raw site credentials. An action proposed
by a model enters the same pipeline as an action from a human, with the same
approval and snapshot gates. "The model decided" is not an authorization.

## 11. Reporting

Security contact and disclosure process: `SECURITY.md`. Incident response
runbooks: `docs/INCIDENT-RESPONSE.md`.
