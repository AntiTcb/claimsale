# Claim Sale — Project Plan

A purpose-built site for running "claim sales": a seller lists many items, buyers
claim an item at the asking price (first come, first served) or submit an offer,
and the seller works through the results. It replaces the Facebook workflow of
one giant post where every item is a photo and every claim is a comment.

---

## 1. What's broken about doing this on Facebook

These are the pains the product has to solve; each one maps to a feature below.

| Facebook pain | What we do instead |
| --- | --- |
| Comment order is ambiguous (edits, deleted comments, "claim" vs "claimed" vs "c") | Claims are a button. The server timestamps them and assigns a queue position atomically. |
| Sellers manually track who claimed what, often in a spreadsheet | Per-buyer rollup ("invoice") built automatically. |
| Backups ("BU") get lost when a buyer flakes | Explicit backup queue; the next buyer is promoted with one click (or automatically after a deadline). |
| Offers buried in comments or DMs | Structured offers with accept / decline / counter. |
| Buyers can't see what's still available | Live grid with filters: available, claimed, has backups, sold. |
| Questions ("measurements?") mixed in with claims | Per-item Q&A thread, kept separate from claims. |
| Disputes over who was first | Immutable audit log of every claim / unclaim / promotion. |
| Location data leaking from photos | EXIF stripped on upload. |

## 2. Users and roles

- **Seller** — creates sales, lists items, sets rules, manages claims, offers,
  invoices and shipping.
- **Buyer** — browses, claims, offers, asks questions, sees their own invoice.
- **Visitor** — signed out; can browse a public or unlisted sale but must sign in to claim.
- **Admin** — moderation (reports, bans). Minimal in the MVP.

Any account can be both a buyer and a seller.

## 3. Core concepts and rules

### Sale
- Title, description, cover image, and the seller's **terms**: payment methods,
  shipping policy, payment deadline, region/country restrictions, and free-text rules.
- **Visibility:** `public` (listed on a browse page), `unlisted` (link only, the
  default since most sales get shared into a FB group), or `private` (only invited
  users or members of a group).
- **Lifecycle:** `draft → scheduled → live → closed → archived`.
  - `scheduled`: items are visible ("preview") but claim buttons are disabled
    and a countdown is shown. This replaces "sale goes live at 8pm EST".
  - `live`: claims and offers are open.
  - `closed`: no new claims; the seller finishes invoicing and shipping.
- Optional automatic close time.

### Item
- Title, description, condition, photos (ordered, the first one is the cover), category/tags.
- **Asking price** (integer cents) and **quantity** (usually 1; >1 for "3 available").
- **Offers:** `off`, `on`, or `on with a minimum` (the minimum is never shown to buyers).
- Per-item shipping override (e.g. oversized items).
- **Status:** `available → claimed → pending_payment → paid → shipped`, plus `withdrawn`.
  Most of this is derived from the claim and invoice state rather than set by hand.

### Claim (the core of the product)
- A buyer presses **Claim** and gets a position in that item's queue.
  - Positions `1..quantity` are **winners**; everyone after them is a **backup**.
  - This mirrors the FB convention ("claim", "BU1", "BU2").
- The buyer can **release** a claim. Rule options per sale:
  - free release until the sale closes,
  - release only within N minutes of claiming,
  - or no releases ("claims are binding").
- The seller can **void** a claim (non-payer, blocked buyer, mistake); it then
  promotes the next backup.
- **Promotion** happens when a winner releases or is voided. The new winner is
  notified and gets the payment deadline restarted.
- Optional per-sale limits: a maximum number of claims per buyer, and a maximum backups per item.

### Offer
- A buyer submits an amount below asking, with an optional note.
- The seller can **accept** (it becomes a winning claim if a slot is free, otherwise a
  backup or rejected, depending on rules), **decline**, or **counter** (the buyer accepts
  or declines).
- Offers expire after a configurable time (e.g. 24h) or when the item is claimed at asking.
- **Key rule to decide per sale:** does a claim at full price beat a pending offer?
  The FB norm is yes ("asking price claims take priority"), so that is the default.
