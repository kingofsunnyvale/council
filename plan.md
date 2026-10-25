# Frontier AI Council implementation plan

> Implementation decision (October 24, 2026): the owner selected Vercel/Cloudflare, then explicitly asked to omit additional identity verification. The implemented boundary is Vercel All Deployments protection plus a secret-authenticated gateway and browser-bound OpenRouter PKCE. The original alternatives below are retained as planning history; see `AGENTS.md` for the actual architecture.

This is the handoff for a new chat to implement. The owner explicitly asked to
finish repository setup first and leave dashboard implementation to that chat.
Read `AGENTS.md` before making changes. The current infrastructure bootstrap does
not implement the dashboard features below.

## Existing infrastructure — reuse it

- Repository: `kingofsunnyvale/council`; production branch: `main`.
- Local checkout used for setup: `/Users/avneesh/Documents/Codex/2026-10-24/p/council`.
- Vercel: project `council`, scope `anywager`, ID `prj_HhZWX8F02VzNf28NuP8FU0tEAFHC`.
- Vercel URL: <https://council-delta-nine.vercel.app>.
- Cloudflare account: `8b1ada8b10e9e8e5664ec10bd9d3c370`.
- Cloudflare Worker: `council-api`, <https://council-api.anywager.workers.dev>.
- D1: `council`, ID `46e3b3b2-5f5b-46c3-bd68-fabf4fb2de12`, binding `DB`.
- The Vercel `/api/health` rewrite forwards to the Worker's `/health`.
- Both Vercel and Cloudflare Builds are connected to `main`. Cloudflare runs
  `npm test` then `npm run deploy:worker`; preview builds and caching are disabled.
  These are independent deployments: verify both when changing shared interfaces.
- Vercel protection is set to **All Deployments**. Keep it enabled.
- `public/index.html` is only an infrastructure page; replace it during implementation.
- `worker/index.js` currently exposes a safe health check only. Replace/extend it
  with TypeScript server routes once authenticated access is implemented.
- No OpenRouter credentials, application encryption key, or conversation schema
  have been configured. Never infer they exist from the working health check.

## Hosting and authentication decision — resolve before exposing app routes

The original approved plan specified the Sites Vinext/React/TypeScript starter,
Cloudflare Workers/D1, owner-private Sites hosting, and ChatGPT authentication.
The subsequent request asked for this GitHub repo with both Vercel and Cloudflare
set up. Ordinary Vercel and Cloudflare projects do not issue trusted ChatGPT
identity headers. Deployment protection alone does not authenticate a direct
request to a separately exposed Worker.

At the start of implementation, resolve this one architectural mismatch with the
owner rather than silently changing the authentication requirement:

1. **Use the new Vercel/Cloudflare infrastructure:** React/TypeScript frontend and
   a thin server layer on Vercel, Workers/D1 for the application backend. Use an
   owner-only identity flow supported on these hosts (for example, GitHub OAuth
   with a server-enforced owner ID allowlist). Treat this as an explicit change
   from the original ChatGPT-auth requirement. Verify identity at every boundary;
   keep a server-only signed or secret-authenticated Vercel-to-Worker connection.
2. **Keep ChatGPT authentication exactly as originally requested:** use the Sites
   Vinext starter and private Sites deployment for the authenticated application;
   keep this repo as the source and document the role of the separately provisioned
   Vercel/Cloudflare resources. A private, unpublished Site was reserved earlier as
   `appgprj_6add83637c248191a3fe36a699cdfed8` (`frontier-council-avneesh`). Inspect and
   reuse it if appropriate; do not create duplicates or treat it as already deployed.

The earlier starter is available at `../work/frontier-council` relative to this
checkout. It has no completed application features. Use the Sites skill if taking
the Sites route. Never trust client-supplied `oai-*` headers on external hosting.

## Experience

Send a shared text prompt to one to eight selected models concurrently. Stream
each answer independently, retain each model's separate conversation history,
and save conversations. No synthesis, voting, or debate.

Use a dark responsive interface with a shared composer, independently scrolling
panels, and an expanded reading view. Show model identity, Markdown answer text,
returned sources, elapsed time, and reported usage/cost. Include per-model Stop,
Retry, and Copy, plus Stop all and New chat. Changing the lineup starts a new
conversation. Pin exact model IDs for the life of a conversation.

