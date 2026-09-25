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
```

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

`admin_tasks` rows are the board's to-do list. `_shared/task_routing.ts` decides who sees each one and who gets the phone pop-up. A task goes to one board member (`assigned_admin_id`), or to everyone holding one of its `target_scopes`, and owners always see everything. Every scope used must be a real one from `ALL_SCOPES` in `tenant_admin_auth`. A made-up scope silently hides the task from everyone but the owner. `node scripts/test_task_routing.mjs` checks this, offline.

### Member help

Members ask the board from the app (`help_requests` function, `help_requests` + `help_messages` tables). Each topic goes to the board member picked in the Member help inbox (`settings.value.help_topics`), else the president. Only they see it, it keeps one dashboard task until solved, and board replies are texted to the member with a `/m/#help=<id>` link. Photos live in the private `help-photos` bucket behind signed links. SQL can't delete storage files, so delete a request through the function (president) to remove its photos. `node scripts/test_help_requests.mjs [--offline]`.

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