- Offers are visible only to the seller and the offering buyer. Public bidding
  turns into an auction, which is a different product (see Later).

### Invoice (per buyer per sale)
- Built automatically from that buyer's winning claims and accepted offers.
- Shipping rules per sale: a flat rate per buyer, per item, first item plus
  each additional item, free over $X, or "seller will quote".
- The seller can adjust lines, add a discount or custom shipping, then **send** it.
- Status: `draft → sent → paid → shipped (tracking #) → complete`.
- **Payment happens off-platform** (PayPal G&S, Venmo, etc.). The invoice shows the
  seller's handles, and the buyer clicks "I've paid" with an optional reference. The
  seller confirms. We never touch money in the MVP: no PCI scope and no
  money-transmitter questions.

### Q&A
- A threaded comment area per item. The seller's answers are highlighted.
- Separate from claims, so "is this still available?" never counts as a claim.

## 4. Features by phase

### Phase 0 — Foundations (week 1)
- SvelteKit 3 project, Cloudflare Worker deploy, D1 and R2 bindings, CI.
- Authentication, user profile, and layout shell.

### Phase 1 — MVP: run one real sale end to end
- Seller: create a sale, bulk upload items (drag in many photos, one item per photo
  or grouped, then fill in titles and prices in a table view), and set terms.
- Schedule or go-live, close.
- Buyer: browse the grid, view an item, claim, release, join the backup queue.
- Live updates: claimed items flip in real time for every viewer.
- Seller dashboard: per-item queue, void and promote, per-buyer rollup.
- Invoices with simple shipping rules, mark paid, mark shipped.
- Email notifications: you won / you were promoted / invoice sent / offer response.
- An Open Graph share card, so the sale link looks good when posted in FB.
- "Copy as text" export of the item list for the FB post body.

### Phase 2 — v1
- Offers (submit, accept, decline, counter, expire).
- Per-item Q&A.
- Web push notifications, plus "follow seller" to get notified of new sales.
- Automatic promotion after the payment deadline passes.
- Seller block list. Buyer "flake" history visible only to that seller.
- Saved shipping and payment presets per seller.
- Duplicate a sale and relist unsold items.

### Later / maybe
- Buyer and seller feedback (reputation) after completed invoices.
- "Groups": a community space with member-only sales (mirrors FB groups).
- Timed **offer windows**: highest offer wins at the close. This is really an
  auction mode, so build it only if people ask for it.
- On-platform payments via Stripe Connect.
- Shipping label integration (Pirate Ship / EasyPost).
- A CSV import of items.
- A PWA (installable app) with offline drafts.

## 5. Technical architecture

### Stack
| Concern | Choice | Notes |
| --- | --- | --- |
| Framework | **SvelteKit 3** (latest `3.0.x`) + **Svelte 5** (runes) | Use remote functions (`query` / `form` / `command`) for data and mutations where they fit. |
| Hosting | **Cloudflare Workers** with static assets via `@sveltejs/adapter-cloudflare` (v8) | Workers rather than Pages: Cloudflare is steering new features to Workers, and we need Durable Objects, Queues and cron in the same deployment. |
| Database | **Cloudflare D1** (SQLite) + **Drizzle ORM** | Drizzle migrations are applied with `wrangler d1 migrations`. |
| Images | **R2** for originals + **Cloudflare Images transformations** for resizing | Thumbnails are generated on the fly from URL params and cached at the edge. |
| Realtime | **Durable Objects** (one per sale) using the WebSocket Hibernation API | Used to push updates. See the concurrency notes below. |
| Background jobs | **Queues** (notification fan-out) + **DO alarms** / **cron triggers** | Alarms handle go-live, close, offer expiry and payment deadlines. |
| Auth | **Better Auth** with a D1 / Drizzle adapter | Supports magic links, Google and Facebook sign-in. Sessions are stored in D1. |
| Email | Cloudflare Email Sending if it's available on the account, otherwise **Resend** | Transactional email only. |
| Bot protection | **Turnstile** on sign-up, plus the Workers **Rate Limiting** binding on claim and offer endpoints | |
| Styling | Tailwind CSS v4 + a headless component library (bits-ui / shadcn-svelte) | |
| Testing | Vitest (unit tests, plus `@cloudflare/vitest-pool-workers` for tests against D1 and DOs) and Playwright for end-to-end tests | |
| Tooling | pnpm, TypeScript strict mode, ESLint, Prettier, GitHub Actions → `wrangler deploy` | |

