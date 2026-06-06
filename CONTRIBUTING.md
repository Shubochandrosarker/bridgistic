# Contributing to Bridgistic

Thanks for helping improve Bridgistic.

## Repo layout

- `bridgistic/` — the WordPress plugin (PHP 8+, GPL-2.0).
- `bridgistic-mcp-server/` — the MCP server (TypeScript).

## Before a PR

1. **Server:** `cd bridgistic-mcp-server && npm install && npm run build && npm test`.
   Both the contract and integration evals must pass. If you change tool descriptions,
   also run `npm run eval:selection` with an `ANTHROPIC_API_KEY`.
2. **Plugin:** keep to WordPress coding standards — sanitize on input, escape on
   output, `$wpdb->prepare()` for all SQL, nonces on every admin form.
3. **The HMAC contract is load-bearing.** If you touch `signer.ts` or
   `class-hmac-verifier.php`, the canonical string must stay byte-identical on both
   sides, and the integration eval must still pass.

## Adding a tool

1. Add the REST route/controller in the plugin (inherit `Controller`, declare a scope,
   route destructive ops through `Guard`).
2. Add the MCP tool in the matching `src/tools/*.ts` module.
3. Add it to `EXPECTED` in `evals/contract.test.mjs` and add an integration assertion.
4. Add a tool-selection case to `evals/tool-selection.jsonl`.
