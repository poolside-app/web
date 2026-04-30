#!/usr/bin/env bash
# =============================================================================
# Poolside smoke tests — run after every deploy.
# =============================================================================
# Hits the public surfaces (no auth required) and verifies enough of each
# response shape that we'd catch broad breakage: bad migrations, broken
# Edge Functions, busted DNS, expired SSL, stomped vercel.json rewrites.
#
# Usage: ./scripts/smoke.sh [slug]
#   slug defaults to 'bishopestates'.
#
# Exit codes:
#   0 — all green
#   1 — at least one check failed
# =============================================================================

set -uo pipefail

SLUG="${1:-bishopestates}"
SUPA="https://sdewylbddkcvidwosgxo.supabase.co"
HOST="https://${SLUG}.poolsideapp.com"
ROOT="https://poolsideapp.com"

ok=0; fail=0
red=$'\033[31m'; grn=$'\033[32m'; rst=$'\033[0m'

pass() { printf "  ${grn}✓${rst} %s\n" "$1"; ok=$((ok+1)); }
flop() { printf "  ${red}✗${rst} %s — %s\n" "$1" "$2"; fail=$((fail+1)); }

check() {
  local name="$1" url="$2" expect="$3"
  local body
  # -L so apex→www redirects don't return "Redirecting…" stubs
  body="$(curl -sSL --max-time 15 "$url" 2>&1)" || { flop "$name" "curl failed"; return; }
  if [[ "$body" == *"$expect"* ]]; then pass "$name"
  else flop "$name" "expected '${expect}' in response"; fi
}

check_post() {
  local name="$1" url="$2" payload="$3" expect="$4"
  local body
  body="$(curl -sS --max-time 15 -X POST "$url" -H "content-type: application/json" -d "$payload" 2>&1)" \
    || { flop "$name" "curl failed"; return; }
  if [[ "$body" == *"$expect"* ]]; then pass "$name"
  else flop "$name" "expected '${expect}' in: ${body:0:200}"; fi
}

check_status() {
  local name="$1" url="$2" expect="$3"
  local code
  # -L follows redirects (apex→www, vercel.json rewrites etc.) — the
  # final landing page is what we actually care about.
  code="$(curl -sSL --max-time 15 -o /dev/null -w '%{http_code}' "$url" 2>&1)" \
    || { flop "$name" "curl failed"; return; }
  if [[ "$code" == "$expect" ]]; then pass "$name (${code})"
  else flop "$name" "expected ${expect}, got ${code}"; fi
}

echo "Smoke test against slug: ${SLUG}"
echo

echo "── Public surfaces ──"
check_status "marketing root"       "${ROOT}/"                     "200"
check_status "marketing /home.html" "${ROOT}/home.html"            "200"
check_status "tenant landing"       "${HOST}/"                     "200"
check_status "tenant /m/login"      "${HOST}/m/login.html"         "200"
check_status "tenant /m/"           "${HOST}/m/"                   "200"
check_status "tenant /club/admin/"  "${HOST}/club/admin/login.html" "200"
check_status "shared calendar.js"   "${HOST}/js/calendar.js"        "200"
check_status "shared calendar.css"  "${HOST}/js/calendar.css"       "200"
check       "calendar.js exposes widget" "${HOST}/js/calendar.js" "PoolsideCalendar"
check_status "provider /admin/cockpit.html" "${ROOT}/admin/cockpit.html" "200"
check       "cockpit page wires the runner" "${ROOT}/admin/cockpit.html" "Run end-to-end"
check_status "admin events page (after refactor)" "${HOST}/club/admin/events.html" "200"
check       "admin events imports calendar.js" "${HOST}/club/admin/events.html" "/js/calendar.js"

echo
echo "── Edge Functions (public) ──"
check_post "tenant_public OK" \
  "${SUPA}/functions/v1/tenant_public" \
  "{\"slug\":\"${SLUG}\"}" \
  '"ok":true'

check_post "tenant_public has settings shape" \
  "${SUPA}/functions/v1/tenant_public" \
  "{\"slug\":\"${SLUG}\"}" \
  '"public_settings"'

check_post "tenant_public has events shape" \
  "${SUPA}/functions/v1/tenant_public" \
  "{\"slug\":\"${SLUG}\"}" \
  '"events"'

check_post "tenant_public has posts shape" \
  "${SUPA}/functions/v1/tenant_public" \
  "{\"slug\":\"${SLUG}\"}" \
  '"posts"'

check_post "tenant_public has photos shape" \
  "${SUPA}/functions/v1/tenant_public" \
  "{\"slug\":\"${SLUG}\"}" \
  '"photos"'

check_post "tenant_public has programs shape" \
  "${SUPA}/functions/v1/tenant_public" \
  "{\"slug\":\"${SLUG}\"}" \
  '"programs"'

check_post "tenant_public 404 unknown slug" \
  "${SUPA}/functions/v1/tenant_public" \
  '{"slug":"thisclubdoesnotexist__"}' \
  '"ok":false'

check "ical feed VCALENDAR header" \
  "${SUPA}/functions/v1/tenant_calendar_ics?slug=${SLUG}" \
  "BEGIN:VCALENDAR"

echo
echo "── Edge Functions (auth required — should reject anon) ──"
check_post "households_admin rejects anon" \
  "${SUPA}/functions/v1/households_admin" \
  '{"action":"list"}' \
  'Not authenticated'

