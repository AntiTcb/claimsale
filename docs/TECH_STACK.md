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
| S7 | Environments: **local, per-PR preview, staging, production**, with staging from day one. How previews work: T30. |
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
| S23 | **Doppler** for secrets in every environment. See section 5. |
| S24 | **Git flow: feature PRs → `dev`; `dev` is batched into releases → `main`; `main` is always production.** Conventional commits, CI required, proprietary. See section 7. |
| S25 | **Full test suite: unit, browser, Workers integration and E2E (Vitest + Playwright). Every feature and bug fix ships with tests.** See [`TESTING.md`](./TESTING.md). |
| S26 | Round 6 defaults, all accepted: Effect Schema replaces Zod (T24); Drizzle for queries inside an Effect service (T25); Effect is server + core only, except Schema in the client with a bundle budget (T26); the domain core is pure functions (T27); the tracing bridge with a Phase 0 spike (T28); the logging policy (T29); a full Worker pair + D1 per PR (T30); seed data (T31); Cloudflare Access on non-production (T32); CalVer + git-cliff, releases on demand (T33); expand/contract migrations with approval and a Time Travel bookmark (T34); the Renovate policy (T35); the Doppler layout (T36); svelte-check + type-aware oxlint + the `{@html}` guard (T37). |
| S27 | Testing round 7 defaults, all accepted: Vitest 4.1 for Workers tests and 5 elsewhere until the pool supports 5; coverage thresholds + ratchet; nightly Stryker on core (≥ 80%); CI-generated visual baselines; the browser matrix; guarded test-only engine endpoints; the tests-with-changes guard; GitHub-only coverage reporting; the spec traceability check against STATE_MACHINES section 10. |

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
  browser → web → RPC → DO → D1 → Queue → consumer → Resend, visible in Sentry with
  correlated logs and a linked error. **Fallback** if the bridge falls short: Effect's
  built-in `OtlpTracer` exporting straight to Sentry's OTLP endpoint. That's simpler,
  but its spans would sit beside the platform spans rather than nested under them.

---

## 5. Secrets with Doppler (S23) — answer to "Can I use Doppler?"

**Yes.** It fits well, because Wrangler 4 now supports
`wrangler deploy --secrets-file <json|.env>` (and the same flag on `versions upload`).
So CI can pull secrets from Doppler and ship them **in the same operation** as the
code. Add `secrets.required` in each `wrangler.jsonc`, and a deploy **fails** if any
secret is missing.

**Setup:**
- **Doppler project `claimsale`**, with configs `dev` (local), `prv` (PR previews),
  `stg` (staging) and `prd` (production). Branch configs (e.g. `dev_alice`) cover
  personal overrides.
- **What lives where:** only secrets go in Doppler (Resend, Twilio, Stripe, Better Auth
  secret, Sentry DSN, Discord OAuth, Turnstile). Non-secret config (`APP_ENV`,
  URLs, feature flags) stays in `wrangler.jsonc` per environment, reviewed in PRs.
- **CI auth:** one Doppler service token per GitHub Environment (`preview`, `staging`,
  `production`), each scoped to its config. Use Doppler's OIDC service-account
  identity instead of tokens if your plan includes it.
- **Deploy step:**
  ```sh
  doppler secrets download --no-file --format json --config "$DOPPLER_CONFIG" > "$RUNNER_TEMP/secrets.json"
  pnpm --filter engine exec wrangler deploy --env "$ENV" --secrets-file "$RUNNER_TEMP/secrets.json"
  pnpm --filter web    exec wrangler deploy --env "$ENV" --secrets-file "$RUNNER_TEMP/secrets.json"
  rm "$RUNNER_TEMP/secrets.json"
  ```
  The file only lives on the runner for the duration of the job. Never `cat` or upload it.
- **Local:** `doppler run --config dev -- pnpm dev`. Wrangler and Vite read
  `process.env` for names in `secrets.required`, so no `.dev.vars` file is written to disk.
- **Rotation:** a secret changed in Doppler takes effect on the next deploy. A manual
  "Sync secrets" workflow (`wrangler secret bulk` per Worker) applies it without a code
  release. *Optional:* a Doppler webhook → `repository_dispatch` to run that automatically.
- **Don't** also use Doppler's own push-sync to Cloudflare. That would give two writers
  for the same secrets.
- **Each Worker gets only the secrets it needs:** the download step filters by an
  allowlist per Worker (web doesn't need Twilio, engine doesn't need the Better Auth secret).

---

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
| Adapter / CLI | `@sveltejs/adapter-cloudflare` / `wrangler` | 8.0.0 / 4.148.0 (Previews need ≥ 4.135) |
| App framework | `effect`, `@effect/sql-d1`, `@effect/vitest`, `@effect/language-service` | 4.0.2 / 4.0.2 / 4.0.2 / 0.87.4 |
| Validation | `effect/Schema` (Standard Schema) | built in |
| ORM | `drizzle-orm` / `drizzle-kit` | 0.45.3 / 0.31.11 |
| Auth | `better-auth` | 1.7.7 |
| Email / SMS | `resend` / Twilio Verify REST | 6.32.1 / — |
| Payments | `stripe` | 23.0.0 |
| UI | `tailwindcss`, `shadcn-svelte`, `bits-ui`, `@lucide/svelte` | 4.3.3 / 1.7.0 / 2.19.5 / 1.53.0 |
| Realtime client | `partysocket` | 1.3.0 |
| Web push | `@block65/webcrypto-web-push` | 2.0.0 |
| OG images | `@ethercorps/sveltekit-og` | 4.3.0 |
| Markdown | `marked` + an allowlist sanitizer | 18.1.0 |
| IDs | `uuidv7` | 1.2.1 |
| Bot check | `svelte-turnstile` | 0.11.0 |
| Errors | `@sentry/sveltekit`, `@sentry/cloudflare` | 11.6.0 |
| Tests | `vitest` 5 (+ `@vitest/browser-playwright`, `vitest-browser-svelte`, `@vitest/coverage-v8`), `@effect/vitest`, `fast-check`, `msw`, `@playwright/test`, `@axe-core/playwright`, `@stryker-mutator/core` | 5.0.3 / 3.1.0 / 4.0.2 / 4.10.2 / 3.0.2 / 1.64.0 / 4.13.0 / 10.0.0 |
| Workers tests | `vitest` **4.1** + `@cloudflare/vitest-pool-workers` (the pool doesn't support Vitest 5 yet) | 4.1.11 / 0.23.0 |
| Lint / format / types | `oxlint`, `oxfmt`, `svelte-check` | 1.87.0 / 0.72.0 / — |
| Secrets | Doppler CLI (in CI and locally) | — |
| Deps | Renovate (GitHub App) | — |

---

## 9. Questions

Round 6 (T24–T37) is answered; see S26. The open questions are now about testing,
in [`TESTING.md`](./TESTING.md) and in `PLAN.md` section 12.
