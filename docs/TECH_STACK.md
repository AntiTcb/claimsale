# Tech Stack — Decisions and Open Questions

Versions are the latest on npm as of **2026-10-08**. Platform facts were checked
against Cloudflare's docs on the same date. Decisions are numbered **S#**; open
questions are **T#**, each with a recommended default in *italics*.

---

## 1. Decisions (round 5)

| # | Decision |
| --- | --- |
| S1 | **Two Workers in a pnpm monorepo:** `web` (SvelteKit) and `engine` (Durable Objects, Queue consumer, cron). See section 2. |
| S2 | **SvelteKit remote functions** (`query` / `form` / `command`), enabled via `kit.experimental.remoteFunctions` and wrapped in one thin layer of our own. |
| S3 | The web Worker calls the engine through **Workers RPC** (`WorkerEntrypoint` methods). |
| S4 | ~~Zod~~ → **Effect Schema** (superseded by S26/T24). |
| S5 | **Drizzle** for schema and migrations (query layer: T25). |
| S6 | **D1 FTS5** for search at launch. |
| S7 | Environments: **local, per-PR preview, staging, production**, with staging from day one. How previews work: T30, plus Worker Previews for web-only PRs (S37). |
| S8 | **Better Auth.** |
| S9 | Sign-in: **email + password, magic link, Discord.** (No Google or passkeys at launch.) |
| S10 | **Twilio Verify** for phone OTP, rejecting VoIP numbers. |
| S11 | **shadcn-svelte** (bits-ui, Tailwind v4), with light and dark themes following the system setting. |
| S12 | Limited Markdown in descriptions, plain text in messages. |
| S13 | **`@ethercorps/sveltekit-og`** ([sveltekit-og.dev](https://sveltekit-og.dev)) for share images, cached in R2 per sale version. It renders Svelte components, uses satori + resvg-wasm internally, and detects workerd at runtime. |
| S14 | A hand-written service worker (manifest + push only). |
| S15 | Hand-written client-side image resizing (WebP, max 2000px). |
| S16 | **Sentry** + Cloudflare Web Analytics. Seller analytics use Analytics Engine. The observability design is in section 4. |
| S17 | **oxlint + oxfmt** (not ESLint/Prettier). Covering Svelte templates: T37. |
| S18 | GitHub Actions for CI/CD. |
| S19 | Stripe Billing + Stripe Tax (and Stripe Connect later). Svelte email templates. In-app `/admin`. Node 24 LTS, pnpm and `compatibility_date` pinned. |
| S20 | **Effect 4** (`effect@4.0.2`) as the server-side application framework. See section 3. |
| S21 | **Deep structured logging and clean OpenTelemetry** through to Sentry and Cloudflare. See section 4. |
| S22 | **Renovate** for dependency updates. See section 6. |
| S23 | ~~Doppler for secrets~~ → **superseded by S35** (2026-10-29). |
| S24 | **Git flow: feature PRs → `dev`; `dev` is batched into releases → `main`; `main` is always production.** Conventional commits, CI required, proprietary. See section 7. |
| S25 | **Full test suite: unit, browser, Workers integration and E2E (Vitest + Playwright). Every feature and bug fix ships with tests.** See [`TESTING.md`](./TESTING.md). |
| S26 | Round 6 defaults, all accepted: Effect Schema replaces Zod (T24); Drizzle for queries inside an Effect service (T25); Effect is server + core only, except Schema in the client with a bundle budget (T26); the domain core is pure functions (T27); the tracing bridge with a Phase 0 spike (T28); the logging policy (T29); a full Worker pair + D1 per PR (T30); seed data (T31); Cloudflare Access on non-production (T32); CalVer + git-cliff, releases on demand (T33); expand/contract migrations with approval and a Time Travel bookmark (T34); the Renovate policy (T35); the Doppler layout (T36, later superseded by S35); svelte-check + type-aware oxlint + the `{@html}` guard (T37). |
| S27 | Testing round 7 defaults, all accepted: Vitest 4.1 for Workers tests and 5 elsewhere until the pool supports 5; coverage thresholds + ratchet; nightly Stryker on core (≥ 80%); CI-generated visual baselines; the browser matrix; guarded test-only engine endpoints; the tests-with-changes guard; GitHub-only coverage reporting; the spec traceability check against STATE_MACHINES section 10. |
| S28 | **Cloudflare Email Service replaces Resend** for all outbound email. See section 10. |
| S29 | **Import/export libraries:** `papaparse` 5.7.0 (CSV), `read-excel-file` 9.3.12 / `write-excel-file` 4.1.1 (XLSX), `fflate` 0.8.3 (ZIP). **Not** the npm `xlsx` package: it's frozen at 0.18.5 because SheetJS now publishes only from its own CDN, and Renovate can't track it. |
| S30 | **Cloudflare account: AntiTcb** (`e89111551171752d4230693ae0c83ed6`). Every Worker, D1, R2, Queue, Email Service domain and Access policy lives there. |
| S31 | **Name: ClaimSale · Domain: `claimsale.net`** (provisional, "for now"). Hostnames: `claimsale.net` (production web), `staging.claimsale.net` (staging, behind Access), `notify.claimsale.net` (Email Service sending subdomain, e.g. `no-reply@notify.claimsale.net`), and PR previews on `*.workers.dev` behind Access. The domain lives in the AntiTcb account, registered through Cloudflare Registrar if `.net` is offered there, otherwise elsewhere with nameservers pointed at Cloudflare. **Kept in config, not code:** the domain and sender addresses are `vars` in `wrangler.jsonc` per environment, so a rename is a config change. |
| S32 | **TCG catalog ingestion (TCGCSV only, D60):** an engine cron (daily, after TCGCSV's ~20:00 UTC refresh) enqueues one job per game and set. Consumers upsert `games` / `catalog_sets` / `catalog_products` and the latest `market_prices` (per product + subtype) in D1, with an FTS5 index for autofill. No images are ingested. Prices are a seller-only listing aid (D64). `TcgCsvSource` is an Effect service with rate limiting, a descriptive `User-Agent`, retries and MSW fixtures. The ingestion is idempotent and resumable, and its progress is visible in `/admin`. The source's terms and attribution are checked before the build. |
| S33 | **Photo authenticity (D63):** an engine Queue job decodes each upload in WASM (`@jsquash/webp` 1.5.0, `@jsquash/jpeg` 1.6.0; `@jsquash/resize` 2.1.1 for downscaling) and computes dHash and pHash (our own small implementation in `packages/core`, property-tested), for the original, mirrored and rotated versions. Near-duplicates are found through a D1 index of 4 × 16-bit bands (multi-index hashing) followed by a Hamming-distance check. This avoids the Cloudflare Images binding, which needs a separate Images Paid subscription. |
| S34 | **Milestone 0 findings (2026-10-09):** (1) `@cloudflare/vitest-pool-workers` is renamed **`@cloudflare/vitest-plugin`** (`cloudflareTest()` Vite plugin). Its first Vitest 5 release (1.4.0) is 1 day old and depends on an alpha Miniflare, so the engine stays on Vitest 4.1 + plugin 1.3.6 until it clears the 3-day release-age window. (2) SvelteKit 3 moved config into `sveltekit({...})` in `vite.config.ts` and replaced `$lib` with `#lib` subpath imports. (3) adapter-cloudflare 8 no longer passes `platform`; bindings come from `cloudflare:workers`. (4) Two `wrangler dev` processes crash each other in some environments, so local dev and E2E run **both Workers in one process** (`wrangler dev -c web -c engine`). (5) TypeScript is pinned to **6.0.x**, because SvelteKit 3 and svelte-check don't support TypeScript 7 yet. (6) pnpm's `minimumReleaseAge` (3 days) is enforced at install time. |
| S35 | **No Doppler for now (2026-10-29).** Secrets live as **GitHub Environment secrets** (`preview`, `staging`, `production`). CI passes each Worker secret **by name** as an environment variable on the deploy step (never `toJSON(secrets)`, which GitHub flags as possibly malicious and holds for approval), and `scripts/secrets-for.ts` collects the names in each Worker's `secrets.required`, and wrangler uploads them with `--secrets-file`. Locally, secrets go in each app's `.dev.vars` (gitignored). Doppler can be reintroduced later behind the same `secrets-for.ts` step. |
| S36 | **Cloudflare CLI (`cf`, beta, pinned `1.0.0-beta.29` since 2026-11-13) for provisioning (2026-10-29).** D1, queues, Worker deletion, D1 Time Travel bookmarks and **remote D1 migrations** (`cf d1 migrations apply`, which uses the same tracking table as wrangler) run through `cf`, via `scripts/cf-resources.sh` and the setup wizard. **Deploys, local dev and type generation stay on wrangler**, because adapter-cloudflare builds against `wrangler.jsonc` and moving to `cloudflare.config.ts` (`cf migrate`) waits for `cf` to leave beta. `cf` needs Node ≥ 22.23 / 24.22. Note: `cf` ≥ 1.0.0-beta.31 requires wrangler ≥ 4.161.0 for the commands that build (`cf dev`, `cf build`, `cf deploy`); provisioning commands don't build, so bump both together when Renovate offers it. |
| S37 | **Cloudflare Worker Previews for web-only PRs (2026-11-13).** Worker Previews (`wrangler preview`, open beta, wrangler ≥ 4.135) create a Preview of an existing Worker with its own URL, config and Durable Object namespace. Three limits rule them out as a full replacement for the per-PR pair (T30): a Preview's service binding reaches the bound Worker's **deployed** version, never another Worker's Preview; Previews don't consume queues; and crons don't run in them. So: **`scripts/preview-kind.ts`** gives a PR a **Worker Preview** of `claimsale-web-staging` (`--name pr-<n>`, URL `pr-<n>-claimsale-web-staging.<subdomain>.workers.dev`) when every changed file is under `apps/web/`, `docs/` or a root `*.md`. Its `ENGINE` binding points at `claimsale-engine-staging`, so it reads and writes **staging data**. Every other PR keeps the isolated pair. Preview settings live in `env.staging.previews` in `apps/web/wrangler.jsonc`, and Previews inherit nothing from the Worker's own settings. **Production has no `previews` block on purpose**: without one, `wrangler preview` refuses to run, which keeps any Preview off the production engine. Never accept wrangler's offer to generate one there. Preview secrets are listed in `previews.secrets.required` and passed with `scripts/secrets-for.ts --previews` (S35). Locally, `pnpm preview` builds and creates a Preview named after the current git branch. Cleanup deletes the PR's Worker Preview and its pair, whichever exist. Revisit when Previews can bind to a matching Preview of another Worker. |
| S38 | **Observability spike outcome, T28 (2026-11-13): keep the bridge; report server errors without the Sentry SDK.** `CloudflareTracer` maps Effect spans onto Workers custom spans, nests them with `tracing.withActiveSpan()` and uses `span.spanContext()` IDs in log lines. It feature-detects both, because the workerd used by the Workers test pool (1.20261001) lacks them; wrangler 4.160's local runtime has them. **Server errors go to Sentry through our own envelope reporter** (`packages/observability/src/sentry.ts`, ~150 lines, `fetch` only), not `@sentry/cloudflare` / `@sentry/sveltekit`: the SDKs wrap handlers and Durable Object classes in proxies, own their own async-context scopes, and adapter-cloudflare 8 offers no entry point to wrap; we only need "defect → issue tagged with `trace_id`", which `contexts.trace` gives. Reports come from the root span of the Worker where the defect happens. **RPC methods return `RpcResult` data instead of throwing** (one bug, one Sentry issue; a throwing Durable Object call also logs an uncaught exception). The browser Sentry SDK and the `OtelApiShim` for SvelteKit's own spans are deferred until there are real pages (milestone 3+). Details: section 4, "Spike outcome". |
| S39 | **Auth implementation (milestone 3, 2026-11-13).** Better Auth 1.7 runs in the web Worker (`apps/web/src/lib/server/auth.ts`) with the Drizzle adapter on the shared D1 database, so web now binds `DB` and `EMAIL` too. Its SvelteKit helper declares Kit 2 only, so we use the framework-neutral parts: `/api/auth/[...all]` calls `auth.handler()`, `hooks.server.ts` loads the session into `locals`, and pages are **form actions** that call `auth.api.*` and copy its `Set-Cookie` headers onto `event.cookies` (they work without client JavaScript). IDs are UUIDv7; the rate limiter stores its counters in D1 (`rate_limits`). Profile fields (handle, age, Facebook URL, phone) are `input: false` in Better Auth and are written only by our validated forms (`packages/core/src/identity.ts`). **No session cookie cache:** handle and age are written straight to D1, so each page view reads the session from D1. Accounts without a handle or age attestation (Discord and magic-link sign-ups) are sent to `/onboarding`. **Email mode is a var, `MAILER`:** `capture` (writes `email_outbox`, read by E2E through `/api/test/outbox`) locally, in tests and in isolated PR pairs; `cloudflare` (real sends) on staging, its Worker Previews and production, so captured links never exist where real people's accounts live. Discord turns on when `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` are set. Deferred to the next auth slice: phone verification (Twilio Verify, D55), Turnstile on sign-up (Better Auth's captcha plugin), and enforcing seller requirements at publish. |

---

## 2. Worker layout (S1)

```
apps/
  web/        SvelteKit 3 → Worker "claimsale-web[-<env>]"
              bindings: D1, R2, Queue producer, SALE_ENGINE (DO via script_name), ENGINE (service, RPC)
  engine/     Worker "claimsale-engine[-<env>]"
              exports: SaleEngine (DO), queue() consumer, scheduled() sweep, EngineEntrypoint (RPC)
packages/
  core/           pure domain logic: state machines, ranking, money, entitlements, rescind codes
  db/             Drizzle schema, migrations, query services
  observability/  Effect tracer → Workers spans bridge, logger, redaction (section 4)
  emails/         Svelte email templates
  config/         shared tsconfig, oxlint/oxfmt config
```

---

## 3. Effect 4 (S20)

Effect 4.0 consolidates most of the ecosystem into the core `effect` package.
Schema, SQL, HTTP, RPC and an **OTLP exporter** (`effect/observability/Otlp*`) all
ship in it. That matters for several choices:

| Area | Effect 4 situation | Consequence |
| --- | --- | --- |
| Validation | **Effect Schema is built in** and implements Standard Schema, so SvelteKit remote functions accept it. | Using Zod as well means two schema systems. **T24.** |
| D1 access | `@effect/sql-d1@4.0.2` exists. **`@effect/sql-drizzle` has no Effect 4 release** (latest 0.51 needs `effect@^3`). | Drizzle queries must be wrapped by hand, or we use Effect SQL. **T25.** |
| Tests | `@effect/vitest@4.0.2` | `it.effect(...)` tests with test layers. |
| OTel | `@effect/opentelemetry@4.0.2` (needs the OTel SDK packages) *or* the built-in fetch-based OTLP exporter | The Workers runtime does not support the OTel JS API directly yet, so we bridge instead (section 4). |
| Editor | `@effect/language-service` | Install as a TS plugin. |

**How Effect runs on Workers:**
- A `ManagedRuntime` is built once per isolate from Layers (D1, R2, Queue, config).
  Bindings come from `import { env } from "cloudflare:workers"`.
- Per-request context (request ID, user, sale) is provided as Effect services.
- **The remote-function layer (S2):** `effectQuery(schema, (input) => Effect…)` and
  `effectCommand(...)` run the program on the runtime. Typed failures
  (`Data.TaggedError`) map to SvelteKit `error()` / form issues, and defects go to Sentry.
- **The engine:** each DO method is an Effect program, with the per-item lock as a
  `Semaphore` per item ID.
- **Workers RPC payloads (S3)** are encoded and decoded with schemas at both ends.
  The types are shared, but the runtime still validates.

---

## 4. Observability (S16, S21)

**What the platform gives us today** (verified in Cloudflare's docs):
- **Automatic tracing** of fetch, D1, R2, KV, DO and RPC calls and handlers
  (`observability.traces.enabled`).
- A **custom spans API**: `tracing.enterSpan`, `startActiveSpan`, `startSpan`,
  `getActiveSpan`, `recordException`, `setAttributes` from `cloudflare:workers`.
  Custom spans nest correctly with platform spans.
- **OTLP export** of Workers **traces and logs** to Sentry, configured as account
  destinations and listed in `observability.traces.destinations` / `logs.destinations`.
- The Workers runtime **does not yet support the OpenTelemetry JS API directly**
  (Cloudflare says support is in progress).

**Design:**

```
Effect spans (Effect.fn / withSpan) ──► Effect Tracer bridge ──► cloudflare:workers tracing ─┐
SvelteKit 3 built-in OTel spans ──► minimal @opentelemetry/api TracerProvider shim ──────────┤
Platform spans (D1, R2, DO, RPC, fetch, queue) — automatic ─────────────────────────────────┤
                                                                                              ▼
                                            Cloudflare Workers Traces ──OTLP──► Sentry (traces)
Effect Logger → JSON console.log (with trace/span IDs) → Workers Logs ──OTLP──► Sentry (logs)
Sentry SDK (@sentry/sveltekit, @sentry/cloudflare): errors only, with tracing turned off ──► Sentry (issues)
Browser: Sentry browser SDK (errors + web vitals)
```

**Rules:**
- **One tracing owner.** Cloudflare traces the server side; the Sentry SDK's own
  server tracing is turned off, so there are no duplicate or orphaned spans.
- **`packages/observability` exports:**
  - `CloudflareTracer`: an Effect `Tracer` that maps Effect spans and attributes onto
    `tracing.startActiveSpan`, and records failures with `recordException`.
  - `OtelApiShim`: lets SvelteKit's built-in spans flow into the same trace.
  - `StructuredLogger`: Effect Logger → one JSON object per line.
  - `redact()`: the PII redaction used by the logger.
- **Every log line has:** `ts, level, msg, service (web|engine), env, version (git
  SHA), trace_id, span_id, request_id`. Plus where relevant: `user_id`, `sale_id`,
  `item_id`, `entry_id`, `command`. Email and phone are never logged raw (they are
  hashed or masked), and nor are tokens or message bodies.
- **Span names follow `domain.action`** (`engine.place_entry`, `invoice.send`), with
  attributes using the same keys as the logs.
- **Context crosses boundaries:** Workers RPC and DO calls are traced automatically.
  Queue messages carry `traceparent` in their envelope, and the consumer links its
  span to it.
- **Errors:** an Effect defect or unhandled exception → Sentry issue tagged with
  `trace_id`, so the issue links to the Cloudflare-exported trace. Expected domain
  failures (e.g. `ItemSoldOut`) are logged at `info`, not reported as errors.
- **Sampling:** 100% of traces in preview and staging; production starts at 100% and
  is lowered with `head_sampling_rate` as traffic grows.
- **Phase 0 spike (before feature work):** prove one end-to-end trace through
  browser → web → RPC → DO → D1 → Queue → consumer → Cloudflare Email Service, visible in Sentry with
  correlated logs and a linked error. **Fallback** if the bridge falls short: Effect's
  built-in `OtlpTracer` exporting straight to Sentry's OTLP endpoint. That's simpler,
  but its spans would sit beside the platform spans rather than nested under them.

### Spike outcome (T28, S38)

**Built** (one request through every hop, available everywhere except production):
`POST /api/debug/trace-probe` (and the page `/debug/trace`) → web span `web.trace_probe` →
engine RPC `traceProbe` → `SaleEngine` Durable Object → D1 query → message on the
notifications queue with `traceparent` → consumer span `engine.notifications.trace_probe`
linked to the producer → Email Service (only when the `TRACE_PROBE_TO` secret is set).
`{"fail": true}` makes the Durable Object hit a defect after its D1 query. The E2E suite
runs the probe locally, on previews and on staging after each deploy.

**Verified locally** (`wrangler dev`, wrangler 4.160):
- Web, engine and the Durable Object share **one trace ID across Workers RPC** with no work
  on our side, and every log line carries the matching `trace_id` / `span_id`.
- The local runtime has `span.spanContext()` and `tracing.withActiveSpan()`, so Effect
  spans nest and platform spans (D1, queue send) nest under them.
- **The queue consumer starts a new trace.** The consumer span records the producer's
  IDs as `link.0.trace_id` / `link.0.span_id` (Workers spans have no links API yet).
- A defect is reported once, by the Worker where it happened, with `trace_id` as a tag
  and in `contexts.trace`; callers receive it as an `RpcResult` failure.

**Still to verify on staging** (needs the owner steps in section 11): that the spans
arrive in Sentry nested the same way, that logs arrive correlated, and that the issue
from "Run probe with a deliberate error" links to its trace. If nesting fails in
production, the fallback above (Effect's `OtlpTracer`) still applies.

**Rules that came out of it:**
- Every Worker entry point runs its Effect program through `run(env, "domain.action", …)`
  (engine) or `runExit("domain.action", …)` (web), which adds the root span, logger, tracer
  and reporter.
- RPC methods (Worker and Durable Object) return `RpcResult<A>`; the caller maps a failed
  result to a typed failure, never to a defect.
- Queue messages carry `traceparent`; consumers link to it.
- The redaction pattern for phone numbers no longer matches digits inside IDs and
  timestamps (it used to mask part of UUIDs).

---

## 5. Secrets (S35; Doppler removed)

- **Where secrets live:** GitHub Environment secrets on `preview`, `staging` and
  `production`. Non-secret config stays in `wrangler.jsonc` `vars`.
- **Each Worker declares** the secret names it needs in `secrets.required`. `wrangler deploy`
  then fails if one is missing, and `wrangler types` generates typed bindings for them.
- **Deploy step** (`.github/actions/deploy-pair`): the calling workflow step's `env:` lists
  each secret **by name** (`FOO: ${{ secrets.FOO }}`) → `scripts/secrets-for.ts` (that
  Worker's names only; fails if one is missing) → `wrangler deploy --secrets-file`. The
  temporary files are deleted when the job ends, whatever the outcome.
- **Never pass `toJSON(secrets)`** to a step or action: GitHub flags such workflows as
  possibly malicious and holds every run until someone approves it.
- **Local:** put values in `apps/<app>/.dev.vars` (gitignored). Wrangler and Vite read
  it for the names in `secrets.required`.
- **Rotation:** update the GitHub secret, then re-run the environment's deploy workflow.
- **Coming back to Doppler later:** have Doppler set those environment variables before
  `secrets-for.ts` runs; nothing else changes.

## 6. Renovate (S22)

Proposed `renovate.json` policy (T35):
- `baseBranches: ["dev"]`; weekly schedule (e.g. Monday early morning); Dependency
  Dashboard on.
- `minimumReleaseAge: "3 days"`, so freshly published, possibly compromised versions
  never land. pnpm's own `minimumReleaseAge` is also set in `pnpm-workspace.yaml`.
- **Groups:**
  - `effect` + `@effect/*`: always together; they must match versions.
  - `svelte` / `@sveltejs/*` / `vite`
  - `wrangler` / `@cloudflare/*`
  - `oxlint` / `oxfmt`
  - `@sentry/*`
  - `drizzle-*`
  - `better-auth`
  - GitHub Actions
- **Automerge** patch and minor updates to devDependencies, and patch updates to
  runtime dependencies, once CI is green. Majors, `effect`, `better-auth`, `wrangler`
  minors and `@sveltejs/kit` always need review.
- Pin GitHub Actions to commit digests (`helpers:pinGitHubActionDigests`); weekly
  lockfile maintenance.
- The Renovate GitHub App must be installed on the repo.

---

## 7. Git flow and releases (S24)

```
feature/* ──PR (squash)──► dev ──auto-deploy──► staging
                            │
                            └──Release PR (merge commit)──► main ──auto-deploy──► production
hotfix/*  ──PR──► main ──► production, then an automatic back-merge PR main → dev
```

- **`dev` and `main` are both protected.** `main` accepts PRs only from `dev` or `hotfix/*`.
- **Release PR:** opened (or refreshed) by a workflow, listing the commits since the
  last release.
- **Production deploys** need approval on the GitHub `production` environment.
- **Database migrations follow expand/contract:** every migration must work with
  both the old and the new code, because staging and production run different code
  for a while and Workers deploy gradually. CI applies D1 migrations **before**
  deploying the code. DO class migrations go in `wrangler.jsonc` and also need review.

---

## 8. Packages (updated)

| Area | Package | Version |
| --- | --- | --- |
| Framework | `@sveltejs/kit` / `svelte` / `vite` | 3.0.1 / 5.57.2 / 8.x |
| Adapter / CLI | `@sveltejs/adapter-cloudflare` / `wrangler` | 8.0.0 / 4.160.0 (Worker Previews need ≥ 4.135; S37) |
| App framework | `effect`, `@effect/sql-d1`, `@effect/vitest`, `@effect/language-service` | 4.0.2 / 4.0.2 / 4.0.2 / 0.87.4 |
| Validation | `effect/Schema` (Standard Schema) | built in |
| ORM | `drizzle-orm` / `drizzle-kit` | 0.45.3 / 0.31.11 |
| Auth | `better-auth` | 1.7.20 |
| Email / SMS | Cloudflare Email Service (`send_email` binding, no package or API key) / Twilio Verify REST | — |
| Payments | `stripe` | 23.0.0 |
| UI | `tailwindcss`, `shadcn-svelte`, `bits-ui`, `@lucide/svelte` | 4.3.3 / 1.7.0 / 2.19.5 / 1.53.0 |
| Realtime client | `partysocket` | 1.3.0 |
| Web push | `@block65/webcrypto-web-push` | 2.0.0 |
| OG images | `@ethercorps/sveltekit-og` | 4.3.0 |
| Markdown | `marked` + an allowlist sanitizer | 18.1.0 |
| IDs | `uuidv7` | 1.2.1 |
| Bot check | `svelte-turnstile` | 0.11.0 |
| Errors | Server: our own envelope reporter (S38). Browser: `@sentry/svelte` when the first real pages land | — |
| Tests | `vitest` 5 (+ `@vitest/browser-playwright`, `vitest-browser-svelte`, `@vitest/coverage-v8`), `@effect/vitest`, `fast-check`, `msw`, `@playwright/test`, `@axe-core/playwright`, `@stryker-mutator/core` | 5.0.3 / 3.1.0 / 4.0.2 / 4.10.2 / 3.0.2 / 1.64.0 / 4.13.0 / 10.0.0 |
| Workers tests | `vitest` **4.1** + `@cloudflare/vitest-pool-workers` (the pool doesn't support Vitest 5 yet) | 4.1.11 / 0.23.0 |
| Lint / format / types | `oxlint`, `oxfmt`, `svelte-check` | 1.87.0 / 0.72.0 / — |
| Secrets / provisioning | GitHub Environment secrets; `cf` (Cloudflare CLI, beta) | 1.0.0-beta.21 |
| Deps | Renovate (GitHub App) | — |

---

## 9. Questions

Round 6 (T24–T37) is answered; see S26. The open questions are now about testing,
in [`TESTING.md`](./TESTING.md) and in `PLAN.md` section 12.

---

## 10. Email: Cloudflare Email Service (S28)

**Status (checked 2026-10-08):** Email Sending is in **public beta** and needs the
**Workers Paid** plan, which we already need for Durable Objects. Pricing is **3,000 emails
per month included, then $0.35 per 1,000**. It's for transactional email only; Cloudflare
doesn't allow marketing email yet. DKIM/ARC signing, SPF/DMARC alignment, IP reputation
and a suppression list are all managed by Cloudflare.

**How we use it:**
- **Binding, not an API key:** `"send_email": [{ "name": "EMAIL", "allowed_sender_addresses": [...] }]`
  in each Worker that sends. Each binding is restricted to our own sender
  addresses, so a bug can't send as an arbitrary address. There's no email secret at
  all.
- **Two senders:**
  - **web** sends auth emails directly (verification, magic link, password reset),
    because they're latency-sensitive and the user is waiting.
  - **engine** sends notifications (won, promoted, invoice, offer responses, follows)
    from the Queue consumer.
- **A sending subdomain** such as `notify.<domain>`, kept separate from the root
  domain so notification complaints can't hurt account email.
- **An `Mailer` Effect service** with three implementations:
  - `CloudflareMailer`: production and staging.
  - `CapturingMailer`: tests and previews. It writes every message to an outbox table
    that the test-only endpoint can read, so Playwright can follow magic-link and
    verification emails.
  - `LogMailer`: local `wrangler dev`, where the binding is simulated and the message
    is printed to the console and saved to a file.

**Consequences:**
- **The domain is needed earlier.** Until a sending domain is onboarded, Email Service
  can only send to **verified destination addresses** in the account. That's fine,
  and safe, for staging and previews: non-production can never email a real user.
  **Production can't send to users until the name and domain are decided and the domain is onboarded.**
- **Daily quotas start low and rise with good sending history.** Emails are spread
  out rather than sent in bursts:
  - Auth email is never queued behind notifications.
  - Notifications use their own Queue, with retry and backoff on rate-limit errors.
  - "New sale from a seller you follow" emails are batched as a digest when a
    seller has many followers.
  - Ask Cloudflare for a quota increase before the pilot sale.
- **Beta risk.** The `Mailer` service is the only code that touches the binding.
  Moving to another provider later (e.g. back to Resend or to Postmark) means
  writing one Layer and adding a secret. Nothing else changes.
- **Local development:** the binding is simulated by default (logs + files). Set
  `remote: true` only when you deliberately want real sends, to verified addresses.
- **Testing:** unit tests use an in-memory `Mailer`. Workers integration tests assert
  on the simulated binding. E2E tests read the `CapturingMailer` outbox. A staging
  smoke test sends one real email to a verified address after each staging deploy.

---

## 11. Milestone 0 setup checklist

Done in the repository and the AntiTcb account:
- [x] D1 databases `claimsale-staging` (`e4d69871-…`) and `claimsale-production` (`5506c6e8-…`), East US.
- [x] Wrangler configs for local, preview (generated per PR), staging and production.
- [x] CI (`.github/workflows/ci.yml`), PR previews + cleanup, staging deploy, release PR, production deploy, nightly.
- [x] Worker Previews of `claimsale-web-staging` for web-only PRs (S37).
- [ ] Confirm in the dashboard that the Access policy on `claimsale-web-staging` covers its **Previews** as well as production traffic (Worker-level Access offers "Previews only" or "All traffic"). Worker Previews run on staging data.
- [x] `dev` branch pushed.

Auth (S39), owner steps before staging can sign people in:
- [ ] `BETTER_AUTH_SECRET` in the GitHub Environments `preview`, `staging` and `production`
      (`scripts/setup.sh` step 4b generates them; or
      `openssl rand -base64 48 | gh secret set BETTER_AUTH_SECRET --env <env>`). **Deploys fail
      without it**, because `apps/web/wrangler.jsonc` lists it in `secrets.required`.
- [ ] Optional, Discord sign-in: create an application in the Discord Developer Portal with the
      redirect `https://staging.claimsale.net/api/auth/callback/discord`, then in `apps/web`:
      `wrangler secret put DISCORD_CLIENT_ID --env staging` and the same for
      `DISCORD_CLIENT_SECRET`. Without them the Discord button is hidden.
- [ ] Until `notify.claimsale.net` is onboarded in Email Service, staging can only email addresses
      verified in the Cloudflare account: verify each tester's address there, or they won't
      receive verification, magic-link or reset email.

Observability spike (T28, S38), owner steps before it can be checked in Sentry:
- [ ] Create a Sentry project (platform: JavaScript). Put its DSN in `SENTRY_DSN` under
      `env.staging.vars` in `apps/engine/wrangler.jsonc`, and under `env.staging.vars` and
      `env.staging.previews.vars` in `apps/web/wrangler.jsonc` (PR preview pairs copy staging's
      vars). A DSN is public by design, so it lives in config.
- [ ] In the Cloudflare dashboard (**Observability → Destinations**), add `sentry-traces`
      (Traces) and `sentry-logs` (Logs) with Sentry's OTLP endpoints and the
      `x-sentry-auth: sentry sentry_key=<public key>` header. Then add
      `"destinations": ["sentry-traces"]` / `["sentry-logs"]` to `observability.traces` /
      `observability.logs` for staging in both Workers. (Not added yet: a deploy that names
      a destination that doesn't exist fails.)
- [ ] Optional, once `notify.claimsale.net` is onboarded in Email Service:
      `wrangler secret put TRACE_PROBE_TO --env staging` (in `apps/engine`) with a verified
      address, so the probe ends with a real email.
- [ ] Open `https://staging.claimsale.net/debug/trace`, run both buttons, and check the
      trace, its logs and the linked issue in Sentry. Record the result under S38.

Owner steps are scripted in **`scripts/setup.sh`** (a guided wizard run on your own
machine, using `cf` and `gh`). It covers: default branch and protections, GitHub
Environments with their secrets and variables, the Cloudflare API token, queues, the
`workers.dev` subdomain, Cloudflare Access for previews and staging, and Renovate.
