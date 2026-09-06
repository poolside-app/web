// =============================================================================
// applications — Public submission + admin review of membership applications
// =============================================================================
// Public actions (no auth):
//   { action: 'submit', slug, family_name, primary_name,
//     primary_email?, primary_phone?, address?, city?, zip?,
//     num_adults?, num_kids?, body? }
//     → { ok, application_id }
//
// Admin actions (tenant admin token):
//   { action: 'list', status?: 'pending'|'approved'|'rejected'|'all' }
//     → { ok, applications: [...] }
//
//   { action: 'approve', id, admin_notes?, override?: { tier?, fob_number?, paid_until_year? } }
//     → { ok, household_id }
//        // creates household + primary household_member, links them on
//        // applications.household_id, sets status='approved'.
//
//   { action: 'reject', id, admin_notes? }
//     → { ok }
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { requireScope, requireOwner } from '../_shared/auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}

type Payload = { sub: string; kind: string; tid: string; synthetic?: boolean };
async function verifyTenantAdmin(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const payload = await verify(token, key) as Record<string, unknown>;
    if (payload.kind !== 'tenant_admin' || !payload.sub || !payload.tid) return null;
    return payload as unknown as Payload;
  } catch { return null; }
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function audit(
  sb: ReturnType<typeof createClient>,
  tenant_id: string, actor_id: string | null, actor_kind: string,
  kind: string, entity_id: string | null, summary: string,
) {
  try {
    await sb.from('audit_log').insert({
      tenant_id, kind, entity_type: 'application', entity_id,
      summary, actor_id, actor_kind, actor_label: null,
    });
  } catch { /* never break the operation */ }
}
function intOrDefault(v: unknown, d: number): number {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : d;
}

function normalizePhoneE164(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return /^\+\d{8,15}$/.test(digits) ? digits : null;
  if (/^\d{10}$/.test(digits)) return '+1' + digits;
  if (/^1\d{10}$/.test(digits)) return '+' + digits;
  return null;
}

const FIELDS = 'id, tenant_id, family_name, membership_year, is_renewal, primary_name, primary_email, primary_phone, address, city, zip, num_adults, num_kids, body, status, admin_notes, decided_at, decided_by, household_id, payment_method, payment_status, paid_at, verified_at, verified_by, reminder_count, last_reminder_at, stripe_session_id, is_new_member, need_new_fob, prior_fob_number, alt_email, adults_json, children_json, waivers_accepted, accepted_at, signature_primary, signature_guardian, tier_slug, no_app_member, claim_source, invited_at, claimed_at, created_at, updated_at';

// stripe_plan is the pay-in-2 option offered on the apply form; it must be
// accepted here or the plan radio submits a "400 Invalid payment method".
const VALID_PAYMENT_METHODS = new Set(['stripe', 'stripe_plan', 'venmo']);

// Claim tokens (CSV-import → claimable application flow) reuse randomToken /
// sha256Hex declared above — same generate-then-store-the-hash pattern the
// magic-link paths already use.

