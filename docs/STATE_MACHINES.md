# State Machines and Rules

This document is the exact behavior spec for sales, items, entries (claims and
offers), take-backs and invoices. It is meant to be implemented as **pure
functions**: `(state, command, actor, now) → (newState, events)`. Those functions
are unit-tested without any I/O and called from the serialized write path
(see "Write path" at the end).

Decision references (D#) point to `PLAN.md` section 0.

---

## 1. Vocabulary

| Term | Meaning |
| --- | --- |
| **Entry** | One buyer's interest in one item. It is either a **claim** (at the asking price) or an **offer** (any amount, including above asking; D35). Claims and offers live in one table so they can be ranked together. |
| **Unit** | One sellable copy. An item with `quantity = 3` has 3 units. |
| **Won** | The entry holds a unit. It is binding and goes on the buyer's invoice. |
| **Open** | The entry is active but doesn't hold a unit. Depending on the item's state, it is either *awaiting the seller's decision* or a *backup*. |
| **Rank** | The order of open entries. Default: **amount descending, then time ascending**, so a claim at $40 ranks above an offer at $35, and an offer at $45 ranks above both. The seller can reorder manually (D44). |
| **Decision window** | The time the seller has to choose between a full-price claim and competing offers before the earliest claim wins automatically. **24h for free sellers; Pro sellers can configure it** (D25). |

---

## 2. Sale lifecycle

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> scheduled: publish with a future live_at
    draft --> live: publish now
    scheduled --> draft: unpublish
    scheduled --> live: alarm at live_at
    live --> closed: seller closes / alarm at closes_at
    closed --> archived: all invoices complete or cancelled / 90 days
    draft --> deleted: seller deletes
```

| State | Visible to buyers | Claims and offers | Notes |
| --- | --- | --- | --- |
| `draft` | No | No | Items can be edited freely. The free-tier item cap (10) is enforced on publish *and* on add. |
| `scheduled` | Yes (preview) | No, the buttons show a countdown | The preview opens at most 7 days before `live_at` (D42). Followers are notified on publish. |
| `live` | Yes | Yes | Maximum 14 days (D42). Price and quantity are locked on any item that has entries (D40). |
| `closed` | Yes (read-only) | No new entries | Decision windows, payment deadlines and promotions **keep running** after the sale closes. |
| `archived` | Yes, via the seller's history | No | |

**Free-tier limit:** at most 2 sales in `scheduled` + `live` at once (D30).

---

## 3. Item state (derived, never set by hand)

An item's displayed state is computed from its entries and units. It is stored
only as a cached column for filtering.

```mermaid
stateDiagram-v2
    [*] --> available
    available --> deciding: claim arrives while offers are open, or the sale has "review every claim" on
    available --> sold_out: claim wins instantly (all units taken)
    deciding --> sold_out: seller awards / window expires (all units taken)
    deciding --> available: units remain after the award
    sold_out --> available: a winner is removed and no backup is auto-promoted
    sold_out --> deciding: a winner is removed and the best backup is below asking (D45)
    available --> withdrawn: seller withdraws
    deciding --> withdrawn: seller withdraws
    available --> unsold: sale closes with no open entries
```

| Derived state | Condition |
| --- | --- |
| `available` | free units > 0 and no decision deadline is set |
| `deciding` | free units > 0 and `decision_deadline` is set |
| `sold_out` | free units = 0 (backups may still be open) |
| `withdrawn` | the seller withdrew the item; all entries end with `item_withdrawn` |
| `unsold` | the sale is closed, there are free units, and there are no open entries |

The buyer-facing badge also shows: **N claims / N offers** (counts are always
visible, D26), and offer **amounts** only if the sale's offer visibility is `visible` (D26).

---

## 4. Entry (claim / offer) lifecycle

```mermaid
stateDiagram-v2
    [*] --> won: claim, instant win (see 4.1)
    [*] --> open: claim or offer, otherwise
    open --> won: seller awards / window expires (earliest claim) / auto-promoted
    open --> countered: seller counters an offer
    countered --> won: buyer accepts and a unit is free
    countered --> open: buyer accepts but no unit is free (re-ranked at the counter amount)
    countered --> declined: buyer declines / counter expires
    open --> declined: seller declines an offer
    open --> withdrawn: buyer withdraws (an offer before it's accepted, D46) or leaves the backup queue (D14)
    open --> lost: the item's units are all paid for and the sale is closed
    open --> ended: item withdrawn / sale cancelled
    won --> rescinded: seller rescinds (any time; reason required)
    won --> released: Pro buyer rescinds (guardrails below) / take-back approved
    won --> fulfilled: the invoice containing it is completed
```

Terminal states: `declined`, `withdrawn`, `lost`, `ended`, `rescinded`,
`released`, `fulfilled`. Each terminal transition records `ended_reason` and
`ended_by`, and writes an audit log row.

### 4.1 Placing an entry

Run atomically per item (see the write path):

```
place(item, buyer, kind, amount):
  reject if: sale not live · buyer blocked · buyer fails the sale's buyer requirements
             (Pro buyers bypass the email-verified and new-account requirements, D29)
             · buyer is at the per-buyer unit limit for the item (D12) · buyer already
             has an open/countered entry on the item · kind=offer and offers are off
             · kind=offer and amount < hidden minimum (Pro sellers only, D27)
             → auto-decline with a generic "Offer not accepted" message

  if kind == claim:
      amount = item.price
      if freeUnits > 0 and no open offers and not sale.reviewEveryClaim and not deciding:
          → won                                   # the FB-style instant win
      elif freeUnits > 0:
          → open; if not deciding: set decision_deadline = now + window
      else:
          → open (backup)
  if kind == offer:
      if freeUnits == 0 and not sale.allowBackupOffers: reject (D43)
      → open                                      # offers never auto-win
      notify the seller
```

An offer on its own does **not** start a decision window. The seller can accept
it at any time. The window exists only so a full-price claimant isn't left
waiting indefinitely.

### 4.2 Awarding

```
award(item, entry, by=seller):
  require entry ∈ {open} and freeUnits > 0
  entry → won at entry.amount
  if freeUnits == 0 or no open claims remain: clear decision_deadline
  the other open entries stay open (now backups if sold_out)

on decision_deadline (DO alarm):
  while freeUnits > 0 and an open claim exists:
      award the earliest open claim               # D25: the claim wins by default
  clear decision_deadline
  (open offers stay open; the seller can still accept them while units are free)
```

### 4.3 Removing a winner and promoting

A winner can be removed in three ways:

| How | Who | Allowed when | Counts on the record as |
| --- | --- | --- | --- |
| **Seller rescind** | Seller | Any time before fulfilled. A structured reason **and** a written explanation are required (see 4.3.1). After the buyer has marked the invoice paid, it needs an extra confirmation and the line is flagged "refund owed" unless the reason says no refund is due (D51). | Whatever the reason's **fault attribution** says (4.3.1) |
| **Pro buyer rescind** | Buyer (Pro) | Until the invoice containing the entry is **sent**, max **5 per month** (D24) | `rescind` (a softer signal than non-pay) |
| **Take-back approved** | Seller approves the buyer's request | The request can be filed until the buyer marks the invoice paid (D52) | `takeback` |

#### 4.3.1 Rescind reasons and fault attribution (D51)

Every seller rescind records a **reason code**, a **required written explanation**
(minimum 20 characters), and an optional attachment (e.g. a screenshot of a
reversed payment). The reason code decides whose record it affects:

| Reason code | Fault | Buyer record | Seller record | Typical case |
| --- | --- | --- | --- | --- |
| `buyer_nonpayment` | Buyer | `non_pay` | — | Payment deadline missed |
| `buyer_unresponsive` | Buyer | `non_pay` | — | Paid nothing and stopped replying |
| `buyer_payment_reversed` | Buyer | `payment_reversed` (severe) | — | Chargeback, or PayPal dispute filed after shipping was arranged |
| `buyer_requested_after_payment` | Buyer | `takeback` | — | Buyer asked to cancel after paying; the seller refunds as a courtesy |
| `buyer_terms_violation` | Buyer | `violation` | — | Ships outside the allowed region, harassment, etc. |
| `seller_item_unavailable` | Seller | — | `seller_cancel` | Lost, damaged, or sold elsewhere |
| `seller_listing_error` | Seller | — | `seller_cancel` | Wrong price, set or condition |
| `mutual_agreement` | Neither | — | — | Both sides agreed in messages |
| `suspected_fraud` | Pending review | held | held | Goes to the admin queue; nothing is counted until resolved |

- **The buyer sees** the reason code and the explanation. They can **contest the
  attribution** within 7 days by giving their side.
- **A contested rescind** goes to the admin queue. Until it's resolved, neither
  record is affected. The admin can re-attribute it (e.g. buyer-fault → seller-fault).
- **`mutual_agreement` requires the buyer's confirmation.** The buyer gets an
  "Agree / Dispute" prompt; agreeing marks it neutral, and no response in 72h also counts as neutral.
- **Abuse guard:** if a seller's buyer-fault rescinds are contested and overturned
  repeatedly (3 times in 30 days, D68), the admin queue flags that seller.
- **Refund owed:** set for any rescind after `buyer_paid` except
  `buyer_payment_reversed` (the buyer already has their money back). The seller marks
  "Refunded" with an optional reference; the buyer confirms or disputes.

Then:

```
promote(item):    # runs after any winner removal, unless the seller withdrew the item
  best = highest-ranked open entry
  if best is null: item → available (or unsold if the sale is closed)
  elif best.amount >= item.price: best → won (auto-promoted); notify; payment deadline starts with its invoice
  else: set decision_deadline = now + window; notify the seller "backup below asking — decide"   (D45)
```

The seller's one-click **"Rescind and pass to next"** (D13) is `rescind` followed by
`promote`. A plain **"Rescind"** without passing marks the item `withdrawn`.

### 4.4 Counter-offers

- The seller counters an `open` offer with `counter_amount`, and the entry becomes
  `countered`. The counter expires after 24h (D48: one round only at launch).
- The buyer **accepts**:
  - If a unit is free, the entry is `won` at `counter_amount`.
  - Otherwise it goes back to `open`, re-ranked at `counter_amount`, and the buyer is
    told: "Item was taken; you're backup #N at your accepted price."
- The buyer **declines**, or the counter expires: the entry becomes `declined`.

### 4.5 Sale close

- New entries are rejected.
- Items with free units and an open claim: if not already deciding, start a window.
- Items with free units and only open offers: the seller has 24h to accept, then they
  `lost`. *(This uses the same window length as the seller's decision window.)*
- Items with no entries become `unsold`. A one-click "Relist unsold" creates a new draft sale.
- Open backups stay open until every unit of their item is **paid**, then become `lost`.

---

## 5. Take-back requests

```mermaid
stateDiagram-v2
    [*] --> pending: buyer requests (with an optional reason)
    pending --> approved: seller approves → the entry is released and promote() runs
    pending --> denied: seller denies (with an optional note)
    pending --> cancelled: buyer cancels / the entry ends some other way
```

- At most one pending request per entry. After a denial, the buyer can't file again
  for the same entry.
- The claim stays `won` (and binding) while the request is pending.
- Pro buyers don't need take-backs while their rescind window is open; after the
  invoice is sent they use take-backs like everyone else.

---

## 6. Invoice lifecycle

An invoice groups one buyer's `won` entries in one sale.

```mermaid
stateDiagram-v2
    [*] --> draft: first entry won by this buyer in this sale
    draft --> sent: sale closed, then the seller sends / auto-send at close if enabled (D49)
    sent --> buyer_paid: buyer picks shipping + "I've paid" (+ reference)
    sent --> overdue: payment deadline passes (48h, or 24h for Pro, D13)
    overdue --> buyer_paid: buyer pays late (the seller can still accept it)
    buyer_paid --> paid: seller confirms receipt
    buyer_paid --> sent: seller says "not received" (the deadline does not restart)
    paid --> shipped: seller adds a carrier + tracking (required if over the threshold, D15)
    shipped --> completed: buyer confirms receipt / auto 14 days after shipped (D50)
    draft --> cancelled: all lines removed
    sent --> cancelled: all lines removed
    overdue --> cancelled: all lines removed
```

**Rules:**
- **Lines** are added automatically when the buyer wins (or is promoted to) an entry.
  - **Invoices can only be sent after the sale closes (D49).** During the sale, a
    buyer's wins accumulate in their `draft` invoice, shown to them as a running
    total (D53).
  - At close, the seller reviews and sends all drafts (one click, "Send all"), or the
    sale's **auto-send at close** option sends them. Items still `deciding` at close
    are added when decided; if the invoice has already been sent by then, they go on a
    second invoice.
  - Wins after an invoice is `sent` (promotions, late decisions) go into a new draft
    invoice, which the seller can send immediately (the sale is already closed). The
    "merge invoices" feature in v1 can combine them (D16).
  - A consequence for **Pro buyer rescind (D24):** "until the invoice is sent" means
    in practice "until the sale closes and the seller sends invoices".
- **Rescinding a line** on a `sent` / `overdue` invoice removes it and recalculates
  the total. On a `buyer_paid` / `paid` invoice, the line is kept but marked
  "refund owed", following the rescind's reason code (4.3.1).
- **The shipping option** is chosen by the buyer before "I've paid". Untracked
  options are hidden when the subtotal is over the seller's threshold ($20 free / $40 Pro, D15).
- **When the payment deadline passes,** the seller sees "rescind and pass to next"
  on each line. Automatic rescind is opt-in per sale (D13). When it's on, the
  `overdue` alarm runs rescind + promote on every line.
- **`gmv_cents`** is recorded when the invoice becomes `paid`; this feeds the fee ledger later (section 3a).

---

## 7. Timers (DO alarms, with a cron sweep as a backstop)

| Timer | Set when | On fire |
| --- | --- | --- |
| `sale.live_at` | publish (scheduled) | sale → live; notify followers |
| `sale.closes_at` | publish | close the sale (4.5) |
| `item.decision_deadline` | 4.1, 4.3, 4.5 | auto-award the earliest open claim |
| `entry.counter_expires_at` | counter | the entry is `declined` |
| `invoice.due_at` | invoice sent | → `overdue`; auto-rescind if enabled |
| `invoice.autocomplete_at` | shipped | → `completed` |
| `closed sale offer expiry` | sale close | unaccepted offers → `lost` |
| `rescind mutual answer` | a `mutual_agreement` rescind | 72h without an answer → neutral (4.3.1) |

Each sale's Durable Object keeps **one** alarm set to the earliest pending timer
across the sale's items and invoices. When it fires, it processes everything that
is due, then re-arms.

---

## 8. Who can do what

| Action | Buyer (free) | Buyer (Pro) | Seller (free) | Seller (Pro) |
| --- | --- | --- | --- | --- |
| Claim / offer | ✓ (email verified) | ✓ | — | — |
| Withdraw a pending offer / leave the backup queue | ✓ | ✓ | — | — |
| Rescind own winning claim | — (take-back request) | ✓ until the invoice is sent, 5/month | — | — |
| Award / decline / counter | — | — | ✓ | ✓ |
| Configure the decision window | — | — | fixed 24h | ✓ |
| Hidden minimum offer | — | — | — | ✓ |
| Offer amount visibility (blind / visible) | — | — | ✓ (D26) | ✓ |
| Payment deadline | — | — | 48h | 48h or 24h |
| Rescind and pass to next | — | — | ✓ | ✓ |
| Reorder backups | — | — | ✓ | ✓ |

All checks run server-side in the engine. The UI only hides the buttons.

---

## 9. Write path (concurrency)

The rules above involve read → decide → write (ranking, free units,
promotion), so a single SQL statement per action is no longer enough.

**Decision: each sale has a Durable Object that serializes writes per item.**
- Every mutation for a sale (place, award, counter, rescind, take-back, invoice
  transitions) is sent to that sale's DO.
- The DO holds one lock per item, so different items still run in parallel. It
  loads the item's entries from D1, runs the pure transition function, and writes
  the result as a single `db.batch()` (a transaction) with a version check on the item.
- After a successful write, it broadcasts diffs to connected WebSockets and
  enqueues notifications.
- The same DO owns the sale's alarm (section 7), so timed and user-triggered
  transitions go through the same lock.

**Decision (WS-N, 2026-11-18): the sale lives in its DO's own SQLite; D1 is its read model.**
The first staging load test missed the target (p95 < 300 ms at 200 claims/second on one
sale): from 50 claims/second, D1 rate-limited the database. So the fallback this section
named was taken. Only the engine's storage adapter changed; the transition functions
didn't.

- **What lives in the DO:** a sale's items, entries, invoices and their lines, rescinds,
  take-back requests and new audit rows. These are the same tables and columns as D1,
  built from the Drizzle schema (`@claimsale/db/local`).
  - The sale row, users, plans, blocks and every other sale stay in D1.
  - The engine caches the sale row for 2 s, and a buyer's standing for 30 s or until the
    web Worker reports a block, unblock, ban or Pro change (`buyerChanged`).
  - Past that time, an expired copy is still served for up to a minute while one read runs
    in the background, so a claim never waits for D1 under its item's lock. This applies
    only to a live sale, and only to a buyer the copy lets claim.
  - Lifecycle commands (publish, unpublish, go live, close) read the sale fresh and change
    it in D1 first. The free seller's active-sale cap spans other sales.
- **Hydration:** the first time a DO serves a sale, it copies the sale's rows in from D1.
  `rehydrate` drops the copy and copies again, after writing everything pending to D1. Use
  it for repairs and after a D1 restore.
- **The outbox:**
  - **What it records:** triggers record every write to the DO's tables. A command's events
    and its cross-sale writes (an account flag) go in the same transaction.
  - **How it flushes:** a flush sends D1 the current state of each changed row in commit
    order, as idempotent upserts. Only after D1 accepts does it queue the events. A flush
    runs right after each commit; commits that land meanwhile go together in the next one.
  - **On failure:** a failed flush keeps everything, and the alarm retries it.
  - **Items:** the web Worker still owns their other fields. The engine writes only its
    columns (state, version, deadlines, units won). Versions only grow.
- **Read-your-writes:**
  - Claims, offers, withdrawals and counter answers return once the DO has them. D1
    follows within a flush, normally a few milliseconds.
  - Every other command waits for D1, because the web Worker reads it right after.
  - Pages get the live state from the DO (`liveSnapshot`), not from D1.
- **Items edited in D1:** the web editor, imports, and drafts too. They reach the DO
  through `listingsChanged`, or on publish and go-live. An item the DO doesn't know yet is
  copied in when someone claims it.
  - Once an item has entries, its price and quantity are locked (D40). If a change slipped
    in anyway, it is written back.
- **The rollback switch:** the engine var `SALE_STORE = "d1"` puts every sale back in D1. A
  DO in that mode first writes its outbox to D1, then drops its tables. Both stores run the
  whole Workers suite (the `engine` and `engine-d1` projects).

Every transition writes an `audit_log` row in the same batch.

Claims and offers are also **rate-limited per buyer** (Workers Rate Limiting binding,
20 per 10 seconds) before they reach the Durable Object, so one client can't flood a
sale's write path; a limited command is rejected with `rate_limited` and writes nothing.

---

## 9a. Clarifications from the domain core (2026-11-13)

`packages/core` implements sections 2–8 as pure functions. Where this spec left a
case open, the code does the following; change the spec and the code together.

- **Pending** means `open` or `countered`. A countered offer blocks an instant win
  (4.1) and counts as the buyer's one pending entry on the item.
- **A claim waiting on a free unit is binding.** Buyers can withdraw an offer (D46) or
  leave the backup queue (D14), but not a claim that is being decided.
- **Hidden-minimum offers** are stored as `declined` with `ended_reason = below_minimum`
  and `ended_by = system`, so they appear in the audit log; the buyer only sees
  "Offer not accepted".
- **Accepting a counter on a sold-out item** reopens the entry at the counter amount
  and keeps the counter on record, so the seller can't counter it a second time (D48).
- **Withdrawing an item** ends its pending entries; existing winners stay `won` and
  are rescinded one by one if needed.
- **Ranking ties** (same amount, same millisecond) are broken by entry ID, so the
  order is total. Entries the seller reordered come first, in the seller's order.
- **After close,** pending offers on items with free units lapse after one decision
  window of the seller (24h for free sellers), as 4.5 says; backup offers on sold-out
  items don't lapse until every unit is paid.
- **A Pro seller's decision window** can be any positive duration; D25 sets no bounds.
- **Re-attribution by the admin:** if the admin moves a rescind to buyer fault but its
  reason code has no buyer mark (a seller code), the buyer gets `violation`.
- **A disputed mutual agreement** goes to the admin queue like a contest.

### Clarifications from the control room (WS-I, 2026-11-17)

- **Contests and answers** run in the sale's engine like every other write. A contest
  needs the buyer's side (10–2000 characters). The 72h mutual-agreement answer is a
  sale timer (`mutual_answer_due`, §7): the alarm and the cron sweep treat a missing
  answer as agreement.
- **The admin resolves** a contested or held rescind to `buyer`, `seller` or `neutral`.
  Only the admin can (users with `role = admin`, checked by the engine).
- **Abuse guard:** "overturned" means a contested rescind whose code is buyer-fault and
  that the admin resolved to seller or neutral. The third one resolved within 30 days opens an
  `overturned_rescinds` account flag on the seller (one open flag at a time); older ones no
  longer count (D68).
- **Rows written before the `phase` column** get their phase derived: resolved → final,
  contested → contested, `suspected_fraud` → admin review, `mutual_agreement` → awaiting
  the buyer, otherwise final.

---

## 10. Rule ID registry (for test traceability)

Every rule below must have at least one test whose name contains its ID (TESTING.md
section 2). CI reads this table and fails if any ID has no test. To add a rule,
add a row here in the same PR as the code and the test. Never renumber; retired
IDs stay in the table, marked ~~struck~~.

| ID | Rule | Section |
| --- | --- | --- |
| `SM-2-publish-scheduled` | Publishing with a future `live_at` → `scheduled`; claim buttons disabled | 2 |
| `SM-2-publish-now` | Publishing with no `live_at` → `live` | 2 |
| `SM-2-go-live-alarm` | The alarm at `live_at` moves `scheduled → live` and notifies followers | 2 |
| `SM-2-preview-window` | Preview opens at most 7 days before `live_at` | 2 |
| `SM-2-max-duration` | A live sale runs at most 14 days | 2 |
| `SM-2-free-sale-cap` | Free sellers have at most 2 sales scheduled or live | 2 |
| `SM-2-free-item-cap` | Free sellers have at most 10 items per sale (checked on add and publish) | 2 |
| `SM-2-lock-price-qty` | Price and quantity are locked once an item has entries | 2 |
| `SM-2-close` | Close rejects new entries; timers keep running | 2, 4.5 |
| `SM-3-derived-state` | Item state is derived from units, entries and deadline (all five states) | 3 |
| `SM-3-counts-public` | Claim and offer counts are always visible | 3 |
| `SM-3-offer-visibility` | Offer amounts are hidden in `blind` mode, and shown with anonymous labels in `visible` mode | 3 |
| `SM-4.1-instant-win` | A claim with a free unit, no open offers, no review mode and no deadline → `won` | 4.1 |
| `SM-4.1-deciding` | A claim with a free unit and open offers (or review mode) → `open` + decision deadline | 4.1 |
| `SM-4.1-backup-claim` | A claim on a sold-out item → `open` (backup) | 4.1 |
| `SM-4.1-offer-open` | An offer → `open`; never auto-wins; does not start a window | 4.1 |
| `SM-4.1-backup-offer-toggle` | Offers on sold-out items obey the per-sale toggle | 4.1 |
| `SM-4.1-min-offer` | A Pro seller's hidden minimum auto-declines lower offers | 4.1 |
| `SM-4.1-one-open-entry` | One open or countered entry per buyer per item | 4.1 |
| `SM-4.1-unit-limit` | The per-buyer unit limit is enforced | 4.1 |
| `SM-4.1-buyer-requirements` | Blocked or unverified buyers are rejected; Pro buyers bypass the email and new-account requirements; the verified email isn't a seller setting (D68) | 4.1, D68 |
| `SM-4.2-award` | The seller awards an open entry when a unit is free | 4.2 |
| `SM-4.2-window-expiry` | Window expiry awards the earliest open claim(s), never an offer | 4.2 |
| `SM-4.2-window-length` | The window is 24h for free sellers and configurable for Pro, up to 7 days or the seller's admin-approved cap (at most 30 days) | 4.2, D68 |
| `SM-4.2-ranking` | Rank is amount desc, then time asc; the seller can override | 1, 4.2 |
| `SM-4.3-seller-rescind` | Seller rescind requires a reason code and explanation | 4.3 |
| `SM-4.3-pro-rescind` | A Pro buyer can rescind until the invoice is sent, max 5 per month | 4.3 |
| `SM-4.3-promote-auto` | Promotion: the best backup at or above asking auto-wins | 4.3 |
| `SM-4.3-promote-below-asking` | Promotion: below asking restarts the decision window | 4.3 |
| `SM-4.3-rescind-withdraw` | Plain rescind (not "pass to next") withdraws the item | 4.3 |
| `SM-4.3.1-buyer-nonpayment` | `buyer_nonpayment` / `buyer_unresponsive` → buyer `non_pay` only | 4.3.1 |
| `SM-4.3.1-buyer-payment-reversed` | `buyer_payment_reversed` → buyer severe mark, no refund owed | 4.3.1 |
| `SM-4.3.1-buyer-requested-after-payment` | `buyer_requested_after_payment` → buyer `takeback`, seller unaffected | 4.3.1 |
| `SM-4.3.1-buyer-terms-violation` | `buyer_terms_violation` → buyer `violation` | 4.3.1 |
| `SM-4.3.1-seller-fault` | `seller_item_unavailable` / `seller_listing_error` → `seller_cancel` only | 4.3.1 |
| `SM-4.3.1-mutual` | `mutual_agreement` needs the buyer to confirm, or no response in 72h; neutral | 4.3.1 |
| `SM-4.3.1-fraud-review` | `suspected_fraud` holds both records pending admin review | 4.3.1 |
| `SM-4.3.1-contest` | A buyer contest within 7 days freezes the attribution until the admin resolves it | 4.3.1 |
| `SM-4.3.1-refund-owed` | Refund owed after `buyer_paid`, except for payment reversed | 4.3.1 |
| `SM-4.4-counter` | One counter round; accept → won if a unit is free, else open at the counter amount | 4.4 |
| `SM-4.4-counter-expiry` | A counter expires after 24h → declined | 4.4 |
| `SM-4.4-withdraw-offer` | A buyer can withdraw a pending offer until it's accepted | 4.4 |
| `SM-4.4-leave-backup` | A buyer can leave the backup queue until promoted | 4 |
| `SM-4.5-close-offers-lapse` | Offers still pending at close lapse after 24h | 4.5 |
| `SM-4.5-close-unsold` | Items with no entries become `unsold` at close | 4.5 |
| `SM-4.5-backups-lost` | Backups become `lost` once every unit of their item is paid | 4.5 |
| `SM-5-takeback-request` | Take-back: one pending per entry, the claim stays won, filed until paid | 5 |
| `SM-5-takeback-decide` | Approve → released + promote; deny → no refiling | 5 |
| `SM-6-send-after-close` | Invoices are sent only after the sale closes (manual or auto-send) | 6 |
| `SM-6-late-wins-new-invoice` | Wins after an invoice is sent go to a new draft | 6 |
| `SM-6-shipping-threshold` | Untracked shipping is hidden above $20 for free sellers and $40 for Pro | 6 |
| `SM-6-payment-deadline` | Due 48h after sending (Pro sellers can set 24h) → `overdue`; optional auto-rescind | 6 |
| `SM-6-paid-flow` | buyer_paid → paid → shipped (tracking above the threshold) → completed | 6 |
| `SM-6-autocomplete` | Auto-complete 14 days after shipping; feedback opens | 6 |
| `SM-6-rescind-line` | Rescinding a line before payment recalculates the total; after payment it's marked refund owed | 6 |
| `SM-6-gmv` | `gmv_cents` is recorded when an invoice becomes `paid` | 6 |
| `SM-7-single-alarm` | The DO keeps one alarm at the earliest due timer and processes everything due | 7 |
| `SM-8-permissions` | Each action in the section 8 matrix is rejected for unauthorized actors | 8 |
| `SM-9-serialized-writes` | Concurrent commands on one item are serialized; no double award | 9 |
| `SM-9-audit` | Every transition writes an audit row in the same batch | 9 |
| `IO-import-target` | Item import only into `draft` / `scheduled` sales; rejected for live and closed | PLAN 3c.1 |
| `IO-import-upsert` | Rows match by `sku` / `item_id` → update; others → create; unlisted items kept unless opted in | PLAN 3c.1 |
| `IO-import-cap` | Free-tier item cap enforced on import, with the count that fits reported | PLAN 3c.1 |
| `IO-import-validate` | The server re-validates every row with the shared schema; invalid rows never apply | PLAN 3c.4 |
| `IO-import-idempotent` | A re-sent batch (same `import_id` + row) is a no-op | PLAN 3c.4 |
| `IO-import-photos` | ZIP photos go through resize + EXIF strip; URL photos are rejected | PLAN 3c.1 |
| `IO-export-roundtrip` | Exporting items and re-importing them unchanged produces no changes | PLAN 3c.2 |
| `IO-export-privacy` | Order exports contain only handle, display name and address for won items; never email or phone | PLAN 3c.2 |
| `IO-export-formula-escape` | Cells starting with `= + - @ \t \r` are escaped | PLAN 3c.2 |
| `IO-export-expiry` | Export links expire after 24h; every export is audit-logged | PLAN 3c.2 |
| `IO-tracking-match` | Tracking rows match by invoice number, then the shipping-tool reference, else unmatched | PLAN 3c.3 |
| `IO-tracking-transition` | Only `paid` invoices move to `shipped`; others are rejected with a reason | PLAN 3c.3, SM 6 |
| `IO-tracking-replace` | Replacing an existing tracking number needs confirmation and is logged | PLAN 3c.3 |
| `IO-tracking-carrier` | The carrier is detected from the tracking number format when blank; ambiguous ones are flagged | PLAN 3c.3 |
| `IO-tracking-link` | A shipped invoice links its tracking number to the carrier's tracking page when the carrier is known or detected | PLAN 3c.3 |
| `TCG-tracked-graded-sealed` | Graded singles and sealed product always require tracked shipping, whatever the seller's threshold | PLAN 3 (TCG catalog), SM 6 |
| ~~`TCG-real-photo`~~ | *Retired: replaced by `IMG-required` (D63)* | — |
| `TCG-attribute-schema` | An item's attributes validate against its game + kind schema (forms, imports and API alike) | PLAN 3 (TCG catalog) |
| `TCG-catalog-match` | Import matching order: TCGplayer ID → set + number / set code → fuzzy name + set; ambiguous → seller chooses; unmatched → uncatalogued | PLAN 3c.1 |
| `TCG-want-list-notify` | A listing in a public sale that matches a want-list entry (product, finish, condition ≥ min, price ≤ max) notifies its owner once, whether the listing was there at publishing or added or repriced while the sale is scheduled or live | PLAN 3 (TCG catalog) |
| ~~`TCG-catalog-free`~~ | *Retired: Scryfall is no longer used (D60)* | — |
| `TCG-autofill-only` | Catalog autofill sets only game / set / number / rarity / product type / name / TCGplayer ID; seller fields are never overwritten | PLAN 3 (TCG catalog) |
| `TCG-no-code-cards` | Digital code cards can't be listed; altered art needs the flag; repacks need the label | PLAN 9, D62 |
| `IMG-required` | A sale can't be scheduled or published unless every item has at least one `approved` photo | PLAN 3 (Photo authenticity) |
| `IMG-dup-reject` | A photo within the reject distance of another seller's image (any variant) is rejected without revealing the other seller | PLAN 3 (Photo authenticity) |
| `IMG-dup-review` | A photo in the review band is held for admin review and blocks publishing until resolved | PLAN 3 (Photo authenticity) |
| `IMG-own-reuse` | Own-photo reuse is allowed only for relisting the same item; blocked across different items | PLAN 3 (Photo authenticity) |
| `IMG-hash-robust` | Hashes match across resize, recompress, mirror and 90° rotations (property-tested) | TECH_STACK S33 |
| `IMG-repeat-offender` | Repeated rejected matches flag the account for admin review | PLAN 3 (Photo authenticity) |
| `TCG-market-placeholder` | The market price appears only as a placeholder and hint for the item's seller; the price is never set without a seller action; market prices are never in buyer-facing responses | PLAN 3, D64 |
| `TCG-market-pct` | % buttons compute price = market × pct, rounded down ($0.05 under $5, $0.25 from $5), never below $0.05; bulk apply is previewed first | PLAN 3, D64 |
| `IMG-timestamp-required` | Sellers with fewer than 5 completed sales can't publish a sale without an approved, new timestamp photo; "Timestamped" badge when present | PLAN 3 (Photo authenticity), D66 |
| `IMG-public-approved` | Buyers and visitors only ever see `approved` photos; pending, held and rejected photos are visible to their seller and admins only | PLAN 3 (Photo authenticity), WS-F2 |
| `AUTH-seller-requirements` | Selling needs an 18+ attestation and a verified email, for every seller (no phone, D70); the seller is shown what's missing | PLAN 5 (Auth and identity), D55, D70 |
| ~~`AUTH-phone-e164`~~ | *Retired: phone verification removed (D70)* | — |
| ~~`AUTH-phone-otp-limit`~~ | *Retired: phone verification removed (D70)* | — |
| `AUTH-signup-captcha` | Email sign-up, through the form or the API, needs a passing Turnstile check | TECH_STACK S41 |
| `SM-2-visibility` | Drafts are seen only by their seller; public and unlisted sales by anyone with the link; private sales by the seller, a browser that entered the password, or a verified allowlisted email. Only public sales are listed or indexed (unlisted and private are `noindex`) | 2, D5, D56 |
| `SM-2-private-pro` | Private visibility (password / allowlist) is Pro only; free sellers choose public or unlisted | 2, D31 |
| `SM-2-private-images` | Photos are served only through an access-checked route; photos of private sales and drafts are never publicly cacheable | 2, PLAN 3 (Sale) |
| `SM-2-photo-cap` | Photos per item: 4 for free sellers, 12 for Pro, checked server-side on upload | 2, D33 |
| `TCG-catalog-ingest` | Catalog ingestion is idempotent and resumable: re-ingesting the same TCGCSV build writes no rows, sets that fail or don't fit in a run are retried by the next one, and only autofill fields plus the latest market price per product + subtype are stored (no images, no card text) | PLAN 3 (TCG catalog), TECH_STACK S32 |
| `SM-9-entry-rate-limit` | Claims and offers are rate-limited per buyer before the Durable Object; over the limit → `rate_limited`, nothing written | 9 |
| `SM-4.3.1-abuse-guard` | When the admin overturns a seller's third contested buyer-fault rescind (moves it to seller or neutral) within 30 days, counted by when each was resolved, the seller is flagged in the admin queue | 4.3.1, 9a, D68 |
| `REP-buyer-record` | The seller sees each claimant's record (completed purchases, non-pay, payment reversed, take-backs, violations, Pro rescinds, member since); only final rescinds count, by their resolved fault | PLAN 3b, 4.3.1 |
| `ADMIN-ban` | An admin bans an account with a reason: its sessions end, it can't sign in again, and the engine rejects its claims and offers; unbanning restores sign-in. Every ban and unban is audit-logged | PLAN 9, D22 |
| `ADMIN-pro-grant` | An admin grants seller, buyer or bundle Pro as a `granted` subscription (open-ended or until a date) and can revoke it; tiers follow at once; every grant and revoke is audit-logged | PLAN 3a, 4 (Phase 1) |
| `ADMIN-decision-window` | A Pro seller asks for a decision-window cap above 7 days (up to 30) with a reason; an admin approves it (the cap becomes the requested hours) or declines it, and can reset an approved cap to 7 days; every decision and reset is audit-logged | D68 |
| `ADMIN-report-queue` | A signed-in user reports a user, sale, item or message with a reason; one open report per reporter and target; reports wait in the admin queue until resolved or dismissed with a note | PLAN 9 |
| `SM-6-shipping-menu` | The seller's shipping menu has 1–10 options, each with a label and a flat price of $0–$100 in cents and a tracked flag; option IDs stay stable across edits | 6, D15 |
| `SM-6-address-snapshot` | "I've paid" needs one of the buyer's saved addresses; the invoice keeps a snapshot (and the shipping option's label), which later address-book edits don't change; the seller sees it only on that buyer's invoices | 6, PLAN 3 (Invoice) |
| `SM-6-overdue-rescind` | On an overdue invoice the seller can, in one click, rescind every line for non-payment and pass each item to the next backup | 6, D13 |
| `LIVE-broadcast` | The sale's live socket sends server time and a snapshot on every (re)connect, then one versioned diff per committed write; writes made outside a command (the web item editor, import batches) send every viewer a fresh snapshot marked `edited`, and the page refetches its item details (also when an item it shows is missing from a snapshot); clients keep each item's highest version | 9, PLAN 5 (Realtime details) |
| `LIVE-access` | A live socket opens only for a viewer who may see the sale (`SM-2-visibility`, private sales included) and only from the site's own pages; when a sale goes back to draft, or a published private sale's access changes (it becomes private, its password changes or is removed, its invite list is turned off or loses an address), every socket but the seller's is closed and the page checks access again | 2, 9, D5 |
| `LIVE-no-leak` | What the live grid sends a viewer never names another buyer and never carries the hidden minimum or market prices; offer amounts follow `SM-3-offer-visibility` | 3, D26, D27, D64 |
| `LIVE-position` | Buyers see their own position: winners as #1…#quantity (by when they won), open entries as backup #N, or #N in line while the seller decides, in rank order | PLAN 3 (Claim), 4.2 |
| `LIVE-running-total` | During a sale, a buyer sees the running total of their wins in it (integer cents) | D53 |
| `LIVE-claim-confirm` | Claim buttons ask for confirmation ("Claims are binding. Claim for $40?") unless the seller turned that off for the sale | PLAN 3 (Claim) |
| `NOTIF-idempotent` | A redelivered event batch creates no second notification or email (rows keyed by batch and event; follower and want-list keys by sale/phase and want/item) | PLAN 5 (Notifications), WS-K |
| `NOTIF-preferences` | In-app notifications are always written; email goes only to a verified address and only for categories the user left on | PLAN 5 (Notifications), WS-K |
| `NOTIF-seller-batch` | A seller's activity (claims, offers, decisions, payments, take-backs) is emailed as one digest per 5-minute window; activity already read isn't emailed | PLAN 5 (Notifications), WS-K |
| `NOTIF-allowlist-invite` | Each address on a private sale's invite list gets one invite email: when the sale is published, or when added to a published sale; drafts invite nobody | D5, WS-A/WS-K |
| `MSG-one-conversation` | One conversation per buyer per sale, between that buyer and the seller only; a seller can't open one on their own sale | PLAN 3 (Messaging), D18 |
| `MSG-payment-warning` | A message that looks like an off-platform payment request (payment apps, handles, "friends and family") is shown with a warning | PLAN 3 (Messaging) |
| `MSG-attachment-access` | Message photos are served only to the conversation's buyer and seller (and admins), never cached publicly | PLAN 3 (Messaging) |
| `MSG-block` | A seller can block a user: the blocked user can't message the seller (or claim, `SM-4.1-buyer-requirements`); the seller can unblock | PLAN 3 (Messaging), PLAN 9 |
| `MSG-report` | Any participant can report a message (one open report per message per reporter); reports go to the admin queue | PLAN 3 (Messaging), PLAN 9 |
| `MSG-email-unread` | A new message notifies the other side in-app at once and by email only if still unread 10 minutes later; bodies are never emailed or logged | PLAN 3 (Messaging) |
| `DISC-public-only` | Browse, game pages, search and "who has this card?" show only public sales that are scheduled or live, and only their items that aren't withdrawn; drafts, unlisted, private, closed and deleted sales never appear. Results carry only buyer-facing fields (no hidden minimum, SKU or market price) | D28, D56, PLAN 6 (Phase 1) |
| `DISC-who-has` | "Who has this card?" lists every listing of one catalog product across discoverable sales (`DISC-public-only`), items still available first, then cheapest first | PLAN 3 (TCG catalog) |
| `DISC-copy-text` | The seller's "copy as text" export lists the sale's items in sale order with price, condition and quantity, marks sold-out ones, leaves withdrawn ones out, and ends with the sale link; it includes only buyer-facing fields | PLAN 6 (Phase 1) |
| `SHARE-private-title-only` | A sale's share card (`og:image`, `og:` and `twitter:` tags) shows what a signed-out visitor may see, whoever is viewing: a public or unlisted sale's title, seller, status, item count and first items with prices; a private sale's title, seller and status only; drafts and deleted sales have none (the image is a 404) | PLAN 3 (Visibility), TECH_STACK S13 |
| `SHARE-cache-version` | Share images are cached in R2 per card version (the card's fields plus the design version); a change to anything on the card gives a new version and a new `og:image` URL, the same card always the same one, and a sale's older versions are deleted | TECH_STACK S13 |
| `SM-9-local-store` | A sale's items, entries, invoices, rescinds and take-backs live in its SaleEngine's own SQLite; D1 is their read model (the web Worker's edits to items are copied in, and a claimed item keeps its price and quantity) | 9, D40 |
| `SM-9-outbox` | Every committed write reaches D1 through the outbox in commit order, each changed row written once per flush; events are queued only after D1 has the rows; a failed flush keeps everything and is retried | 9 |
| `SM-9-hydrate` | The first time an engine serves a sale it copies the sale's rows in from D1; `rehydrate` writes everything pending to D1, then copies the sale in again | 9 |
| `SM-9-read-your-writes` | Claims, offers, withdrawals and counter answers return once the engine has them; every other command returns only after D1 has its writes | 9 |
| `SM-9-buyer-cache` | The engine reads a buyer's standing (verified, account age, blocked, banned, Pro) from D1 at most every 30 s per sale, or again at once after a block, unblock, ban or Pro change; past 30 s an old copy that lets the buyer claim is served while one read runs in the background, one that refuses them never is | 9, D22 |
| `SM-9-claim-access-cache` | The claim and entry-action endpoints check a public or unlisted sale against a copy at most 5 s old; private sales are read every time; the engine still refuses a sale that isn't live | 9, D5 |
| `AUTH-session-cookie-cache` | A session and its user are cached in a signed cookie for at most 60 s; the user's own profile writes (onboarding, settings) drop it, so the next request reads D1 | TECH_STACK S40 |

