# Implementation Plan — what's left to the pilot sale

> Written 2026-11-15 from PLAN §13 and the code on `dev` (`c0f5363`). PLAN.md stays the
> source of product decisions (D#), and STATE_MACHINES §10 holds the rule IDs. This file
> only covers **order, chunking and done criteria** for the rest of the build. Update it
> when a workstream merges.

## 1. Where we are

| Milestone (PLAN §13) | Status |
| --- | --- |
| 0. Foundations (monorepo, CI, previews, staging/prod) | Done |
| 1. Observability spike (T28, S38) | Done; Sentry check waits on owner steps (TECH_STACK §11) |
| 2. Domain core (`packages/core`, SM-2…SM-8 pure) | Done; `SM-9-*` come with the engine |
| 3. Auth | First slice done (S40). Left: phone OTP, Turnstile, seller requirements at publish |
| 4. Sales and items | Not started (schema has only auth tables) |
| 4b. TCG catalog + photo authenticity | Not started |
| 5. Engine (SaleEngine DO write path) | WS-E: write path, RPC, alarms, cron sweep, rate limit (k6 run pending) |
| 6. Live grid | Not started |
| 7. Seller control room + admin disputes | Not started |
| 8. Invoices after close + exports + tracking import | Pure invoice machine done; no I/O |
| 9. Notifications and messaging | Email outbox + Email Service binding exist; no Queue consumer logic |
| 10. Discovery + pilot | Not started |

## 2. Workstreams

Each workstream (WS) is one PR into `dev` unless it says otherwise. Every one follows
CLAUDE.md: tests with the change, `@spec` tags plus `[RULE-ID]` test names for every
rule it implements, expand-only migrations, integer cents, redacting logger.

### WS-A · Domain data model + sales and items CRUD (M4, part 1)
- **Migration `sales_items`:** `seller_profiles`, `sales`, `sale_access`, `sale_allowlist`,
  `items`, `item_attributes`, `item_images`, `entries`, `takeback_requests`, `rescinds`,
  `invoices`, `invoice_lines`, `addresses`, `audit_log`, `notifications`, `follows`,
  `blocks`, `plans`, `subscriptions`, `fees` (PLAN §6, with the "gains" columns folded in).
  One migration for the whole entry/invoice model, so WS-E and later never need to race on
  the core tables. Catalog and image-hash tables are **not** here (WS-C, WS-F).
- `#lib/server` repositories over Drizzle inside an Effect service (T25).
- Routes: `/sell`, `/sell/new` (details → terms → items wizard), `/sell/[saleId]/items`
  (table editor: tab through title/price, drag reorder, photo dropzone), `/s/[slug]`
  and `/s/[slug]/i/[itemId]` read-only views, `/me/addresses`.
- Image upload: client resize/re-encode (strips EXIF), Worker upload endpoint into R2,
  `item_images` rows with status `pending`; access-checked serving for private sales.
- Entitlements wired server-side: `SM-2-free-sale-cap`, `SM-2-free-item-cap`,
  `SM-2-lock-price-qty` (enforced on edit), visibility rules (D5, D31).
- Publish/schedule calls into the engine are **stubbed behind an interface** so WS-E can
  replace them; publish still checks `SM-2-publish-*`, `SM-2-preview-window`.
- **Done:** a seller can create a draft sale, add items with photos, schedule it, and a
  visitor can view it at `/s/[slug]`; E2E covers that path.

### WS-B · TCG item model and import/export logic in core (M4 part 2, M8 part, pure)
All pure functions in `packages/core` (no I/O), so it can start now.
- `games` registry data (launch games, condition scale, finishes, languages, TCGplayer
  category IDs) and **Effect Schema attribute schemas per game × kind**
  (`TCG-attribute-schema`), with template-column generation.
- TCG rules: `TCG-no-code-cards`, `TCG-tracked-graded-sealed`, `TCG-autofill-only`
  (merge function), `TCG-market-pct` (rounding), `TCG-market-placeholder` (a
  buyer-facing projection that strips market data).
- Import/export logic: column mapping + TCGplayer and ManaBox presets, row validation,
  upsert planning (`IO-import-upsert`, `IO-import-cap`, `IO-import-target`,
  `IO-import-validate`), catalog-match ordering (`TCG-catalog-match`, against an injected
  lookup), formula escaping (`IO-export-formula-escape`), export row builders with the
  privacy projection (`IO-export-privacy`), Pirate Ship + generic layouts, tracking match
  and carrier detection (`IO-tracking-match`, `IO-tracking-carrier`), CSV encoding rules
  (BOM, `,`/`;` detection, Windows-1252).
- **Done:** every rule above has a `@spec` tag and a `[RULE-ID]` test; property tests for
  the round-trip (`IO-export-roundtrip` at the pure level) and price rounding.

### WS-C · TCGCSV catalog ingestion and search (M4b part 1)
- **Before starting for real:** check TCGCSV's terms and attribution (PLAN §12). The code
  can be built against recorded fixtures first.
- Migration `catalog`: `games`, `catalog_sets`, `catalog_products`, `market_prices`,
  FTS5 virtual table over name / set name / number, `want_list_items`.
- Engine cron: nightly ingestion (games → groups → products → prices), batched D1
  writes, idempotent upserts, structured logs and a run summary; MSW/fixture tests.
- Autofill search endpoint (type-ahead over FTS5) and a market-price lookup that is
  **seller-only** (`TCG-market-placeholder`).
- **Done:** ingestion runs locally against fixtures, staging can run it on demand, and
  the search endpoint returns ranked results.

### WS-D · Auth slice 2: phone, Turnstile, seller requirements (M3 finish)
- Twilio Verify phone OTP (E.164, unique per account, never shown publicly), behind a
  capture/fake mode for tests like `MAILER`.
- Turnstile on sign-up (Better Auth captcha plugin), test keys locally.
- Seller requirements (D55, `sellerBlockers`): 18+, verified email and phone (Pro skips
  phone), surfaced on `/sell` with what's missing; buyer requirements
  (`SM-4.1-buyer-requirements` inputs: email verified, Pro bypass).
- Admin grant of Pro (`plans`/`subscriptions` rows) **if WS-A has merged**; otherwise a
  `tier` field read through one `entitlements(user)` function to swap later.
- **Done:** a new seller is blocked at publish until verified; E2E for phone OTP in
  capture mode.

### WS-E · The engine write path (M5)
Needs WS-A merged (tables).
- `SaleEngine` DO: per-item lock, load item + entries, run the core transition, commit
  one `db.batch()` with an item `version` check and an `audit_log` row
  (`SM-9-serialized-writes`, `SM-9-audit`).
- RPC surface (returning `RpcResult`): place claim/offer, withdraw/leave, award,
  counter/accept/decline, rescind (with reason codes), take-back request/decide, Pro
  buyer rescind, publish/schedule/close, invoice transitions.
- Alarms: one alarm at the earliest due timer (`SM-7-single-alarm`), plus the 5-minute
  cron sweep; go-live, close, decision windows, counter expiry, payment deadlines,
  autocomplete.
- Rate Limiting binding on claim/offer.
- Claim race test in the Workers pool (N concurrent claims, one winner), audit replay test,
  and a k6 (or similar) load test script against staging with the p95 < 300 ms target.
- **Done:** web's stubbed engine calls go through RPC; `SM-9-*` in the registry are covered.

### WS-F · Photo authenticity (M4b part 2)
Pure part can start now; wiring needs WS-A.
- **F1 (now):** a package (`packages/imagehash`) with WASM decode (`@jsquash/*`),
  downscale, dHash + pHash, the 5 variants, 4×16-bit bands, Hamming distance, and the
  decision function (≤ 6 reject, 7–12 review). `IMG-hash-robust` as property tests.
- **F2 (after WS-A):** migration `image_hashes`, engine Queue job that verifies `pending`
  images, banded candidate lookup, `IMG-dup-reject`, `IMG-dup-review`, `IMG-own-reuse`,
  `IMG-repeat-offender`, `IMG-required` and `IMG-timestamp-required` at publish, and the
  `/admin` review queue.
- Notes from F1 (`@claimsale/imagehash`):
  - Store each 64-bit hash as hex TEXT (D1 returns INTEGER as a JS number and loses
    bits); the 16-bit bands are safe as INTEGER.
  - Index only the `orig` bands of stored images; look up with all 5 variants of the upload.
  - `candidateBands` radius 1 is guaranteed to find every match within 7 bits (all rejects);
    review-band matches (7–12) are best effort.
  - Pass candidate keys as one JSON parameter through `json_each` (D1 allows 100 bound
    parameters per query).
  - Import the jsquash `.wasm` files in wrangler and pass them to `createJsquashDecoder`.
  - Owner to confirm: review needs both hashes ≤ 12, each hash takes its own minimum
    over the variants, and mirror + 90° together isn't covered.
- Notes from F2 (built with the F1 defaults above):
  - Tables (migration `0007_image_hashes`): `image_hashes` (hex hashes, 8 band columns
    with one index each, `decision`, `reason`; no foreign keys to photo, item or sale, so
    another seller's image still counts after it is deleted), `account_flags`
    (IMG-repeat-offender), `users.role` (`admin` opens `/admin`; set with SQL).
  - The verify job runs on the engine's existing queue as `photo_verify` messages (no new
    queue to provision); the engine binds the web Worker's `IMAGES` bucket. The web
    Worker queues a check after each upload over RPC (`requestPhotoVerification`), and
    the 5-minute cron re-queues photos still `pending` after 10 minutes (up to a day old).
  - Thresholds live in `@claimsale/imagehash` (`REJECT_MAX_DISTANCE`,
    `REVIEW_MAX_DISTANCE`) and `@claimsale/core` photos.ts (`TIMESTAMP_EXEMPT_COMPLETED_SALES`
    = 5, `REPEAT_OFFENDER_REJECTIONS` = 3, `COMPLETED_SALE_STATUSES` = closed, archived).
  - Own reuse (`decideUpload`): rejected only for a different item of the same sale; reuse
    in another sale counts as relisting. A timestamp photo already used in any other sale
    is rejected, even the seller's own.
  - Publish checks are pure (`checkPublishPhotos` in core); WS-E's publish RPC should call
    it with `publishPhotoState` (web `images.ts`) or an engine equivalent.
  - Buyers only see approved photos (`IMG-public-approved`, new registry row).

### WS-G · Item import UI + catalog picker + market price aid (M4 part 3)
Needs WS-A, WS-B, WS-C.
- `/sell/[saleId]/import`: `papaparse` / `read-excel-file` in the browser, column mapping,
  preview with row results, ZIP photos via `fflate` through the normal upload path,
  apply in batches of 100 through the engine with `import_id` idempotency
  (`IO-import-idempotent`, `IO-import-photos`), results CSV.
- Catalog type-ahead in the item form and table editor; price placeholder and the
  70–100 % buttons; seller default %; bulk "N % of market" with preview.
- ManaBox exports carry no price, and core's import validation requires one: offer the
  % of market preview for blank prices before validating (from WS-B).

### WS-H · Live grid (M6)
Needs WS-E.
- WebSocket via `/api/sales/[id]/live` → DO (Hibernation API), version-diff messages,
  server time on connect, refetch on reconnect.
- Claim and offer UI (confirmation toggle, "You're #1" / "backup #2"), filters, the
  buyer's running total (D53), offer visibility (`SM-3-offer-visibility`), live-region
  announcements. Browser tests + a multi-context Playwright race test.

### WS-I · Seller control room + admin disputes (M7)
Needs WS-E. Can run alongside WS-H (different routes).
- `/sell/[saleId]/manage`: per-item queues, deciding countdowns, award / decline /
  counter, reorder backups, rescind with reason codes, take-back inbox, buyer records.
- `/admin`: rescind contests (`SM-4.3.1-contest`), fraud review, reports, bans,
  Pro grants.

### WS-J · Invoices after close, exports, tracking import (M8)
Needs WS-E; uses WS-B's pure logic.
- `/sell/[saleId]/buyers`, `/sell/[saleId]/invoices/[id]`, buyer invoice view with
  address + shipping option + "I've paid", seller confirm / ship / tracking, completion
  and feedback opening.
- Shipping menu editor; payment deadlines and the overdue one-click rescind.
- Export jobs on a Queue → R2, 24 h links (`IO-export-expiry`), `/sell/exports`;
  tracking re-import (`IO-tracking-transition`, `IO-tracking-replace`).
- Make `invoice.ship()` enforce core's `trackingRequiredFor` (graded/sealed and the
  threshold); WS-B added the rule but not this check.

