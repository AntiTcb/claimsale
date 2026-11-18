# Pilot checklist (WS-L, milestone 10)

What has to be true before the first real sale. Each item says who does it and how to
check it. Items marked **owner** need the owner's accounts or decisions; the rest can be
done by anyone with staging access. Tick them in the PR that closes WS-L, or in a follow-up.

## 1. Domain and email (owner)
- [ ] `claimsale.net` is registered in the AntiTcb Cloudflare account (PLAN §12).
- [ ] `notify.claimsale.net` is onboarded in Email Service (TECH_STACK §11). Until then,
      staging can only email verified destination addresses.
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
- [ ] Run it once against staging; record the p95, the error rate and the date here.
- [ ] Delete the sessions file afterwards (it holds live sessions).

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
      so close or pause live sales before restoring production.

## 6. Smoke test before the pilot sale
- [ ] On staging: sign up a seller and a buyer, verify email and phone, schedule a public sale
      with photos, find it on `/browse`, `/g/<game>` and search, claim at go-live, close,
      invoice, mark paid and shipped (the E2E specs cover each step locally).
- [ ] The seller's "Copy as text" output pastes cleanly into a Facebook post.
- [ ] The release PR `dev` → `main` is merged and production `/api/health` reports both Workers.
