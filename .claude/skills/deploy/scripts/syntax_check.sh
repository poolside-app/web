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

if [ $# -gt 0 ]; then
  targets=("$@")
else
  targets=($(
    { git diff --name-only --ignore-all-space; git ls-files --others --exclude-standard; } \
      | sed -n 's|^supabase/functions/\([^_/][^/]*\)/.*|\1|p' | sort -u
  ))
fi
[ ${#targets[@]} -eq 0 ] && { echo "No edge functions changed."; exit 0; }

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fail=0
for slug in "${targets[@]}"; do
  src="supabase/functions/$slug/index.ts"
  [ -f "$src" ] || continue
  cp "$src" "$tmp/$slug.mts"
  out=$(node --experimental-strip-types -e "
    import('file://$tmp/$slug.mts')
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