### WS-K · Notifications and messaging (M9)
Needs WS-E. Can run alongside WS-H/I/J if it only adds the consumer side.
- Domain events → `notifications` + Queue; consumer sends Email Service mail with Svelte
  templates, per-user preferences, seller batching; bell icon.
- Messaging: one conversation per buyer per sale, realtime over the sale DO, image
  attachments in R2 with access checks, payment-handle warning, report and block.
- Want-list matching (`TCG-want-list-notify`) and follow-seller notifications
  (`SM-2-go-live-alarm` followers part).

### WS-L · Discovery and pilot readiness (M10)
Needs WS-A, WS-C; best after WS-H.
- Browse by game (`/g/[game]`), search over public sales (D56) with filters, "who has
  this card?", follows, OG share cards (Satori), "copy as text" export, landing page.
- Pilot checklist: domain + Email Service onboarding, ToS / prohibited items page, load
  test on staging, Sentry dashboards, backup/restore drill with D1 Time Travel.

### After the pilot (PLAN Phase 2)
Stripe Billing for Pro, merged invoices (D16), Discord webhooks, Q&A, web push, auto
promotion after the deadline, block list UI, presets, duplicate/relist, feedback display.

## 3. Order

```
Wave 1 (now, in parallel):  WS-A   WS-B   WS-C   WS-D   WS-F1
Wave 2 (after WS-A):        WS-E   WS-F2  WS-G (also needs B, C)
Wave 3 (after WS-E):        WS-H   WS-I   WS-J   WS-K
Wave 4:                     WS-L → pilot sale
```

