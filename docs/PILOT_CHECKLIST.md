# Pilot checklist (WS-L, milestone 10)

What has to be true before the first real sale. Each item says who does it and how to
check it. Items marked **owner** need the owner's accounts or decisions; the rest can be
done by anyone with staging access. Tick them in the PR that closes WS-L, or in a follow-up.

## 1. Domain and email (owner)
- [x] `claimsale.net` is registered in the AntiTcb Cloudflare account (zone active since 2026-10-09) (PLAN §12).
- [x] `notify.claimsale.net` is onboarded in Email Service (2026-11-18): sending subdomain
      created with `cf email-sending subdomains create`, which added the bounce MX, SPF, DKIM and
      DMARC (`p=reject`) records; DNS status `ready`. Check it any time with
      `cf email-sending subdomains dns status <id> --zone claimsale.net` (the id is in
      `cf email-sending subdomains list --zone claimsale.net`). Starting quota: 1,000 emails a day.
- [ ] Check: sign up on staging with a fresh address; "Confirm your email" arrives, and a
      followed seller's new public sale sends the follower an email (WS-K).

## 2. Policies (owner)
- [x] Prohibited items page: `/policies/prohibited-items`, from D21, D59, D62 and D63.
- [ ] Terms of service and privacy policy: the text needs the owner (and ideally a lawyer).
      Link them from `SiteFooter.svelte` next to "Prohibited items" once written.
- [ ] Trademark search for "ClaimSale" and the matching social handles (PLAN §12).
- [ ] TCGCSV terms and attribution, checked before catalog data shows on production (PLAN §12).

## 3. Load test on staging
`load/claim-rush.js` (k6) drives 200 claims a second at one live sale through the real
path, with a p95 target under 300 ms (WS-E, STATE_MACHINES §9). Its header has the setup:
a live staging sale, a sessions file of signed-in buyers (at least 150, because of the
per-buyer rate limit) and an Access service token.
- [x] Run it once against staging; record the p95, the error rate and the date here.
      **2026-11-18: failed the target.** 200 seeded buyers, one live unlisted sale of 60
      single-quantity items, 30 s per rate, measured from a client about 50 ms from the edge:

      | Rate | Handled (201/409) | Median | p95 | p99 |
      |---|---|---|---|---|
      | 25/s | 100% | 257 ms | 407 ms | 717 ms |
      | 50/s | 53% | 625 ms | 1.12 s | 1.33 s |
      | 100/s | 50% | 864 ms | 2.14 s | 2.79 s |
      | 200/s | 50% (only ~100/s sent; 2,130 dropped) | 5.3 s | 23.5 s | 32.7 s |

      Every failure was D1 overload. The engine logged `D1 DB is overloaded. Too many resources
      consumed within a 10 second window` (496 times at 200/s), and the web Worker's 500s were
      the same overload, in Better Auth's session lookup. The 503s were `engine_unavailable`.
      Each query is fast (about 0.2 ms on average), but D1 peaked at about 400 statements a
      second. That is roughly 8–10 per claim: Better Auth's session lookup, the sale lookup, the
      engine's read batch and write batch, the sale's invoices on every win, and the notification
      consumer. Reads per claim also grow with the sale's size: the item and sale queries scan
      every item, and each win reloads every invoice of the sale. That was about 80 rows per
      claim on this 60-item sale. Every win also takes the sale-wide invoices lock across two D1
      round trips, which serializes go-live wins. That is the condition in STATE_MACHINES §9 /
      PLAN for the fallback: DO-local SQLite with an outbox to D1. That is follow-up work before
      the pilot.
- [x] Delete the sessions file afterwards (it holds live sessions). Deleted, and the seeded
      users, sessions, sale, entries, draft invoices and notifications were removed from
      staging D1 (bookmark before seeding: `00000153-00000000-00005127-d560ec0cfe7382e14f880573567230f5`).
