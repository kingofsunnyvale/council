# Council agent instructions

## Working preference

Complete authorized implementation, configuration, testing, deployment and verification autonomously. Prefer supported tools and CLIs. Do not stop at a plan or an unverified upload. Never bypass mandatory safeguards.

## Architecture and access boundary

The owner chose Vercel/Cloudflare, omitted additional identity verification, and explicitly authorized public visitors to share the connected OpenRouter credits and conversations. Council is a public shared workspace.

- The canonical production URL is public. Vercel Standard Protection (`ssoProtection.deploymentType: prod_deployment_urls_and_all_previews`) protects generated deployment URLs and previews. Do not restore an authentication gate on the canonical URL without a new owner request.
- `PUBLIC_SHARED=true` in Wrangler locks account mutation and OAuth endpoints. Anyone may create a browser session and use the shared chats/credits, but only the owner manages the stored credential through trusted deployment tools. Public account status omits key limits and overall account usage.
- The React/TypeScript frontend and thin Node.js gateway (`api/gateway.ts`) run on Vercel. An explicit `/api/:path*` rewrite routes every API depth to it; do not rely on framework-specific catch-all filenames. Only the gateway has the server-side `SERVICE_SECRET`.
- The Cloudflare Worker checks that secret before every application endpoint. It never trusts incoming `oai-*`, user IDs, or client-supplied identity headers.
- The gateway forwards only cookies, Origin, and Content-Type, and constructs its own service-authentication header. The direct Worker URL exposes only the non-sensitive D1 health check without that credential.
- A secure, HttpOnly, SameSite=Lax browser session identifies a visitor session within the shared workspace. Session creation requires both gateway authentication and a valid Origin. It is not a second user-identity check.
- Keep the canonical public origin and Worker origin in `shared/config.ts`. Preview deployments deliberately lack production credentials and fail closed. Use the canonical production URL for the app and OAuth callbacks.

## Existing infrastructure — reuse it

- GitHub: `kingofsunnyvale/council`, production branch `main`.
- Vercel project: `council`, scope `anywager`, project `prj_HhZWX8F02VzNf28NuP8FU0tEAFHC`, team `team_LHum2gS0hBnirnMc7aUjgRXT`.
- App: <https://council-delta-nine.vercel.app>.
- Cloudflare account: `8b1ada8b10e9e8e5664ec10bd9d3c370`.
- Worker: `council-api`, <https://council-api.anywager.workers.dev>.
- D1: `council`, ID `46e3b3b2-5f5b-46c3-bd68-fabf4fb2de12`, binding `DB`.
- Both hosts build from `main`. Cloudflare Builds runs `npm test` followed by `npm run deploy:worker`; previews and build caching are disabled. Pushing `main` triggers production changes on both hosts.
- `/api/health` on Vercel rewrites to Worker `/health`. Other API routes pass through the authenticated Node gateway.
- Reuse these projects; do not create replacements. `.vercel/project.json` is a local ignored link. Relink with `vercel link --yes --project council --scope anywager`.

## Product invariants

One shared prompt creates one persisted turn and one independently streamed attempt per selected model. Each model sees shared user turns and only its own completed assistant history. There is no synthesis, aggregate vote, or debate. Each model independently supplies a YES/NO conclusion for binary questions.

- Pin exact ordered model IDs for each conversation. A changed lineup starts a new one. Do not silently substitute unavailable models.
- Validate models, pricing, tool support and reasoning efforts against the live OpenRouter catalog. The requested defaults, including Kimi K3.1 Pro, live in `shared/config.ts`.
- Default to high reasoning when advertised and cap completion at 32,768 tokens, subject to model limits.
- Search uses `openrouter:web_search`, Exa `auto`, `max_uses: 3`, `max_results: 5`, `max_total_results: 15`. Each model chooses its own searches. Search Off omits tools.
- Automatically recognize any yes/no question or decision. Require the responding model to make its own YES or NO choice (no neutral option), independent of the side requested in the prompt. Show a green YES or red NO badge only after successful completion; open-ended requests have no badge. Persist verdicts per attempt, never infer them from keywords in prose, and never expose verdict metadata in answers or subsequent model history.
- Persist partials, returned citations, provider IDs and only reported usage/cost. Missing metrics remain unknown. Never store hidden chain-of-thought.
- D1 enforces ownership, model membership, turn versions and idempotency. Stream claims are atomic. Cancellation is stored in D1, polled every 2 seconds, and aborts upstream; it is not a process-global controller map.
- Attempts have 30-second leases and a 270-second duration cap, below the gateway's 300-second cap. Expired attempts become interrupted on the next application read. Retry is explicit and only allowed on the latest turn. Previous attempts remain available.

## Commands and verification

Use Node.js 24, aligned across `.node-version`, `package.json`, Vercel and GitHub Actions.

- `npm ci`
- `npm run typecheck` — regenerate Worker types and check TypeScript.
- `npm test` — deterministic SQLite-backed security, concurrency, persistence and provider-stream tests.
- `npm run build` — Vite production frontend.
- `npm run check:worker` — Worker dry-run bundle.
- `npx playwright install chromium && npm run test:e2e` — desktop/mobile browser tests with explicitly mocked provider data.
- `npm run db:local` / `npm run db:remote` — apply versioned migrations to the intended database.
- `npm run dev:worker` and `npm run dev` — local Worker and frontend. Put local secrets in `.dev.vars`. Local origin is explicitly set by the Worker dev command.
- `npm run deploy:worker` and `vercel deploy --prod --yes --scope anywager` — deploy existing projects.

Verify the final deployments, not just CLI uploads. Confirm the canonical app loads without Vercel authentication, a new anonymous browser can join the shared workspace, account mutation and OAuth return 403, spoofed/direct Worker application requests return 401, and health reads D1. Use ordinary curl for public production checks. Provider fixtures are not live inference: report OpenRouter authorization/credits and real-search verification separately.

## Secrets and privacy

Never commit `.env*` except `.env.example`, `.dev.vars*`, `.vercel/`, `.wrangler/`, `work/`, credentials, production conversations or database exports. Do not log credentials or pass secret values as command-line arguments. Use stdin and provider secret stores.

- `SERVICE_SECRET`: matching random value on the Worker and Vercel production gateway.
- `ENCRYPTION_KEYS`: Worker-only JSON keyring `{ "current": "v1", "keys": { "v1": "<32-byte base64url key>" } }`.
- OpenRouter credentials are encrypted in D1 with AES-GCM, a fresh nonce and workspace ID as associated data. The retained OAuth implementation is disabled in public shared mode; in private mode its state expires after ten minutes and is atomically consumed once.
- Rotate the keyring by adding a new version and changing `current`; retain old versions until existing encrypted records have been re-encrypted or disconnected. Never discard an old version while it is referenced.
- App code does not log callback URLs, codes, verifiers, keys or prompts. Worker invocation logging is disabled to avoid request-URL logging.
- `scripts/wrangler.mjs` prevents Vercel `.env.local` credentials from becoming Worker bindings. Always use that wrapper.