### Request flow
```
Browser ──HTTP──▶ Worker (SvelteKit) ──▶ D1 (source of truth)
   │                     │                 R2 (images)
   │                     ├──▶ Queue ──▶ consumer: email / web push
   │                     └──▶ SaleRoom DO (per sale): broadcast "item X changed"
   └──WebSocket──────────────▶ SaleRoom DO ──▶ all connected viewers
```

### Claim concurrency: the most important correctness issue
At go-live, dozens of people hit **Claim** on the same item within milliseconds.
"First" must be unambiguous and the result must never show two winners.

**Recommendation: D1 is the source of truth, and each claim is a single atomic statement.**
D1 processes writes one at a time per database, so one statement cannot race with itself:

```sql
INSERT INTO claims (id, item_id, user_id, kind, position, status, created_at)
SELECT ?1, ?2, ?3, 'claim',
       COALESCE(MAX(position), 0) + 1, 'active', unixepoch('subsec') * 1000
FROM claims
WHERE item_id = ?2 AND status = 'active'
  AND NOT EXISTS (SELECT 1 FROM claims WHERE item_id = ?2 AND user_id = ?3 AND status = 'active')
RETURNING position;
```

Add a unique index on `(item_id, position) WHERE status = 'active'` as a backstop.
Releasing a claim and promoting the next backup run as one `db.batch([...])`,
which executes as a transaction. After a successful write, the Worker tells the
sale's DO to broadcast the change. The DO is a fan-out hub only, so losing it never loses data.

*Alternative if D1 write contention shows up under load:* make the SaleRoom DO
the claim authority for live sales, using its SQLite storage to serialize claims,
and write through to D1 asynchronously. This is faster at the moment of the rush
but adds a second source of truth. Load-test before choosing it.

### Realtime details
- On page load, render from D1 through server-side rendering, then open a
  WebSocket to `/api/sales/:id/live`, which the Worker forwards to the DO.
- Messages are small diffs: `{type:"item", id, status, claimCount, version}`.
  The client ignores versions it already has, and refetches on reconnect.
- The Hibernation API means idle sockets don't bill DO run time.
- "Server time" is sent on connect so the go-live countdown isn't based on the
  buyer's clock. Claims made before `live_at` are rejected server-side regardless.

### Images
1. The client picks files and resizes them to at most about 2000px on a canvas,
   re-encoding to WebP or JPEG. This **strips EXIF/GPS** and cuts upload size.
2. The client asks the server for a short-lived R2 presigned PUT URL, or uploads
   through a Worker endpoint for simplicity at first.
3. The client uploads, and the server records an `item_images` row.
4. Images are served through `/cdn-cgi/image/width=400,format=auto/...` (Images
   transformations) for grid thumbnails and the full size for the lightbox.
- Still strip EXIF server-side as a fallback if a raw upload path is ever added.

### Auth and identity
- **Sign-in:** an email magic link, plus Google and Facebook OAuth.
- **Facebook trust:** FB Login doesn't give you the user's profile URL without app
  review (the `user_link` permission). The MVP lets users paste their FB profile URL
  on their profile. The seller sees it next to claims and can verify it themselves.
  Display names are not unique, so show the avatar plus the profile link.
- Require a verified email before a user can claim.

### Scheduled work
- Each live or scheduled sale's DO sets an **alarm** for its next event: go-live,
  auto-close, the next offer expiry, the next payment deadline.
