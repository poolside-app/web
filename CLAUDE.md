# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Poolside — multi-tenant SaaS for community pool clubs (members, gate access, applications, programs, party booking, payments). One codebase serves every club; the hostname determines which tenant you are. Bishop Estates Cabana Club is tenant zero.

Production: `poolsideapp.com` (Vercel) + Supabase project `sdewylbddkcvidwosgxo` (`poolside-prod`).

**`PLAN.md` is the current step-by-step working plan** (since 2026-09-23). Doug approves one step at a time. The April 2026 architecture plan it replaced is in git history and described tables that no longer exist.

## Commands

```bash
./scripts/smoke.sh [slug]         # public-surface smoke test, defaults to bishopestates
python scripts/e2e.py             # end-to-end: mints synthetic JWTs, real DB writes against live infra, self-cleaning
node scripts/frontend_smoke.mjs   # headless Chrome render check of EVERY page (public + authed), catches JS errors
node scripts/test_payments.mjs    # targeted: fake card + fake Venmo signup end to end, ~15 function calls
node scripts/test_screens.mjs [--live] [--render]   # member/board screens (D1–D13); offline by default
```

Targeted tests for newer features each take `--offline` (free) or run live against a temporary family or board login they remove afterward: `test_board_meetings`, `test_help_requests`, `test_screens`, `test_money` (plans, discounts, referrals, codes), `test_positions` (board positions, bylaws), `test_agenda` (meeting agendas), `test_flex_plan` (payment plans; offline by default, `--live` uses a throwaway club with its own Stripe test account), `test_signup_notes` (signup checks, Home Screen sign-in, parties, pop-ups), `test_keyfobs` (fob requests, payments, issuing; offline by default), `test_plan_approval` (PLAN.md S: billing day, approving plan payments; offline by default), `test_board_notes` (PLAN.md R: tab counts, meeting votes, the renewal message, renewal signing, auto-renew approval; offline by default), `test_board_home` (PLAN.md W: each board member's home, the gate unlock, the bottom bar; offline by default). `test_task_routing` has no offline mode: it always makes its 4 live calls. `ONLY=<step>` limits the live part of `test_money`, `test_positions`, `test_agenda` and `test_flex_plan`. `node scripts/check_phone_width.mjs [page]` opens every page and pop-up at iPhone width (about 2 calls a page).

All of these read secrets from `.env.local` (gitignored). There is no `npm test`, no lint, no build step — the frontend is static files served as-is.

Every script runs against live production, and every call counts against the Supabase invocation quota. Prefer the targeted script for what changed. Run the full suites only when a full check is actually wanted. CI (`verify.yml`) is manual-only for the same reason.

## Deploying

- **Frontend:** `git push origin main` → Vercel auto-deploys to production (~30s). No build; no manual Vercel step.
- **Edge Functions:** deploy via the Supabase MCP `deploy_edge_function` tool, or the Supabase CLI. `tools/supabase.exe` is a **Windows** binary and will not run on macOS.
- **Migrations:** SQL files in `supabase/migrations/`, applied against the shared project. One migration upgrades every tenant at once.
- **Secrets:** set on the Supabase project (Edge Function secrets), not in the repo. Functions read env vars per-call, so most secret changes need no redeploy. See `INTEGRATIONS.md`.

## Architecture

### Tenant resolution happens in `vercel.json`, not in code

`vercel.json` rewrites are the routing layer. `<slug>.poolsideapp.com/` → `/club/index.html`; the apex → `/home.html`. Per-tenant PWA manifests and touch icons are rewritten to the `tenant_manifest` / `tenant_icon` edge functions with `?slug=`. Editing `vercel.json` can silently break every tenant's routing — `smoke.sh` exists partly to catch that.

### There is no server — Edge Functions are the entire backend

~53 Deno functions in `supabase/functions/`. Static HTML pages call them directly by URL (`${SUPABASE_URL}/functions/v1/<name>`), hardcoded per page. Functions use the service-role key and enforce tenant scoping **in application code**, not via RLS policies — most tables have RLS enabled with no policies, which is intentional given nothing reaches Postgres except these functions. Do not assume RLS is protecting a table.

Database functions are private too. The anon key ships in every page, so a function the anon role can execute is callable by anyone at `/rest/v1/rpc/<name>`. Since 2026-09-24, functions a migration creates start with no public EXECUTE (default privileges revoked). If the service role needs to call one, `grant execute ... to service_role`, and never to anon or authenticated. `node scripts/test_rpc_lockdown.mjs` checks this.

Shared logic lives in `supabase/functions/_shared/`: `auth.ts` (JWT verify + role/scope gates), `send_email.ts`, `plan_caps.ts`, `sms_cap.ts`, `google_drive.ts`, `sync_application.ts`, PDF builders.

### Three separate auth audiences, all HMAC-signed with `ADMIN_JWT_SECRET`

| Audience | Token in localStorage | Surface |
|---|---|---|
| Provider (you) | `poolside_provider_token` | `/admin/` |
| Tenant admin | `poolside_tenant_token` | `/club/admin/` |
| Member | `poolside_member_token` | `/m/` |

Not Supabase Auth — custom JWTs. `_shared/auth.ts` is the single source of truth for "can this caller do X": `verifyTenantAdmin`, `requireScope`, `requireOwner`, and `verifyTenantAdminOrProvider` for cross-tenant provider actions. Authorization is **JWT-first with DB fallback**, so tokens issued before newer claims existed keep working, and the DB stays authoritative for revocation (a deactivated admin's token dies on the next call).

### Surfaces

- `home.html`, `apply.html`, `signup.html`, `pricing.html` — marketing + public application (apex domain)
- `club/` — member-facing tenant home; `club/admin/` — 36 tenant admin pages
- `m/` — member portal (login, verify, family)
- `admin/` — provider admin (tenants, gate integrations, analytics)

### Plan model

Capacity-gated, **not** feature-gated: every tier gets every feature; only household headcount differs (`_shared/plan_caps.ts` — starter 75, pro 200, enterprise ∞). SMS caps are separate (`_shared/sms_cap.ts`).

The Free Forever tier was retired 2026-09; `plan='free'` survives only as a legacy value on tenants created before then, and maps to the Starter cap rather than locking a club out mid-season. New clubs get a **free first season** instead — uncapped, then they pick a plan. Prices live in three places that must move together: `pricing.html`, `home.html`, and the `TIERS` array in `club/admin/billing.html`. They disagreed until 2026-09-09, when billing.html was still showing Pro at $799 against $1,400 on the public site.

### Dashboard tasks

`admin_tasks` rows are the board's to-do list. `_shared/task_routing.ts` decides who sees each one and who gets the phone pop-up. A task goes to one board member (`assigned_admin_id`); or, if it's a board-position alert (its `notice`, or its kind in `TASK_NOTICE` in `_shared/positions.ts`), to whoever holds that position now, else the President; or to everyone holding one of its `target_scopes`. Owners always see everything on the dashboard. Every scope used must be a real one from `ALL_SCOPES` in `tenant_admin_auth`. A made-up scope silently hides the task from everyone but the owner. `node scripts/test_task_routing.mjs` checks this, offline.

### The board home

The dashboard (`club/admin/index.html`) is built per board member from the ticks on Settings → Board (PLAN.md W). One call, `admin_tasks` `home`, returns their tasks plus `home`: three banner numbers and four quick buttons picked from their screens (`_shared/board_home.ts`, `pickStats` / `pickQuick`: each position's main area first, the President gets the club-wide set), today and the week ahead (events expanded on the page by `js/today.js`), the next meeting, the next plan charge day for money people, and the gate. Nothing is stored, so a changed tick shows on their next visit. The gate unlock sits at the top for every board member when the club has keyfobs and remote unlock on; `gate_admin` `board_unlock` refuses while the bridge is off (the bridge takes the oldest waiting unlock whenever it returns) and records `gate_unlocks.admin_user_id`. On phones every board page has a bottom bar (Home, the sections they can use, More), drawn by `js/admin-subtabs.js` (`AdminNav`) once `PoolsideFlags.apply` knows who is signed in; top tabs hide sections they can't use and open each one on a screen they can. `node scripts/test_board_home.mjs [--live]`.

### Board positions

Each club has its own board positions (`board_positions`, `board_position_holders`), edited on Settings → Board (`board` function). A position has a job description, the alerts it gets (`notices`) and the screens it can use (`scopes`); holding it sets the person's `board_title`, role and scopes (`_shared/positions_db.ts` `syncLogins`). Positions replaced the old fixed role templates in the UI. Permission checks read the login's current role and scopes from the database, so a change applies on the next call. An empty position's alerts go to the President, then the Vice-President. `node scripts/test_positions.mjs [--offline]`.

### Payment plans

A family pays in full, or picks how much to pay today ($0 included) and the month to be paid off by (PLAN.md M). `_shared/flex_plan.ts` splits the rest evenly by month and checks the club's deadlines (`settings.payments.plan.milestones`, "half by April 10", "paid in full by July 15"). `_shared/plan_quote.ts` prices the offer for the join form, the renewal pages and checkout, so the family is charged exactly the schedule they saw. That includes the $4 plan fee (unless the club's fees are waived) and the card fee when the club passes card fees on. `_shared/plan_ops.ts` holds the rules everyone shares:
- The gate opens once half is paid; the club can choose card saved or first payment instead.
- A card is retried 3, 7 and 14 days after it is first declined.
- A plan ends on the fourth decline, when the family cancels, or if it isn't paid by the paid-in-full date. Then the family is emailed that their membership is canceled, the Treasurer gets one email, and the gate goes off: from the season's start, or straight away at the deadline.
- To reinstate, the family pays what's overdue plus the reactivation fee.

Every plan payment falls on the club's billing day (`payments.plan.billing_day`, the 1st by default), and **nothing is charged until a board member ticks it** on Money → Upcoming (`upcoming.html`, `payment_plans` `upcoming` / `approve` / `unapprove`, PLAN.md S). Approval covers the payment's retries. The Treasurer gets a dashboard task and pop-up 3 days before, and a daily reminder from the due date while anything waits; a plan never ends over a payment the board hadn't approved (`chargeableNow`, `awaitingApproval` in `plan_ops.ts`). The daily `payment_plans` cron charges only approved payments, with idempotency keys. Test-payment cards (`sim_pm_…`) are never sent to Stripe; the board uses "Simulate the next payment" instead. `node scripts/test_flex_plan.mjs [--live]`.

### Seasons and who's a member

A club has one current season (`settings.membership.year`, read through `sellingYear`). It changes only when the owner presses "Close 2027 and start 2028" on Settings → Season (`tenant_settings` `close_season`, PLAN.md U2), which also shows a checklist for the new season. `_shared/membership_status.ts` decides who's a member: paid for the season, on a plan for it, or last season's member before January 1. From January 1, anyone else can sign in but only use My family, the calendar, Ask the board and renewing; the gate, parties, photo uploads and keyfob requests refuse them, and the daily `payment_plans` run turns their `dues_paid_for_year` off. `member_auth` `me` returns `access`. The member app has three tabs fixed to the bottom of the screen: Home (a small banner with the date, the weather at the pool from Open-Meteo, and today; remote unlock; to-dos; news; fundraiser; photos; calendar, parties and programs), Ask the board, and My family (family, plan, keyfobs, refer a friend). PLAN.md U4, V. `node scripts/test_season_home.mjs [--live]`.

### Renewals

When the next season goes on sale, the board sends the **renewal message** (Members → Renewals, `renewals` `send_renewal_links`). It goes only to last season's members who haven't renewed, to the person who opened each account, by email and/or text, with each family's own no-login link (`/renew.html?t=`). Renewing, from that link or in the app (`m/renew.html`), shows everything filled in; the family accepts the club's policies and the primary signs (`js/renew-sign.js`, `_shared/renewal_sign.ts`). `stripe_checkout` refuses to take payment for an unsigned renewal.

Auto-renew is "approve next season" (PLAN.md R7, since 2026-10-08). The daily `auto_renew_run` never charges: when renewals open it sends auto-renew families their renewal to approve (pop-up and email), with one reminder a week later. Approving with the card kept for auto-renew charges it once (`payment_plans` `renewal_charge_saved`, internal only), then runs the normal renewal approval. The terms a family agrees to are in `_shared/payment_terms.ts` (version 2).

### Emails

Every email Poolside sends a family is one of 15 in `_shared/email_template.ts`, grouped by moment (Signing up, Welcome, Payments, Renewals, Parties, Family changes; PLAN.md T). Each has a message a club can change on Settings → Emails (`email_templates` function and table: subject, `body_html` holds the message, enabled), and Poolside's part (heading, details, buttons, sign-in line) built in code from the same variables. Senders still name the exact version (`application_approved_stripe_paid_no_app`…); `ALIASES` maps those to the merged email and what differs. What a board types goes through `cleanMessage`. `node scripts/test_emails.mjs [--live]`.

### Member notifications

Members turn on pop-ups in the app (`js/member-push.js`, the `push_member` function, `member_push_subscriptions`). Doug decided on 2026-10-07 how members are told things. Board replies, party decisions, plan receipts and announcements (with "Notify members" on) arrive as pop-ups through `_shared/member_notify.ts`, plus email where it makes sense: receipts and payment details always, a board reply only when no pop-up reached them. **No texts** except "Text all members", sign-in codes, the welcome text at approval, and the board's renewal message when they tick Text. Agendas reach the board by pop-up only. On iPhone, pop-ups need the app on the Home Screen. The member home hands that app a one-time sign-in through the manifest's start address (`member_auth` `handoff`, `tenant_manifest ?h=`), so it opens signed in. `node scripts/test_signup_notes.mjs [--live]`.

### Parties

Members pick a date and start time; every party runs the club's length (`_shared/party_length.ts`). `_shared/party_slots.ts` holds the rest:
- The fee.
- Automatic approval of open times.
- Two parties can share a day but never overlap. The `party_bookings_booked_no_overlap` exclusion constraint enforces this for paid parties.
- A 2-day hold for unpaid approved parties. The daily `payment_plans` run releases them.
- Card totals: the card fee is always the member's.

Card payment books the party in the webhook. Venmo waits for the board's `verify_payment`.

### Keyfobs

When a club has keyfobs on (`features.keyfobs`), each fob is a row in `keyfobs` (PLAN.md P). `_shared/keyfobs.ts` holds the rules: the free count and fee (`settings.keyfobs`, 1 and $15 at Bishop), the two printed number formats, and the card total. A new family's free fob is requested at approval when they ticked "I need a keyfob". Poolside, not the form, decides who is new: a claim link or a renewal never gets one, imported families are sent to their personal link, and a signup at a past member's address carries a warning for the board. A family can also add extra fobs at signup or renewal (PLAN.md Q): they're part of the membership price (`applications.fob_extra_count`, `fob_cents`, priced in `membership_price.ts`), up to `max_per_family` (5) counting the fobs they have and the free one, and `fobsAtApproval` sets them all up with one task. Later extras and replacements are paid in the app first, several at once, by card (`stripe_checkout` `keyfob`, `keyfob_ids`) or Venmo the board confirms. A broken fob goes through Member help and the board's swap (free, or the fee). The board issues fobs on Settings → Keyfobs, and every fob task is the "gate" alert (Facilities Director). `households.fob_number` mirrors the active fobs. Switching fobs at the panel comes later (P5). `node scripts/test_keyfobs.mjs [--live]`.

### Member help

Members ask the board from the app (`help_requests` function, `help_requests` + `help_messages` tables). Each topic goes to whoever holds the board position that gets it (`HELP_NOTICE` in `_shared/positions.ts`), else the president. Only they see it, it keeps one dashboard task until solved, and board replies are texted to the member with a `/m/#help=<id>` link. Photos live in the private `help-photos` bucket behind signed links. SQL can't delete storage files, so delete a request through the function (president) to remove its photos. `node scripts/test_help_requests.mjs [--offline]`.

Offline tests load Edge Function helpers with `scripts/lib/importts.mjs`, which follows their relative `.ts` imports.

### Scheduled work

Four `pg_cron` jobs call edge functions: payment plans, applications cleanup, external calendar sync, gate-bridge monitor. Defined in migrations, not in app code.

### Gate integration

Real hardware: an on-prem bridge polls `gate_bridge` and drives a MENGQI-CONTROL HXC-7000 panel; `gate_panels.bridge_last_seen_at` is the liveness signal. `unlock_gate` and `gate_admin` are the API surface.

## Conventions

- Vanilla HTML/CSS/JS. **Every page is self-contained** — inline `<style>` and `<script>`, no bundler, no framework. Shared behavior lives in `js/` and is pulled in with plain `<script src>`.
- Fraunces (display) + Inter (body), loaded from Google Fonts.
- New admin pages should be copied structurally from an existing sibling in `club/admin/` (nav, auth guard, subtabs, styling all follow one pattern).
- **Every time is the pool's time** (`tenants.timezone`). This applies to server and screens alike, never UTC and never the viewer's phone.
  - Server: use `_shared/pool_time.ts` (`poolToday`, `poolDate`, `partyWhen`, `fmtPoolStamp`, `wallTimeToUtc`). Never `toISOString().slice(0, 10)` for "today", and never `toLocale*` without a `timeZone`.
  - Club pages: load `js/pooltime.js` first. `scripts/add_pooltime.py` adds it to new pages. It makes pool time the default for all `toLocale*` display.
    - Day arithmetic and `datetime-local` boxes go through `PoolTime` (`todayKey`, `dayKey`, `atTime`, `toInput`, `fromInput`).
    - Date-only values (`YYYY-MM-DD`) go through `PoolTime.fmtDay`, never `new Date(value)`.
  - Test with `node scripts/test_pool_time.mjs`.

## Gotchas

- **CRLF churn:** Windows tooling has rewritten tracked files with CRLF line endings, producing enormous diffs that are pure noise. The repo has no `.gitattributes`. Before reviewing a large diff, run `git diff --ignore-all-space --ignore-blank-lines --stat` to see the real change.
- Client-side JS errors are not captured anywhere in production — `frontend_smoke.mjs` is the only thing that catches them, and only pre-deploy.
