# Council

A public, shared workspace for sending a question to one to eight models. Answers stream independently, conversations are saved, and each model retains only its own assistant history.

Production: <https://council-delta-nine.vercel.app> (public; no sign-in required).

## Access and account connection

Anyone can open Council and use the same saved conversations and host-provided OpenRouter credits. The owner explicitly chose this shared public mode. No Vercel, GitHub, or ChatGPT sign-in is required on the canonical production URL.

The key remains encrypted in D1 and is never returned to browsers. Public visitors cannot replace or disconnect it, and account-wide usage and key limits are not exposed. Credential maintenance uses the owner's trusted deployment tools. The Worker still rejects direct application requests without the server-only gateway secret. Vercel Standard Protection remains on generated deployment URLs and previews.

## Features

- Questions appear once, followed by a grid of model responses. New conversations start with a composer and the selected models.
- Neutral dark interface, expandable sources and usage details, and individual response reading views.

- Live searchable catalog, explicit 1–8 model selection, current base prices and capabilities.
- Requested defaults: GPT-6 Astra, Claude Opus 5.5, Gemini 4 Argon, Grok 4.7, Kimi K3.1 Pro, GLM 5.3, and Mistral Large 4. All seven were present in the catalog on October 24, 2026. Unavailable IDs are surfaced, never replaced silently.
- High reasoning when supported; completion cap of 32,768 tokens, including reasoning, bounded by each model's advertised limit.
- Model-controlled Exa search (Auto/Off), up to three searches and five results per search per model. Returned citations and reported usage/cost are attached to each response. Token prices, tier caveats and search charges appear under **Prices & limits** before sending.
- Automatic green **YES** / red **NO** badges for binary questions and decisions. Each model must choose its own conclusion, even if the prompt suggests the opposite. Badges appear after completion and persist in saved chats and previous attempts; open-ended questions have none. Existing answers retain their original content without retroactive classification.
- Per-model Stop, Retry, Copy and expanded reading; Stop all; saved conversations; safe Markdown; mobile layout and keyboard navigation.
- Atomic stream claims, versioned turns, idempotent submissions/retries, 2-second checkpoints/cancellation polling, and 30-second recovery leases. A response is capped at 270 seconds; interruption never automatically starts another billable attempt.
- Failed/cancelled partials and previous retries remain visible. Follow-ups use shared prompts and the model's latest completed answer for each prior turn; incomplete answers are excluded. Retrying an older turn after a follow-up is disallowed so history stays consistent.

## Development

Use Node 24. `npm ci`, then create an ignored `.dev.vars` with local `SERVICE_SECRET` and `ENCRYPTION_KEYS` values as described in `AGENTS.md`. `npm run db:local` applies local migrations. Run `npm run dev:worker` and `npm run dev` in separate terminals; open <http://localhost:5173>. The development gateway reads only `.dev.vars`, never `.env.local`.

```sh
npm run typecheck
npm test
npm run build
npm run check:worker
npx playwright install chromium
npm run test:e2e
```

The backend tests use SQLite and deterministic upstream fixtures to exercise concurrent starts, stream framing, late usage, isolated failures, cancellations, recovery, OAuth replay/expiry, ownership, request limits and malicious URLs. Browser tests use mock responses and check desktop/mobile layouts, safe Markdown, persistence and draft protection. These tests do not spend OpenRouter credits or prove live provider/search behavior.

Production verification on October 24, 2026 also exercised the seven default models with a real OpenRouter account. All seven requests started within 968 ms, completed independently, returned search citations and reported usage, and were read back from D1. The reported total for that check was $0.191704. The supplied account key is stored encrypted on the backend.

## Deployment

Reuse the existing projects and database identified in `AGENTS.md`. Apply `npm run db:remote` before deploying a schema change. Store matching `SERVICE_SECRET` values in Vercel production and Worker secrets, and store `ENCRYPTION_KEYS` only on the Worker. `.env.example` contains names, never real values.

GitHub `main` triggers independent Vercel and Cloudflare production builds. GitHub Actions runs type checking, unit tests, the frontend build, Worker bundling and desktop/mobile tests. Verify both hosts after pushing; CLI upload success alone is insufficient. Preview deployments lack production secrets and fail closed.

The canonical origin is in `shared/config.ts`; use it for the application and OpenRouter callback. The Worker's unauthenticated `/health` reads D1 and returns no private data. All application endpoints require the gateway secret, and all data endpoints additionally require a browser session. Mutations validate Origin and request sizes.

Search API reference: [OpenRouter server-side web search](https://openrouter.ai/docs/guides/features/server-tools/web-search). Connection reference: [OpenRouter OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth).