- When the alarm fires, the DO calls back into D1 to apply the transition, then
  re-arms for the following event.
- A **cron trigger** (every 5 minutes) sweeps for anything missed. Alarms are
  reliable, but a sweep is cheap insurance.

### Notifications
- Domain events (`claim.won`, `claim.promoted`, `offer.countered`,
  `invoice.sent`, …) are written to a `notifications` table *and* sent to a Queue.
- A queue consumer sends the email or web push, respecting per-user preferences.
- In-app: a bell icon backed by the `notifications` table.
- Batch the seller's notifications ("12 new claims in the last 5 minutes")
  instead of sending one email per claim.

## 6. Data model (first pass)

All money is stored as **integer cents** plus a currency code. All timestamps are
stored as integer milliseconds, set by the server. IDs are ULIDs or UUIDv7, so
they are sortable and not guessable.

```
users            id, email, email_verified, display_name, avatar_url, fb_profile_url,
                 country, created_at
accounts/sessions/verifications  (managed by Better Auth)

seller_profiles  user_id PK, payment_handles JSON, default_terms, default_shipping JSON

sales            id, seller_id, slug, title, description_md, cover_image_id,
                 visibility, status, currency, live_at, closes_at,
                 rules JSON  -- release policy, offer policy, limits, payment deadline hrs
                 shipping JSON, terms_md, created_at, updated_at

items            id, sale_id, sort_order, title, description_md, condition,
                 price_cents, quantity, offers_mode, min_offer_cents,
                 shipping_override_cents, status, version, created_at, updated_at

item_images      id, item_id, r2_key, width, height, sort_order

claims           id, item_id, user_id, kind ('claim'|'offer_accepted'),
                 position, status ('active'|'released'|'voided'|'converted'),
                 price_cents, created_at, ended_at, ended_reason
                 UNIQUE(item_id, position) WHERE status='active'
                 UNIQUE(item_id, user_id)  WHERE status='active'

offers           id, item_id, user_id, amount_cents, note, status
                 ('pending'|'accepted'|'declined'|'countered'|'expired'|'withdrawn'),
                 counter_cents, expires_at, created_at, responded_at

invoices         id, sale_id, buyer_id, status, subtotal_cents, shipping_cents,
                 adjustment_cents, total_cents, payment_ref, tracking,
                 sent_at, paid_at, shipped_at, due_at
invoice_lines    id, invoice_id, claim_id, description, amount_cents

comments         id, item_id, user_id, parent_id, body, created_at, deleted_at

follows          follower_id, seller_id
blocks           seller_id, blocked_user_id, reason
notifications    id, user_id, type, payload JSON, read_at, created_at
push_subscriptions  id, user_id, endpoint, keys JSON
audit_log        id, sale_id, item_id, actor_id, action, data JSON, created_at
```

Indexes: `items(sale_id, sort_order)`, `claims(item_id, status, position)`,
`claims(user_id, status)`, `offers(item_id, status)`, `invoices(sale_id, buyer_id)` (unique),
`audit_log(sale_id, created_at)`.

## 7. Routes / pages

```
/                               landing page; "your sales" and "followed sellers"
/login, /signup                 sign-in
/u/[handle]                     public profile: active sales, (later) feedback
/s/[slug]                       sale page: header, terms, live item grid, filters
/s/[slug]/i/[itemId]            item detail: photos, claim/offer, queue size, Q&A
/me/claims                      my claims, offers and invoices across sales
/me/settings                    profile, notifications, payment handles

/sell                           my sales
/sell/new                       create a sale (wizard: details → terms → items)
/sell/[saleId]/items            bulk editor: table view with drag-reorder and photo dropzone
/sell/[saleId]/manage           live control room: per-item queues, offers inbox, activity feed
/sell/[saleId]/buyers           per-buyer rollup → invoices
/sell/[saleId]/invoices/[id]    edit and send an invoice

/api/sales/[id]/live            WebSocket upgrade → SaleRoom DO
/api/uploads                    presign or receive image uploads
/og/s/[slug].png                dynamic share image (generated with Satori)
```

