# Council

Infrastructure for a private, multi-model AI Council dashboard.

- **Vercel:** frontend deployment, connected to this repository's `main` branch.
- **Cloudflare Workers:** backend runtime, configured by `wrangler.jsonc`.
- **Cloudflare D1:** database bound to the Worker as `DB`.

The current deployment is an infrastructure preview. Model conversations,
OpenRouter OAuth, search, and the dashboard UI have not been implemented yet.

See [AGENTS.md](AGENTS.md) for the existing hosting resources, authentication
constraints, deployment commands, and instructions for future coding agents.
The dashboard implementation handoff is in [plan.md](plan.md).

## Develop and verify

```sh
npm ci
npm run build
npm test
npm run check:worker
npm run dev:worker
```

The Worker's `GET /health` checks D1 connectivity and returns a small JSON status.
It returns 503 if D1 is unavailable. Other paths return 404 and unsupported health
methods return 405. No model credentials or private application data are served.

## Deploy

Vercel builds `dist/` using `npm run build`. Its GitHub integration deploys `main`.
For an explicit deployment, run `vercel deploy --prod --yes --scope anywager`.
Deploy the Worker with `npm run deploy:worker` after checking the account and
bindings in `wrangler.jsonc`. Do not assume a Vercel deployment also deploys the Worker.
