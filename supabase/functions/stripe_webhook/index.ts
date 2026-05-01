// =============================================================================
// stripe_webhook — verifies signed events from Stripe and flips paid status
// =============================================================================
// One platform-level webhook endpoint for ALL connected accounts. Stripe
// sends `checkout.session.completed` here when a customer pays; we route
// based on the session's metadata.kind to the right table.
//
// Configure in Stripe Dashboard:
//   POST https://<your-supabase>/functions/v1/stripe_webhook
//   Events: checkout.session.completed, account.updated
// Add the signing secret as STRIPE_WEBHOOK_SECRET.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Stripe signs payloads with HMAC-SHA256 using the webhook secret.
// Header format: t=<unix-ts>,v1=<signature>
async function verifyStripeSignature(rawBody: string, sigHeader: string, secret: string, toleranceSec = 300): Promise<boolean> {
  const parts = sigHeader.split(',').reduce<Record<string, string>>((acc, p) => {
    const [k, v] = p.split('=', 2); if (k && v) acc[k] = v; return acc;
  }, {});
  const ts = parseInt(parts.t || '0', 10);
  const v1 = parts.v1;
  if (!ts || !v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${rawBody}`));
  const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  // Constant-time-ish compare
  if (expected.length !== v1.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return mismatch === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return new Response('POST required', { status: 405 });

  const rawBody = await req.text();
  const sig = req.headers.get('stripe-signature') || '';

  // If no secret configured, accept the event but log loudly. Useful for
  // bring-up before the dashboard webhook is fully configured.
  if (WEBHOOK_SECRET) {
    const ok = await verifyStripeSignature(rawBody, sig, WEBHOOK_SECRET);
    if (!ok) return new Response('Invalid signature', { status: 400 });
  }

  let event: Record<string, unknown>;
  try { event = JSON.parse(rawBody); } catch { return new Response('Bad JSON', { status: 400 }); }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const type = String(event.type || '');

  if (type === 'checkout.session.completed') {
    const session = event.data && typeof event.data === 'object'
      ? (event.data as Record<string, unknown>).object as Record<string, unknown>
      : null;
    if (!session) return new Response('No object', { status: 400 });
    const md = (session.metadata as Record<string, string> | undefined) || {};
    const kind = md.kind;
    const tenantId = md.tenant_id;

    if (kind === 'application' && md.application_id) {
      const now = new Date().toISOString();
      await sb.from('applications').update({
        payment_status: 'paid', payment_method: 'stripe',
        paid_at: now, verified_at: now, stripe_session_id: String(session.id || ''),
      }).eq('id', md.application_id).eq('tenant_id', tenantId);

      // Auto-approve: applicant paid via Stripe = they're a member, no manual
      // review needed. Idempotent — applications.approve checks status first
      // and returns 409 if already approved (we ignore that error here).
      const { data: app } = await sb.from('applications')
        .select('id, status, household_id')
        .eq('id', md.application_id).maybeSingle();
      if (app?.status === 'pending') {
        try {
          const r = await fetch(`${SUPABASE_URL}/functions/v1/applications`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-poolside-internal': SERVICE_ROLE,
            },
            body: JSON.stringify({
              action: 'approve',
              id: md.application_id,
              tenant_id: tenantId,
            }),
          });
          // Best-effort: if approval fails (e.g. phone clash), the payment
          // is still recorded and an admin can resolve manually. The admin
          // task left open by the original submit will surface this.
          if (!r.ok) {
            const t = await r.text().catch(() => '');
            console.error('auto-approve failed:', r.status, t.slice(0, 200));
          }
        } catch (e) {
          console.error('auto-approve fetch failed:', (e as Error).message);
        }
      }

      // Re-load household_id (approval just set it) and flip dues paid.
      const { data: appAfter } = await sb.from('applications')
        .select('household_id, paid_until_year').eq('id', md.application_id).maybeSingle();
      if (appAfter?.household_id) {
        await sb.from('households').update({
          dues_paid_for_year: true,
          paid_until_year: appAfter.paid_until_year ?? new Date().getFullYear(),
        }).eq('id', appAfter.household_id);
      }
      // Close any related admin tasks (submitted, venmo claim, etc.)
      await sb.from('admin_tasks')
        .update({ completed_at: now })
        .eq('source_kind', 'application').eq('source_id', md.application_id).is('completed_at', null);

      // Reflect Stripe verification in the Drive sheet (best-effort, write-once).
      const GOOGLE_ID  = Deno.env.get('GOOGLE_CLIENT_ID');
      const GOOGLE_SEC = Deno.env.get('GOOGLE_CLIENT_SECRET');
      if (GOOGLE_ID && GOOGLE_SEC) {
        try {
          const { markVerifiedInDrive } = await import('../_shared/sync_application.ts');
          await markVerifiedInDrive(sb, {
            tenantId: tenantId, applicationId: md.application_id, method: 'stripe',
            googleClientId: GOOGLE_ID, googleClientSecret: GOOGLE_SEC,
          });
        } catch { /* never fails the webhook */ }
      }
    }

    // ── Payment plan: first installment paid via Checkout. Save the customer
    // + payment_method on the plan so the cron can charge installment 2 later.
    if (kind === 'payment_plan_first' && md.plan_id && md.application_id) {
      const sessionId = String(session.id || '');
      const piId = (session.payment_intent as string) || null;
      const customerId = (session.customer as string) || null;
      const now = new Date().toISOString();

      // Pull payment_method off the PaymentIntent (Checkout doesn't return it directly)
      let paymentMethodId: string | null = null;
      if (piId && STRIPE_KEY) {
        try {
          const r = await fetch(`https://api.stripe.com/v1/payment_intents/${piId}`, {
            headers: {
              Authorization: `Bearer ${STRIPE_KEY}`,
              'Stripe-Account': await sb.from('tenants').select('stripe_account_id').eq('id', tenantId).maybeSingle()
                .then(({ data }) => (data?.stripe_account_id as string) || ''),
            },
          });
          if (r.ok) {
            const piData = await r.json();
            paymentMethodId = piData.payment_method || null;
          }
        } catch { /* fallback: leave null, second charge will fail visibly */ }
      }

      // Mark installment 1 paid
      await sb.from('payment_plan_installments').update({
        status: 'paid', paid_at: now,
        stripe_payment_intent_id: piId, stripe_session_id: sessionId,
        last_error: null,
      }).eq('plan_id', md.plan_id).eq('sequence', 1);

      // Save customer + saved payment method on the plan for off-session re-charges
      await sb.from('payment_plans').update({
        stripe_customer_id: customerId,
        stripe_payment_method_id: paymentMethodId,
      }).eq('id', md.plan_id);

      // Mark the application paid (status 'pending' for payment_status until BOTH
      // installments collected — but treat first-installment as 'pending' rather
      // than 'paid' since dues aren't fully settled yet)
      await sb.from('applications').update({
        payment_status: 'pending', payment_method: 'stripe',
        stripe_session_id: sessionId,
      }).eq('id', md.application_id).eq('tenant_id', tenantId);

      // Auto-approve: applicant put a card on file + paid first half = they're a member.
      const { data: app } = await sb.from('applications').select('id, status').eq('id', md.application_id).maybeSingle();
      if (app?.status === 'pending') {
        try {
          await fetch(`${SUPABASE_URL}/functions/v1/applications`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-poolside-internal': SERVICE_ROLE },
            body: JSON.stringify({ action: 'approve', id: md.application_id, tenant_id: tenantId }),
          });
        } catch (e) { console.error('plan auto-approve failed:', (e as Error).message); }
      }

      // Link plan to household now that approval may have created one
      const { data: appAfter } = await sb.from('applications')
        .select('household_id').eq('id', md.application_id).maybeSingle();
      if (appAfter?.household_id) {
        await sb.from('payment_plans').update({ household_id: appAfter.household_id }).eq('id', md.plan_id);
      }
    }

    // ── Payment plan reactivation: lapsed plan paid in full (balance + fee).
    // Restore household dues + keyfob, mark plan + installments cleared.
    if (kind === 'payment_plan_reactivation' && md.plan_id) {
      const now = new Date().toISOString();
      const { data: plan } = await sb.from('payment_plans').select('id, household_id').eq('id', md.plan_id).maybeSingle();
      if (plan) {
        await sb.from('payment_plans').update({
          status: 'completed', completed_at: now, reactivated_at: now,
        }).eq('id', plan.id);
        await sb.from('payment_plan_installments').update({
          status: 'manual', paid_at: now, last_error: null,
        }).eq('plan_id', plan.id).neq('status', 'paid').neq('status', 'manual');
        if (plan.household_id) {
          await sb.from('households').update({
            dues_paid_for_year: true, paid_until_year: new Date().getFullYear(),
          }).eq('id', plan.household_id);
          // Restore keyfob access for adult + teen members
          await sb.from('household_members').update({ can_unlock_gate: true })
            .eq('household_id', plan.household_id).eq('tenant_id', tenantId)
            .in('role', ['primary', 'adult', 'teen']);
        }
        // Close any open lapse-related admin tasks
        await sb.from('admin_tasks').update({ completed_at: now })
          .eq('source_kind', 'payment_plan').eq('source_id', plan.id).is('completed_at', null);
      }
    }

    if (kind === 'program_booking' && md.booking_id) {
      await sb.from('program_bookings').update({ paid: true, updated_at: new Date().toISOString() })
        .eq('id', md.booking_id).eq('tenant_id', tenantId);
    }

    if (kind === 'guest_pass_pack' && md.pack_id) {
      await sb.from('guest_pass_packs').update({ paid: true, updated_at: new Date().toISOString() })
        .eq('id', md.pack_id).eq('tenant_id', tenantId);
    }

    return new Response('ok', { status: 200 });
  }

  if (type === 'account.updated') {
    const acct = event.data && typeof event.data === 'object'
      ? (event.data as Record<string, unknown>).object as Record<string, unknown>
      : null;
    if (acct?.id) {
      await sb.from('tenants').update({
        stripe_charges_enabled: !!acct.charges_enabled,
        stripe_payouts_enabled: !!acct.payouts_enabled,
      }).eq('stripe_account_id', acct.id);
    }
    return new Response('ok', { status: 200 });
  }

  // Unhandled event types just ack so Stripe stops retrying
  return new Response('ignored', { status: 200 });
});