### Wave 1 integration notes
- WS-A's publish check accepts any photo that isn't rejected; WS-F2 tightens it to
  `approved` (`IMG-required`). WS-A's item form takes WS-B's schemas through
  `apps/web/src/lib/listing-input.ts`.
- WS-A deferred: allowlist invite emails (WS-K), deleting R2 objects with a draft.
- WS-A: new tables store timestamps as number milliseconds (auth tables use `Date`);
  repositories are plain async functions over `Db`, like `users.ts`; all PR pairs share
  the `claimsale-images-preview` bucket. The R2 buckets must exist before the next web
  deploy (TECH_STACK §11).
- WS-D adds `requireSeller(event)` (`#lib/server/seller.ts`): every `/sell` `load` and
  action from WS-A must call it when the two merge.
- WS-D turns email sign-up off wherever no Turnstile key is set, which includes
  production today. Turnstile keys must exist before WS-D ships to production.
- WS-D's Turnstile browser test failed once in a full run and didn't reproduce in 13
  reruns; find the cause before merging (CLAUDE.md: no flaky tests).
- Games (2026-11-16, WS-B × WS-C): the core registry (`packages/core/src/games.ts`) is
  the source of truth, and migration `0005_games_registry` makes the `games` table match
  it (`games-seed.test.ts` checks this). Launch: the ten games WS-C enabled; Final Fantasy
  and five others are disabled until turned on with a migration. Japanese Pokémon is a
  language of `pokemon`; the disabled `pokemon-japan` row marks TCGCSV category 85 for
  later ingestion. The sell form lists the enabled registry games plus "Other TCG",
  which WS-G replaces; Magic's id is `mtg` (0005 renames stored `magic` items).