## 8. UX details worth getting right

- **Mobile first.** Most buyers arrive by tapping a link inside the FB app's
  in-app browser. Test there: magic links can open in a different browser than
  the one the user started in, and OAuth popups misbehave.
- **The claim button is optimistic but honest.** Show "Claiming…", then confirm
  either "You're #1 — it's yours" or "You're backup #2".
- **Go-live rush:** preload the grid during preview, so at go-live only the button
  state flips. No page reload is needed.
- **The seller's bulk item entry must be fast.** This is where FB is actually
  easiest today (upload 50 photos, type prices in captions). Aim for: drop
  photos → auto-create items → tab through a title/price table → publish.
- **Filters:** available only, price range, category, "items I claimed".
- **Accessibility:** keyboard-operable grid, real buttons, live-region announcements for claim results.

## 9. Abuse, trust and safety

- Rate limit claims per user and per IP, using the Rate Limiting binding.
- Turnstile on sign-up, and optionally on the first claim of a session.
- Per-sale maximum claims per buyer, to stop someone sniping everything.
- Seller block list. Blocked users see the sale but can't claim.
- Report sale / report user, going to an admin queue.
- Audit log visible to the seller, and the relevant entries to an affected buyer.
- Prohibited items policy and terms of service, especially if this ever leaves the
  hobby niche. Check the categories against payment-provider rules if Stripe is added later.

## 10. Cost and limits (rough)

All of the services above have a free tier or a $5/month Workers Paid plan base
that should cover early usage. Durable Objects need the paid plan. Watch for:
- D1: 10 GB per database and single-writer throughput. Fine for this scale.
- DO WebSockets: hibernation keeps costs near zero while sale pages sit idle.
- Images transformations: billed per unique transformation. Limit thumbnails to a
  few fixed sizes rather than arbitrary widths.

## 11. Testing strategy

- **Unit tests:** pricing, shipping and invoice math, plus the claim, offer and
  invoice state machines as pure functions.
- **Integration tests** (`vitest-pool-workers` against local D1 and DOs): the claim
  race. Fire 100 concurrent claims at one item and assert exactly one #1 and
  contiguous backups. Also release → promote → notify.
- **End-to-end tests** (Playwright): a seller creates a sale and goes live, two
  buyers race for an item, an invoice is sent, the buyer marks it paid.
- **Load test** before the first real sale: simulate the go-live rush with k6 or
  `autocannon` against a preview deployment.

## 12. Open questions for the product owner

1. **Niche:** is this for a specific hobby (cards, sneakers, plants, LEGO…)? That
   affects categories, condition scales and the shipping defaults.
2. **Single seller vs community:** is it just you and your group(s) at first, or open
   sign-up for any seller from day one?
3. **Group-gated sales:** do sales need to be restricted to members of a community,
   like FB groups are?
4. **Offers vs claims priority:** confirm that "full-price claim beats pending offers"
   is the right default.
5. **Binding claims:** should a claim be binding by default, or releasable?
6. **Payments:** is off-platform payment acceptable long-term, or is Stripe a goal?
7. **Geography:** US only (USD, US shipping) at first, or multi-currency?
8. **Domain name and branding.**

## 13. Proposed first milestones

1. Scaffold: `pnpm create svelte` (SvelteKit 3), adapter-cloudflare,
   `wrangler.jsonc` with D1, R2 and DO bindings, Drizzle schema plus the first
   migration, and CI deploys to a preview Worker.
2. Auth: Better Auth with magic links and Google, plus the profile page.
3. Sales and items CRUD, plus image upload to R2.
4. Claims (atomic insert, release, promote) with the race test.
5. The SaleRoom DO and the live grid.
6. Seller control room, buyer rollup, invoices.
7. Email notifications via a Queue.
8. Share card and text export → run a real pilot sale.