## Requested initial lineup

Validate each ID and capabilities against OpenRouter's live model catalog before
enabling it. Do not silently replace an unavailable model.

| Provider | Requested model | Requested OpenRouter ID |
| --- | --- | --- |
| OpenAI | GPT-6 Astra | `openai/gpt-6-astra` |
| Anthropic | Claude Opus 5.5 | `anthropic/claude-opus-5.5` |
| Google | Gemini 4 Argon | `google/gemini-4-argon` |
| xAI | Grok 4.7 | `x-ai/grok-4.7` |
| Moonshot | Kimi K3.1 Pro | `moonshotai/kimi-k3.1-pro` |
| Z.ai | GLM 5.3 | `z-ai/glm-5.3` |
| Mistral | Mistral Large 4 (preview) | `mistralai/mistral-large-4-0` |

Prioritize capability over cost. The owner explicitly requested the best Kimi
model. Default to high reasoning and a 32,768-token completion cap, including
reasoning, subject to the actual model's supported parameters. Show live prices
and capabilities in a searchable picker and before prompt submission.

## Search and OpenRouter

Connect the owner's OpenRouter account with OAuth and PKCE. Exchange codes on
the server. Persist expiring single-use state, and encrypt credentials in D1
using a runtime secret. Never store credentials in browser storage or logs.

Give each model OpenRouter's web-search tool using Exa, allowing independent
queries with up to three searches and five results per search. Include search Off.
Verify the current API's tool support and budget parameters before implementing.
Show only returned citations and reported usage/cost. Render Markdown safely.

## Concurrency and persistence

Create a shared turn once, then independently start one streaming request per
model. Prevent duplicate submissions and attempts. Keep partial answers, isolate
errors per panel, and make retries explicit. Follow-ups include shared user
messages plus only that model's own prior assistant answers.

Authenticate account connection, discovery, conversation management, turn
creation, cancellation/retry, and streaming routes. The original plan specified
owner-private Sites hosting and ChatGPT auth; the later request added this repo's
Vercel and Cloudflare setup. Resolve that hosting/auth boundary explicitly before
deploying application APIs. Vercel deployment protection is currently enabled,
but is not a substitute for validating identity at a separately exposed Worker.

## Acceptance checks

- All seven requests start concurrently and stream independently.
- A current-information prompt exercises real search and returned citations.
- Separate histories, saved reloads, selection, cancellation, retry, and mobile UI work.
- Insufficient credits, unavailable models, interrupted streams, duplicate
  submissions, invalid OAuth state, and unauthorized access are handled.
- Verify the deployed application, and report any missing OpenRouter authorization
  or credits that prevent live inference tests.

## Implementation sequence

### 1. Establish the application boundary

- Finish the hosting/authentication decision above; document it in `AGENTS.md`.
- Keep a single source of truth for deployment config and explicit public origins.
- Protect every account, model-discovery, conversation, turn, attempt, and stream
  endpoint. Validate owner identity server-side, including on direct Worker URLs.
- Use secure, HttpOnly, SameSite cookies as appropriate. Check Origin/CSRF on
  mutations, enforce request size limits, and reject invalid model counts/IDs.
- Keep provider keys, encryption material, and service credentials on the server.
  Put required secret **names** in an example file, never their actual values.

### 2. Build D1 persistence and OpenRouter connection

Use versioned migrations with ownership and uniqueness enforced in the database.
A useful schema includes users, encrypted account connections, OAuth states,
conversations with ordered pinned model IDs, shared turns, and per-model attempts.
Persist prompt text, visible answer text, status, timestamps, returned citations,
provider request IDs, and reported usage/cost. Retain failed/cancelled partials.

For OpenRouter OAuth:

- Generate a cryptographically random verifier and S256 PKCE challenge.
- Persist expiring state tied to the authenticated owner/session and a known
  callback origin. Consume state atomically once; reject expired/replayed states.
