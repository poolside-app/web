# Plan — ship the backlog + test payments, without burning Supabase calls

Replaces the stale April 2026 plan (still in git history).
Rule: one step at a time. Doug says "execute Step N"; I do it, prove it worked, report, and stop.

## Where things stand (2026-09-23)
- Supabase is back after the quota block. The gate bridge (99% of all calls) is off and stays off.
- Never reached the backend: 8 migrations and about 20 commits of function code from 9/9–9/10 (late fees, fee waiver, email queue, referral approval, payment authorizations, share link and more). Those pages are already live and calling backend code that isn't there.
- Test payments (fake Venmo and fake card) are built but only on the Mac, not committed.
- Call budget: about 470,000 left this month. Everything below should cost under 2,000.

## Step 1 — Safety first
- Switch `.github/workflows/verify.yml` to manual-only, so pushes stop running the full suite against production.
- Record the starting call count from the logs, and confirm the bridge is still silent.
- Proof: the workflow file has no `deployment_status` trigger; the log count is recorded here.

## Step 2 — Write the failing test first
- New targeted script `scripts/test_payments.py`. It never runs the full suite.
- What it does:
  - Turns on test mode for bishopestates.
  - Submits one card application and one Venmo application, each with a family name starting `SimTest` so they're easy to find and delete later.
  - Pays the card one through the fake checkout, and presses "Simulate Venmo payment" for the other.
  - Checks the database: both approved and paid, households marked paid for the season, the card one's session id starting `sim_`, and a welcome email and text logged.
- This is my own check before real people touch it. It uses doug.frevele+simtest…@gmail.com (lands in Doug's inbox, never bounces) and a fake 555 phone number, so it confirms a text was attempted without texting anyone.
- Does not delete its rows. Doug says when to clean up.
- Proof: run it now, before deploying. It must fail because test mode doesn't exist yet. Cost: about 5 calls.

## Step 3 — Apply the 8 migrations, in file order
- `reconstruct_applied_migrations`, `gate_integration_requests`, `late_fees`, `platform_fee_waiver`, `email_queue`, `resend_quota_header`, `referral_board_approval`, `payment_authorizations`.
- All of them are safe to re-run. Their only drops are "drop … if exists" followed by a re-create.
- Proof: `list_migrations` shows all 8, and the new tables and columns exist. Cost: 0 calls.

## Step 4 — Commit, then deploy every stale function
- Commit the test-payments work first, so what's deployed matches git. Commit only, no push.
- Deploy through the Management API from disk, with `verify_jwt:false` and all `_shared` files included:
  - About 32 functions whose live code is older than the repo.
  - `tenant_share`, which has never been deployed.
  - The 4 test-payment functions.
- Proof: call each function once and confirm it isn't returning `BOOT_ERROR`. Cost: about 35 calls.

## Step 5 — Push the pages
- `git push origin main`. Vercel deploys `apply.html`, `pay-test.html` and the admin Payments page.
- Proof: fetch the pages from bishopestates.poolsideapp.com. Cost: 0 Supabase calls.

## Step 6 — Run the test again
- `scripts/test_payments.py` must now pass.
- Proof: test output, plus the call count from the logs compared with Step 1. Cost: about 20 calls.

## Step 7 — Real people try it
- Doug's wife, daughter, neighbor and board members sign up on the live site with their own names, emails, phones and family members.
- Each one picks Venmo or card, fake-pays, and gets approved automatically.
- Each gets the real welcome email and text with a sign-in link, and can log in to the member app.
- Doug watches the backend: Members, Households, Audit log, the Payments page.
- Test mode stays on the whole time. Check the Twilio balance first: it was $8 with no auto-recharge, and texts silently stop at $0.

## Step 8 — Clean up (only when Doug says)
- Delete every `SimTest` application and household, plus anything testers created, if Doug wants that.
- Turn test mode off.

## Doug's own to-dos (not mine)
- Set `SMS_GLOBAL_DAILY_CAP` back to 25 (Supabase → Edge Functions → Secrets).
- Decide on Supabase Pro ($25/mo): backups, and no pausing after 7 idle days.
- Keep the bridge off until its polling is fixed.
