# apps/dashboard: dashboard.bridgistic.app (app.bridgistic.app 301-redirects here)

Vite + React 18 + TypeScript + Tailwind 3 + Framer Motion + Recharts. Static build for Cloudflare Pages (`dist/`, SPA `_redirects`).

```
npm run dev --workspace apps/dashboard        # http://localhost:5173, demo: /?demo=1
npm run build --workspace apps/dashboard      # tsc + vite build → apps/dashboard/dist
npm test --workspace apps/dashboard           # vitest
npm run lint --workspace apps/dashboard
```

## Data access
`src/lib/api/client.ts` defines `BridgisticClient`. Implementations:
- `BridgeClient`: real HMAC-signed calls to `https://<site>/wp-json/bridgistic/v1/*` through `@bridgistic/wp-client` (same signer as the hosted executor). The key secret lives in `sessionStorage` for that tab only and is never sent to a Bridgistic server.
- `DemoClient`: bundled sample data. Whenever it is active a gold "Demo data" banner is shown on every screen.

Routes `audit`, `approvals`, `license/*` need plugin PR Wordpressistic/bridgistic#8. On older plugins they return `rest_no_route` and the screen shows "Needs plugin update". Approval decisions and key minting stay in WP Admin; the dashboard deep-links there.

When api.bridgistic.app ships (BR-007), add a `HostedClient` implementing the same interface; screens don't change.

## Screens
Sign-in shell (account sign-in labelled Coming soon), Sites + connect flow, Overview (stats, quota bar, activity area chart, outcomes donut, top actions), Keys & scopes, Approvals, Audit log (search/filter/CSV), Snapshots (timeline, restore/delete with confirm), Usage, Posts, Media, Users, Plugins (toggle → approval), Options, Files, Database, Playbooks, Schedules (pause/resume/run now), Memory, WooCommerce, License, Coming soon, Roadmap. Feature → route map: `docs/DASHBOARD-FEATURE-INVENTORY.md`.