- `pnpm test` times out in `scripts/` tests that spawn `node` on the owner's machine
  (Node takes ~3–4 s to start), and `cf-resources.test.ts` fails when WSL's `bash` is
  first on PATH. Seen on every wave-1 branch, including WS-B, WS-C and WS-F1, which don't
  touch `scripts/` (WS-D only adds preview-pair vars in `preview-config.ts`).

### Wave 2 integration notes (WS-E, the engine write path)
- Every sale write goes through the Engine entrypoint's RPC methods (`placeEntry`,
  `awardEntry`, `sellerRescind`, `publishSale`, `sendInvoice`, … in `apps/engine/src/index.ts`).
  Each returns `RpcResult<Outcome<T>>`: the outer result fails only on a defect or invalid
  input; a rule's "no" is `{ ok: false, error: { code, message } }`. The web Worker passes
  the authenticated user's ID; the engine works out seller / buyer and tiers itself.
- Sale settings the engine reads from `sales.terms` (beyond the web form's fields):
  `decisionWindowHours` (Pro), `autoSendAtClose`, `autoRescindOverdue`,
  `requireVerifiedEmail`, `minAccountAgeDays`; the shipping menu from `sales.shipping`
  as `[{ id, label, priceCents, tracked }]`. WS-I / WS-J add the form fields.
- `POST /api/sales/[saleId]/entries` takes a claim or offer as JSON (session + sale access
  checked in web). WS-H can use it or call `placeEntry` from a remote function.
- Committed events go to the notifications queue as `{ kind: "sale_events", sale_id, events }`;
  the consumer only acknowledges them until WS-K.
- Import batches: see the WS-G notes below (WS-G replaced this first version).
- The publish photo check stays in web (`itemsWithoutPhotos`, `#lib/server/engine.ts`);
  WS-F2 tightens it there.
- Not built yet: rescind contests / mutual-agreement answers and their 72h timer (WS-I),
  a test-only clock endpoint for E2E time travel, WebSocket broadcast (WS-H).
- Locally on Windows, Playwright's `webServer` command fails (cmd.exe has no subshell for
  `(cd ../engine && …)`); start the stack by hand and Playwright reuses it.

