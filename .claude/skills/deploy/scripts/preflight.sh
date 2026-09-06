#!/usr/bin/env bash
# =============================================================================
# preflight.sh — classify pending changes into the three Poolside deploy lanes
# =============================================================================
# Poolside ships through three independent paths that must land in order:
#   1. migrations     → Supabase (apply_migration)
#   2. edge functions → Supabase (deploy_edge_function)
#   3. frontend       → git push → Vercel
#
# A plain `git push` only moves lane 3. This script says which lanes are
# actually dirty so nothing gets half-shipped.
#
# The subtle one is _shared/: each edge function bundles its own copy of the
# shared files at deploy time, so touching _shared/foo.ts means every function
# importing it is stale until redeployed — even functions with no diff of their
# own. We resolve those dependents here (static AND dynamic imports).
#
# Usage: ./preflight.sh [--staged]
#   default   compare working tree against HEAD (includes untracked)
#   --staged  only what is staged
# =============================================================================

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

DIFF_ARGS="--ignore-all-space --ignore-blank-lines"
if [[ "${1:-}" == "--staged" ]]; then
  changed="$(git diff --cached --name-only $DIFF_ARGS)"
else
  changed="$(git diff --name-only $DIFF_ARGS; git ls-files --others --exclude-standard)"
fi
changed="$(printf '%s\n' "$changed" | sed '/^$/d' | sort -u)"

if [[ -z "$changed" ]]; then
  echo "Nothing to deploy — working tree matches HEAD."
  exit 0
fi

bold=$'\033[1m'; dim=$'\033[2m'; ylw=$'\033[33m'; rst=$'\033[0m'

# ---- lane 1: migrations ----------------------------------------------------
migrations="$(printf '%s\n' "$changed" | grep '^supabase/migrations/.*\.sql$' || true)"

# ---- lane 2: edge functions ------------------------------------------------
# Directly-touched functions.
direct_fns="$(printf '%s\n' "$changed" \
  | sed -n 's|^supabase/functions/\([^_/][^/]*\)/.*|\1|p' | sort -u)"

# Shared modules touched → every function importing them is stale.
shared_files="$(printf '%s\n' "$changed" | grep '^supabase/functions/_shared/' || true)"
dependent_fns=""
for sf in $shared_files; do
  base="$(basename "$sf")"
  # Matches both `from '../_shared/x.ts'` and `await import('../_shared/x.ts')`.
  hits="$(grep -rl "_shared/${base}" supabase/functions/*/index.ts 2>/dev/null \
          | xargs -n1 dirname 2>/dev/null | xargs -n1 basename 2>/dev/null || true)"
  dependent_fns="$dependent_fns $hits"
done
dependent_fns="$(printf '%s\n' $dependent_fns | sed '/^$/d' | sort -u)"
all_fns="$(printf '%s\n%s\n' "$direct_fns" "$dependent_fns" | sed '/^$/d' | sort -u)"

# ---- lane 3: frontend ------------------------------------------------------
frontend="$(printf '%s\n' "$changed" | grep -v '^supabase/' || true)"

# ---- report ----------------------------------------------------------------
echo "${bold}Deploy lanes${rst}"
echo

echo "${bold}1. Migrations${rst} → Supabase apply_migration"
if [[ -n "$migrations" ]]; then
  printf '   %s\n' $migrations
else
  echo "   ${dim}(none)${rst}"
fi
echo

echo "${bold}2. Edge functions${rst} → Supabase deploy_edge_function"
if [[ -n "$all_fns" ]]; then
  for fn in $all_fns; do
    if printf '%s\n' "$direct_fns" | grep -qx "$fn"; then
      echo "   $fn"
    else
      echo "   $fn   ${ylw}← no diff of its own; stale via _shared${rst}"
    fi
  done
  if [[ -n "$shared_files" ]]; then
    echo
    echo "   ${dim}shared modules touched:${rst}"
    for sf in $shared_files; do echo "   ${dim}  ${sf}${rst}"; done
  fi
else
  echo "   ${dim}(none)${rst}"
fi
echo

echo "${bold}3. Frontend${rst} → git push (Vercel auto-deploys)"
if [[ -n "$frontend" ]]; then
  printf '   %s\n' $frontend
else
  echo "   ${dim}(none)${rst}"
fi
echo

# Ordering matters when more than one lane is dirty: the DB must accept the new
# shape before functions write it, and functions must answer before pages call.
lanes=0
[[ -n "$migrations" ]] && lanes=$((lanes+1))
[[ -n "$all_fns"    ]] && lanes=$((lanes+1))
[[ -n "$frontend"   ]] && lanes=$((lanes+1))
if (( lanes > 1 )); then
  echo "${ylw}${lanes} lanes dirty — deploy in the order above, verifying each${rst}"
fi