- Exchange the returned code server-side at the documented OpenRouter endpoint.
- Encrypt the resulting credential with authenticated encryption (for example
  AES-GCM with a fresh nonce and owner ID as associated data), using a runtime
  secret. Plan key versioning/rotation and account disconnection.
- Redact callback codes, state, verifiers, and keys from logs and client responses.
- Check connection/credit status via documented APIs; no assumed balance.

### 3. Fetch and present the model catalog

Retrieve <https://openrouter.ai/api/v1/models> server-side with bounded caching.
Validate the seven requested IDs, reasoning/tool support, context/output limits,
and pricing against the live catalog. If a requested ID is absent, surface that
fact and require an explicit selection; never silently substitute.

Provide search and selection for one to eight models. Show provider/model name,
context limits, relevant capabilities, and current per-token prices with units.
Explain that costs are estimates until the provider reports usage. A new lineup
starts a new conversation; historical conversations keep their pinned IDs.

### 4. Implement independent attempts and streaming

- Create a shared turn once with an idempotency key. Atomically create/claim an
  attempt for each selected model; duplicate browser requests must not bill twice.
- Launch all model requests concurrently. An early failure from one model must
  not delay or cancel the other panels. Do not use OpenRouter model fallbacks.
- Reconstruct each request from shared user turns and that model's own prior
  assistant answers. Never leak another panel's answer into its history.
- Stream visible answer deltas using a proper SSE parser that handles split
  frames, comments, provider errors, final usage events, and stream termination.
  Do not terminate at the first finish_reason if usage follows in another event.
- Preserve partial text periodically and on cancellation/error. Bound buffering,
  stream duration, and database writes. Store only useful visible response data,
  not hidden chain-of-thought or fabricated tool activity.
- Support independent Stop, explicit Retry, and Stop all. Cancellation must work
  across Worker instances; do not rely on a process-global AbortController map.
  Persist cancellation/attempt state and abort the upstream request when observed.
- Use attempt leases/heartbeats or another explicit recovery mechanism so reloads
  and dead streams become recoverable interrupted attempts rather than running forever.
- Track elapsed time per attempt and retain the provider's reported usage/cost.
  Use unknown/unavailable states when metrics are missing; do not invent zeros.

### 5. Add server-side web search

Verify OpenRouter's current web-search tool schema and streaming behavior against
official docs. The requested design uses `openrouter:web_search` with Exa, up to
three uses and five results per use. Each model decides its own queries. Default
search on when useful and provide an Off toggle. Do not claim that one shared
search is independent model search. Display only citations actually returned by
the provider and sanitize citation URLs. Explain search charges alongside token
pricing. If a model/API cannot enforce the requested limits, show that limitation.

### 6. Build the dashboard

- Dark, polished, responsive React/TypeScript UI with a saved-conversation sidebar,
  searchable model picker, shared composer, and one to eight response panels.
- States: ready, connecting, thinking/responding, complete, stopped, interrupted,
  and error; show accurate activity only.
- Independently scrolling panels; readable expanded panel view; keyboard controls
  and clear focus/accessible labels. Avoid forcing scroll while the owner reads.
- Safe Markdown without raw HTML injection. Per-panel Copy, Retry, and Stop.
- Returned sources and reported metrics are associated with the right attempt.
- Reload saved conversations without crossing model histories. Protect dirty
  drafts and disable only controls whose actions would violate turn invariants.
- Handle small screens deliberately, including composer/keyboard overlap.

### 7. Verify and deploy

Use deterministic provider fixtures for error/security/concurrency tests, and a
real authorized OpenRouter account for the final live check. Verify seven upstream
requests start concurrently, independently stream, and separately exercise search.
Test all acceptance checks above, plus direct Worker access, CSRF/ownership checks,
OAuth replay/expiry, malicious Markdown/citation URLs, and multiple browser tabs
submitting the same turn. Check desktop and narrow mobile layouts visually.

Apply migrations to the intended database, configure runtime secrets securely,
build, deploy privately, and verify the final URL. Update `AGENTS.md`/README with
the actual architecture, commands, auth boundaries, and any automatic deployment
rules. Report live-test dependencies on OpenRouter authorization or credits
explicitly. Never claim model answers or paid search were tested without running them.
