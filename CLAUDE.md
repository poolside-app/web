# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Poolside — multi-tenant SaaS for community pool clubs (members, gate access, applications, programs, party booking, payments). One codebase serves every club; the hostname determines which tenant you are. Bishop Estates Cabana Club is tenant zero.

Production: `poolsideapp.com` (Vercel) + Supabase project `sdewylbddkcvidwosgxo` (`poolside-prod`).

**`PLAN.md` is a stale April 2026 planning artifact.** It describes tables and a tier model that no longer exist (`gate_bridges`, `bridge_status`, feature-gated pricing). Trust the code and the live schema over that doc.

## Commands

```bash
./scripts/smoke.sh [slug]        # public-surface smoke test, defaults to bishopestates. Run after every deploy.
python scripts/e2e.py            # end-to-end: mints synthetic JWTs, real DB writes against live infra, self-cleaning
node scripts/frontend_smoke.mjs  # headless Chrome render check of EVERY page (public + authed), catches JS errors
```

All three read secrets from `.env.local` (gitignored). There is no `npm test`, no lint, no build step — the frontend is static files served as-is.

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

Capacity-gated, **not** feature-gated: every tier gets every feature; only household headcount differs (`_shared/plan_caps.ts` — free 20, starter 75, pro 200, enterprise ∞). SMS caps are separate (`_shared/sms_cap.ts`).

### Scheduled work

Four `pg_cron` jobs call edge functions: payment plans, applications cleanup, external calendar sync, gate-bridge monitor. Defined in migrations, not in app code.

### Gate integration

Real hardware: an on-prem bridge polls `gate_bridge` and drives a MENGQI-CONTROL HXC-7000 panel; `gate_panels.bridge_last_seen_at` is the liveness signal. `unlock_gate` and `gate_admin` are the API surface.

## Conventions

- Vanilla HTML/CSS/JS. **Every page is self-contained** — inline `<style>` and `<script>`, no bundler, no framework. Shared behavior lives in `js/` and is pulled in with plain `<script src>`.
- Fraunces (display) + Inter (body), loaded from Google Fonts.
- New admin pages should be copied structurally from an existing sibling in `club/admin/` (nav, auth guard, subtabs, styling all follow one pattern).

## Gotchas

- **CRLF churn:** Windows tooling has rewritten tracked files with CRLF line endings, producing enormous diffs that are pure noise. The repo has no `.gitattributes`. Before reviewing a large diff, run `git diff --ignore-all-space --ignore-blank-lines --stat` to see the real change.
- Client-side JS errors are not captured anywhere in production — `frontend_smoke.mjs` is the only thing that catches them, and only pre-deploy.
