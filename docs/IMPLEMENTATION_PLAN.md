# Implementation Plan — what's left to the pilot sale

> Written 2026-11-15 from PLAN §13 and the code on `dev` (`c0f5363`); status refreshed
> 2026-11-18 after wave 3 (`f8f8428`). PLAN.md stays the
> source of product decisions (D#), and STATE_MACHINES §10 holds the rule IDs. This file
> only covers **order, chunking and done criteria** for the rest of the build. Update it
> when a workstream merges.

## 1. Where we are

| Milestone (PLAN §13) | Status |
| --- | --- |
| 0. Foundations (monorepo, CI, previews, staging/prod) | Done |
| 1. Observability spike (T28, S38) | Done; Sentry check waits on owner steps (TECH_STACK §11) |
| 2. Domain core (`packages/core`, SM-2…SM-8 pure) | Done |
| 3. Auth | Done: Better Auth (#8), phone OTP, Turnstile, seller requirements (WS-D, #14) |
| 4. Sales and items | Done: WS-A (#13), WS-B (#15), item import WS-G (#24) |
| 4b. TCG catalog + photo authenticity | Done: WS-C (#16), WS-F1 (#17), WS-F2 (#23) |
| 5. Engine (SaleEngine DO write path) | Done: WS-E (#22); the k6 load test hasn't been run on staging |
| 6. Live grid | Done: WS-H (#25); open items in its notes below |
| 7. Seller control room + admin disputes | Done: WS-I (#27), with D68 |
| 8. Invoices after close + exports + tracking import | Done: WS-J (#26), with D67 |
| 9. Notifications and messaging | Done: WS-K (#28), with D69 |
| 10. Discovery + pilot | WS-L1 discovery (#29) and WS-L2 share cards (#30) done; WS-M pre-pilot hardening (M1 #31, M2); the pilot checklist (`docs/PILOT_CHECKLIST.md`) waits on owner steps |

### Left after wave 3
Besides the owner steps in §4 and `docs/PILOT_CHECKLIST.md`, these were left out of their
workstreams on purpose (details in each workstream's notes in §3). WS-M (below) takes the
ones that matter before the pilot.
- **Live grid (WS-H):** done in WS-M (buyer actions and item-page claims in M2;
  broadcasting editor and import writes and closing sockets on an access change in M1).
- **Invoices (WS-J):** seller adjustments and discounts, per-item or "free over $X"
  shipping, the XLSX and JSON account exports, and the feedback table and form. After the pilot.
- **Done in WS-M1:** want-list matching for items added or repriced after publishing;
  `@spec` tags for `IO-export-roundtrip` and `IMG-hash-robust`; dropping `import_rows`.
- **Open questions:** WS-E's nonpayment attribution and the WS-F1 hash questions above.
- **Not run yet:** the WS-E k6 load test on staging (p95 < 300 ms).

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
- **Split (2026-11-18):** WS-L1 is discovery (browse, `/g/[game]`, search, "who has this
  card?", follow and report on sale pages, copy as text, landing page, sitemap) plus
  `docs/PILOT_CHECKLIST.md`; WS-L2 is the OG share cards (S13), kept apart because they add
  Satori and resvg-wasm to the web Worker's bundle.
- **WS-L2 notes (2026-11-18):**
  - The web Worker's upload went from 4.0 MB / 0.79 MB gzipped to 8.3 MB / 2.3 MB gzipped
    (resvg's WebAssembly is 2.4 MB of it); the Workers Paid limit is 10 MB gzipped. The
    WebAssembly loads on the first share image, not at Worker startup.
  - Fonts are bundled (Noto Sans, Latin and Latin Extended, from `@fontsource/noto-sans`)
    instead of the renderer's default CDN fonts. Text outside those ranges (Japanese card
    names, for example) is left out of the image; adding a CJK font would cost several MB.
  - Emoji are fetched from the renderer's emoji CDN (jsDelivr, twemoji) while rendering. If
    that fails, the route serves the card without emoji, uncached.
  - Cards carry no go-live time: sellers have no stored time zone, and the image is cached
    for everyone. They show a status (Upcoming, Live now, Closed) instead.
  - Item photos aren't on the card yet (only text). Adding them means reading the item's
    approved photo from R2 into the render, and only for public and unlisted sales.

### WS-M · Pre-pilot hardening (2026-11-18)
After WS-L. Two PRs, like WS-L.
- **M1:**
  - `LIVE-access`: saving a published sale that is now private, and was public or lost
    someone's access (password changed or removed, invite list off or an address removed),
    calls the engine's `revokeLiveViewers`, which closes every socket but the seller's
    with 4403; browsers reload and the web Worker checks access again.
  - `LIVE-broadcast` for writes outside a command: the item editor (add, edit, delete,
    bulk price) calls `listingsChanged`; an import batch does the same inside the engine.
    Either sends every viewer a fresh snapshot, and the page refetches when a snapshot
    lacks an item it shows or has one it doesn't. Reordering isn't broadcast (the page
    order shows on reload).
  - `TCG-want-list-notify` for late items: the same call publishes a `listings_changed`
    sale event; the consumer matches a public scheduled or live sale's listings again
    (keys by want and item, so nobody hears twice).
  - Contract migration `0012_drop_import_rows`; `@spec` tags for `IO-export-roundtrip`
    and `IMG-hash-robust`.
  - Tooling: the E2E web server command works under cmd.exe; preview deploys wait for
    five good answers before the smoke test; the rate-limit test sends its claims at once.
  - Email: `notify.claimsale.net` onboarded in Email Service (PILOT_CHECKLIST §1).
- **M2:** buyer actions on the grid and the item page.
  - `POST /api/sales/[saleId]/entries/[entryId]` with `{ itemId, action }` (`withdraw_offer`,
    `leave_queue`, `accept_counter`, `decline_counter`) calls the engine's `withdrawEntry` /
    `respondToCounter` after the same sign-in and access checks as placing.
  - `EntryControls.svelte` holds the buyer's part of an item (position, claim and offer,
    and the entry's actions from `entryActions` in `lib/live/state.ts`: an open offer can
    be withdrawn, an open claim only as a backup, an unexpired counter answered). The grid
    card and the new `LiveItemPanel.svelte` on `/s/[slug]/i/[itemId]` both use it; the panel
    follows one item on the sale's socket (`LiveGrid`'s `itemId` option).
  - Fix to M1: the editor's snapshot is marked `edited`, and the page refetches, so new
    titles, prices and photos show without a reload.

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

Waves 1–3 are merged (status in §1).

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
  `minAccountAgeDays` (a verified email is always required, D20/D68); the shipping menu from `sales.shipping`
  as `[{ id, label, priceCents, tracked }]`. WS-I / WS-J add the form fields.
- `POST /api/sales/[saleId]/entries` takes a claim or offer as JSON (session + sale access
  checked in web). WS-H can use it or call `placeEntry` from a remote function.
- Committed events go to the notifications queue as `{ kind: "sale_events", sale_id, events }`;
  the consumer only acknowledges them until WS-K.
- Import batches: see the WS-G notes below (WS-G replaced this first version).
- The publish photo check stays in web (`itemsWithoutPhotos`, `#lib/server/engine.ts`);
  WS-F2 tightens it there.
- Not built yet: a test-only clock endpoint for E2E time travel. (Rescind contests and the
  72h mutual-agreement timer came with WS-I, the WebSocket broadcast with WS-H.)
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
  and email). Buyers' invoice notifications link to `/me/invoices/<id>` and the seller's
  "buyer paid" to `/sell/<sale>/invoices` (WS-J).
- Rescinds (WS-I's events): the buyer is told once per rescind, from `rescind_recorded` (a
  mutual-agreement one asks them to answer within 72h); the seller hears about contests and
  disputes; both sides hear the admin's decision. Buyer links go to `/me/rescinds`, seller
  links to the control room.
- Message reports use WS-I's `reports` table and `fileReport` (ADMIN-report-queue), so they
  land on `/admin/reports` with the rest; the admin sees the reported message's text there.
  The message form offers `spam` and `off_platform_payment`, now also report reasons.
- Email: per-category preferences, verified addresses only, seller activity as a 5-minute digest,
  message emails only if unread after 10 minutes; the cron sweep sends what a lost message left.
  Delivery state lives on `notifications` (migration `0011_notifications_messaging`).
- Followers and want lists are told about **public** sales only, when scheduled and when live.
  Items added to an already-published sale aren't matched against want lists yet.
- Messaging is server load + form actions; `#lib/messaging/live.ts` polls today. **WS-H seam:**
  swap its `pollTransport` for a subscription on the sale DO's broadcast; the thread page keeps
  calling `watchConversation`.
- Allowlist invites go out when a private sale is published, and when the invite list of a
  published sale is saved (`ENGINE.sendAllowlistInvites`); `setPrivateAccess` keeps `invited_at`.
- Seller blocks reuse `blocks`, so a blocked buyer can neither message nor claim.

### Wave 3 integration notes (WS-I, control room and admin)
- New engine RPCs: `contestRescind` (buyer), `answerMutualRescind` (buyer), `resolveRescind`
  (admin; the engine checks `users.role`). The 72h mutual-agreement answer is a sale timer
  (`mutual_answer_due`) in the alarm and the cron sweep. Committed events now include
  `rescind_recorded`, `rescind_contested`, `rescind_mutual_agreed` / `_disputed` /
  `_timed_out` and `rescind_resolved` for WS-K's notifications.
- Migration `0010_control_room` (expand only): `rescinds.phase` / `answered_at` /
  `resolution_note`, `users.banned_at` / `banned_reason` / `banned_by`, and `reports`.
  Rows from before `phase` get it derived (core `fromStored`).
- Bans: the engine treats a banned account as a blocked buyer; Better Auth refuses a new
  session (`ACCOUNT_SUSPENDED`); banning deletes the account's sessions.
- `POST /api/reports` takes `{ targetKind: user | sale | item | message, targetId, reason,
  details? }` for WS-H's and WS-K's report buttons; WS-K added the check that a reported
  message exists.
- `/me/rescinds` is the buyer's side of rescinds (reason, contest, agree / dispute); WS-K
  should link it from the rescind notification.
- The terms form now writes `decisionWindowHours` (Pro) and `minAccountAgeDays`; WS-J adds its
  own fields to the same `SaleTerms`. Sellers can't turn off the verified-email requirement (D68).
- D68 (owner, 2026-11-17):
  - The abuse guard counts overturned rescinds resolved in the last 30 days.
  - A Pro seller's decision window is capped at 7 days. The seller can ask for more on the
    terms page; an admin approves or declines on `/admin/users`, up to 30 days, and can reset
    it. The cap lives in `users.decision_window_max_hours`, which the engine reads with the sale
    and applies when it reads the terms, so a revoked cap shortens existing sales' windows too.
  - Contests stay 10 to 2,000 characters; suspected-fraud rescinds still go straight to the
    admin without a contest; admins see account emails on `/admin/users`.

### Wave 3 integration notes (WS-J, invoices after close, exports, tracking import)
- New engine RPCs: `rescindOverdueInvoice` (SM-6-overdue-rescind), `replaceInvoiceTracking`
  (IO-tracking-replace), `applyTracking` (≤ 200 matched rows, IO-tracking-transition) and
  `requestExport`. `markInvoicePaid` now **requires `addressId`** (one of the buyer's saved
  addresses; the engine snapshots it and the option label onto the invoice,
  SM-6-address-snapshot). `shipInvoice` and `markInvoicePaid` pass the invoice's item kinds
  to core, so graded and sealed lines always need tracked shipping (TCG-tracked-graded-sealed).
- Exports reuse the engine's queue (`export_job` messages) and the `IMAGES` bucket (keys
  `exports/<seller>/<job>.csv`, served only by `/sell/exports/[jobId]` to their seller): no new
  Cloudflare resource. The 5-minute cron deletes files whose 24h link expired. CSV only; XLSX
  and the JSON account export are not built yet.
- Migration `0009_invoices_exports`: `invoices.shipping_option_label`, `io_jobs.layout` (expand only).
- Invoice numbers are shown as `CS-<n>` (core `invoiceNumberLabel`); the tracking import and
  Pirate Ship's "Order ID" use the same label.
- The shipping menu, the `autoSendAtClose` / `autoRescindOverdue` switches and the seller's
  payment handles live on `/sell/[saleId]/shipping` (not the terms form). `updateTerms` now
  merges into `sales.terms`, so fields saved elsewhere (these switches, WS-I's) survive it.
- Events for WS-K come from the engine as usual (`invoice_sent`, `buyer_marked_paid`,
  `payment_confirmed`, `invoice_shipped`, `tracking_replaced`, `invoice_completed`,
  `feedback_opened`); WS-J sends no email.
- Not built: seller adjustments / discounts on an invoice, per-item or "free over $X" shipping
  pricing, a feedback table and form (only the `feedback_opened` event). WS-J's E2E claims
  through `POST /api/sales/[saleId]/entries`, not WS-H's live grid.

### Wave 3 integration notes (WS-H, the live grid)
- **Path:** the browser opens `GET /api/sales/[saleId]/live` (WebSocket). The web Worker checks the
  upgrade, the `Origin` (same site only) and sale access exactly like the sale page
  (`liveUpgrade` in `#lib/server/live.ts`), then forwards to the engine's `fetch` at
  `/live/<saleId>` with the session's user in `x-claimsale-viewer` (core `LIVE_VIEWER_HEADER`).
  The engine has no public route, so only the web Worker can set that header. The Engine
  entrypoint passes the request to the sale's `SaleEngine`, which accepts it with the
  Hibernation API (`apps/engine/src/live/`).
- **Protocol** (`LiveMessage` in `packages/core/src/live.ts`; one JSON object per frame):
  `hello { protocol: 1, serverNow }` first, then `snapshot { serverNow, sale, items }` on every
  (re)connect, then per commit `sale { sale: { status, liveAt, closesAt, at } }` when the sale's
  status changed and `items { items: LiveItem[] }` with every item the commit touched. A
  `LiveItem` is `{ id, version, state, quantity, freeUnits, unitsWon, claimCount, offerCount,
  decisionDeadline, offers: [{ label, amountCents }], mine: MyEntry[] }`, projected per viewer by
  core's `liveItem` (no buyer IDs, no hidden minimum, no market price; offers per
  `SM-3-offer-visibility`; `mine` = the viewer's own entries with their `position`). Clients keep
  each item's highest `version` and the newest sale `at`. The browser sends only `"ping"`
  (every 25 s), which the runtime answers with `"pong"` without waking the object. Close codes:
  4403 (the sale went back to draft; every non-seller socket is closed) and 4404 (sale gone).
- **First render:** the sale page calls the new `ENGINE.liveSnapshot({ saleId, viewerId })` RPC
  (same projection, D1 read in the entrypoint, no DO hop); without the engine (`pnpm dev:ui`)
  the page renders without live data.
- **Broadcast helper for WS-K** (`LiveHub`, `apps/engine/src/live/hub.ts`; one per `SaleEngine`,
  field `#live`): `accept(viewer)` → `{ client, server }`; `broadcast(type, payload, audience?)`
  sends `{ type, ...payload }` to every socket whose `LiveViewer { userId, role: "seller" |
  "buyer" | "visitor", connectedAt }` passes `audience`; `payload` may be a function of the
  viewer (called once per distinct role + user; return undefined to skip that viewer);
  `sendToUser(userId, type, payload)` uses the socket's `user:<id>` tag (all of that user's tabs);
  `closeWhere(audience, code, reason)`; `count(audience?)`. Messaging can add its own `type`s
  (e.g. `message`) on the same sockets: send to `viewer.role === "seller" || viewer.userId ===
  buyerId`. Each message type must be projected for its audience like `liveItem` is.
- **After each commit** `SaleEngine.#afterCommit` calls `broadcastCommit(hub, work)` before
  re-arming the alarm; a broadcast failure is logged, never fails the committed command.
- **Sale settings:** the engine now reads `offerVisibility` from `sales.terms`; the terms form
  has a new `confirmClaims` field (default on; `LIVE-claim-confirm`).
- **Not built (open):** buyer actions beyond placing (withdraw an offer / leave the backup queue,
  answer a counter) have no UI or web endpoint yet; claim buttons are on the grid only, not on
  `/s/[slug]/i/[itemId]`; open sockets are not closed when a private sale's password or
  allowlist changes or its visibility changes (they are on the next reconnect); writes made
  outside the engine (the web item editor, import batches) aren't broadcast: a client that sees
  an unknown item ID refetches the page, others catch up on reconnect. The header's status badge
  updates on reload; the grid's buttons and countdown flip live. `ItemCard.svelte` is no longer
  used on the sale page (kept for WS-L's browse pages).

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
- ~~`claimsale.net` + `notify.claimsale.net` in Email Service~~ Done 2026-11-18 (PILOT_CHECKLIST §1).
- The remaining TECH_STACK §11 checklist items (Sentry, Access).