### Wave 2 integration notes (WS-G, item import)
- Import batches go through the engine:
  `ENGINE.applyImportBatch({ saleId, sellerId, ...ImportBatchBody })` (core's body: `importId`
  UUID, `format`, `totalRows`, ≤ 100 `rows`, optional `removeMissing` keep-lists) returns
  `RpcResult<Outcome<ImportBatchResult>>`: per-row results, `removed`, and `removedR2Keys`
  for the web to delete. It runs under the sale lock (`apps/engine/src/sale/import.ts`) with
  job tracking in `io_jobs`, per-row results and idempotency in `io_job_rows` (migration
  `0008_io_jobs`), the opted-in removal once per import with its first batch, catalog
  autofill, and one D1 batch per call.
- **Contract step owed:** WS-E's `import_rows` table (`0006_engine_write_path`) is no longer
  written. It stays while deployed code may still write it; a later contract migration
  drops it (and `importRows` in `packages/db/src/schema.ts`).
- Items without a game store `game_id = 'none'` (core `NO_GAME_ID`); `isNoGame` also treats
  the older `'other'` as no game.
- WS-G dropped "Other TCG": the item form lists the enabled registry games, plus
  "Not game-specific" (`game_id = 'none'`) for accessories only. Items stored as
  `other` still display as "Other TCG" and must pick a game when next saved.
- Market prices reach the web from D1 directly (`marketPricesFor`, seller-gated /sell
  pages and endpoints); the type-ahead uses the engine's `searchCatalog` RPC.
- The hand-entry item form still takes free-form attributes (catalog autofill fills
  them); moving it onto core's per-game field lists is open.

### Wave 3 integration notes (WS-K, notifications and messaging)
- The notifications queue now carries `sale_events` (WS-E), `notify_deliver`, `notify_digest`,
  `allowlist_invites` and WS-F2's `photo_verify`. The consumer (`apps/engine/src/notifications`)
  maps events to `notifications` rows with core's `notificationsForSaleEvents`; to notify about a
  new event type, add a case there and its copy in `describeNotification` (one place for the bell
  and email). Invoice links point at the sale page until WS-J's buyer invoice page exists.
- Email: per-category preferences, verified addresses only, seller activity as a 5-minute digest,
  message emails only if unread after 10 minutes; the cron sweep sends what a lost message left.
  Delivery state lives on `notifications` (migration `0009_notifications_messaging`).
- Followers and want lists are told about **public** sales only, when scheduled and when live.
  Items added to an already-published sale aren't matched against want lists yet.
- Messaging is server load + form actions; `#lib/messaging/live.ts` polls today. **WS-H seam:**
  swap its `pollTransport` for a subscription on the sale DO's broadcast; the thread page keeps
  calling `watchConversation`.
- Allowlist invites go out when a private sale is published, and when the invite list of a
  published sale is saved (`ENGINE.sendAllowlistInvites`); `setPrivateAccess` keeps `invited_at`.
- Seller blocks reuse `blocks`, so a blocked buyer can neither message nor claim.

### Merge rules for parallel work
- **Migrations:** WS-A owns the core tables, WS-C owns catalog tables, WS-F2 owns
  `image_hashes`. Whoever merges second regenerates their migration on top of `dev`
  (`pnpm --filter @claimsale/db db:generate`) so the Drizzle journal stays linear.
- **Shared files** most likely to conflict: `packages/db/src/schema.ts`,
  `packages/core/src/index.ts`, `apps/*/wrangler.jsonc`, `worker-configuration.d.ts`
  (regenerate with `cf-typegen`), `pnpm-lock.yaml` (re-run `pnpm install`), and the
  STATE_MACHINES §10 registry (append-only).
- New rules discovered while building get a registry row in the same PR.

## 4. Owner steps that gate later waves
- TCGCSV terms and attribution check (before WS-C ships to staging).
- Twilio Verify account and Turnstile site keys into Infisical (WS-D on staging).
- `claimsale.net` + `notify.claimsale.net` in Email Service (WS-K on staging).
- The remaining TECH_STACK §11 checklist items (Sentry, Access).
