# Council agent instructions

## Working preference

- Complete authorized work autonomously, including setup, configuration, testing,
  pull requests, merges, deployment, and verification. Make reasonable decisions
  independently and perform the available actions yourself.
- Avoid user handoffs. Prefer supported tools, APIs, and CLIs that let you finish
  the task directly. Do not stop at a plan, an open PR, or an unverified deployment.
- Do not ask again for routine permission already granted in the conversation.
  System, developer, and tool restrictions still apply. Never bypass safeguards.

## Repository and deployment setup

- GitHub: `kingofsunnyvale/council`, production branch `main`.
- Vercel project: `council`, team/scope `anywager`.
- Vercel project ID: `prj_HhZWX8F02VzNf28NuP8FU0tEAFHC`.
- Vercel team ID: `team_LHum2gS0hBnirnMc7aUjgRXT`.
- Vercel dashboard: <https://vercel.com/anywager/council>.
- Vercel production URL: <https://council-delta-nine.vercel.app>.
- Vercel is connected to this GitHub repository. Pushing `main` triggers production builds.
- Cloudflare account: `8b1ada8b10e9e8e5664ec10bd9d3c370`.
- Cloudflare Worker: `council-api`, URL <https://council-api.anywager.workers.dev>.
- Cloudflare Builds is connected to `kingofsunnyvale/council`, production branch
  `main`, root `/`, build command `npm test`, deploy command `npm run deploy:worker`.
  Preview builds and build caching are disabled. Reuse the existing build token.
- The exact Vercel rewrite `/api/health` forwards to the Worker's `/health`.
- Cloudflare D1 database: `council`, ID `46e3b3b2-5f5b-46c3-bd68-fabf4fb2de12`, binding `DB`.
- Worker configuration lives in `wrangler.jsonc`; use its account and resource IDs.
- Reuse these projects. Do not create replacements or deploy into unrelated projects.
- `.vercel/project.json` is a local link and is intentionally ignored. Relink a fresh
  checkout with `vercel link --yes --project council --scope anywager`.
- CLI authentication is machine-local and may expire. Verify with `vercel whoami`
  and `wrangler whoami`; refresh an existing login through the official login flow.
- Use the npm Worker scripts: their wrapper prevents Vercel's `.env.local` from
  being imported as Cloudflare bindings. Worker local secrets belong in `.dev.vars`.

## Current implementation boundary

This repository starts with deployment infrastructure, a static setup page, and a
D1-backed `/health` check. It is not yet the working AI Council dashboard.
The implementation handoff and preserved feature requirements are in `plan.md`.

The intended product broadcasts shared prompts to independently streaming models
with separate histories, saved conversations, a live model picker, web search,
per-model Stop/Retry/Copy, and reported citations and costs. No voting, debate, or
synthesis. Pin the selected model IDs for each conversation and never silently
substitute models. Verify current model IDs/capabilities against OpenRouter before
implementing the defaults; the preferred Moonshot slot is its most capable model.

The earlier product plan called for Sites/Vinext and ChatGPT authentication. The
owner subsequently requested Vercel and Cloudflare setup in this repository.
Standard Vercel/Cloudflare deployments do **not** supply trusted ChatGPT identity
headers. Do not treat incoming `oai-*` headers as authentication on these hosts.
Preserve the private-app requirement when implementing the dashboard; resolve
the authentication architecture before exposing chat or OpenRouter endpoints.

## Commands and verification

- `npm ci`: install pinned tooling.
- `npm run build`: build the setup page to `dist/`.
- `npm test`: test Worker health behavior and failure isolation.
- `npm run dev:worker`: local Worker and D1 development.
- `npm run types:worker`: regenerate Cloudflare bindings after config changes.
  The generated runtime declaration file is local and ignored by Git.
- `npm run check:worker`: validate the Worker bundle without deploying.
- `npm run deploy:worker`: deploy this Worker's checked-in configuration.
- `vercel deploy --prod --yes --scope anywager`: explicitly deploy the Vercel project.

After changes, run relevant checks and verify the deployed URLs. A successful CLI
upload is insufficient: check the final deployment and its HTTP behavior. A sign-in
redirect or 401 from an unauthenticated protected Vercel deployment is expected;
inspect it using an authorized Vercel session. Verify the Worker `/health` response
reads D1.

## Secrets and privacy

- Never commit `.env*`, `.dev.vars*`, `.vercel/`, `.wrangler/`, OAuth tokens, provider
  keys, production chat contents, or database exports.
- Keep secrets in provider secret stores; do not place them in `vars` or client bundles.
- Do not log credentials or pass secret values as command-line arguments.
- Future OpenRouter OAuth must use expiring single-use PKCE state and server-side
  encrypted credentials. No browser storage of provider credentials.
- Keep Vercel deployment protection set to **All Deployments** (`deploymentType: all`).
  Verify anonymous requests remain blocked after adding or changing domains.
- The Worker currently exposes only a non-sensitive health check. Add enforced
  authentication before adding any application, conversation, or inference API.
