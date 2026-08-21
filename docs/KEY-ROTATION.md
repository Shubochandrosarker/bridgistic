# Rotating `TENANT_ENC_KEY`

**Build this before you need it.** The free repo's `cloud/src/crypto.ts`
documents the trap plainly:

> Replacing TENANT_ENC_KEY does not migrate existing rows — every stored secret
> encrypted under the old key becomes undecryptable, and those tenants must
> reconnect.

"Those tenants" is every connected site. A key rotation done the obvious way —
`wrangler secret put TENANT_ENC_KEY` — is a full outage for every customer, with
no error message that explains why, and no way back unless the old key was kept.

## The shape of a safe rotation

`sites.enc_key_version` exists for exactly this. It records which key generation
each row is sealed under, so a rotation can walk rows, resume after a failure,
and be observed while it runs. Without it, a half-finished rotation is
indistinguishable from a corrupt table.

1. **Add the new key alongside the old one.** The Worker reads
   `TENANT_ENC_KEY` (version *N*) and `TENANT_ENC_KEY_NEXT` (version *N+1*).
   Decryption tries the version named on the row; encryption always uses *N+1*.
2. **Walk the rows.** For each site with `enc_key_version = N`: decrypt with the
   old key, re-encrypt with the new one, write both the envelope and
   `enc_key_version = N+1` in the same statement. Batch it, and let it resume —
   `SELECT … WHERE enc_key_version = N LIMIT 100` is the whole cursor.
3. **Wait for zero.** `SELECT COUNT(*) FROM sites WHERE enc_key_version = N`
   must be 0. Until it is, both keys must remain set.
4. **Promote.** Move the new key into `TENANT_ENC_KEY`, unset
   `TENANT_ENC_KEY_NEXT`, deploy.
5. **Destroy the old key** only after a full backup cycle has rolled over — an
   export taken before step 4 is still sealed under the old key.

## When to rotate

- On any suspicion of exposure of the key material or a D1 export.
- On a scheduled cadence once the platform has paying customers, because being
  *able* to rotate is what makes step 1 of an incident response fast instead of
  terrifying.

## What never happens

- The migration in `db/migrations/0001_tenancy.sql` does **not** re-encrypt. It
  copies the envelope across byte for byte. Re-encrypting during a schema
  migration would mean holding the key at migration time and would turn a
  reversible change into an irreversible one.
- A site is never asked to reconnect as part of a rotation. If a rotation ever
  requires that, it was done wrong.