check_post "events_admin rejects anon" \
  "${SUPA}/functions/v1/events_admin" \
  '{"action":"list"}' \
  'Not authenticated'

check_post "posts_admin rejects anon" \
  "${SUPA}/functions/v1/posts_admin" \
  '{"action":"list"}' \
  'Not authenticated'

check_post "photos_admin rejects anon" \
  "${SUPA}/functions/v1/photos_admin" \
  '{"action":"list"}' \
  'Not authenticated'

check_post "parties_admin rejects anon" \
  "${SUPA}/functions/v1/parties_admin" \
  '{"action":"list"}' \
  'Not authenticated'

check_post "tenant_settings rejects anon" \
  "${SUPA}/functions/v1/tenant_settings" \
  '{"action":"get"}' \
  'Not authenticated'

check_post "member_auth me rejects anon" \
  "${SUPA}/functions/v1/member_auth" \
  '{"action":"me"}' \
  'Not authenticated'

check_post "tenant_metrics rejects anon" \
  "${SUPA}/functions/v1/tenant_metrics" \
  '{"action":"get"}' \
  'Not authenticated'

check_post "provider_metrics rejects anon" \
  "${SUPA}/functions/v1/provider_metrics" \
  '{}' \
  'Not authenticated'

check_post "audit_admin rejects anon" \
  "${SUPA}/functions/v1/audit_admin" \
  '{"action":"list"}' \
  'Not authenticated'

check_status "audit page exists"           "${HOST}/club/admin/audit.html" "200"
check       "audit page wires the API"     "${HOST}/club/admin/audit.html" "audit_admin"
check_status "shared admin-flags.js"       "${HOST}/js/admin-flags.js"     "200"
check       "admin-flags.js exports apply" "${HOST}/js/admin-flags.js"     "PoolsideFlags"

check_status "provider /admin/analytics.html" "${ROOT}/admin/analytics.html" "200"
check       "analytics page wires API"        "${ROOT}/admin/analytics.html" "provider_metrics"

check_post "documents_admin rejects anon" \
  "${SUPA}/functions/v1/documents_admin" \
  '{"action":"list"}' \
  'Not authenticated'

check_post "applications.list rejects anon" \
  "${SUPA}/functions/v1/applications" \
  '{"action":"list"}' \
  'Not authenticated'

check_post "programs.list rejects anon" \
  "${SUPA}/functions/v1/programs" \
  '{"action":"list"}' \
  'Not authenticated'

check_post "programs.list_public returns ok" \
  "${SUPA}/functions/v1/programs" \
  "{\"action\":\"list_public\",\"slug\":\"${SLUG}\"}" \
  '"ok":true'

check_status "admin /club/admin/programs" "${HOST}/club/admin/programs.html" "200"
check       "admin programs page wires the API" "${HOST}/club/admin/programs.html" "/functions/v1/programs"

check_post "campaigns.list rejects anon" \
  "${SUPA}/functions/v1/campaigns" \
  '{"action":"list"}' \
  'Not authenticated'

check_post "campaigns.list_active returns ok" \
  "${SUPA}/functions/v1/campaigns" \
  "{\"action\":\"list_active\",\"slug\":\"${SLUG}\"}" \
  '"ok":true'

check_status "admin /club/admin/campaigns" "${HOST}/club/admin/campaigns.html" "200"
check       "admin campaigns page wires the API" "${HOST}/club/admin/campaigns.html" "/functions/v1/campaigns"

check_status "public /apply.html"                "${HOST}/apply.html"                "200"
check_status "admin /club/admin/applications"    "${HOST}/club/admin/applications.html" "200"
check       "apply.html wires the API"            "${HOST}/apply.html"                "applications"
check       "admin apps page wires the API"       "${HOST}/club/admin/applications.html" "applications"

check_status "admin /club/admin/impact.html"     "${HOST}/club/admin/impact.html"     "200"
check       "impact page wires the API"           "${HOST}/club/admin/impact.html"     "tenant_metrics"
check_status "admin /club/admin/documents.html"  "${HOST}/club/admin/documents.html"  "200"
check       "docs page wires the API"             "${HOST}/club/admin/documents.html"  "documents_admin"
check_status "provider /admin/profile.html"       "${ROOT}/admin/profile.html"          "200"
check       "profile page wires admin_auth"       "${ROOT}/admin/profile.html"          "change_password"
check_post "tenant_public exposes documents shape" \
  "${SUPA}/functions/v1/tenant_public" \
  '{"slug":"bishopestates"}' \
  '"documents"'

echo
echo "── Member magic-link round trip (no auth, but real DB write) ──"
check_post "member_auth.start (generic ok response)" \
  "${SUPA}/functions/v1/member_auth" \
  "{\"action\":\"start\",\"slug\":\"${SLUG}\",\"email\":\"nonexistent_smoketest@example.com\"}" \
  '"ok":true'

echo
total=$((ok + fail))
if [[ $fail -eq 0 ]]; then
  printf "%s%d/%d green%s\n" "$grn" "$ok" "$total" "$rst"
  exit 0
else
  printf "%s%d/%d failed%s\n" "$red" "$fail" "$total" "$rst"
  exit 1
fi