// Bind an admin row to the household_member they just got approved as.
// Match on email OR phone (E.164) — phone is a stronger signal because
// the admin-prefill flow copies it byte-for-byte from admin_users.
// Idempotent: skips if linked_member_id is already set.
async function autoLinkAdminToMember(
  sb: ReturnType<typeof createClient>,
  tenantId: string,
  identity: { email?: string | null; phone?: string | null },
  memberId: string,
): Promise<void> {
  if (!identity.email && !identity.phone) return;
  try {
    const orParts: string[] = [];
    if (identity.email) orParts.push(`email.ilike.${identity.email}`);
    if (identity.phone) orParts.push(`phone_e164.eq.${identity.phone}`);
    const { data: matchedAdmin } = await sb.from('admin_users')
      .select('id, linked_member_id')
      .eq('tenant_id', tenantId).eq('active', true)
      .or(orParts.join(','))
      .limit(1).maybeSingle();
    if (matchedAdmin && !matchedAdmin.linked_member_id) {
      await sb.from('admin_users')
        .update({ linked_member_id: memberId })
        .eq('id', matchedAdmin.id);
      await sb.from('audit_log').insert({
        tenant_id: tenantId, kind: 'admin.linked_to_member',
        entity_type: 'admin_user', entity_id: matchedAdmin.id,
        summary: 'Admin auto-linked to household member',
        actor_kind: 'system',
      });
    }
  } catch { /* never fail the calling action over this */ }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── cron_cleanup_abandoned ───────────────────────────────────────────
  // Scheduled by pg_cron every 30 min via Vault-stored CRON_SECRET. Hard-
  // deletes Stripe-path applications that submitted but never paid within
  // the abandonment window (60 min default). The applicant chose Stripe
  // so the form was never the legal record — payment is. No payment, no
  // legal record needed; the row is just clutter the admin shouldn't see
  // in their pipeline.
  //
  // Venmo + decide-later flows are deliberately excluded — those expect
  // a human follow-up step over days/weeks, not minutes.
  if (action === 'cron_cleanup_abandoned') {
    const cronSecret = Deno.env.get('CRON_SECRET');
    const got = req.headers.get('x-cron-secret');
    if (!cronSecret || got !== cronSecret) {
      return jsonResponse({ ok: false, error: 'Forbidden' }, 403);
    }
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: abandoned } = await sb.from('applications')
      .select('id, tenant_id, family_name, primary_email, payment_method, created_at')
      .in('payment_method', ['stripe', 'stripe_plan'])
      .eq('payment_status', 'unpaid')
      .eq('status', 'pending')
      .lt('created_at', cutoff)
      // Never auto-delete a CSV-imported member's claimed application. Those
      // represent existing members the club is chasing for payment over
      // days/weeks — not 60-minute Stripe-checkout ghosts. (.neq alone would
      // drop normal NULL-source rows, so allow null OR not-import.)
      .or('claim_source.is.null,claim_source.neq.csv_import')
      .limit(500);

    let deleted = 0;
    for (const a of (abandoned ?? [])) {
      try {
        await sb.from('audit_log').insert({
          tenant_id: a.tenant_id,
          kind: 'application.auto_abandoned',
          entity_type: 'application', entity_id: a.id,
          summary: `Abandoned at Stripe checkout — auto-deleted (${a.family_name || 'unknown'} · submitted ${a.created_at})`,
          actor_kind: 'system',
          metadata: {
            payment_method: a.payment_method,
            primary_email: a.primary_email,
          },
        });
        // Drop the open admin task (queue would otherwise show a ghost row).
        await sb.from('admin_tasks').delete()
          .eq('tenant_id', a.tenant_id)
          .eq('source_kind', 'application')
          .eq('source_id', a.id)
          .eq('kind', 'application.submitted');
        // Drop any application_actions rows referencing this application.
        await sb.from('application_actions').delete().eq('application_id', a.id);
        // Hard-delete the application row.
        const { error: delErr } = await sb.from('applications')
          .delete().eq('id', a.id);
        if (delErr) {
          console.error('cleanup delete failed for', a.id, delErr.message);
          continue;
        }
        deleted++;
      } catch (e) {
        console.error('cleanup error for', a.id, (e as Error).message);
      }
    }
    return jsonResponse({ ok: true, deleted, scanned: (abandoned ?? []).length });
  }

  // ── submit (no auth — anyone with the form can apply) ─────────────────
  if (action === 'submit') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    if (!slug) return jsonResponse({ ok: false, error: 'slug required' }, 400);
    const { data: tenant } = await sb.from('tenants')
      .select('id, status, plan').eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    if (tenant.status === 'churned' || tenant.status === 'suspended') {
      return jsonResponse({ ok: false, error: 'This club isn\'t accepting applications right now' }, 403);
    }

    // Claim flow: a CSV-imported member is completing their pre-filled
    // application via apply.html?claim=<token>. Resolve the existing row so
    // we UPDATE it (below) instead of inserting a new one. Claims skip the
    // capacity gate + duplicate guard — they're existing members being
    // migrated, and the household cap is still enforced at approve time.
    let claimAppId: string | null = null;
    const claimToken = String(body.claim_token ?? '').trim();
    if (claimToken) {
      const hash = await sha256Hex(claimToken);
      const { data: claimApp } = await sb.from('applications')
        .select('id, status').eq('tenant_id', tenant.id).eq('claim_token_hash', hash).maybeSingle();
      if (!claimApp) return jsonResponse({ ok: false, error: 'This invite link is invalid or has expired.' }, 404);
      if (!['prefilled', 'pending'].includes(String(claimApp.status))) {
        return jsonResponse({ ok: false, error: 'This application has already been processed.' }, 409);
      }
      claimAppId = claimApp.id as string;
    }

    // Capacity gate at SUBMIT time, not just approve. Avoids the bad UX where
    // a family fills out the form, gets a "we received it!" confirmation,
    // and then never hears back because the admin can't approve them.
    if (!claimAppId) {
      const { getHouseholdCapStatus } = await import('../_shared/plan_caps.ts');
      const cap = await getHouseholdCapStatus(sb, tenant.id, tenant.plan);
      if (cap.at_cap) {
        return jsonResponse({
          ok: false,
          error: `This club is at capacity right now (${cap.count} of ${cap.cap === Infinity ? '∞' : cap.cap} household${cap.cap === 1 ? '' : 's'}). Please contact the club directly to be added to a waitlist.`,
          at_capacity: true,
        }, 409);
      }
    }

    const family_name = String(body.family_name ?? '').trim();
    const primary_name = String(body.primary_name ?? '').trim();
    if (!family_name)  return jsonResponse({ ok: false, error: 'Family name is required' }, 400);
    if (!primary_name) return jsonResponse({ ok: false, error: 'Primary contact name is required' }, 400);

    const email = String(body.primary_email ?? '').trim().toLowerCase() || null;
    if (email && (!email.includes('@') || email.length > 200)) {
      return jsonResponse({ ok: false, error: 'Invalid email' }, 400);
    }
    const rawPhone = String(body.primary_phone ?? '').trim();
    const phone = rawPhone ? normalizePhoneE164(rawPhone) : null;
    if (rawPhone && !phone) return jsonResponse({ ok: false, error: 'Invalid phone number' }, 400);
    if (!email && !phone)   return jsonResponse({ ok: false, error: 'Provide an email or a phone (or both)' }, 400);

    // Duplicate-signup guard: if this email or phone is already on file as
    // an ACTIVE member of this tenant, OR has a pending application from a
    // few days ago, don't create a new application. Common case: someone
    // hits Submit twice, or a returning member forgets they're a member.
    // Both checks scoped to active rows so a household that was deactivated
    // for non-payment can re-apply. Skipped for claims — the imported row IS
    // the match, and the member's own contact info legitimately "already
    // exists" as their prefilled application.
    if (!claimAppId && (email || phone)) {
      // Tracked separately so the UX can offer a recovery path keyed to
      // the actual match (e.g. "use phone-magic-link if your phone is on
      // file, even if the email doesn't match"). Doug 2026-05-23 got stuck
      // in a Google-sign-in → apply → "already a member" → loop because
      // his gmail wasn't on any row but the phone was — message was generic
      // "sign in" with no indication of which one to use.
      let emailMatch: { id: string } | null = null;
      let phoneMatch: { id: string } | null = null;
      if (email) {
        const { data } = await sb.from('household_members').select('id')
          .eq('tenant_id', tenant.id).eq('active', true)
          .ilike('email', email).limit(1).maybeSingle();
        emailMatch = data;
      }
      if (phone) {
        const { data } = await sb.from('household_members').select('id')
          .eq('tenant_id', tenant.id).eq('active', true)
          .eq('phone_e164', phone).limit(1).maybeSingle();
        phoneMatch = data;
      }
      if (emailMatch || phoneMatch) {
        // matched_via tells the UI which sign-in option to lead with.
        // "both"  → either works
        // "email" → magic-link to email
        // "phone" → magic-link to phone (most common case for the loop —
        //           user changed emails since they signed up, but kept
        //           their phone number)
        const matched_via = emailMatch && phoneMatch ? 'both' : (emailMatch ? 'email' : 'phone');
        return jsonResponse({
          ok: false,
          error: matched_via === 'phone'
            ? `Your phone number is already registered as a member at ${tenant.display_name || 'this club'}. If that's you, sign in with the phone-magic-link option below.`
            : matched_via === 'email'
            ? `Your email is already registered as a member at ${tenant.display_name || 'this club'}. If that's you, sign in with the email-magic-link option below.`
            : `You're already a member at ${tenant.display_name || 'this club'}. Sign in below — we'll text or email you a one-tap link.`,
          code: 'already_member',
          matched_via,
        }, 409);
      }

      const appMatchPromises: Promise<{ data: Array<{ id: string; created_at: string }> | null }>[] = [];
      if (email) {
        appMatchPromises.push(
          sb.from('applications').select('id, created_at')
            .eq('tenant_id', tenant.id).eq('status', 'pending')
            .ilike('primary_email', email).limit(1) as never,
        );
      }
      if (phone) {
        appMatchPromises.push(
          sb.from('applications').select('id, created_at')
            .eq('tenant_id', tenant.id).eq('status', 'pending')
            .eq('primary_phone', phone).limit(1) as never,
        );
      }
      const appHits = (await Promise.all(appMatchPromises))
        .flatMap(r => r.data ?? []);
      if (appHits.length > 0) {
        const since = appHits[0].created_at
          ? `from ${new Date(appHits[0].created_at).toLocaleDateString()}`
          : 'on file';
        return jsonResponse({
          ok: false,
          error: `You already submitted an application ${since}. The board will review it soon — watch for an email.`,
          code: 'already_applied',
        }, 409);
      }
    }

    const payment_method = strOrNull(body.payment_method);
    if (payment_method && !VALID_PAYMENT_METHODS.has(payment_method)) {
      return jsonResponse({ ok: false, error: 'Invalid payment method' }, 400);
    }

    // Full-detail fields (BE parity): adults, children, waivers, signatures.
    // Hard caps on array length so a malicious submitter can't blow up the
    // payload + spam Resend / Drive with a 100MB request.
    const MAX_ADULTS_PER_HOUSEHOLD = 12;     // generous — most families ≤4
    const MAX_CHILDREN_PER_HOUSEHOLD = 16;
    const adultsArr   = Array.isArray(body.adults)
      ? (body.adults   as Array<Record<string, unknown>>).slice(0, MAX_ADULTS_PER_HOUSEHOLD)
      : [];
    const childrenArr = Array.isArray(body.children)
      ? (body.children as Array<Record<string, unknown>>).slice(0, MAX_CHILDREN_PER_HOUSEHOLD)
      : [];
    if (Array.isArray(body.adults) && (body.adults as unknown[]).length > MAX_ADULTS_PER_HOUSEHOLD) {
      return jsonResponse({ ok: false, error: `Maximum ${MAX_ADULTS_PER_HOUSEHOLD} adults per household. Contact the club if your situation is unusual.` }, 400);
    }
    if (Array.isArray(body.children) && (body.children as unknown[]).length > MAX_CHILDREN_PER_HOUSEHOLD) {
      return jsonResponse({ ok: false, error: `Maximum ${MAX_CHILDREN_PER_HOUSEHOLD} children per household.` }, 400);
    }

    // Validate per-adult shape if provided. Adults must each have a name; phone normalization happens here.
    const adults_json: Array<Record<string, unknown>> = [];
    for (const a of adultsArr) {
      const nm = String(a?.name ?? '').trim();
      if (!nm) continue;  // skip empty rows from the dynamic builder
      const ap = String(a?.phone ?? '').trim();
      const apE = ap ? normalizePhoneE164(ap) : null;
      if (ap && !apE) return jsonResponse({ ok: false, error: `Invalid phone for ${nm}` }, 400);
      // signature_url is the canonical field name (matches apply form's
      // payload + the PDF renderer's type def). Older clients sent
      // 'signature' — accept both for back-compat but store as signature_url.
      const sigData = (typeof a?.signature_url === 'string' ? a.signature_url
                     : typeof a?.signature === 'string' ? a.signature
                     : null);
      adults_json.push({
        name: nm,
        dob: a?.dob ? String(a.dob) : null,
        email: a?.email ? String(a.email).trim().toLowerCase() : null,
        phone: apE,
        signature_url: sigData ? String(sigData).slice(0, 200000) : null,
      });
    }
    const children_json: Array<Record<string, unknown>> = [];
    for (const c of childrenArr) {
      const nm = String(c?.name ?? '').trim();
      if (!nm) continue;
      children_json.push({
        name: nm,
        dob: c?.dob ? String(c.dob) : null,
        allergies: c?.allergies ? String(c.allergies).slice(0, 500) : null,
      });
    }

    const waivers = (body.waivers_accepted ?? body.waivers ?? {}) as Record<string, unknown>;
    const waivers_accepted: Record<string, boolean> = {};
    for (const k of ['rules','guest','party','sitter','waiver']) {
      waivers_accepted[k] = waivers[k] === true;
    }
    const allWaiversAccepted = Object.values(waivers_accepted).every(Boolean);

    const sigPrimary  = typeof body.signature_primary  === 'string' ? String(body.signature_primary).slice(0, 200000)  : null;
    const sigGuardian = typeof body.signature_guardian === 'string' ? String(body.signature_guardian).slice(0, 200000) : null;

    // Which season is this buying? Stamped once, here, so every downstream
    // write (approve, Stripe webhook, installment charge) copies the year the
    // member actually paid for instead of re-guessing it from the clock —
    // which is wrong for anyone paying before the season they're joining.
    const { data: yearSettings } = await sb.from('settings')
      .select('value').eq('tenant_id', tenant.id).maybeSingle();
    const { sellingYear } = await import('../_shared/membership_year.ts');
    const membership_year = sellingYear(yearSettings?.value);

    const appData: Record<string, unknown> = {
      tenant_id: tenant.id,
      membership_year,
      family_name, primary_name,
      primary_email: email,
      primary_phone: phone,
      address: strOrNull(body.address),
      city:    strOrNull(body.city),
      zip:     strOrNull(body.zip),
      num_adults: adults_json.length || intOrDefault(body.num_adults, 2),
      num_kids:   children_json.length || intOrDefault(body.num_kids, 0),
      body:    strOrNull(body.body),
      payment_method,
      payment_status: 'unpaid',
      is_new_member:    body.is_new_member !== false,
      need_new_fob:     body.need_new_fob === true,
      prior_fob_number: strOrNull(body.prior_fob_number),
      alt_email:        body.alt_email ? String(body.alt_email).trim().toLowerCase() : null,
      adults_json,
      children_json,
      waivers_accepted,
      accepted_at: allWaiversAccepted ? new Date().toISOString() : null,
      signature_primary:  sigPrimary,
      signature_guardian: sigGuardian,
      tier_slug: strOrNull(body.tier_slug),
      referral_code: body.referral_code ? String(body.referral_code).trim().toUpperCase().slice(0, 32) : null,
      // 2026-05-23 "guest checkout" — applicant ticked "Just sign me up"
      // (don't want the app). Used downstream to pick the welcome email
      // template + show a pill in the Pipeline. Doesn't change the
      // applicant's underlying capability — they can always opt into the
      // app later via /m/login.html.
      no_app_member: body.no_app_member === true,
    };

    // Claim → UPDATE the pre-filled row (flip to 'pending', stamp claimed_at).
    // Otherwise INSERT a brand-new application. Same return shape either way
    // so the apply form's downstream payment step is unchanged.
    let data: { id: string } | null = null;
    let error: { message: string } | null = null;
    if (claimAppId) {
      appData.status = 'pending';
      appData.claimed_at = new Date().toISOString();
      ({ data, error } = await sb.from('applications')
        .update(appData).eq('id', claimAppId).eq('tenant_id', tenant.id)
        .select('id').single());
    } else {
      ({ data, error } = await sb.from('applications')
        .insert(appData).select('id').single());
    }
    if (error || !data) return jsonResponse({ ok: false, error: error?.message || 'Could not save application' }, 500);
    await audit(sb, tenant.id, null, 'public', 'application.submit', data.id,
      `Application submitted: ${family_name} (${primary_name}, ${adults_json.length} adults / ${children_json.length} kids)`);

    // ── Application routing (2026-05-22 redesign — Doug's ONE-CLICK ask) ─
    //   Stripe / stripe_plan : the webhook auto-approves on payment.
    //                          NO admin_task here — the application is
    //                          either pending-payment (60-min cleanup)
    //                          or auto-approved+paid by webhook.
    //   Venmo                : application stays PENDING. Admin sees ONE
    //                          task ("verify Venmo + approve in one click")
    //                          and uses the combined approve+verify path
    //                          in applications.html. This kills the old
    //                          "auto-approved but unpaid" half-state that
    //                          confused admins into thinking the work was
    //                          done — and the orphan "I paid Venmo" claim
    //                          flow that often never fired.
    //   No method (decide later) : admin_task fires for manual approval.
    const isStripeFlow = payment_method === 'stripe' || payment_method === 'stripe_plan';
    if (!isStripeFlow) {
      try {
        const { enqueueAdminTask } = await import('../_shared/enqueue_task.ts');
        const isVenmo = payment_method === 'venmo';
        await enqueueAdminTask(sb, {
          tenant_id: tenant.id,
          target_scopes: ['applications'],
          kind: 'application.submitted',
          summary: isVenmo
            ? `New Venmo application from ${family_name} (${primary_name}) — verify in Venmo + approve in one click`
            : `New application: ${family_name} (${primary_name})`,
          link_url: '/club/admin/members.html#applications',
          source_kind: 'application', source_id: data.id,
          push_title: isVenmo
            ? `💵 New Venmo application — verify + approve`
            : `📨 New application from ${family_name}`,
          push_body: isVenmo
            ? `${primary_name} applied via Venmo. Open Venmo, confirm the payment, then tap "Approve & verify" — one click handles both.`
            : `${primary_name} just applied. Tap to review.`,
        });
      } catch { /* best-effort — never fails submission */ }
    }

    // Referral capture: if this application came in via a code, create a
    // referrals row at status='applied'. Will flip to 'verified' (or
    // 'rejected' on returning-member detection) when payment clears.
    if (body.referral_code) {
      try {
        const code = String(body.referral_code).trim().toUpperCase().slice(0, 32);
        const { data: rc } = await sb.from('referral_codes')
          .select('id').eq('tenant_id', tenant.id).eq('code', code).eq('active', true).maybeSingle();
        if (rc) {
          await sb.from('referrals').insert({
            tenant_id: tenant.id,
            referral_code_id: rc.id,
            application_id: data.id,
            applied_by_email: email,
            applied_by_family: family_name,
            status: 'applied',
          });
        }
      } catch { /* best-effort — referral failure never blocks the application */ }
    }

    // ── Render the legal-evidence PDF ONCE at submit time ──────────────
    // The same bytes are reused for: (a) attachment to the applicant's
    // confirmation email, (b) Drive upload for the club's archive. Single
    // render = single source of truth (the PDF the member receives is
    // bit-for-bit identical to what the club archives).
    let pdfBytes: Uint8Array | null = null;
    let pdfData: import('../_shared/application_pdf.ts').ApplicationForPdf | null = null;
    try {
      const { loadApplicationForPdf } = await import('../_shared/sync_application.ts');
      const { renderApplicationPdf } = await import('../_shared/application_pdf.ts');
      pdfData = await loadApplicationForPdf(sb, tenant.id, data.id);
      if (pdfData) pdfBytes = await renderApplicationPdf(pdfData);
    } catch (e) {
      console.error('PDF build at submit failed (non-fatal):', (e as Error).message);
    }

    // Drive sync — fire inline so the PDF + Sheet row are in the club's
    // Drive within seconds of submit. Failures enqueue silently for retry;
    // user-facing submit response is unaffected.
    const GOOGLE_ID  = Deno.env.get('GOOGLE_CLIENT_ID');
    const GOOGLE_SEC = Deno.env.get('GOOGLE_CLIENT_SECRET');
    if (GOOGLE_ID && GOOGLE_SEC) {
      try {
        const { syncApplicationToDrive, enqueueDriveSync } = await import('../_shared/sync_application.ts');
        const r = await syncApplicationToDrive(sb, {
          tenantId: tenant.id, applicationId: data.id,
          googleClientId: GOOGLE_ID, googleClientSecret: GOOGLE_SEC,
          prebuilt: pdfData && pdfBytes ? { pdfData, pdfBytes } : undefined,
        });
        if (!r.ok) await enqueueDriveSync(sb, tenant.id, data.id, r.error);
      } catch (e) {
        try {
          const { enqueueDriveSync } = await import('../_shared/sync_application.ts');
          await enqueueDriveSync(sb, tenant.id, data.id, (e as Error).message);
        } catch { /* not even the queue worked — acceptable; submit still succeeds */ }
      }
    }

    // ── Submit-confirmation email — fires immediately so the applicant
    // doesn't sit in suspense. Template is registry-backed; admin can
    // customize per-tenant via Emails admin page.
    //
    // IMPORTANT: For Stripe paths (stripe + stripe_plan), we skip this
    // entirely — the Stripe webhook auto-approves within seconds-minutes
    // and fires a combined "got your application + payment confirmed"
    // welcome email instead, with the legal-evidence PDF attached. Two
    // emails for one continuous flow felt redundant. (If the applicant
    // abandons checkout, they get no email — admins see a pending unpaid
    // application in Members > Pipeline and can nudge from there.)
    const primary_email = email;
    const skipReceivedEmail = payment_method === 'stripe' || payment_method === 'stripe_plan';
    if (primary_email && !skipReceivedEmail) {
      try {
        const { renderAndSend } = await import('../_shared/email_template.ts');
        const { data: settingsRow2 } = await sb.from('settings').select('value').eq('tenant_id', tenant.id).maybeSingle();
        const sv2 = settingsRow2?.value as Record<string, unknown> | undefined;
        const venmoHandle = ((sv2?.payments as Record<string, unknown> | undefined)?.venmo_handle as string | null) ?? '';
        const tiers = (sv2?.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];
        const tier  = tiers.find(t => t.slug === body.tier_slug) || tiers[0];
        const tierLabel = (tier?.label as string) || (body.tier_slug as string) || 'Family';
        const tierPriceCents = (typeof tier?.price_cents === 'number') ? tier.price_cents as number : 0;
        const tierPrice = tierPriceCents > 0 ? '$' + (tierPriceCents / 100).toFixed(0) : '';

        const planCfg = (sv2?.payments as Record<string, unknown> | undefined)?.plan as Record<string, unknown> | undefined;
        const splitPct = Math.max(1, Math.min(99, Number(planCfg?.first_installment_pct) || 50));
        const finalDue = String(planCfg?.final_due_date || '');
        let firstAmt = '', secondAmt = '';
        if (tierPriceCents > 0) {
          const first = Math.round(tierPriceCents * splitPct / 100);
          const second = tierPriceCents - first;
          firstAmt  = '$' + (first / 100).toFixed(0);
          secondAmt = '$' + (second / 100).toFixed(0);
        }

        const baseVars = {
          tenant_name: tenant.display_name,
          primary_name, family_name,
          tier_label: tierLabel,
          tier_price: tierPrice,
          num_adults: String(adults_json.length),
          num_kids:   String(children_json.length),
          venmo_handle: venmoHandle,
          first_amount: firstAmt,
          second_amount: secondAmt,
          final_due_date: finalDue,
          club_url: `https://${tenant.slug}.poolsideapp.com`,
        };

        const templateKey =
          payment_method === 'venmo'       ? 'application_received_venmo'
        : payment_method === 'stripe'      ? 'application_received_stripe'
        : payment_method === 'stripe_plan' ? 'application_received_stripe_plan'
        : 'application_received_other';

        // Build attachment if the PDF rendered successfully. The applicant
        // gets the bit-for-bit-identical legal-evidence PDF the club
        // archives — full policy text, acceptance stamp, signatures.
        let attachments: Array<{ filename: string; content: string; contentType?: string }> | undefined;
        if (pdfBytes) {
          const { bytesToBase64 } = await import('../_shared/send_email.ts');
          const safeFamily = family_name.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
          const dateStr = new Date().toISOString().slice(0, 10);
          attachments = [{
            filename: `${safeFamily}-application-${dateStr}.pdf`,
            content: bytesToBase64(pdfBytes),
            contentType: 'application/pdf',
          }];
        }

        await renderAndSend(sb, {
          tenantId: tenant.id, templateKey,
          to: primary_email, variables: baseVars,
          attachments,
        });
      } catch { /* never fail submission because of an email hiccup */ }
    }

    return jsonResponse({
      ok: true,
      application_id: data.id,
      payment_method,
      // auto_approved / self_signup_complete removed 2026-05-22 — Venmo
      // applications no longer auto-approve, so both flags would always be
      // false. apply.html falls through to the generic "we got your
      // application" page for everything except Stripe (which redirects
      // to Checkout) and the legacy admin-self-signup celebration.
      tenant_slug: tenant.slug,
      tenant_display_name: tenant.display_name,
    });
  }

  // ── post_payment_signin — public, time-bounded ───────────────────────
  // After Stripe Checkout redirects the applicant back to apply.html with
  // ?paid=1&app_id=<uuid>, the success page calls this to get an instant
  // magic-link URL so the new member can sign in WITHOUT waiting for the
  // welcome email. Anti-abuse: only works while paid_at is within 10 min,
  // and only if the app is approved (so we know there's a primary household
  // member to sign in as). Otherwise: 410 with "wait for the welcome email".
  if (action === 'post_payment_signin') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: app } = await sb.from('applications')
      .select('id, tenant_id, status, payment_status, paid_at, primary_email, household_id')
      .eq('id', id).maybeSingle();
    if (!app)                                              return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.payment_status !== 'paid' && app.payment_status !== 'pending') {
      return jsonResponse({ ok: false, error: 'Payment not complete yet — refresh in a moment' }, 409);
    }
    if (!app.paid_at)                                      return jsonResponse({ ok: false, error: 'Payment timestamp missing' }, 409);
    const ageSec = (Date.now() - new Date(app.paid_at as string).getTime()) / 1000;
    if (ageSec > 600) {
      return jsonResponse({ ok: false, error: 'Sign-in window expired — use the link in your welcome email' }, 410);
    }
    if (app.status !== 'approved' || !app.household_id) {
      // Auto-approve hasn't run yet — likely racing the Stripe webhook.
      // Tell the client to retry.
      return jsonResponse({ ok: false, retry: true, error: 'Almost ready — retry in a few seconds' }, 425);
    }

    // Find the primary household member (the email on the application is
    // theirs by definition — the apply form's first adult).
    const { data: primary } = await sb.from('household_members')
      .select('id, name, email').eq('household_id', app.household_id).eq('role', 'primary').maybeSingle();
    if (!primary) return jsonResponse({ ok: false, error: 'Primary member missing' }, 500);

    // Issue a fresh single-use token (15 min expiry — same as member_auth.start)
    const tok = randomToken();
    const tokHash = await sha256Hex(tok);
    const expIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await sb.from('member_magic_links').insert({
      tenant_id: app.tenant_id, member_id: primary.id,
      token_hash: tokHash, expires_at: expIso,
    });

    const { data: tenant } = await sb.from('tenants').select('slug').eq('id', app.tenant_id).maybeSingle();
    const verifyUrl = `https://${tenant?.slug}.poolsideapp.com/m/verify.html#token=${encodeURIComponent(tok)}`;

    return jsonResponse({ ok: true, verify_url: verifyUrl, member_name: primary.name });
  }

  // ── claim_venmo_paid (member-side: "I paid via Venmo") ─────────────────
  // Public action — anyone with the application id can flag it. We dedupe
  // on (source_id, kind) so multiple taps don't multi-notify the treasurer.
  if (action === 'claim_venmo_paid') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: app } = await sb.from('applications')
      .select('id, tenant_id, family_name, primary_name, payment_status, status')
      .eq('id', id).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.payment_status === 'paid') {
      return jsonResponse({ ok: false, error: 'Already marked paid — no action needed' }, 409);
    }
    // Dedupe: don't add a second open claim for the same app
    const { data: existing } = await sb.from('admin_tasks')
      .select('id').eq('tenant_id', app.tenant_id).eq('source_kind', 'application')
      .eq('source_id', app.id).eq('kind', 'venmo.claim')
      .is('completed_at', null).is('dismissed_at', null).maybeSingle();
    if (existing) return jsonResponse({ ok: true, deduped: true });
    {
      const { enqueueAdminTask } = await import('../_shared/enqueue_task.ts');
      await enqueueAdminTask(sb, {
        tenant_id: app.tenant_id,
        target_scopes: ['payments', 'applications'],
        kind: 'venmo.claim',
        summary: `${app.family_name}: ${app.primary_name} reports paid via Venmo — verify`,
        link_url: '/club/admin/members.html#applications',
        source_kind: 'application', source_id: app.id,
        push_title: `💵 Venmo payment to verify: ${app.family_name}`,
        push_body: `${app.primary_name} says they paid. Open Venmo, confirm the amount, then approve their membership.`,
      });
    }
    await audit(sb, app.tenant_id, null, 'public', 'application.venmo_claim', app.id,
      `${app.family_name} claimed Venmo payment`);
    return jsonResponse({ ok: true });
  }

  // ── get_claim (public) ─────────────────────────────────────────────────
  // A CSV-imported member opens apply.html?claim=<token>. We resolve the
  // pre-filled application and hand back its fields so the form starts
  // populated. No auth — the unguessable token IS the credential.
  if (action === 'get_claim') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    const claimToken = String(body.claim_token ?? '').trim();
    if (!slug || !claimToken) return jsonResponse({ ok: false, error: 'slug + claim_token required' }, 400);
    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name').eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    const hash = await sha256Hex(claimToken);
    const { data: app } = await sb.from('applications').select(FIELDS)
      .eq('tenant_id', tenant.id).eq('claim_token_hash', hash).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'This invite link is invalid or has expired.' }, 404);
    if (app.status === 'approved') {
      return jsonResponse({ ok: false, code: 'already_member', error: 'You\'re already set up — just sign in at /m/login.html.' }, 409);
    }
    if (app.status === 'rejected') {
      return jsonResponse({ ok: false, error: 'This application is no longer active. Contact the club.' }, 409);
    }
    return jsonResponse({
      ok: true,
      application: {
        family_name: app.family_name,
        primary_name: app.primary_name,
        primary_email: app.primary_email,
        primary_phone: app.primary_phone,
        address: app.address, city: app.city, zip: app.zip,
        adults_json: app.adults_json ?? [],
        children_json: app.children_json ?? [],
        tier_slug: app.tier_slug,
        prior_fob_number: app.prior_fob_number,
        body: app.body,
        already_claimed: app.status === 'pending',
      },
    });
  }

  // Admin actions below — verify tenant admin OR service-role internal call
  // (used by stripe_webhook to auto-approve on Stripe Checkout success).
  // Internal header carries the service-role key + body.tenant_id is the scope.
  const internalKey = req.headers.get('x-poolside-internal');
  let payload: Payload | null = null;
  if (internalKey && internalKey === SERVICE_ROLE && body.tenant_id) {
    payload = { sub: 'webhook', kind: 'tenant_admin', tid: String(body.tenant_id), synthetic: true };
  } else {
    const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
    const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
    payload = token ? await verifyTenantAdmin(token) : null;
  }
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const TID = payload.tid;

  // Scope gate: admin actions on applications require the 'applications' scope.
  // Synthetic webhook tokens bypass (used by stripe_webhook for auto-approve).
  if (!payload.synthetic && !(await requireScope(sb, payload as never, 'applications'))) {
    return jsonResponse({ ok: false, error: 'Missing required scope: applications' }, 403);
  }

  // ── list_prefilled (admin) — migration tracker ─────────────────────────
  // Every row that came from a CSV import, with rollup counts so the admin
  // sees how the "claim your spot" blast is landing.
  if (action === 'list_prefilled') {
    const { data, error } = await sb.from('applications')
      .select('id, family_name, primary_name, primary_email, primary_phone, status, payment_status, invited_at, claimed_at, created_at')
      .eq('tenant_id', TID).eq('claim_source', 'csv_import')
      .order('created_at', { ascending: true });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const rows = data ?? [];
    const summary = {
      total:    rows.length,
      invited:  rows.filter(r => r.invited_at).length,
      claimed:  rows.filter(r => r.claimed_at).length,
      paid:     rows.filter(r => r.payment_status === 'paid').length,
      approved: rows.filter(r => r.status === 'approved').length,
      no_email: rows.filter(r => !r.primary_email).length,
    };
    return jsonResponse({ ok: true, applications: rows, summary });
  }

  // ── send_claim_invites (admin) — the migration blast ───────────────────
  // Email-first: mints a fresh one-time claim token per imported member,
  // stores its hash, and emails the apply.html?claim=<token> link. Members
  // without an email are reported back so the admin can chase them another
  // way. (SMS blast intentionally omitted for now — the global SMS kill-
  // switch would throttle it; revisit once per-tenant SMS limits exist.)
  if (action === 'send_claim_invites') {
    const onlyUninvited = body.only_uninvited !== false;   // default: don't re-spam
    const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String) : null;
    let q = sb.from('applications')
      .select('id, family_name, primary_name, primary_email, status, invited_at')
      .eq('tenant_id', TID).eq('claim_source', 'csv_import')
      .in('status', ['prefilled', 'pending']);
    if (ids) q = q.in('id', ids);
    const { data: apps, error: listErr } = await q;
    if (listErr) return jsonResponse({ ok: false, error: listErr.message }, 500);

    const { data: tenant } = await sb.from('tenants')
      .select('slug, display_name').eq('id', TID).maybeSingle();
    const clubUrl  = tenant ? `https://${tenant.slug}.poolsideapp.com` : '';
    const clubName = tenant?.display_name || 'your club';
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const RESEND_FROM    = Deno.env.get('RESEND_FROM') || 'Poolside <onboarding@resend.dev>';
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));

    let sent = 0, skipped_no_email = 0, skipped_already = 0, failed = 0;
    for (const app of (apps ?? [])) {
      if (onlyUninvited && app.invited_at) { skipped_already++; continue; }
      if (!app.primary_email) { skipped_no_email++; continue; }

      // Fresh token each send — a re-send invalidates the previous link.
      const tok  = randomToken();
      const hash = await sha256Hex(tok);
      const { error: updErr } = await sb.from('applications')
        .update({ claim_token_hash: hash, invited_at: new Date().toISOString() })
        .eq('id', app.id).eq('tenant_id', TID);
      if (updErr) { failed++; continue; }

      const claimUrl = `${clubUrl}/apply.html?claim=${encodeURIComponent(tok)}`;
      if (!RESEND_API_KEY) { failed++; continue; }   // token stored; resend once email is configured
      const firstName = String(app.primary_name || '').trim().split(/\s+/)[0] || 'there';
      const html = `
        <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
          <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">${esc(clubName)} has moved to a new system</h2>
          <p style="margin:0 0 16px;color:#334155">Hi ${esc(firstName)} — we've switched to Poolside to manage memberships, payments, and pool access. We've pre-filled your information to make this quick.</p>
          <p style="margin:0 0 16px;color:#334155">Tap below to review your details, add anyone on your membership, accept the club policies, and pay your dues for the season.</p>
          <p style="margin:24px 0">
            <a href="${claimUrl}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Confirm &amp; pay →</a>
          </p>
          <p style="margin:0;color:#64748b;font-size:13px;line-height:1.5">If the button doesn't work, paste this link into your browser:<br><code style="font-size:12px;word-break:break-all;color:#0a3b5c">${claimUrl}</code></p>
          <hr style="border:0;border-top:1px solid #e5e7eb;margin:28px 0">
          <p style="margin:0;color:#94a3b8;font-size:12px">You're receiving this because you're a member of ${esc(clubName)}. Questions? Just reply to this email.</p>
        </div>`;
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: RESEND_FROM, to: [app.primary_email],
            subject: `${clubName}: confirm your membership & pay for the season`,
            html,
          }),
        });
        if (res.ok) sent++; else failed++;
      } catch { failed++; }
    }

    await audit(sb, TID, payload.synthetic ? null : payload.sub, 'tenant_admin', 'application.claim_invites_sent', null,
      `Sent ${sent} season-invite email${sent === 1 ? '' : 's'}`);
    return jsonResponse({
      ok: true, sent, skipped_no_email, skipped_already, failed,
      total: (apps ?? []).length,
      email_configured: !!RESEND_API_KEY,
    });
  }

  if (action === 'list') {
    const status = String(body.status ?? 'pending');
    const filter = String(body.filter ?? '');  // 'unpaid' | 'overdue' | ''
    const year = body.year ? Number(body.year) : null;
    let q = sb.from('applications').select(FIELDS).eq('tenant_id', TID);

    // status='needs_attention' (Doug 2026-05-23) = the Pipeline's unified
    // "things to do" view. Returns pending applications PLUS approved
    // applications whose payment hasn't cleared yet — typically the
    // legacy "auto-approved Venmo, member never claimed it" backlog
    // (pre-2026-05-22 flow) plus any case where an admin used the
    // "Approve only" path and is now waiting on payment. Both surfaces
    // become a single one-click inline-button row in the UI.
    if (status === 'needs_attention') {
      q = q.or('status.eq.pending,and(status.eq.approved,payment_status.in.("unpaid","pending"))');
    } else if (status !== 'all') {
      q = q.eq('status', status);
    }
    if (filter === 'unpaid')  q = q.in('payment_status', ['unpaid', 'pending']);
    if (filter === 'overdue') {
      // approved + still unpaid + decided more than 10 days ago
      const tenDaysAgo = new Date(Date.now() - 10 * 86400_000).toISOString();
      q = q.eq('status', 'approved').in('payment_status', ['unpaid','pending']).lt('decided_at', tenDaysAgo);
    }
    if (year && Number.isFinite(year)) {
      // Year window in UTC — matches what list_years returns.
      const start = new Date(Date.UTC(year,     0, 1)).toISOString();
      const end   = new Date(Date.UTC(year + 1, 0, 1)).toISOString();
      q = q.gte('created_at', start).lt('created_at', end);
    }
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, applications: data ?? [] });
  }

  if (action === 'list_years') {
    // Distinct list of years (newest first) that have applications. Powers
    // the year-filter chip row on the admin applications panel.
    const { data, error } = await sb.from('applications')
      .select('created_at').eq('tenant_id', TID)
      .order('created_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const set = new Set<number>();
    for (const r of (data ?? [])) {
      const y = new Date(r.created_at as string).getUTCFullYear();
      if (Number.isFinite(y)) set.add(y);
    }
    return jsonResponse({ ok: true, years: Array.from(set).sort((a,b) => b-a) });
  }

  if (action === 'approve') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    // Combined "verify Venmo + approve" path: when admin checks the Venmo
    // app and confirms the payment landed, they pass verify_venmo_payment=
    // true. We mark the application paid BEFORE creating the household so
    // the welcome email logic below picks the application_approved_venmo_
    // verified template (one email, "you're 100% active") instead of the
    // application_approved_unpaid_venmo template ("approved, now send
    // dues"). The user gets exactly one email.
    const verifyVenmo = !!body.verify_venmo_payment;
    if (verifyVenmo) {
      const verified_by_pre = payload.synthetic ? null : payload.sub;
      const now = new Date().toISOString();
      await sb.from('applications').update({
        payment_method: 'venmo',
        payment_status: 'paid',
        paid_at: now,
        verified_at: now,
        verified_by: verified_by_pre,
      }).eq('id', id).eq('tenant_id', TID);
      // Per-application audit
      await sb.from('application_actions').insert({
        application_id: id, tenant_id: TID,
        kind: 'venmo_verified',
        body: strOrNull(body.venmo_note) ?? 'Verified at approval',
        actor_id: verified_by_pre,
      });
    }

    const { data: app } = await sb.from('applications').select(FIELDS)
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.status !== 'pending') return jsonResponse({ ok: false, error: `Already ${app.status}` }, 409);

    // ── Renewal: the household already exists ────────────────────────────
    // A renewal reuses the application row for payment, audit and receipts,
    // but must NOT run the new-member path below: there is no household to
    // create, the phone "clash" is the member's own number, and they already
    // occupy a plan slot so the capacity gate would wrongly reject them at
    // full clubs — the exact clubs most eager to keep everyone.
    if (app.is_renewal && app.household_id) {
      const renewYear = (app.membership_year as number | null) ?? new Date().getUTCFullYear();
      const nowIso = new Date().toISOString();

      await sb.from('applications').update({
        status: 'approved',
        decided_at: nowIso,
        decided_by: payload.synthetic ? null : payload.sub,
        admin_notes: strOrNull(body.admin_notes) ?? app.admin_notes,
        updated_at: nowIso,
      }).eq('id', id).eq('tenant_id', TID);

      // Roll the season forward. Only ever forward: an admin approving a late
      // 2026 renewal must not pull back a household already paid through 2027.
      const { data: hh } = await sb.from('households')
        .select('id, paid_until_year').eq('id', app.household_id).eq('tenant_id', TID).maybeSingle();
      if (hh) {
        const current = (hh.paid_until_year as number | null) ?? 0;
        await sb.from('households').update({
          paid_until_year: Math.max(current, renewYear),
          dues_paid_for_year: app.payment_status === 'paid',
          active: true,
        }).eq('id', hh.id).eq('tenant_id', TID);
      }

      await sb.from('application_actions').insert({
        application_id: id, tenant_id: TID,
        kind: 'renewal_approved',
        body: `Renewed through ${renewYear}`,
        actor_id: payload.synthetic ? null : payload.sub,
      });
      await audit(sb, TID, payload.synthetic ? null : payload.sub, 'admin',
        'application.renewed', id, `${app.family_name} renewed through ${renewYear}`);

      await sb.from('admin_tasks').update({ completed_at: nowIso })
        .eq('source_kind', 'application').eq('source_id', id).is('completed_at', null);

      return jsonResponse({ ok: true, renewed: true, household_id: app.household_id, membership_year: renewYear });
    }

    if (!app.primary_phone) {
      return jsonResponse({ ok: false, error: 'Need a phone number to create the household. Edit the application or ask the family for one.' }, 400);
    }

    // Make sure the phone isn't already taken
    const { data: clash } = await sb.from('household_members')
      .select('id').eq('tenant_id', TID).eq('phone_e164', app.primary_phone).eq('active', true).maybeSingle();
    if (clash) return jsonResponse({ ok: false, error: 'Another active member already uses that phone number' }, 409);

    // Hard cap enforcement: don't approve into a household if doing so would
    // exceed the plan limit. Surfaces the same 402 to the admin UI as create.
    const { getHouseholdCapStatus, capStatusToJson } = await import('../_shared/plan_caps.ts');
    const { data: tenantRowCap } = await sb.from('tenants').select('plan').eq('id', TID).maybeSingle();
    const cap = await getHouseholdCapStatus(sb, TID, tenantRowCap?.plan);
    if (cap.at_cap) {
      return jsonResponse({
        ok: false,
        error: `Cannot approve — at household limit (${cap.count}/${cap.cap === Infinity ? '∞' : cap.cap}, ${cap.plan_label}). Upgrade your plan or remove an inactive household.`,
        plan_cap: capStatusToJson(cap),
      }, 402);
    }

    const ovr = (body.override ?? {}) as Record<string, unknown>;
    // Tier resolution order: admin override > applicant's selected tier > 'family' default
    const tier = strOrNull(ovr.tier) ?? strOrNull(app.tier_slug) ?? 'family';
    const fob_number = strOrNull(ovr.fob_number);
    const paid_until_year = ovr.paid_until_year !== undefined && ovr.paid_until_year !== ''
      ? Math.trunc(Number(ovr.paid_until_year) || 0) : null;

    // Create household. If we just verified the Venmo payment in this same
    // call, mark the household's dues paid for the season the APPLICATION was
    // for — not for "now". A December application for next summer must land as
    // paid through next year, or the family shows up expired on opening day.
    const appYear = (app.membership_year as number | null) ?? new Date().getUTCFullYear();
    const hhInsert: Record<string, unknown> = {
      tenant_id: TID,
      family_name: app.family_name,
      tier,
      fob_number,
      paid_until_year: verifyVenmo ? appYear : paid_until_year,
      address: app.address,
      city: app.city,
      zip: app.zip,
      active: true,
    };
    if (verifyVenmo) hhInsert.dues_paid_for_year = true;
    const { data: hh, error: hhErr } = await sb.from('households').insert(hhInsert).select('id').single();
    if (hhErr || !hh) return jsonResponse({ ok: false, error: hhErr?.message || 'Could not create household' }, 500);

    // Create primary contact
    const { data: pm, error: pmErr } = await sb.from('household_members').insert({
      tenant_id: TID, household_id: hh.id,
      name: app.primary_name,
      phone_e164: app.primary_phone,
      email: app.primary_email,
      role: 'primary',
      can_unlock_gate: true, can_book_parties: true,
      active: true,
      confirmed_at: new Date().toISOString(),
    }).select('id').single();
    if (pmErr) {
      // Roll back the household
      await sb.from('households').delete().eq('id', hh.id);
      return jsonResponse({ ok: false, error: pmErr.message }, 500);
    }

    // ── Populate the rest of the family from adults_json + children_json ──
    // Skip adults_json[0] when its name matches primary_name (avoid duplicate).
    const adults = Array.isArray(app.adults_json) ? app.adults_json as Array<Record<string, unknown>> : [];
    const children = Array.isArray(app.children_json) ? app.children_json as Array<Record<string, unknown>> : [];

    // Normalize whatever the apply form's formatPhoneInput rendered (e.g.
    // "(555) 123-4567") into E.164 so future SMS magic-link lookups can match.
    function toE164(raw: string | null | undefined): string | null {
      if (!raw) return null;
      const digits = String(raw).replace(/[^\d+]/g, '');
      if (digits.startsWith('+') && /^\+\d{8,15}$/.test(digits)) return digits;
      if (/^\d{10}$/.test(digits)) return '+1' + digits;
      if (/^1\d{10}$/.test(digits)) return '+' + digits;
      return null;
    }

    let createdExtraMembers = 0;
    // Surface failed inserts so admin knows if the 8-member household cap (or
    // any other DB constraint) silently dropped someone. Previously these
    // errors were eaten and approval succeeded with a partial household.
    const insertErrors: Array<{ name: string; error: string }> = [];
    for (let i = 0; i < adults.length; i++) {
      const a = adults[i];
      const aName = String(a?.name ?? '').trim();
      if (!aName) continue;
      // First adult is the primary already inserted — skip if it matches
      if (i === 0 && aName.toLowerCase() === String(app.primary_name).trim().toLowerCase()) continue;
      const aPhone = toE164(a?.phone);
      // Skip if phone clashes with primary's phone (safety)
      if (aPhone && aPhone === app.primary_phone) continue;
      const { error: spErr } = await sb.from('household_members').insert({
        tenant_id: TID, household_id: hh.id,
        name: aName,
        phone_e164: aPhone,
        email: a?.email ? String(a.email).toLowerCase() : null,
        role: 'adult',
        can_unlock_gate: true, can_book_parties: false,
        active: true,
        confirmed_at: new Date().toISOString(),
      });
      if (!spErr) createdExtraMembers++;
      else insertErrors.push({ name: aName, error: spErr.message });
    }
    for (const c of children) {
      const cName = String(c?.name ?? '').trim();
      if (!cName) continue;
      // Determine role by DOB if provided (teen >= 13)
      let role = 'child';
      if (c?.dob) {
        const yrs = (Date.now() - new Date(String(c.dob)).getTime()) / (365.25 * 86400_000);
        if (yrs >= 13) role = 'teen';
      }
      const { error: chErr } = await sb.from('household_members').insert({
        tenant_id: TID, household_id: hh.id,
        name: cName,
        role,
        can_unlock_gate: role === 'teen',
        can_book_parties: false,
        active: true,
        confirmed_at: new Date().toISOString(),
      });
      if (!chErr) createdExtraMembers++;
      else insertErrors.push({ name: cName, error: chErr.message });
    }

    const decided_by = payload.synthetic ? null : payload.sub;
    await sb.from('applications').update({
      status: 'approved',
      admin_notes: strOrNull(body.admin_notes) ?? app.admin_notes,
      decided_at: new Date().toISOString(),
      decided_by,
      household_id: hh.id,
      updated_at: new Date().toISOString(),
    }).eq('id', id);

    // ── Welcome email + magic-link token ────────────────────────────────
    // Generate a member_magic_links row so the family can sign in
    // immediately without the magic-link request dance.
    let welcome_dev_link: string | null = null;
    let welcome_sent = false;
    if (app.primary_email) {
      const tok = randomToken();
      const tokHash = await sha256Hex(tok);
      const expIso = new Date(Date.now() + 60 * 60 * 24 * 1000 * 7).toISOString();  // 7 days
      await sb.from('member_magic_links').insert({
        tenant_id: TID, member_id: pm.id,
        token_hash: tokHash, expires_at: expIso,
      });

      const { data: tenant } = await sb.from('tenants')
        .select('display_name, slug').eq('id', TID).maybeSingle();
      const clubName = tenant?.display_name || 'Your club';
      const clubUrl  = tenant ? `https://${tenant.slug}.poolsideapp.com` : '';
      const verifyLink = `${clubUrl}/m/verify.html#token=${encodeURIComponent(tok)}`;

      const { data: settingsRow } = await sb.from('settings')
        .select('value').eq('tenant_id', TID).maybeSingle();
      const venmo = ((settingsRow?.value as Record<string, unknown> | null)?.payments as Record<string, unknown> | undefined)?.venmo_handle;

      // Branch into one of the welcome-email registry templates based on
      // payment status. Admin can customize each variant separately via
      // the Emails admin page. 2026-05-23 — when the applicant opted into
      // "guest checkout" (no_app_member=true), append "_no_app" so they
      // get the warmer, magic-link-free copy.
      let templateKey = 'application_approved_other';
      if (app.payment_status === 'paid') {
        if      (app.payment_method === 'stripe')      templateKey = 'application_approved_stripe_paid';
        else if (app.payment_method === 'venmo')       templateKey = 'application_approved_venmo_verified';
        else if (app.payment_method === 'stripe_plan') templateKey = 'application_approved_plan_first';
      } else if (app.payment_method === 'venmo' && venmo) {
        templateKey = 'application_approved_unpaid_venmo';
      }
      if (app.no_app_member) {
        templateKey = templateKey + '_no_app';
      }

      // For Stripe paths, the welcome email IS the receipt — the submit
      // handler suppresses the "application received" email so the
      // applicant gets exactly one email for the whole flow. We attach
      // the legal-evidence PDF (frozen at submit time) here so it still
      // reaches the family.
      let welcomeAttachments: Array<{ filename: string; content: string; contentType?: string }> | undefined;
      if (app.payment_status === 'paid' && (app.payment_method === 'stripe' || app.payment_method === 'stripe_plan')) {
        try {
          const { loadApplicationForPdf } = await import('../_shared/sync_application.ts');
          const { renderApplicationPdf } = await import('../_shared/application_pdf.ts');
          const { bytesToBase64 } = await import('../_shared/send_email.ts');
          const pdfData = await loadApplicationForPdf(sb, TID, id);
          if (pdfData) {
            const pdfBytes = await renderApplicationPdf(pdfData);
            const safeFamily = (app.family_name || 'Family').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
            const dateStr = new Date().toISOString().slice(0, 10);
            welcomeAttachments = [{
              filename: `${safeFamily}-application-${dateStr}.pdf`,
              content: bytesToBase64(pdfBytes),
              contentType: 'application/pdf',
            }];
          }
        } catch (e) {
          console.error('welcome PDF attach (non-fatal):', (e as Error).message);
        }
      }

      try {
        const { renderAndSend } = await import('../_shared/email_template.ts');
        const r = await renderAndSend(sb, {
          tenantId: TID, templateKey, to: app.primary_email,
          variables: {
            tenant_name: clubName,
            primary_name: app.primary_name,
            sign_in_link: verifyLink,
            venmo_handle: venmo ? String(venmo) : '',
            club_url: clubUrl,
          },
          attachments: welcomeAttachments,
        });
        welcome_sent = r.sent;
      } catch { /* fall through to dev mode */ }
      if (!welcome_sent) welcome_dev_link = verifyLink;

      await sb.from('application_actions').insert({
        application_id: id, tenant_id: TID,
        kind: 'welcome_sent',
        body: welcome_sent ? 'email via Resend' : 'dev mode (link returned)',
        actor_id: decided_by,
      });
    }

    await audit(sb, TID, decided_by, 'tenant_admin', 'application.approve', id,
      `Approved ${app.family_name}; household + ${1 + createdExtraMembers} member${createdExtraMembers === 0 ? '' : 's'} created`);

    // Close the "review application" task that was opened on submit.
    // When this is a combined verify+approve, also close any open
    // venmo.claim task so the dashboard doesn't show a stale row.
    await sb.from('admin_tasks')
      .update({ completed_at: new Date().toISOString(), completed_by: decided_by })
      .eq('tenant_id', TID).eq('source_kind', 'application').eq('source_id', id)
      .in('kind', ['application.submitted', 'venmo.claim'])
      .is('completed_at', null);

    // Auto-link: if the approved primary's email/phone matches an active
    // admin on this tenant, set admin_users.linked_member_id so the system
    // knows that admin is also a member. The "Set up my membership" banner
    // on the admin home checks this flag — once linked, the banner hides.
    await autoLinkAdminToMember(sb, TID, {
      email: app.primary_email as string | null,
      phone: app.primary_phone as string | null,
    }, pm.id);

    return jsonResponse({
      ok: true,
      household_id: hh.id, primary_id: pm.id,
      members_created: 1 + createdExtraMembers,
      welcome_sent, welcome_dev_link,
      // Non-empty list = some members the family submitted couldn't be
      // created (most commonly the per-household 8-member DB cap). Admin
      // sees this in the response and can fix it manually.
      partial_failures: insertErrors.length ? insertErrors : undefined,
    });
  }

  // ── verify_payment (manual, used for Venmo flow) ──────────────────────
  // Membership coordinator clicks "Verify Venmo" — flips application to
  // paid AND flips household.dues_paid_for_year=true. Stamps verified_at /
  // verified_by for audit. Idempotent — safe to call twice.
  if (action === 'verify_payment') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const method = strOrNull(body.method) ?? 'venmo';

    const { data: app } = await sb.from('applications').select(FIELDS)
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.status !== 'approved') {
      return jsonResponse({ ok: false, error: 'Approve the application first' }, 409);
    }

    const verified_by = payload.synthetic ? null : payload.sub;
    const now = new Date().toISOString();
    const { error: updErr } = await sb.from('applications').update({
      payment_status: 'paid',
      payment_method: method,
      paid_at: now,
      verified_at: now,
      verified_by,
      updated_at: now,
    }).eq('id', id).eq('tenant_id', TID);
    if (updErr) return jsonResponse({ ok: false, error: updErr.message }, 500);

    // Flip the household's dues flag for the season this application bought.
    if (app.household_id) {
      await sb.from('households').update({
        dues_paid_for_year: true,
        paid_until_year: (app.membership_year as number | null) ?? new Date().getUTCFullYear(),
      }).eq('id', app.household_id).eq('tenant_id', TID);
    }

    // Audit log (per-application)
    await sb.from('application_actions').insert({
      application_id: id, tenant_id: TID,
      kind: method === 'stripe' ? 'stripe_paid' : 'venmo_verified',
      body: strOrNull(body.note) ?? null,
      actor_id: verified_by,
    });
    // Audit log (tenant-wide)
    await audit(sb, TID, verified_by, 'tenant_admin', 'application.verify_payment', id,
      `Verified ${method} payment for ${app.family_name}`);

    // Close any related open Venmo-claim or application-submitted tasks.
    await sb.from('admin_tasks')
      .update({ completed_at: now, completed_by: verified_by })
      .eq('tenant_id', TID).eq('source_kind', 'application').eq('source_id', id)
      .is('completed_at', null);

    // Run auto-link here too — covers the case where approve happened
    // before the admin row existed (e.g., admin invited later, or the
    // initial approve missed the link due to email mismatch). Idempotent.
    if (app.household_id) {
      const { data: primaryMember } = await sb.from('household_members')
        .select('id').eq('household_id', app.household_id)
        .eq('role', 'primary').maybeSingle();
      if (primaryMember) {
        await autoLinkAdminToMember(sb, TID, {
          email: app.primary_email as string | null,
          phone: app.primary_phone as string | null,
        }, primaryMember.id);
      }
    }

    // Reflect the verification in the Drive sheet (best-effort, write-once).
    const GOOGLE_ID  = Deno.env.get('GOOGLE_CLIENT_ID');
    const GOOGLE_SEC = Deno.env.get('GOOGLE_CLIENT_SECRET');
    if (GOOGLE_ID && GOOGLE_SEC) {
      try {
        const { markVerifiedInDrive } = await import('../_shared/sync_application.ts');
        await markVerifiedInDrive(sb, {
          tenantId: TID, applicationId: id, method,
          googleClientId: GOOGLE_ID, googleClientSecret: GOOGLE_SEC,
        });
      } catch { /* never fails the verify action */ }
    }

    // Notify the member that their payment was verified.
    if (app.primary_email && method === 'venmo') {
      try {
        const { renderAndSend } = await import('../_shared/email_template.ts');
        await renderAndSend(sb, {
          tenantId: TID, templateKey: 'payment_verified_venmo',
          to: app.primary_email as string,
          variables: { primary_name: app.primary_name as string },
        });
      } catch { /* never block verify */ }
    }

    // Trigger referral verification — flips the referral row from 'applied'
    // to 'verified' if eligibility passes, or 'rejected' if the applicant
    // was a returning member. Idempotent — safe if no referral exists.
    try {
      await fetch(`${SUPABASE_URL}/functions/v1/referrals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-poolside-internal': SERVICE_ROLE },
        body: JSON.stringify({ action: 'verify_referral', application_id: id, tenant_id: TID }),
      });
    } catch { /* never block verify */ }

    return jsonResponse({ ok: true });
  }

  // ── send_reminder ─────────────────────────────────────────────────────
  // Records the reminder + bumps the counter. The actual email/SMS is
  // wired to whatever notification infra is configured (Resend if keys
  // are set, else dev_link in the response so admin can copy-paste).
  if (action === 'send_reminder') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    const { data: app } = await sb.from('applications').select(FIELDS)
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.payment_status === 'paid') {
      return jsonResponse({ ok: false, error: 'Already paid — no reminder needed' }, 409);
    }
    if (!app.primary_email && !app.primary_phone) {
      return jsonResponse({ ok: false, error: 'Application has no contact info to remind' }, 400);
    }

    // Try Resend if a key exists; fall back to "dev mode" return.
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const RESEND_FROM    = Deno.env.get('RESEND_FROM') || 'Poolside <onboarding@resend.dev>';
    const { data: tenant } = await sb.from('tenants')
      .select('display_name, slug').eq('id', TID).maybeSingle();
    const clubName = tenant?.display_name || 'Your club';
    const clubUrl  = tenant ? `https://${tenant.slug}.poolsideapp.com` : '';
    let sent = false;
    let dev_link: string | null = null;

    if (RESEND_API_KEY && app.primary_email) {
      const html = `
        <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
          <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">Friendly reminder from ${clubName}</h2>
          <p style="margin:0 0 14px;color:#64748b">Hi ${escapeHtml(app.primary_name)} — your application to ${escapeHtml(clubName)} was approved, but we haven't received your dues payment yet.</p>
          <p style="margin:0 0 14px;color:#64748b">Please send your dues to complete the membership and we'll get your account fully active.</p>
          <p style="margin:24px 0">
            <a href="${clubUrl}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Visit ${escapeHtml(clubName)}</a>
          </p>
          <p style="margin:0;color:#94a3b8;font-size:12px">This is automated — reply to this email if you have questions.</p>
        </div>
      `;
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: RESEND_FROM,
            to: [app.primary_email],
            subject: `Reminder: dues for ${clubName}`,
            html,
          }),
        });
        sent = res.ok;
      } catch { /* fall through to dev mode */ }
    }
    if (!sent) {
      dev_link = `mailto:${app.primary_email ?? ''}?subject=${encodeURIComponent(`Reminder: dues for ${clubName}`)}&body=${encodeURIComponent(`Hi ${app.primary_name},\n\nYour application to ${clubName} was approved, but we haven't received your dues payment yet. Please send your dues to complete your membership.\n\n${clubUrl}\n`)}`;
    }

    const now = new Date().toISOString();
    await sb.from('applications').update({
      reminder_count: (app.reminder_count ?? 0) + 1,
      last_reminder_at: now,
      updated_at: now,
    }).eq('id', id).eq('tenant_id', TID);

    await sb.from('application_actions').insert({
      application_id: id, tenant_id: TID,
      kind: 'reminder_sent',
      body: sent ? 'email via Resend' : 'dev mode (mailto link returned)',
      actor_id: payload.synthetic ? null : payload.sub,
    });

    return jsonResponse({ ok: true, sent, dev_link });
  }

  // ── log (audit trail viewer) ──────────────────────────────────────────
  if (action === 'log') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data, error } = await sb.from('application_actions')
      .select('id, kind, body, actor_id, created_at')
      .eq('application_id', id).eq('tenant_id', TID)
      .order('created_at', { ascending: false }).limit(50);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, log: data ?? [] });
  }

  if (action === 'reject') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const decided_by = payload.synthetic ? null : payload.sub;
    const { data, error } = await sb.from('applications').update({
      status: 'rejected',
      admin_notes: strOrNull(body.admin_notes),
      decided_at: new Date().toISOString(),
      decided_by,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', TID).eq('status', 'pending').select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    if (!data)  return jsonResponse({ ok: false, error: 'Application not pending' }, 409);

    // Send rejection email if the applicant has an email on file.
    if (data.primary_email) {
      try {
        const { renderAndSend } = await import('../_shared/email_template.ts');
        await renderAndSend(sb, {
          tenantId: TID, templateKey: 'application_rejected',
          to: data.primary_email as string,
          variables: {
            primary_name: data.primary_name as string,
            admin_notes: (data.admin_notes as string | null) ?? '',
          },
        });
      } catch { /* never fail the reject because the email hiccupped */ }
    }
    return jsonResponse({ ok: true, application: data });
  }

  // ── purge ──────────────────────────────────────────────────────────────
  // HARD-delete an application + its open admin_tasks. If the application
  // already created a household, refuse and tell the caller to purge from
  // households_admin instead (that path also nukes the household + members).
  // Owner-only (unrecoverable). Doug 2026-05-23.
  if (action === 'purge') {
    if (!(await requireOwner(sb, payload))) {
      return jsonResponse({ ok: false, error: 'Only owners can permanently delete an application' }, 403);
    }
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: app } = await sb.from('applications')
      .select('id, family_name, household_id').eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.household_id) {
      return jsonResponse({
        ok: false,
        error: 'This application created a household. Permanently delete the household instead (Members → Households → Edit → Permanently delete) — it will remove the application too.',
        has_household: true,
      }, 409);
    }
    await sb.from('admin_tasks').delete()
      .eq('tenant_id', TID).eq('source_kind', 'application').eq('source_id', id);
    await sb.from('application_actions').delete().eq('tenant_id', TID).eq('application_id', id);
    const { error } = await sb.from('applications').delete().eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await audit(sb, TID, payload.sub, 'tenant_admin', 'application.purge', id,
      `Permanently deleted application "${app.family_name}"`);
    return jsonResponse({ ok: true, family_name: app.family_name });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});