- [x] **2026-11-19, WS-N on PR #33's Worker pair** (its own D1, engine and queue; same seeding,
      same client). The local store fixed the D1 overload on the claim path:

      | Run | Handled | p95 (k6) | p95 (web Worker, server side) |
      |---|---|---|---|
      | 25/s (cold start) | 100% | 358 ms | — |
      | 50/s | 100% | 222 ms | — |
      | 100/s | 100% | 260 ms | — |
      | 200/s, sessions from D1 | 90.6% (500s: session reads) | 584 ms | 334 ms |
      | 200/s, warm sessions, mostly repeat claims | 95.4% (429s: rate limit) | 408 ms | 163 ms |
      | 200/s, warm sessions, fresh sale (first claims) | **100%** | 1.29 s | 734 ms |

      - **Before the sessions fix:** k6 sent only each buyer's session token, so every claim
        read its session from D1. That is what failed at 200/s. `setup()` now opens a page
        as each buyer first, as a browser would, so claims carry the session cache cookie.
      - **What made the last run slow:** the engine's RPCs spent their time waiting (3 ms of
        CPU at p95, 765 ms of wall time), for two reasons:
        - When the sale cache (2 s) and new buyers' standing expired, every claim in flight
          read D1 while holding its item's lock.
        - The notifications consumer was working off earlier runs' backlog. Its item lookup
          walked every item of the sale (about 400 rows per call).
      - **Fixed since, not yet measured:** expired copies are served while one read runs in
        the background, and the consumer's lookups use the primary key (`CROSS JOIN`).
- [x] Re-run 200/s on a fresh sale after those fixes deploy (2026-11-19, `c2fedf4`, a fresh
      120-item sale with 200 new buyers, 100/s then 200/s). **Every claim was handled and no
      errors were logged; the server side is within target:**

      | Rate | Handled | p95 (k6) | p95, web Worker | p95, engine RPC |
      |---|---|---|---|---|
      | 100/s | 100% | 388 ms | 224 ms | 117 ms |
      | 200/s | 100% | 451 ms | 260 ms | 186 ms |

      - **The gap between k6 and the Worker** is the network between the test machine and
        the edge (Access included).
      - **Half the warm-ups were refused:** Better Auth's limit of 100 requests a minute on
        `/api/auth/*` turned away about 100 of the 200 warm-up requests. Those buyers' claims
        read their session from D1, and still passed. A real buyer's cache comes from loading
        a page, which isn't rate-limited.
- [ ] Run it once more on staging after merge (from a machine close to the edge, to judge the
      300 ms target end to end).

## 4. Observability (owner for the Sentry account)
- [ ] TECH_STACK §11 Sentry items done: project DSN in Infisical, the `sentry-traces` and
      logs destinations in Cloudflare, and `/debug/trace` checked on staging.
- [ ] A Sentry dashboard with: server errors by route, p95 of `engine.*` spans, queue
      consumer failures (`engine.notifications.message`, `photo_verify`, `export_job`), and
      the cron runs (`engine.cron.*`).
- [ ] An alert on new server errors and on queue retries, sent to the owner.

## 5. Backup and restore drill (D1 Time Travel)
D1 Time Travel can restore the database to any minute in its retention window (30 days
on the Workers Paid plan). Practise a restore on **staging** before the
pilot, so a production restore isn't the first one:

```bash
# 1. Note a bookmark for "now" (before the change you'll undo)
pnpm --filter @claimsale/engine exec wrangler d1 time-travel info claimsale-staging --env staging

# 2. Make a visible change on staging (e.g. rename a test sale), then restore
pnpm --filter @claimsale/engine exec wrangler d1 time-travel restore claimsale-staging --env staging --bookmark=<bookmark>

# 3. Check the change is gone, and that sign-in, a sale page and /api/health still work
```

- [ ] Drill done on staging; record the date, how long the restore took, and anything
      surprising here.
- [ ] Note for production: a restore rewinds every table, including sessions, claims and
      invoices written after the bookmark. Durable Object alarms and storage are not rewound,
      so close or pause live sales before restoring production. Since WS-N each sale's claims
      live in its SaleEngine (D1 is the copy): after a restore, press **Reload open sales from
      D1** on `/admin`, or the engines will write their newer rows back over the restored
      ones (TECH_STACK S43). Include that step in the staging drill.

## 6. Smoke test before the pilot sale
- [ ] On staging: sign up a seller and a buyer, verify email and phone, schedule a public sale
      with photos, find it on `/browse`, `/g/<game>` and search, claim at go-live, close,
      invoice, mark paid and shipped (the E2E specs cover each step locally).
- [ ] The seller's "Copy as text" output pastes cleanly into a Facebook post.
- [ ] The release PR `dev` → `main` is merged and production `/api/health` reports both Workers.
