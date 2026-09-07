#!/usr/bin/env bash
# =============================================================================
# syntax_check.sh — catch boot-time SyntaxErrors before they reach production
# =============================================================================
# Twice now a deploy returned 201 while the function could not start, both times
# because an edit introduced a second declaration of a name that already existed
# ('sha256Hex', then 'today'). Supabase compiles on boot, so the deploy API
# cannot tell you: the function is simply down until something calls it.
#
# Node parses the same syntax Deno does. `node --check` is NOT usable here — it
# ignores --experimental-strip-types and trips over the first type annotation —
# so we actually import the module. Parsing happens before execution, so a
# duplicate declaration surfaces as a SyntaxError; the ReferenceError for
# `Deno` that follows means the file parsed fine and is ignored.
#
# A syntax gate, not a type-checker: it will not catch a wrong column name, but
# it catches every "has already been declared".
#
# Usage: ./syntax_check.sh [slug ...]   (default: every changed function)
# =============================================================================
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
export PATH="/opt/homebrew/bin:$PATH"

command -v node >/dev/null || { echo "node not on PATH — skipping syntax check"; exit 0; }

# Changed files are collected as PATHS, not slugs, so _shared/ modules can be
# checked too. A SyntaxError in _shared takes down every function importing
# it at once, and those files are frequently reached by a dynamic import
# inside a branch — which means importing the function's index.ts does NOT
# parse them. They have to be checked on their own.
if [ $# -gt 0 ]; then
  targets=()
  for a in "$@"; do
    if [ -f "$a" ]; then targets+=("$a")
    elif [ -f "supabase/functions/$a/index.ts" ]; then targets+=("supabase/functions/$a/index.ts")
    fi
  done
else
  targets=($(
    { git diff --name-only --ignore-all-space; git ls-files --others --exclude-standard; } \
      | sed -n -e 's|^\(supabase/functions/[^_/][^/]*/index\.ts\)$|\1|p' \
               -e 's|^\(supabase/functions/_shared/.*\.ts\)$|\1|p' \
      | sort -u
  ))
  # A changed function directory that did not itself touch index.ts still
  # needs its entrypoint parsed.
  for d in $(
    { git diff --name-only --ignore-all-space; git ls-files --others --exclude-standard; } \
      | sed -n 's|^supabase/functions/\([^_/][^/]*\)/.*|\1|p' | sort -u
  ); do
    f="supabase/functions/$d/index.ts"
    [ -f "$f" ] && case " ${targets[*]:-} " in *" $f "*) ;; *) targets+=("$f");; esac
  done
fi
[ ${#targets[@]} -eq 0 ] && { echo "No edge functions changed."; exit 0; }

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fail=0
for src in "${targets[@]}"; do
  [ -f "$src" ] || continue
  # Label: 'gate_admin' for a function, '_shared/send_sms.ts' for a module.
  case "$src" in
    supabase/functions/_shared/*) slug="_shared/$(basename "$src")" ;;
    *) slug=$(basename "$(dirname "$src")") ;;
  esac
  safe=$(echo "$slug" | tr '/.' '__')
  cp "$src" "$tmp/$safe.mts"
  out=$(node --experimental-strip-types -e "
    import('file://$tmp/$safe.mts')
      .then(() => process.exit(0))
      .catch(e => {
        // Anything that is not a parse failure means the file parsed — the
        // module just cannot RUN outside Deno, which is expected here.
        if (e instanceof SyntaxError) { console.error(e.message); process.exit(1); }
        process.exit(0);
      });
  " 2>&1)
  rc=$?
  if [ $rc -eq 0 ]; then
    printf "  \033[32m✓\033[0m %s\n" "$slug"
  else
    printf "  \033[31m✗\033[0m %s — %s\n" "$slug" "$(echo "$out" | grep -v 'Warning' | head -1)"
    fail=1
  fi
done
exit $fail
