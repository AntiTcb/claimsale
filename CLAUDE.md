# ClaimSale — working agreement

ClaimSale (claimsale.net) is a claim-sale marketplace for trading card games. The
product and technical decisions live in `docs/`; read the relevant part before changing
behavior:

- `docs/PLAN.md`: product decisions (D#), data model, routes, milestones
- `docs/STATE_MACHINES.md`: exact rules for sales, entries, invoices, plus the **rule ID registry (§10)**
- `docs/TECH_STACK.md`: stack decisions (S#), observability, secrets, git flow
- `docs/TESTING.md`: test layers and what each kind of change requires

## Non-negotiables

1. **Every feature ships with tests; every bug fix ships with a regression test** that
   fails without the fix, at the lowest layer that reproduces it (TESTING.md §2).
2. **Rule traceability:** code that implements a rule from STATE_MACHINES §10 carries
   `@spec RULE-ID` in a comment, and at least one test name contains `[RULE-ID]`.
   New rules get a registry row in the same PR. `pnpm check:spec-traceability` enforces this.
3. Never skip, disable or delete a test to get green. Fix flaky tests at the root cause.
4. Money is integer cents. Timestamps are server-set milliseconds.
5. Never log raw emails, phone numbers, secrets or message bodies; use the
   structured logger in `@claimsale/observability`, which redacts.
6. Migrations are expand/contract only (they must work with the old and new code).

## Layout

```
apps/web      SvelteKit 3 → Worker claimsale-web (adapter-cloudflare 8)
apps/engine   Worker claimsale-engine: SaleEngine Durable Object, queue consumer, cron, RPC
packages/core           pure domain logic (no I/O)
packages/observability  structured JSON logger + PII redaction (Effect 4)
packages/db             Drizzle schema + D1 migrations
```

## Conventions that differ from older SvelteKit / Wrangler habits

- SvelteKit 3 config lives in `vite.config.ts` (`sveltekit({...})`); there is no `svelte.config.js`.
- Use `#lib/...` subpath imports (package.json `imports`), not `$lib`.
- Read bindings with `import { env } from "cloudflare:workers"`; adapter-cloudflare 8 has no `platform`.
- The engine's bindings are typed by `EngineEnv` (apps/engine/src/env.ts), not the global `Env`.
- Effect 4: `Effect.andThen` takes an Effect, not a plain function; use `Effect.sync`.

## Commands

```
pnpm install            # pnpm 12 (packageManager); Node 24 (.nvmrc)
pnpm dev                # both Workers in one wrangler process on http://localhost:8787
pnpm dev:ui             # vite dev with HMR (engine-backed features show as degraded)
pnpm check              # format check, lint, typecheck, spec traceability
pnpm test               # unit + browser tests (Vitest 5)
pnpm test:workers       # engine Workers integration tests (Vitest 4.1 for now)
pnpm test:e2e           # Playwright against the local stack
pnpm test:coverage      # unit + browser with coverage thresholds
pnpm format             # oxfmt
pnpm --filter @claimsale/engine cf-typegen   # after changing a wrangler.jsonc (same for web)
pnpm --filter @claimsale/db db:generate      # after changing the Drizzle schema
```

Locally, set `CHROMIUM_EXECUTABLE` to use an already-installed Chromium for browser and
E2E tests; otherwise run `pnpm --filter @claimsale/web exec playwright install chromium`.

## Git

Feature branches → PR into `dev` (squash). `dev` deploys to staging. Releases are PRs from
`dev` into `main` (merge commit); `main` is production. Conventional commits.
