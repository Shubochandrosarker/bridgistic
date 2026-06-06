# Security Policy

## Reporting a vulnerability

Do not open a public issue for security reports. Email the maintainer at
security@wordpressistic.com with details and reproduction steps. You will get an
acknowledgement within 72 hours.

## Design notes for reviewers

- **Authentication.** Every request is HMAC-SHA256 signed over
  `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(body)`. Keys are scoped and stored
  encrypted (libsodium / AES-256-GCM). There is no Application Password path.
- **Replay protection.** A ±300s timestamp window plus a single-use nonce.
- **Transport.** HTTPS is required; query-string read parameters rely on TLS for
  integrity. All sensitive and mutating parameters travel in the signed body.
- **Least privilege.** Keys carry an explicit scope set; the options tool is
  allowlist-enforced on both read and write; PHP can only be written to a
  quarantined sandbox with web execution blocked.
- **Reversibility.** Destructive operations snapshot first and can require human
  approval; approvals are bound to an action+payload hash.
- **Internal dispatch.** Playbook steps run through the real REST pipeline using
  a per-run random token held only in process memory; it cannot be forged by an
  external request.

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅        |
