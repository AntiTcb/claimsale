# ClaimSale (claimsale.net) — Project Plan

> A claim-sale marketplace for **trading card games** (D59).

A purpose-built site for running "claim sales": a seller lists many items, buyers
claim an item at the asking price (first come, first served) or submit an offer,
and the seller works through the results. It replaces the Facebook workflow of
one giant post where every item is a photo and every claim is a comment.

---

## 0. Decisions so far

| # | Decision | Date |
| --- | --- | --- |
| D1 | Stack: SvelteKit 3 + Svelte 5 on Cloudflare Workers (D1, R2, Durable Objects, Queues). | 2026-10-07 |
| D2 | ~~Category-agnostic platform~~ → **superseded by D59** (TCG-only). | 2026-10-08 |
| D3 | **Open sign-up** for buyers and sellers from day one. | 2026-10-08 |
| D4 | **Monetize from sales.** See section 3a for options. | 2026-10-08 |
| D5 | Sale visibility: **public**, **unlisted** (link only), or **private** (password-protected or an email allowlist). | 2026-10-08 |
| D6 | **Claims are binding.** The seller can rescind a claim. The buyer can only *request* a take-back, which the seller approves or denies. | 2026-10-08 |
| D7 | **US and USD only** at launch. Store a currency code anyway so expanding later doesn't need a migration. | 2026-10-08 |
| D8 | **Launch free**, with **Pro tiers for buyers and sellers**, plus **optional on-site checkout with a fee** later. See section 3a. | 2026-10-08 |
| D9 | The operator will form an **LLC** before taking any payments. | 2026-10-08 |
| D10 | **Sales are events only.** No permanent storefronts. | 2026-10-08 |
| D11 | **Offers ship in the first release.** Accepted offers are binding. **The seller has the final call** between a full-price claim and an offer. | 2026-10-08 |
| D12 | Buyers can claim multiple units of a listing, up to a per-buyer limit the seller sets. | 2026-10-08 |
| D13 | Payment deadline: **48h** by default; **Pro sellers can set 24h**. Every seller gets one-click "rescind and pass to the next backup". | 2026-10-08 |
| D14 | Leaving the backup queue is free until you are promoted. | 2026-10-08 |
| D15 | Sellers define a shipping menu. **Tracking is required above $20 for free sellers and above $40 for Pro sellers.** | 2026-10-08 |
| D16 | Combining shipping across sales ("merge invoices") comes in v1. Shipping labels come later. | 2026-10-08 |
| D17 | Communities: v1/v2, but the data model is designed for them now. | 2026-10-08 |
| D18 | **Buyer↔seller messaging on-site.** | 2026-10-08 |
| D19 | Discord webhooks are a **Pro seller** feature. | 2026-10-08 |
| D20 | Email verification is required; **Pro buyers bypass** it (see D29). | 2026-10-08 |
| D21 | **Proxies, orica and counterfeits are banned.** | 2026-10-08 |
| D22 | While payment is off-site, the platform's role in disputes is reputation, reports and bans only. | 2026-10-08 |
| D23 | The owner is the solo builder and sole admin. No target date or pilot group yet; the name is undecided. | 2026-10-08 |
| D24 | Pro buyer rescind: allowed **until the invoice is sent, max 5 per month**. It counts on the record as a "rescind". Sellers can't opt out but see buyers' rescind rates. | 2026-10-08 |
| D25 | Decision window (full-price claim vs offers): **24h for free sellers, configurable by Pro sellers**. When it expires, the earliest full-price claim wins. | 2026-10-08 |
| D26 | **Offer counts are always public.** Offer **amounts** are per-sale: `blind` (only the seller sees them) or `visible` (everyone sees them). | 2026-10-08 |
| D27 | The hidden minimum offer (auto-decline) is a **Pro seller** feature. | 2026-10-08 |
| D28 | **Public browse and search from day one.** | 2026-10-08 |
| D29 | Pro buyers skip email verification and sellers' new-account requirements; sellers can still block individuals. | 2026-10-08 |
| D30 | Free sellers: max **2** sales scheduled or live at once. | 2026-10-08 |
| D31 | Private sales (password / allowlist) are **Pro**; unlisted is free. | 2026-10-08 |
| D32 | Lots count as one item. | 2026-10-08 |
| D33 | Photos per item: **free 4, Pro 12**. | 2026-10-08 |
| D34 | With no pending offers, a full-price claim wins instantly. Sellers can turn on "review every claim" per sale. | 2026-10-08 |
| D35 | Offers above asking are allowed. | 2026-10-08 |
| D36 | Pro pricing (starting point): Seller Pro about $8/month, Buyer Pro about $4/month, a bundle, 20% off annual; early adopters get free Pro for a period. | 2026-10-08 |
| D37 | On-site checkout fee (later): 3% free / 1.5% Pro; Stripe's processing fee is passed to the seller. | 2026-10-08 |
| D38 | Age: **13+ to buy** (parental-consent checkbox under 18), **18+ to sell**. | 2026-10-08 |
| D39 | Warn about F&F / Zelle / Cash App; show an "Accepts G&S" badge. Not required. | 2026-10-08 |
| D40 | Once an item has entries: title and photos are editable (logged); price and quantity are locked. | 2026-10-08 |
| D41 | Follow a seller and get notified of new sales, in the MVP. | 2026-10-08 |
| D42 | Sales run live for at most 14 days; the preview can open at most 7 days before go-live. | 2026-10-08 |
| D43 | Backup offers on sold-out items: a per-sale toggle, on by default. | 2026-10-08 |
| D44 | Backup ranking: amount (highest first), then time; the seller can reorder. | 2026-10-08 |
| D45 | Backups at or above asking auto-promote; below asking goes back to the seller (decision window restarts). | 2026-10-08 |
| D46 | Buyers can withdraw a pending offer until it is accepted. | 2026-10-08 |
| D47 | Visible-offer mode shows amounts with anonymous labels ("Buyer A"); the seller sees names. | 2026-10-08 |
| D48 | Counter-offers: one round at launch. Offers still pending at close get 24h for the seller to accept, then lapse. | 2026-10-08 |
| D49 | **Invoices go out only after the sale closes**, never mid-sale. The seller sends them, or auto-send at close is on. | 2026-10-08 |
| D50 | Completion: the buyer confirms receipt, or it auto-completes 14 days after shipping; feedback opens on completion. | 2026-10-08 |
| D51 | **Seller rescinds need a reason code plus a written explanation, and the code assigns fault** (buyer, seller, neutral, or admin review). Only seller-fault rescinds count against the seller. Buyers can contest within 7 days, and the admin resolves it. See STATE_MACHINES 4.3.1. | 2026-10-08 |
| D52 | Take-back requests are allowed until the buyer marks the invoice paid. | 2026-10-08 |
| D53 | Buyers see a running total of their wins during a live sale. | 2026-10-08 |
| D54 | Seller analytics: basic counts are free; detailed analytics are Pro. | 2026-10-08 |
| D55 | **Sellers must be 18+ and verify email and phone. Pro sellers skip phone verification.** | 2026-10-08 |
| D56 | Browse and search include public sales only (not unlisted). | 2026-10-08 |
| D57 | **Import/export tools ship at launch:** bulk import of sale data, export of sales and buyer/order info, and re-import of shipping tracking numbers. See section 3c. | 2026-10-08 |
| D59 | **TCG-focused platform.** ClaimSale is for trading card games only (Yu-Gi-Oh, Pokémon, Magic: The Gathering, Riftbound and other TCGs): singles, graded cards, sealed product, TCG accessories, and lots. **Game** is a first-class concept, and items link to a shared **card and product catalog**. No general-purpose categories. See "TCG catalog and item model" in section 3. | 2026-10-08 |
| D58 | Import/export defaults accepted: exports carry only handle, display name and shipping address (no email or phone); CSV + XLSX both ways plus a JSON account export; Pirate Ship preset + generic CSV at launch; a column-mapping step for any CSV, with named collection-app presets in v1; photos by ZIP only; all import/export tools free; imports only into draft or scheduled sales, upserting by `sku` / `item_id`, with removal opt-in. | 2026-10-08 |
| D60 | **The catalog is TCGCSV only, and only for autofill.** Typing a card or product name fills in game, set, number, rarity and product type, and links the TCGplayer product ID. **The seller supplies everything else**: price, condition, finish/edition details, description and photos. No third-party images and no Scryfall / YGOPRODeck / Riftcodex. The TCGplayer market price is used only as a listing aid for sellers (D64). | 2026-10-09 |
| D61 | TCG round defaults accepted: full launch games YGO / Pokémon / MTG / Riftbound plus the other TCGCSV games (Q-TCG-1); want lists at launch (Q-TCG-2); Pokémon handled through TCGCSV like every other game (Q-TCG-4); TCGplayer + ManaBox import presets at launch (Q-TCG-7). Market prices are never shown to buyers (D64). | 2026-10-09 |
| D62 | **No digital code cards** (PTCGL, Arena or any other redeemable code). Altered art is allowed with a required "altered" flag. Repacks are allowed only if labelled "repack, not factory sealed". | 2026-10-09 |
| D63 | **Every item in a sale needs at least one real seller photo**, for every kind and price. **Duplicate images are detected and prohibited:** a photo that matches an image already used in another seller's sale is rejected. Sellers must provide their own unique photos. See "Photo authenticity" in section 3. | 2026-10-09 |
| D64 | **Market price as a seller listing aid.** The price input shows the TCGplayer market price (from TCGCSV) as its **placeholder**, with **quick buttons for a % of market** (e.g. 70 / 75 / 80 / 85 / 90 / 100%, where 80% is the common choice). The seller always sets the final price; nothing is filled in until they click. **Never shown to buyers.** | 2026-10-09 |
| D65 | Photo rules confirmed: own-photo reuse only when relisting the same item; reject at distance ≤ 6, review at 7–12 (tuned before launch); an account is flagged after 3 rejected matches in 30 days. | 2026-10-09 |
| D66 | **A timestamp photo is required for newer sellers** (fewer than 5 completed sales) on every sale they publish. It's optional for everyone else, and any sale with one gets a "Timestamped" badge. | 2026-10-09 |

The detailed behavior spec for claims, offers, take-backs and invoices lives in
[`STATE_MACHINES.md`](./STATE_MACHINES.md).

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
- **Visibility:**
  - `public`: listed on the browse page and in search, and indexable.
  - `unlisted`: anyone with the link can view; it isn't listed or indexed (`noindex`).
    This is likely the most common choice, since sales get shared into FB groups.
  - `private`: the sale is gated, and the seller picks one or both methods:
    - **Password:** a shared password unlocks the sale for that browser session.
      It's stored as a hash and rate-limited against guessing. The buyer still
      needs an account to claim.
    - **Email allowlist:** the seller pastes or uploads emails. Only signed-in
      users whose *verified* email is on the list can view. Invitees get an email
      with a link. The seller can add or remove addresses during the sale.
  - Private-sale photos must not be readable by guessing URLs. Serve them through
    an access-checked route or a short-lived signed URL, not a public R2 path.
  - The share card for private sales shows only the title and seller, never the items.
- **Lifecycle:** `draft → scheduled → live → closed → archived`.
  - `scheduled`: items are visible ("preview") but claim buttons are disabled
    and a countdown is shown. This replaces "sale goes live at 8pm EST".
  - `live`: claims and offers are open.
  - `closed`: no new claims; the seller finishes invoicing and shipping.
- Optional automatic close time.

### Item
- **Game** (required) and **kind**: single, graded single, sealed, accessory or lot.
- **Catalog link** (optional, strongly encouraged): the exact card or product
  printing from the shared catalog. It fills in the name, set, number and rarity,
  and offers a reference image and a market price hint.
- Title, description, photos (ordered, the first one is the cover; real photos,
  not only catalog images).
- **Game-specific attributes:** condition, language, finish, edition, grading and so on
  (see "TCG catalog and item model" below).
- **Asking price** (integer cents) and **quantity** (usually 1; >1 for "3 available").
- **Offers:** `off`, `on`, or `on with a minimum` (the minimum is never shown to buyers).
- Per-item shipping override (e.g. oversized items).
- **Status:** `available → claimed → pending_payment → paid → shipped`, plus `withdrawn`.
  Most of this is derived from the claim and invoice state rather than set by hand.

### Claim (the core of the product)
- A buyer presses **Claim** and gets a position in that item's queue.
  - Positions `1..quantity` are **winners**; everyone after them is a **backup**.
  - This mirrors the FB convention ("claim", "BU1", "BU2").
- **Claims are binding (D6).** A free buyer cannot release one on their own.
  - **Exception: Pro buyers can rescind their own claim** without seller approval
    (D8): until the invoice is sent, max 5 per month (D24).
  - **Take-back request:** the buyer asks to back out, with an optional reason.
    The seller sees it in the control room and **approves** (the claim is released
    and the next backup is promoted) or **denies** (the claim stands). While the
    request is pending, the claim stays active.
  - Leaving a backup queue is free until you are promoted (D14).
  - Approved take-backs are counted on the buyer's record (section 3b).
- The seller can **rescind** a claim at any time: a non-payer, a blocked buyer,
  a listing mistake, or an item that turned out damaged. They choose a reason.
  Rescinding promotes the next backup unless the seller marks the item as withdrawn.
- **Promotion** happens when a winner is rescinded or a take-back is approved. The
  new winner is notified and their payment deadline restarts.
- Claim buttons show a short confirmation ("Claims are binding. Claim for $40?").
  The seller can turn this off for sales where speed matters.
- Optional per-sale limits: a maximum number of claims per buyer, and a maximum backups per item.

### Offer (first release, D11)
- A buyer submits an amount, with an optional note. **Offers are
  binding**: if the seller accepts, the buyer owes it.
- The seller can **accept**, **decline**, or **counter**. If countered, the buyer
  accepts (binding) or declines.
- Offers can be above asking (D35). Pro sellers can set a hidden minimum that
  auto-declines lower offers (D27).
- **The seller has the final call** between full-price claims and offers (D11):
  - With no pending offers, a full-price claim wins instantly (D34).
  - With pending offers, a full-price claim puts the item in **`deciding`**. The
    seller awards any entry. If they haven't decided by the end of the decision
    window (D25), the earliest full-price claim wins.
  - Everyone else becomes a backup, ranked by amount and then time; the seller can reorder.
- **Visibility (D26):** offer counts are always shown. Amounts are `blind` or
  `visible` per sale. Note that `visible` amounts plus above-asking offers behave
  like an open auction. That's fine because the seller still decides; there's no
  auto-win for the highest bid.
- Full rules: [`STATE_MACHINES.md`](./STATE_MACHINES.md).

### Invoice (per buyer per sale)
- Built automatically from that buyer's winning claims and accepted offers.
- **Shipping menu (D15):** the seller defines options, for example "PWE (untracked)
  $1.50", "BMWT (tracked) $5", or "Local pickup". The buyer picks one on the invoice.
  - Options can be per-buyer flat, per item, or first item plus each additional,
    with free shipping over $X.
  - **Tracking rule:** untracked options are hidden once the invoice subtotal goes
    over **$20 (free seller)** or **$40 (Pro seller)**.
- **Payment deadline (D13):** 48h after the invoice is sent (Pro sellers can choose
  24h). When it's missed, the seller is offered one-click "rescind and pass to the
  next backup".
- The seller can adjust lines, add a discount or custom shipping, then **send** it.
- Status: `draft → sent → paid → shipped (tracking #) → complete`.
- **Shipping address:** buyers keep an address book. Choosing an address (with
  the shipping option) is part of "I've paid". The seller sees that address only
  on that buyer's invoices; it also appears in order exports (section 3c).
- **Payment happens off-platform** (PayPal G&S, Venmo, etc.). The invoice shows the
  seller's handles, and the buyer clicks "I've paid" with an optional reference. The
  seller confirms. We never touch money in the MVP: no PCI scope and no
  money-transmitter questions.

