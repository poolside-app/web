#!/usr/bin/env bash
# =============================================================================
# setup-stripe-platform.sh — one-time platform Stripe wiring
# =============================================================================
# Sets STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET on the Supabase project so
# every tenant's "Connect Stripe" button works.
#
# Run from the repo root:
#   bash scripts/setup-stripe-platform.sh
#
# Reads SUPABASE_ACCESS_TOKEN from .env.local automatically.
# =============================================================================

set -euo pipefail

PROJECT_REF="sdewylbddkcvidwosgxo"
WEBHOOK_URL="https://${PROJECT_REF}.supabase.co/functions/v1/stripe_webhook"
SUPABASE="tools/supabase.exe"

if [ ! -f "$SUPABASE" ]; then
  echo "✗ $SUPABASE not found. Run from the poolside-app/web repo root."
  exit 1
fi

if [ ! -f .env.local ]; then
  echo "✗ .env.local not found in current directory."
  exit 1
fi

export SUPABASE_ACCESS_TOKEN
SUPABASE_ACCESS_TOKEN=$(grep '^SUPABASE_ACCESS_TOKEN=' .env.local | cut -d= -f2- || true)
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "✗ SUPABASE_ACCESS_TOKEN missing from .env.local"
  exit 1
fi

echo ""
echo "================================================================="
echo "  Poolside — Platform Stripe setup"
echo "================================================================="
echo ""
echo "Step 1 of 2 — Stripe Secret Key"
echo "  Where to find it:"
echo "    Stripe Dashboard → Developers → API keys → Secret key"
echo "    https://dashboard.stripe.com/apikeys"
echo "  This goes server-side only. NEVER paste the publishable key."
echo "  Format: starts with 'sk_live_' (production) or 'sk_test_' (test)"
echo ""
read -r -p "Paste STRIPE_SECRET_KEY: " STRIPE_KEY
if [ -z "$STRIPE_KEY" ]; then
  echo "✗ Empty input — aborting."
  exit 1
fi
case "$STRIPE_KEY" in
  sk_live_*|sk_test_*) ;;
  *)
    echo "✗ That doesn't look like a Stripe secret key (expected sk_live_* or sk_test_*)."
    exit 1
    ;;
esac

"$SUPABASE" secrets set "STRIPE_SECRET_KEY=$STRIPE_KEY" --project-ref "$PROJECT_REF" >/dev/null
echo "✓ STRIPE_SECRET_KEY set on project $PROJECT_REF"

echo ""
echo "================================================================="
echo "Step 2 of 2 — Webhook signing secret"
echo "================================================================="
echo ""
echo "  Create a webhook in Stripe (one-time):"
echo "    1. Go to Stripe Dashboard → Developers → Webhooks → Add endpoint"
echo "       https://dashboard.stripe.com/webhooks/create"
echo "    2. Endpoint URL:"
echo "       $WEBHOOK_URL"
echo "    3. Events to send (minimum):"
echo "         checkout.session.completed"
echo "         account.updated"
echo "    4. Click 'Add endpoint', then on the endpoint detail page click"
echo "       'Reveal' under 'Signing secret'."
echo "  Format: starts with 'whsec_'"
echo ""
read -r -p "Paste STRIPE_WEBHOOK_SECRET: " WHSEC
if [ -z "$WHSEC" ]; then
  echo "✗ Empty input — aborting (key was saved, you can re-run for webhook only)."
  exit 1
fi
case "$WHSEC" in
  whsec_*) ;;
  *)
    echo "✗ That doesn't look like a webhook secret (expected whsec_*)."
    exit 1
    ;;
esac

"$SUPABASE" secrets set "STRIPE_WEBHOOK_SECRET=$WHSEC" --project-ref "$PROJECT_REF" >/dev/null
echo "✓ STRIPE_WEBHOOK_SECRET set on project $PROJECT_REF"

echo ""
echo "================================================================="
echo "  Done."
echo "================================================================="
echo ""
echo "  All clubs will now see a working 'Connect Stripe' button on"
echo "  Members → Payments. Each club onboards their own Stripe account"
echo "  (KYC + bank info) once for their own bank deposits."
echo ""
echo "  Verify at:"
echo "    https://poolsideapp.com/admin/  (your provider dashboard)"
echo ""
