# Testing Strategy

**Rule (S25): every feature ships with tests, and every bug fix ships with a
regression test that fails without the fix.** Tests are written in the same PR as
the code, not afterward. The tools are Vitest and Playwright.

Versions checked on 2026-10-08. **Status: decided** (TECH_STACK S27). Rule IDs
live in [`STATE_MACHINES.md` section 10](./STATE_MACHINES.md#10-rule-id-registry-for-test-traceability).

---

## 1. Layers

| Layer | Tool | Runs in | What it covers | File pattern |
| --- | --- | --- | --- | --- |
| **Unit** | Vitest 5 (`@effect/vitest`, `fast-check`) | Node | `packages/core` state machines, ranking, money, entitlements, rescind attribution; Effect services with test Layers; validation schemas; utilities | `*.test.ts` next to the source |
| **Browser (component)** | Vitest 5 Browser Mode + `@vitest/browser-playwright` + `vitest-browser-svelte` | Real Chromium | Svelte components and pages in isolation: rendering, interaction, form validation, accessibility, visual snapshots | `*.svelte.test.ts` |
| **Workers integration** | Vitest 4.1 + `@cloudflare/vitest-pool-workers` | workerd (the real runtime) with local D1 / R2 / Queues / DOs | SaleEngine DO (locks, alarms, WebSockets), D1 queries and migrations, Queue consumer, RPC entrypoints, Better Auth flows, remote functions against real bindings | `*.workers.test.ts` |
| **End-to-end** | Playwright 1.64 (`@axe-core/playwright`) | The full stack: web + engine running locally, or a deployed preview / staging | User journeys across both Workers, multiple users at once, real time, mobile viewports | `e2e/**/*.spec.ts` |
| **Load** | k6 | Staging | Go-live claim rush (target from STATE_MACHINES section 9: p95 < 300 ms at 200 claims/s on one sale) | `load/*.js` |

### Why two Vitest versions (until the pool catches up)
- `@effect/vitest@4.0.2` needs **Vitest ≥ 5**.
- `@cloudflare/vitest-pool-workers@0.23.0` (released 2026-10-07) still needs **Vitest ^4.1**.
- So in the monorepo:
  - **Workers integration tests** live in their own Vitest 4.1 projects (`apps/engine`,
    `apps/web` server tests, `packages/db`). They run Effect programs through a small
    `runTest(effect, layer)` helper instead of `@effect/vitest`.
  - **Everything else** runs on Vitest 5.
- Renovate watches for a Vitest 5-compatible pool release, and then they merge into one version.

---

## 2. What each kind of change needs

| Change | Required tests |
| --- | --- |
| A domain rule (anything in `STATE_MACHINES.md`) | Unit tests for every transition and guard, **plus** a fast-check property test for invariants (below). Each test is tagged with its spec section ID. |
| A new engine command or alarm | Unit test of the pure transition + Workers integration test through the DO (lock, D1 batch, broadcast, audit row). |
| A new UI component | A browser test: renders, main interactions, keyboard operation, and no axe violations. |
| A new page or flow | Browser tests for its components + at least one Playwright E2E for the happy path, and E2E tests for the important failure paths. |
| A DB migration | A Workers integration test that applies all migrations to an empty DB **and** to a DB seeded at the previous schema (expand/contract safety). |
| An external integration (Resend, Twilio, Stripe, YGOPRODeck, Discord) | Unit/integration tests with **MSW** (`msw@3`) handlers for success, error and timeout. A staging smoke test with the provider's test mode. |
| **A bug fix** | A regression test at the **lowest layer that reproduces the bug**, committed so that it fails on the parent commit. The PR description links the test. |

### Domain invariants (property tests on `packages/core`)
fast-check generates random sequences of commands (claims, offers, awards, rescinds,
take-backs, timers, closes) and checks after every step that:
1. Won entries ≤ quantity, for every item.
2. A buyer never has two open entries on the same item.
3. Ranking is a total order, and it's stable under re-ranking.
4. Every terminal entry has `ended_reason` and `ended_by`.
5. An invoice's total = the sum of its lines + shipping + adjustments, and is never negative.
6. Rescind fault attribution only changes the record it says it changes.
7. No transition is accepted for an actor without permission (section 8 of the spec).
8. Replaying the audit log reproduces the same state (event-sourcing check).

### Spec traceability
Every rule in `STATE_MACHINES.md` gets a stable ID (e.g. `SM-4.1-instant-win`,
`SM-4.3.1-buyer-payment-reversed`). Tests include the ID in their name. A CI
script fails if a spec ID has no test, so the spec and the tests can't drift apart.

---

## 3. Browser tests (Vitest Browser Mode)

- **Provider:** `@vitest/browser-playwright`; Chromium for every run.
- **Rendering:** with `vitest-browser-svelte`. Interactions use the built-in
  `page` / `userEvent` APIs, which send real events, not simulated ones.
- **Accessibility:** run axe on every component test through a shared `expectAccessible()` helper.
- **Visual snapshots** with `toMatchScreenshot` for a curated set of components (sale
  card, item card states, claim button states, invoice) in light and dark themes.
  Baselines are generated in CI's Linux image only, to avoid font and rendering
  differences between machines.
- **Network:** remote functions are mocked at the boundary with MSW (browser
  worker); components never hit a real server.

---

## 4. End-to-end tests (Playwright)

**Projects (browser matrix):**

| Project | Browser / device | Runs |
| --- | --- | --- |
| `chromium-desktop` | Desktop Chrome | Everything |
| `webkit-mobile` | iPhone (WebKit) | Critical paths (most buyers come from the FB in-app browser on phones) |
| `chromium-mobile` | Pixel | Critical paths |
| `firefox-desktop` | Desktop Firefox | Critical paths, nightly |

**Critical paths** (tagged `@critical`):
- Sign-up (email + password, magic link, Discord via a stub provider in test env),
  email and phone verification.
- A seller creates a sale with items and photos, schedules it, and it goes live.
- **Claim race:** N buyer contexts claim the same item at go-live; exactly one wins,
  everyone else sees their correct backup position live.
- Offer → seller deciding → award, plus the decision-window timeout.
- A Pro buyer rescinds; a take-back request is approved and the backup is promoted.
- Seller rescind with fault attribution → buyer contests → admin resolves.
- Sale close → invoices sent → buyer picks shipping, pays → seller confirms → shipped → completed.
- Private sale: password and allowlist access.
- Browse and search finds a public sale and excludes an unlisted one.

**Mechanics:**
- **Multi-user tests** use a separate browser context per user, in a single test.
- **Time:** Playwright's `page.clock` controls client countdowns. Server-side
  timers (decision windows, deadlines, alarms) are advanced through a **test-only
  engine endpoint**. It exists only when `APP_ENV` is `test` or `preview`, requires a
  secret header, and its absence in production is verified by a test.
- **Data:** each test creates its own users and sales through a test-only seeding
  API (the same guards as above), so tests are independent and can run in parallel.
  Previews also get the shared seed script (T31).
- **Accessibility:** run `@axe-core/playwright` on every page visited in the critical paths.
- **Where E2E runs:**
  - The full suite runs locally in CI, against `vite build && vite preview` + `wrangler dev` for the engine.
  - The `@critical` smoke subset runs against each **deployed PR preview** pair and
    against **staging** before a release is approved.

---

## 5. Coverage and quality gates

- **Coverage:** `@vitest/coverage-v8`, merged across unit, browser and Workers runs.
- **Minimum thresholds** (CI fails below them):

  | Code | Lines | Branches |
  | --- | --- | --- |
  | `packages/core` | 95% | 95% |
  | `apps/engine`, `packages/db`, server code in `apps/web` | 85% | 80% |
  | Svelte components | 70% | 60% |

- **Ratchet:** coverage on `dev` may not go down. A PR that lowers it fails unless
  it's labelled `coverage-exception` with a reason.
- **Mutation testing:** Stryker (`@stryker-mutator/core@10`) runs **nightly on
  `packages/core`**. The mutation score must stay ≥ 80%; a drop opens an issue.
- **Tests-with-changes guard:** a CI check fails a PR that changes source files under
  `apps/` or `packages/` without changing any test file. A `no-tests-needed` label
  overrides it (for refactors, config or docs), and the reason must be in the PR description.
- **PR template checklist:** tests added/updated; for bug fixes, a link to the
  regression test and confirmation that it failed before the fix.

---

## 6. Flaky tests

- No automatic retries for unit, browser or Workers tests. Playwright gets **1
  retry in CI only**, and any test that passes on retry is reported as flaky in the job summary.
- A flaky test is a bug. It gets an issue and is fixed at the root cause. Tests are
  never skipped or deleted to get a green build.
- Determinism by default:
  - fake timers (`vi.useFakeTimers`, Effect `TestClock`)
  - seeded fast-check runs (the seed is printed on failure)
  - deterministic ID and clock services injected via Layers
  - no real network in unit and browser tests

---

## 7. CI pipeline

```
PR → dev
 ├─ oxfmt --check · oxlint (type-aware) · svelte-check · tsc --noEmit
 ├─ unit (Vitest 5)                  ┐
 ├─ browser (Vitest 5, Chromium)     ├─ in parallel; coverage merged afterward
 ├─ workers integration (Vitest 4.1) ┘
 ├─ e2e full (Playwright, local stack, sharded ×4)
 ├─ coverage gates · spec-traceability check · tests-with-changes guard
 ├─ deploy the PR preview pair (Doppler prv) → e2e @critical against the preview
 └─ all green → mergeable

dev → staging deploy → e2e @critical against staging
Release PR dev → main: full e2e + @critical on staging → manual approval → production
Nightly: Firefox e2e · Stryker on core · k6 load test against staging (on demand before the pilot)
```

---

## 8. Conventions

- **Factories, not fixtures:** `packages/testing` exports typed builders
  (`aSale().live().withItems(3)`, `aBuyer().pro()`) and Effect test Layers (in-memory
  clock, IDs, mailer, SMS, queue).
- **Test names** describe behavior: `"claim on item with pending offers starts decision window [SM-4.1-deciding]"`.
- **One behavior per test.** Assert on outcomes (state, events, UI), not on
  implementation details.
- **Scripts:** `pnpm test` (unit + browser), `pnpm test:workers`, `pnpm test:e2e`,
  `pnpm test:all`. Each package can be tested on its own with `pnpm --filter`.
- **Agent instructions:** a `CLAUDE.md` at the repo root will state the S25 rule and
  these conventions, so AI-assisted changes follow it too.
