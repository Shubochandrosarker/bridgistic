# Bridgistic — Evaluations

Three layers, two runnable with zero external dependencies.

| Eval | What it proves | Backend needed |
|------|----------------|----------------|
| `contract.test.mjs` | The tool surface is correct: all 43 tools present + namespaced, each has a title and a real description, every site-targeting tool exposes `site`, and every write tool exposes the guard params (`dry_run` / `approval_id` / `force`). | none |
| `integration.test.mjs` | End-to-end through real `tools/call`: a mock bridge re-verifies the HMAC signature exactly like the PHP plugin, then asserts each tool hits the right route + method, forwards its body and guard params, and that **DELETE carries a signed body**. | none (built-in mock) |
| `run-tool-selection.mjs` | Claude picks the **right tool** for a natural-language task, using the live tool descriptions. Catches description drift. | Anthropic API key |

## Run

```bash
npm run build          # compile first
npm run test           # contract + integration (no key needed)
npm run test:contract
npm run test:integration

# LLM-judged tool selection (optional):
ANTHROPIC_API_KEY=sk-... npm run eval:selection
```

## Extending

- Add tool-selection cases to `tool-selection.jsonl` — one JSON object per line: `{"task": "...", "expect": "bridgistic_..."}`.
- Add integration assertions in `integration.test.mjs` against the mock's `received[]` log.
- Before tagging a release, all three should pass (selection needs a key).
