# legacy/

Superseded code, kept for history. **Nothing here is built, tested, or shipped.**

| Path | What it was |
|---|---|
| `wordpress-plugin-1.0.0/` | The Bridgistic WordPress plugin at 1.0.0, from when this repo was the active one. |
| `mcp-server-1.0.0/` | The local MCP server at 1.0.0, 43 tools. |
| `TEST_COVERAGE_ANALYSIS.md` | A coverage analysis of the two above. |

Both were superseded by
[`bridgistic-claude-marketplace`](https://github.com/Shubochandrosarker/bridgistic-claude-marketplace),
which is at 1.2.0 with 54 tools, a cloud relay, and real release automation.
This repo's own commit `ee8bfe5` said so: *"Point to bridgistic-claude-marketplace
as the actively developed repo."*

## Where to go instead

- **The free plugin and local MCP server** — `bridgistic-claude-marketplace`.
  Public, GPL-2.0-or-later, free forever, no billing code.
- **The hosted platform** — the rest of this repository.

## Why this was not deleted

Deleting it would be tidier and would lose the only in-repo record of what the
1.0.0 wire format looked like. The plugin's HMAC canonical string in
`wordpress-plugin-1.0.0/includes/security/class-hmac-verifier.php` is still what
`packages/wp-client` has to match byte for byte, and having a second independent
copy of it to check against is worth a directory.

It will be removed once the hosted platform has shipped and the format is pinned
by a published contract rather than by two implementations agreeing.