### Messaging (D18)
- Buyer↔seller messages are on-site, with one conversation per buyer per sale,
  linked to their invoice. A buyer can message a seller before claiming (e.g. "can I
  see the back of the card?").
- Messages update in real time over the same WebSocket infrastructure, with an
  email or push notification if unread after N minutes.
- Image attachments are allowed (for condition photos), stored in R2 with access checks.
- A report button on every message; a seller can block a user from messaging them.
- **Off-platform payment risk:** messaging is where scams happen ("pay me F&F
  instead"). Show a warning when a message contains payment-handle patterns.

### Q&A
- A threaded comment area per item. The seller's answers are highlighted.
- Separate from claims, so "is this still available?" never counts as a claim.

### TCG catalog and item model (D59, D60)

**Games.** A `games` table drives navigation, filters and attribute schemas. Each
game has a slug, display name, its condition scale (all use the TCGplayer-style
scale), finish options, language options, its TCGplayer category ID and an enabled flag.
**Launch games (D61):** Yu-Gi-Oh, Pokémon, MTG and Riftbound, plus the other games
TCGCSV covers (One Piece, Lorcana, Flesh and Blood, Star Wars: Unlimited, Digimon,
Gundam…). Adding a game is a data change plus an attribute schema.

**Item kinds and their attributes.** Everything except the catalog-filled fields is
entered by the seller.

| Kind | Autofilled from the catalog | Entered by the seller |
| --- | --- | --- |
| **Single** | game, set, collector number / set code, name, rarity, TCGplayer product ID | **condition** (NM / LP / MP / HP / DMG), language, finish and game-specific details, price, quantity, description, photos. **Yu-Gi-Oh:** edition (1st / Unlimited / Limited), print region. **Pokémon:** holo / reverse holo / non-holo, 1st Edition / Shadowless, promo stamp. **MTG:** non-foil / foil / etched, treatment (showcase, borderless, extended art…). **Riftbound:** foil / non-foil, variant (alt art, signature, overnumbered). **Any game:** "altered" flag (D62). |
| **Graded single** | as Single | grader (PSA / BGS / CGC / SGC / TAG / ACE / other), grade, subgrades, autograph grade, **cert number** (shown as a link to the grader's own verification page), price, photos of the actual slab |
| **Sealed** | game, set, product name, product type, TCGplayer product ID | language, seal notes, "repack" flag (D62), price, photos |
| **Accessory** | — (not in the catalog) | type (playmat, sleeves, deck box, binder, storage / toploaders, dice / counters, other), brand, optional game, condition, price, photos |
| **Lot / bulk** | — | game, card count, description, optional card list, price, photos |

- **Uncatalogued items always work.** If a card isn't in TCGCSV (a brand-new set,
  an OCG print, a misprint), the seller types the details by hand.
- **Autofill UX:** a type-ahead over catalog names. Picking a result fills in the
  fields; the seller can still edit them, and the listing keeps the TCGplayer ID link
  for search, want lists and "who has this card?".
- **Market price aid (D64):**
  - Once a catalog product and finish are chosen, the price field's **placeholder**
    shows the TCGplayer market price, e.g. "Market $12.40 · updated Oct 8".
  - **Buttons below the field: 70% · 75% · 80% · 85% · 90% · 100%.** Clicking one fills
    the price; the seller can still edit it. Prices are rounded down to the nearest
    $0.05 under $5, and to the nearest $0.25 at $5 and above.
  - Sellers can save a **default %** in their settings, and that button is highlighted.
  - **Bulk editor and imports:** "Set all selected / blank prices to N% of market",
    always previewed before applying.
  - **Caveats shown inline:** TCGplayer market is roughly a near-mint price for that
    product and finish (TCGCSV has no per-condition prices), so the seller should
    adjust for condition. Graded, accessory, lot and uncatalogued items have no hint.
  - **Seller-only:** buyers never see market prices, and the prices aren't exported in buyer-facing data.
- **Attribute schemas** live in `packages/core` as Effect Schemas, one per game per
  kind. The same schemas validate forms, imports and the API, and generate the
  import templates.
- **Legal:** game names are used only to describe products (no official logos), and
  every page footer says ClaimSale isn't affiliated with Konami, The Pokémon Company,
  Wizards of the Coast, Riot Games and so on. TCGCSV / TCGplayer attribution is shown
  where catalog data appears, if their terms ask for it (to be checked at ingestion
  build time).

**TCG features the catalog enables:**
- **Browse by game first** (`/g/pokemon`), then set, rarity, condition, graded or raw,
  language, finish, price.
- **"Who has this card?":** search a card or product and see every live listing of it
  across public sales, grouped by catalog product.
- **Want lists (launch, D61):** buyers save catalog products with a max price,
  minimum condition, finish and language, and get an email digest + web push when a
  match is listed in a public sale.
- **Shipping rule:** graded cards and sealed product always need tracked shipping,
  whatever the seller's threshold. Raw singles under the threshold can ship by PWE.

### Photo authenticity (D63)

**Rules:**
- **Every item needs at least one seller photo.** A sale can't be scheduled or
  published until every item has one that has passed verification.
- **A photo that matches another seller's image is rejected,** in any sale, past or present.
- **Reusing your own photo:**
  - allowed when relisting the same item (the relist flow carries the photos over);
  - blocked for a *different* item in the same sale, since each item needs its own photo (Q-IMG-1).
- **No stock images:** there is no catalog image to fall back on, and uploads are
  only accepted from the seller's device (no URLs).

**How detection works:**
1. **Upload:** the client resizes and strips EXIF as before. The photo is stored in
   R2 with status `pending`.
2. **Verify (engine Queue job):**
   - Decode the image in WASM (`@jsquash/webp` / `@jsquash/jpeg`), downscale it, and
     compute two 64-bit **perceptual hashes**: dHash and pHash.
   - Do the same for the **mirrored and 90°/180°/270° rotated** versions, so that
     simple flips and rotations don't evade detection.
   - These hashes survive resizing, recompression and small colour or brightness edits.
3. **Look for near matches:** the hash index stores each 64-bit hash as 4 × 16-bit
   bands. A candidate is any stored image sharing at least one band (an indexed
   lookup), and the Hamming distance is then computed only on those candidates
   (multi-index hashing). This stays fast at millions of images on D1.
4. **Decide:**

   | Closest match from another seller | Result |
   | --- | --- |
   | Distance ≤ 6 on both hashes | **Rejected.** The seller sees "This photo matches an image already used on ClaimSale. Please upload your own photo." The match is logged, and the other seller's identity is never revealed. |
   | Distance 7–12 | **Held for admin review.** It can't publish until approved or replaced. |
   | Otherwise | **Approved.** Its hashes are added to the index. |

   *(The thresholds are starting points, tuned on a test set before launch.)*
5. **Repeat offenders:** an account with several rejected matches is flagged in `/admin`.

**Limits, stated honestly:**
- Heavy crops, collages, or a photo of a screen can evade hashing.
- Two sellers photographing **different copies of the same graded card** on plain
  backgrounds can produce near-identical images (same slab label layout, same art).
  That's why the middle band goes to review rather than being blocked automatically.
- The report button ("this photo isn't theirs") and admin review back up the hashing.
- **Timestamp photos (D66):** a photo of the sale's cards beside a handwritten note
  with the seller's handle and the date.
  - **Required** for sellers with **fewer than 5 completed sales**; the sale can't be
    published without one. **Optional** for everyone else.
  - Any sale with one shows a **"Timestamped"** badge, and the photo appears in the
    sale header.
  - It goes through the same duplicate check, so reusing an old timestamp photo
    (even your own) is rejected; it must be new for each sale.
  - The handwriting itself isn't machine-checked. Buyers and the report button act on
    obvious fakes, and admins can reject one from the review queue.

## 3a. Monetization (D4)

**The core tension:** in the original plan, payment happens off-platform (PayPal
G&S, Venmo). If the money never passes through us, a cut of each sale can only be
*billed* to the seller afterward, and that relies on sellers reporting honestly.
The options:

| Model | How it works | Pros | Cons |
| --- | --- | --- | --- |
| **A. On-platform checkout (Stripe Connect)** | Buyers pay their invoice by card through us. Stripe splits the payment and the platform keeps an application fee (e.g. X% + Y¢). | A true cut of every sale, collected automatically. Buyer protection we control. Stripe handles seller identity checks and payouts. | Disputes and chargebacks become our problem. Possible **marketplace facilitator sales tax** obligations in many states (see below). Card fees stack on top of ours. YGO buyers are used to G&S. |
| **B. Final value fee, billed to the seller** | Payment stays off-platform. Monthly, we charge the seller's card on file X% of invoices marked paid. | Simple, and no payments liability. | Easy to dodge (never mark paid; deal in DMs). The incentive to dodge grows with the fee. |
| **C. Seller subscription** | Free tier with limits; a Pro plan at $N/month removes them. | Predictable revenue, cheap to build (Stripe Billing), no tax or dispute exposure. | Not a cut of sales. Small sellers may never upgrade. |
| **D. Per-sale listing fee / boosts** | Pay to run a large sale, or to feature a sale on the browse page. | Simple. | Friction at the moment a seller is deciding whether to try us. |
| **E. Buyer fee** | A small fee added to the buyer's invoice. | Doesn't scare away sellers. | Buyers hate it, and they're the side we need most at launch. |

### Free vs Pro (D8 and D24–D37)

| Capability | Free | Pro |
| --- | --- | --- |
| **Seller:** items per sale | 10 | Unlimited |
| **Seller:** concurrent live/scheduled sales | 2 | Unlimited |
| **Seller:** photos per item | 4 | 12 |
| **Seller:** decision window (claim vs offers) | 24h | Configurable |
| **Seller:** hidden minimum offer (auto-decline) | — | ✓ |
| **Seller:** offer amounts blind or visible | ✓ | ✓ |
| **Seller:** payment deadline | 48h | 48h or 24h |
| **Seller:** tracking required above | $20 | $40 |
| **Seller:** rescind and pass to the next backup | ✓ | ✓ |
| **Seller:** private sales (password / allowlist) | — (unlisted only) | ✓ |
| **Seller:** Discord webhooks | — | ✓ |
| **Seller:** phone verification to publish | Required | Skipped |
| **Seller:** analytics | Basic counts | Detailed |
| **Buyer:** rescind own claim without approval | — | ✓ until the invoice is sent, 5/month |
| **Buyer:** skip email verification / new-account requirements | — | ✓ |
| **On-site checkout fee** (later) | 3% | 1.5% |
| **Price** (starting point) | $0 | Seller about $8/mo · Buyer about $4/mo · bundle |

Implementation: an `entitlements(user)` function that returns limits from the
user's plan, checked server-side on every relevant action. There is never a
client-only check. Subscriptions are handled by Stripe Billing (Checkout + Customer
Portal + webhooks into D1).

**Recommendation: launch free, then go hybrid.**
1. **Launch:** free, with no fees, to build the seller base. Collect GMV (total
   sales value) data to size later fees.
2. **Then:** **A + C together.**
   - *Free tier:* off-platform payment, capped (e.g. N active sales and M items per
     sale), with private sales limited.
   - *Pro subscription:* higher limits, password and email-allowlist sales,
     analytics, scheduled relists, branding.
   - *Integrated checkout:* optional for any seller. We take a % fee, and offer
     incentives such as buyer protection, faster payouts, and a "Pays on site"
     trust badge.
   - Option B can stay as a fallback for off-platform sales over a threshold.
3. **Before turning on A:** talk to an accountant about marketplace facilitator
   laws. Most US states treat a platform that *processes payment* for third-party
   sellers as responsible for collecting and remitting sales tax. Stripe Tax can
   do the calculation, but the registration and filing obligation would be ours.
   Also confirm 1099-K reporting is handled through Stripe Connect.

**Build implications now (even before charging):**
- Record `gmv_cents` per invoice and keep a `fees` ledger table from day one.
- Add a `plans` / `entitlements` check layer (e.g. `can(user, 'private_sale')`),
  so limits can be turned on without refactoring.
- Design invoices so a "Pay with card" button can be added later.

## 3c. Import and export (D57)

Three seller tools, all built on the same pipeline: **upload → parse → validate →
preview with row-level results → confirm → apply**. Nothing is written until the
seller confirms, and every apply is recorded in the audit log.

### 3c.1 Import sale data
- **Target:** a sale in `draft` or `scheduled`. A live sale can't be imported into,
  because price and quantity lock once items have entries (D40). An import can also
  create a new draft sale.
- **Formats:** CSV and XLSX, plus an optional ZIP of photos (D58).
- **Column mapping:** if the headers don't match a template, the seller maps their
  columns to ours (the mapping is remembered per seller), so exports from any
  collection or inventory app work. Named presets for **TCGplayer and ManaBox exports
  ship at launch** (D61); Collectr, Dragon Shield and others come in v1.
- **Templates:** a downloadable template per item type. Columns come from the item
  type's attribute schema (section 3, "Item types"), and include one example row and
  a `template_version`.
- **Core columns:** `sku` (seller's own ID, optional), `item_type`, `title`,
  `description`, `price`, `quantity`, `condition`, `offers` (off / on / min),
  `min_offer` (Pro only), `shipping_override`, `photos` (file names in the ZIP,
  `;`-separated). Then `game`, `kind` and the attribute columns for that game and
  kind (`set_code`, `number`, `rarity`, `finish`, `edition`, `language`, `grader`,
  `grade`, `cert_number`…).
- **Catalog matching (autofill only):** rows match the catalog by
  `tcgplayer_product_id`, then set + collector number / set code, then fuzzy name +
  set. Ambiguous matches are flagged for the seller to choose; unmatched rows import
  as uncatalogued items.
- **Photos are required (D63):** rows without a photo import as items that are
  marked "needs photo", and the sale can't be published until each has one. Imported
  photos go through the same duplicate check.
- **Re-import updates, it doesn't duplicate:** rows match existing items by `sku`
  (or by the exported `item_id`). Matched rows update, new rows create, and items
  missing from the file are left alone unless the seller ticks "remove items not in file".
- **Limits:** the free-tier cap of 10 items per sale still applies (an import that
  would exceed it shows how many rows fit). Max 2,000 rows and 200 MB of photos per import.
- **Photos:** the ZIP is unpacked **in the browser** (`fflate`), and each image goes
  through the same resize, re-encode and EXIF-stripping path as manual uploads. No
  server-side fetching of image URLs (that's an SSRF risk); photo URLs in a file are
  rejected with a clear message.

### 3c.2 Export
| Export | Contents | Formats |
| --- | --- | --- |
| **Sale items** | Every item with all its attributes, `item_id`, `sku`, status, winner handle, final price. Uses the same columns as the import template, so it can be re-imported (e.g. to relist unsold items). | CSV, XLSX |
| **Orders / buyers** | One row per invoice line: invoice number, buyer handle and display name, **shipping name and address**, item, price, shipping option, totals, status, paid / shipped dates, carrier, tracking. | CSV, XLSX |
| **Shipping-tool preset** | The same order data in **Pirate Ship's** import layout (plus a generic layout), so the seller can make labels in bulk (D58). | CSV |
| **Full account export** | Everything the seller owns: sales, items, entries, invoices, messages, feedback. This is for data portability. | JSON (zipped) |

- **Generated in the background:** export jobs run on a Queue, write to R2, and give a
  download link that expires after 24h. Large sales never time out a request.
- **Privacy:** buyer data in exports is limited to what the seller needs to fulfil
  orders: handle, display name and shipping address for won items. **No buyer
  emails or phone numbers** (D58). Every export is audit-logged (who, when, which sale).
- **Spreadsheet formula injection:** any cell starting with `=`, `+`, `-`, `@`, tab or
  CR is prefixed with `'` on export. Buyer-controlled text (names, addresses, notes)
  could otherwise run as a formula in Excel.

### 3c.3 Tracking re-import
- **Input:** CSV or XLSX with `invoice_number` (from the orders export) **or** an
  order reference the shipping tool echoes back, plus `tracking_number` and an
  optional `carrier`.
- **Matching:**
  - by `invoice_number` first;
  - then by the shipping-tool order reference;
  - otherwise the row is unmatched and the seller can match it by hand in the preview.
- **Carrier detection:** if `carrier` is blank, it's detected from the tracking
  number's format (USPS, UPS, FedEx, DHL). Anything ambiguous is flagged.
- **Apply:** each matched invoice goes through the normal `paid → shipped` transition
  (STATE_MACHINES section 6). Rows for invoices that aren't `paid` are rejected with
  the reason. Buyers get the normal "shipped" notification, batched per buyer.
- **Corrections:** re-importing a different tracking number for an already-shipped
  invoice requires a "replace" confirmation and is logged.

### 3c.4 Shared mechanics
- **Parsing in the browser:** `papaparse` (CSV) and `read-excel-file` (XLSX) give an
  instant preview. Rows are validated with the **same Effect Schema** on the client
  and the server. The server **re-validates** every batch; the client is never trusted.
- **Applying in batches:** in chunks of 100 rows through an engine command, so items
  in a scheduled sale go through the sale's DO lock. The result is idempotent: a
  re-sent batch with the same `import_id` + row number is a no-op.
- **Results:** each row ends as `created`, `updated`, `skipped` or `error` (with the
  field and message), and the results can be downloaded as a CSV with an added `result` column.
- **Encoding:** UTF-8 with a BOM on CSV export (so Excel opens it correctly). Imports
  accept UTF-8 and Windows-1252, and auto-detect `,` or `;` delimiters.

## 3b. Buyer and seller reputation

With binding claims and open sign-up, reputation is how sellers protect
themselves from strangers.
- **Counts on each profile:** completed purchases, completed sales, approved
  take-backs, Pro rescinds, buyer-fault rescinds (non-pay, payment reversed),
  seller-fault cancels, and account age.
- **Fault comes from the rescind reason code** (D51, STATE_MACHINES 4.3.1). A seller who
  cancels because the buyer reversed a payment gets no mark. Contested cases count
  for no one until an admin resolves them.
- **After an invoice completes:** two-way feedback (positive / neutral / negative + comment).
- **When reviewing a claimant,** the seller sees their record at a glance
  ("12 completed, 1 non-pay, member since 2026").
- **Per-sale buyer requirements** (optional): a minimum number of completed
  purchases, a minimum account age, or a verified phone. This mirrors "no
  zero-feedback buyers" rules in FB groups.

## 4. Features by phase

### Phase 0 — Foundations (week 1)
- SvelteKit 3 project, Cloudflare Worker deploy, D1 and R2 bindings, CI.
- Authentication, user profile, and layout shell.

### Phase 1 — MVP: run one real sale end to end
- *Now also includes:* offers (seller decides), on-site messaging, the shipping
  menu with tracking thresholds, payment deadlines, and Free vs Pro limit checks
  (with Pro grantable by an admin before billing exists).
- Seller: create a sale, bulk upload items (drag in many photos, one item per photo
  or grouped, then fill in titles and prices in a table view), and set terms.
- Schedule or go-live, close.
- Buyer: browse the grid, view an item, claim or offer, request a take-back (or rescind as Pro), join or leave the backup queue.
- Live updates: claimed items flip in real time for every viewer.
- Seller control room: per-item entries (claims + offers), award / decline / counter, rescind and pass to next, take-back requests, per-buyer rollup.
- Invoices with simple shipping rules, mark paid, mark shipped.
- Email notifications: you won / you were promoted / invoice sent / offer response.
- An Open Graph share card, so the sale link looks good when posted in FB.
- **Public browse and search** across public sales and items (D28), with filters by
  category, item type attributes (set, rarity, condition…), price, and "ending soon / going live soon".
- Follow a seller and get notified of new sales (D41).
- "Copy as text" export of the item list for the FB post body.

### Phase 2 — v1
- Stripe Billing for Pro subscriptions.
- Merge invoices across sales from the same seller (D16).
- Discord webhooks (Pro).
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
- On-platform checkout via Stripe Connect with a platform fee (after the LLC and a sales tax review).
- Shipping label integration (Pirate Ship / EasyPost).
- A CSV import of items.
- A PWA (installable app) with offline drafts.

## 5. Technical architecture

### Stack
> The detailed, versioned stack proposal and its open questions are in
> [`TECH_STACK.md`](./TECH_STACK.md). The table below is the summary.

| Concern | Choice | Notes |
| --- | --- | --- |
| Framework | **SvelteKit 3** (latest `3.0.x`) + **Svelte 5** (runes) | Remote functions (experimental flag), wrapped in an Effect-aware layer (TECH_STACK S2, section 3). |
| App framework | **Effect 4** on the server side and in the domain core | TECH_STACK S20. |
| Hosting | **Cloudflare Workers** with static assets via `@sveltejs/adapter-cloudflare` (v8) | Workers rather than Pages: Cloudflare is steering new features to Workers, and we need Durable Objects, Queues and cron in the same deployment. |
| Database | **Cloudflare D1** (SQLite) + **Drizzle ORM** | Drizzle migrations are applied with `wrangler d1 migrations`. Query layer: TECH_STACK T25. |
| Images | **R2** for originals + **Cloudflare Images transformations** for resizing | Thumbnails are generated on the fly from URL params and cached at the edge. |
| Realtime | **Durable Objects** (one per sale) using the WebSocket Hibernation API | Used to push updates. See the concurrency notes below. |
| Background jobs | **Queues** (notification fan-out) + **DO alarms** / **cron triggers** | Alarms handle go-live, close, offer expiry and payment deadlines. |
| Auth | **Better Auth** with a D1 / Drizzle adapter | Email + password, magic link, Discord; phone OTP via Twilio Verify. Sessions are stored in D1. |
| Email | **Cloudflare Email Service** (Email Sending, public beta) via the `send_email` binding | Transactional only, Svelte templates. See TECH_STACK S28. |
| Bot protection | **Turnstile** on sign-up, plus the Workers **Rate Limiting** binding on claim and offer endpoints | |
| Styling | Tailwind CSS v4 + a headless component library (bits-ui / shadcn-svelte) | |
| Testing | Vitest + `@effect/vitest` + `@cloudflare/vitest-pool-workers`, fast-check, Playwright | |
| Observability | Cloudflare traces + logs → OTLP → Sentry; Sentry SDK for errors; structured JSON logs | TECH_STACK section 4. |
| Tooling | pnpm monorepo, TypeScript strict, oxlint + oxfmt + svelte-check, GitHub Actions, Doppler, Renovate | `dev` → `main` release flow (TECH_STACK section 7). |

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

**Updated decision (round 3):** offers, ranking, decision windows and promotion
make every action a read → decide → write. So **each sale's Durable Object
serializes writes, with one lock per item**. It runs pure transition functions and
commits each result as one D1 `batch()` with a version check. D1 stays the source
of truth, and the same DO owns the sale's timers and WebSocket broadcast. The
fallback, if load tests miss the target, is DO-local SQLite with an outbox to D1.
Details are in [`STATE_MACHINES.md` section 9](./STATE_MACHINES.md#9-write-path-concurrency).

### Realtime details
- On page load, render from D1 through server-side rendering, then open a
  WebSocket to `/api/sales/:id/live`, which the Worker forwards to the DO.
- Messages are small diffs: `{type:"item", id, status, claimCount, offerCount, version}`.
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
- **Sign-in (S9):** email + password, email magic link, and Discord OAuth.
- **Facebook trust:** FB Login doesn't give you the user's profile URL without app
  review (the `user_link` permission). The MVP lets users paste their FB profile URL
  on their profile. The seller sees it next to claims and can verify it themselves.
  Display names are not unique, so show the avatar plus the profile link.
- **Buyers:** a verified email is required before claiming (Pro buyers skip it, D29),
  and buyers must be 13+ (D38).
- **Sellers (D55):** must attest they are 18+ and verify both email and phone before
  publishing a sale. **Pro sellers skip phone verification.** Their paid
  subscription card is the identity signal.
- **Phone numbers** are stored in E.164 format, are unique per account (one
  number can't verify many seller accounts), and are never shown publicly.

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
users            id, email, email_verified, phone_e164 UNIQUE, phone_verified_at,
                 display_name, handle UNIQUE, avatar_url, fb_profile_url,
                 age_attested ('13+'|'18+'), country, created_at
accounts/sessions/verifications  (managed by Better Auth)

seller_profiles  user_id PK, payment_handles JSON, default_terms, default_shipping JSON

sales            id, seller_id, slug, title, description_md, cover_image_id,
                 visibility, status, currency, live_at, closes_at,
                 rules JSON  -- release policy, offer policy, limits, payment deadline hrs
                 shipping JSON, terms_md, created_at, updated_at

items            id, sale_id, sort_order, title, description_md, condition,
                 price_cents, quantity, offers_mode, min_offer_cents,
                 shipping_override_cents, status, version, created_at, updated_at

item_images      id, item_id, seller_id, r2_key, width, height, sort_order,
                 status ('pending'|'approved'|'review'|'rejected'), match_image_id,
                 match_distance, verified_at
image_hashes     image_id, seller_id, kind ('dhash'|'phash'), variant ('orig'|'mirror'|
                 'r90'|'r180'|'r270'), hash (64-bit), band0, band1, band2, band3
                 -- one index per band column; candidate lookup = any band equal

-- claims and offers unified as "entries" (see STATE_MACHINES.md section 4)
entries          id, item_id, user_id, kind ('claim'|'offer'), amount_cents, note,
                 status ('open'|'countered'|'won'|'declined'|'withdrawn'|'lost'|
                         'ended'|'rescinded'|'released'|'fulfilled'),
                 rank_override, counter_cents, counter_expires_at,
                 won_at, ended_at, ended_reason, ended_by, created_at
                 UNIQUE(item_id, user_id) WHERE status IN ('open','countered')
                 -- items gain: decision_deadline, units_won (cached), state (cached)

invoices         id, sale_id, buyer_id, status, subtotal_cents, shipping_cents,
                 adjustment_cents, total_cents, payment_ref, tracking,
                 sent_at, paid_at, shipped_at, due_at
invoice_lines    id, invoice_id, entry_id, description, amount_cents, refund_owed

comments         id, item_id, user_id, parent_id, body, created_at, deleted_at

follows          follower_id, seller_id
blocks           seller_id, blocked_user_id, reason
notifications    id, user_id, type, payload JSON, read_at, created_at
push_subscriptions  id, user_id, endpoint, keys JSON
audit_log        id, sale_id, item_id, actor_id, action, data JSON, created_at

-- added for import/export (D57)
addresses        id, user_id, name, line1, line2, city, region, postal_code, country,
                 is_default, created_at, deleted_at
                 -- invoices gain: shipping_address JSON (snapshot at payment), carrier,
                 --   tracking_number, invoice_number (human-readable, per seller)
                 -- items gain: sku (UNIQUE per sale when set)
io_jobs          id, seller_id, sale_id, kind ('item_import'|'tracking_import'|
                 'export_items'|'export_orders'|'export_shipping'|'export_account'),
                 status ('parsed'|'applying'|'done'|'failed'|'expired'), format,
                 file_key, result_key, row_count, created, updated, skipped, errors,
                 created_at, finished_at, expires_at
io_job_rows      job_id, row_number, outcome, target_id, message   -- idempotency + results

-- added in round 2
sale_access      sale_id PK, password_hash, allowlist_enabled
sale_allowlist   sale_id, email, invited_at, accepted_user_id
takeback_requests id, entry_id, buyer_id, reason, status ('pending'|'approved'|'denied'),
                 created_at, decided_at
-- TCG catalog (D59); replaces the generic categories/item_types tables
games            id, slug, name, condition_scale JSON, finishes JSON, languages JSON,
                 tcgplayer_category_id, enabled, sort_order
catalog_sets     id, game_id, code, name, release_date, tcgplayer_group_id, external_ids JSON
catalog_products id, game_id, set_id, kind ('single'|'sealed'), name, number, rarity,
                 product_type, tcgplayer_product_id UNIQUE, updated_at
                 -- FTS5 virtual table over name, set name, number; no images (D60)
market_prices    product_id, subtype ('Normal'|'Foil'|'Holofoil'|'Reverse Holofoil'|
                 '1st Edition'…, as TCGCSV names them), market_cents, as_of
                 -- latest only; seller listing aid (D64), never exposed to buyers
                 -- seller_profiles gains: default_market_pct
                 -- sales gain: timestamp_image_id
want_list_items  id, user_id, product_id, finish, max_price_cents, min_condition,
                 language, created_at
                 -- items gain: game_id, kind, catalog_product_id, finish, language,
                 --   condition, attributes JSON, grader, grade, cert_number
item_attributes  item_id, key, value_text, value_num   -- only filterable attributes
rescinds         id, entry_id, seller_id, buyer_id, reason_code, explanation,
                 attachment_key, fault ('buyer'|'seller'|'neutral'|'review'),
                 refund_owed, refunded_at, refund_ref,
                 contested_at, contest_text, resolved_by, resolved_fault, resolved_at, created_at
feedback         id, invoice_id, from_user_id, to_user_id, rating, comment, created_at
plans            id, name, limits JSON
subscriptions    user_id, plan_id, stripe_customer_id, status, current_period_end
fees             id, invoice_id, seller_id, kind, amount_cents, status, created_at
```

Indexes: `items(sale_id, sort_order)`, `entries(item_id, status, amount_cents, created_at)`,
`entries(user_id, status)`, `invoices(sale_id, buyer_id, status)`,
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
/sell/[saleId]/import           item import: upload, preview, confirm, results
/sell/[saleId]/tracking-import  tracking re-import: upload, match, confirm
/sell/exports                   export jobs and download links (24h)
/me/addresses                   buyer address book

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
- Prohibited items policy and terms of service: proxies, counterfeits, orica,
  "replica" or custom cards that imitate real cards (D21), and digital code cards (D62).
  Altered art needs the "altered" flag, and repacks need the "repack" label.
- Photos: every item needs its own photo, and duplicate images are rejected (D63). Check the policy against payment-provider rules if Stripe is added later.

## 10. Cost and limits (rough)

All of the services above have a free tier or a $5/month Workers Paid plan base
that should cover early usage. Durable Objects need the paid plan. Watch for:
- D1: 10 GB per database and single-writer throughput. Fine for this scale.
- DO WebSockets: hibernation keeps costs near zero while sale pages sit idle.
- Images transformations: billed per unique transformation. Limit thumbnails to a
  few fixed sizes rather than arbitrary widths.

## 11. Testing strategy

See [`TESTING.md`](./TESTING.md). Every feature and bug fix ships with tests
(TECH_STACK S25). The layers are unit, browser (component), Workers integration,
end-to-end and load tests.

## 12. Open questions

None. Everything is decided through D66. **Before the pilot sale** (not blocking development):
- Register `claimsale.net` in the AntiTcb account and onboard `notify.claimsale.net` in Email Service.
- Search trademarks for "ClaimSale" and claim the matching social handles.
- Check TCGCSV's terms and attribution requirements before building the catalog ingestion.

## 13. Proposed first milestones

0. **Foundations** (including the test infrastructure: Vitest 5 + 4.1 workspaces,
   Browser Mode, Playwright, MSW, factories, coverage gates, CI pipeline from TESTING.md section 7):
   - The pnpm monorepo (`apps/web`, `apps/engine`, `packages/*`), with oxlint, oxfmt,
     svelte-check, Renovate and Doppler wired in.
   - Wrangler environments for preview, staging and production; D1, R2, Queues
     created for each.
   - GitHub Actions: CI, per-PR preview pairs, `dev` → staging, release → production
     (TECH_STACK sections 5–7).
1. **Observability spike:** one end-to-end trace (browser → web → RPC → DO → D1 →
   Queue → email) visible in Sentry with correlated logs and a linked error
   (TECH_STACK section 4). This decides T28 before feature work starts.
2. **Domain core:** state machines from `STATE_MACHINES.md` as pure functions, with
   spec IDs, unit tests and property tests. No UI yet.
3. **Auth:** Better Auth (email + password, magic link, Discord), email and phone
   verification, age attestation, profiles and handles.
4. **Sales and items:** CRUD, item types and attributes, image upload to R2, **CSV/XLSX
   item import with templates and ZIP photos**.
4b. **TCG catalog and photo authenticity:** nightly TCGCSV ingestion (games, sets,
   products, market prices), FTS autofill, the catalog picker for the listing form and
   imports, the price placeholder and % of market buttons, timestamp photos, and
   the image verification pipeline (perceptual hashes, banded index, admin review queue).
5. **The engine:** the SaleEngine DO (per-item locks, alarms), entries, offers,
   awards, promotion, plus the claim race test and a load test.
6. **The live grid:** WebSocket updates, the claim and offer UI, and the buyer's running total.
7. **The seller control room:** deciding, take-backs, rescinds with reason codes,
   and the admin dispute queue.
8. **Invoices after close:** shipping menu, buyer addresses, payment deadlines,
   completion, **order and item exports, the Pirate Ship preset, and tracking re-import**.
9. **Notifications and messaging:** Queue → Cloudflare Email Service / web push; on-site messages.
10. **Discovery:** browse and search (FTS5), follows, share cards, text export →
    pilot sale.
