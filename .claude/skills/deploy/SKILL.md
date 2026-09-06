---
name: deploy
description: Ship Poolside changes to production safely — applies migrations, deploys Edge Functions, pushes the frontend, and verifies each stage. Use this whenever work is ready to go live or the user says deploy, ship, push it, release, "get this live", "put this in prod", or asks to verify that a deploy landed. Also use it before shipping anything that touches supabase/migrations, supabase/functions, or the club/admin pages, because Poolside deploys through three separate paths that must land in a specific order — a plain git push ships only the frontend and leaves live pages calling backend code that does not exist yet.
---

# Deploying Poolside

Poolside looks like one app but ships through **three independent paths**, and only one of them is git:

| Lane | What | How it deploys |
|---|---|---|
| 1 | `supabase/migrations/*.sql` | Supabase `apply_migration` |
| 2 | `supabase/functions/*` | Supabase `deploy_edge_function` |
| 3 | everything else (HTML/JS/CSS/`vercel.json`) | `git push` → Vercel auto-builds |

This is the single most important thing to internalize: **`git push` deploys the frontend and nothing else.** If a change spans lanes and you only push, production ends up with a new page calling an endpoint that isn't there, or a function writing a column that doesn't exist. Both fail in front of real users, and neither shows up in the git history as wrong.

## Order, and why it is this order

Deploy **1 → 2 → 3**, in that direction, because each lane depends on the one before it:

- The **database** must accept the new shape before functions try to write it.
- The **functions** must be answering before pages start calling them.

Each step is backward-compatible with the old frontend while it's in flight, so production stays coherent between steps. Going the other direction — pushing the frontend first — creates a window where live users hit a broken feature, and that window lasts until you finish.

If only one lane is dirty, this is simple; just do that lane and verify. The ordering only matters when several are in play.

## Steps

### 1. Preflight — find out which lanes are dirty

```bash
./.claude/skills/deploy/scripts/preflight.sh
```

Read its output before doing anything else. It classifies pending changes into the three lanes and — importantly — resolves **`_shared/` dependents**.

That last part catches a trap you cannot see in a diff: every Edge Function bundles its own copy of the `_shared/*.ts` files at deploy time. Change `_shared/plan_caps.ts` and four functions are instantly running stale shared code, even though `git status` shows no change to any of them. The script greps for both static (`from '../_shared/x.ts'`) and dynamic (`await import('../_shared/x.ts')`) imports, since Poolside uses both heavily.

Deploy every function the script lists, not just the ones with their own diff.

### 2. Migrations

Apply each new `supabase/migrations/*.sql` with the Supabase `apply_migration` tool (name it after the file, minus the timestamp). Migrations are shared across all tenants — one apply upgrades everyone.

Then confirm it registered:

```
list_migrations → the new version should be the newest entry
```

Prefer additive, backward-compatible SQL (`add column if not exists`, new tables, widened constraints). A destructive migration breaks the currently-live frontend during the window before lane 3 lands, so if one is unavoidable, say so explicitly and get the user's agreement on the ordering before starting.

### 3. Edge Functions

Deploy each function the preflight named, using `deploy_edge_function`. Two things will silently break the function if you get them wrong:

**`verify_jwt` must stay `false`.** Every Poolside function is deployed with `verify_jwt: false` because Poolside does not use Supabase Auth — it verifies its own HMAC-signed JWTs inside the handler via `_shared/auth.ts`. The deploy tool defaults this to `true`. Letting it default rejects every request at the gateway before the handler runs, and the failure looks like a mysterious 401 rather than a deploy mistake. Check the existing value with `get_edge_function` if unsure.

**Include the shared files in the payload.** The `files` array must carry `index.ts` *and* every `_shared/*.ts` the function imports, at the paths the imports expect (`supabase/functions/_shared/auth.ts`, etc.). Omit one and the function deploys fine but throws at runtime on first use.

Verify each with `get_edge_function` (version should have incremented) before moving on.

### 4. Frontend

```bash
git add <the frontend files>
git commit -m "<subject>"
git push origin main
```

Notes specific to this repo:
- The remote is SSH (`git@github.com:poolside-app/web.git`). Push works without prompting.
- Review diffs with `git diff --ignore-all-space --ignore-blank-lines` — this repo has a CRLF history, so whitespace-only churn can otherwise bury a small real change in thousands of phantom lines.
- Commit only the files belonging to this change. Do not sweep unrelated in-flight work into a deploy commit.

### 5. Verify the deploy landed

Vercel builds automatically on push. Poll `list_deployments` until the newest entry for the pushed commit SHA reads `state: READY`, typically well under a minute.

Do not run the smoke tests before that flips to READY — you'd be testing the previous build and getting a green result that means nothing.

If it reads `ERROR`, fetch `get_deployment_build_logs` and report the actual failure rather than retrying blindly.

### 6. Smoke test production

```bash
./scripts/smoke.sh              # public surfaces; defaults to slug 'bishopestates'
```

Exits 0 when everything is green, 1 on any failure, and names each failing check.

Two heavier suites exist for changes that warrant them — both read `.env.local` and run against **live** infrastructure with real DB writes (they clean up after themselves):

```bash
python scripts/e2e.py           # mints synthetic admin/member/provider JWTs, exercises major paths
node scripts/frontend_smoke.mjs # headless Chrome across every page; catches client-side JS errors
```

Run `e2e.py` when the change touched Edge Functions or the schema. Run `frontend_smoke.mjs` when it touched pages — it's the only thing in the stack that catches client-side JS errors, since production has no error tracking.

### 7. Report

State plainly what shipped in each lane, the deployment id and its state, and the smoke result as counts (`70/70 green`). If anything failed, say so with the output rather than describing it as done.

## When it goes wrong

Fix forward rather than rolling back, unless production is actively broken for users. The lanes roll back independently and unevenly — Vercel can revert to a previous deployment instantly, but a migration cannot, so a "rollback" usually leaves the DB ahead of the code anyway.

If production is broken and you need it working *now*: revert the frontend via Vercel's previous deployment (the earlier build is still there and `isRollbackCandidate` marks eligible ones), then fix the backend lanes properly.

Never re-run a partial deploy from the top without checking what already landed — migrations are recorded and functions are versioned, so re-applying blindly either errors or silently redeploys stale code over good code. `list_migrations` and `get_edge_function` tell you the real state.
