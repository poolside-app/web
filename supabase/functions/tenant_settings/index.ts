// =============================================================================
// tenant_settings — Read/write the per-tenant settings JSONB
// =============================================================================
// Auth: tenant admin token (HS256, kind='tenant_admin'). Tenant scope is
// pulled from the token, never the body, so an admin can't write to another
// tenant's settings.
//
// Actions:
//
//   { action: 'get' }
//     → { ok, settings, tenant: { display_name, slug } }
//
//   { action: 'save', value, display_name?, timezone? }
//     • value: JSON object (replaces settings.value)
//     • display_name: if provided, also updates tenants.display_name
//     • timezone: IANA name (e.g. America/Chicago); updates tenants.timezone
//     → { ok }
//
//   { action: 'setup_status' }   // the one setup checklist (dashboard)
//     → { ok, percent, done, total, items: [{ id, label, done, fix_url, fix_label, why, can_skip? }] }
//     Shown on the dashboard; other admin pages show a one-line reminder.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { requireOwner } from '../_shared/auth.ts';
import { validTimeZone } from '../_shared/pool_time.ts';

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

type Payload = { sub: string; kind: string; tid: string; slug: string };

async function verifyTenantAdmin(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const payload = await verify(token, key) as Record<string, unknown>;
    if (payload.kind !== 'tenant_admin') return null;
    if (!payload.sub || !payload.tid || !payload.slug) return null;
    return payload as unknown as Payload;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── get ────────────────────────────────────────────────────────────────
  if (action === 'get') {
    const [{ data: settings }, { data: tenant }] = await Promise.all([
      sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle(),
      sb.from('tenants').select('slug, display_name, status, plan, timezone').eq('id', payload.tid).maybeSingle(),
    ]);
    return jsonResponse({
      ok: true,
      settings: settings?.value ?? {},
      tenant: tenant ?? null,
    });
  }

  // ── save ───────────────────────────────────────────────────────────────
  if (action === 'save') {
    // OWNER ONLY: settings include payment config, branding, tier prices —
    // any tenant_admin shouldn't be able to silently rewrite these.
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can change club settings' }, 403);
    }
    const value = (body.value ?? {}) as Record<string, unknown>;
    if (typeof value !== 'object' || Array.isArray(value)) {
      return jsonResponse({ ok: false, error: '`value` must be a JSON object' }, 400);
    }
    // Checked before anything is written, so a bad zone saves nothing.
    if (body.timezone !== undefined && !validTimeZone(body.timezone)) {
      return jsonResponse({ ok: false, error: 'Unknown time zone' }, 400);
    }

    // Upsert settings row, merging with what's already there so a save from
    // one surface doesn't clobber keys managed by another.
    //
    // This used to be a TOP-LEVEL shallow merge — `{...existing, ...value}` —
    // which preserved sibling groups but replaced any group it touched
    // wholesale. Different surfaces write different subsets of the same
    // group, so each one silently deleted the other's fields:
    //
    //   * payments: the Payments page writes venmo_handle, paypal_link,
    //     offline_verify_window_days and pass_stripe_fee. The setup wizard
    //     writes only the first two. Re-running the wizard therefore reset
    //     pass_stripe_fee — which stripe_checkout, renewal_quote and
    //     payment_plans all read to decide whether the MEMBER pays the
    //     Stripe fee. A club could re-run setup and quietly start eating
    //     card fees it had chosen to pass on.
    //   * club: the wizard writes city/state/country; the settings page
    //     does not, so saving Club info dropped them. (That one self-heals,
    //     because the wizard re-derives them by splitting `location`.)
    //
    // Now merges plain objects recursively. Arrays and scalars are replaced
    // outright, which is what callers expect: membership_tiers is an array
    // and must be settable to a shorter list, and an explicit `null` has to
    // stay a real "clear this field" instruction rather than being ignored.
    const isPlainObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v);

    function deepMerge(
      base: Record<string, unknown>,
      patch: Record<string, unknown>,
    ): Record<string, unknown> {
      const out: Record<string, unknown> = { ...base };
      for (const [k, v] of Object.entries(patch)) {
        out[k] = isPlainObject(v) && isPlainObject(base[k])
          ? deepMerge(base[k] as Record<string, unknown>, v)
          : v;
      }
      return out;
    }

    const { data: existing } = await sb.from('settings')
      .select('value').eq('tenant_id', payload.tid).maybeSingle();
    if (existing) {
      const merged = deepMerge(
        (existing.value ?? {}) as Record<string, unknown>,
        value,
      );
      const { error } = await sb.from('settings')
        .update({ value: merged }).eq('tenant_id', payload.tid);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    } else {
      const { error } = await sb.from('settings')
        .insert({ tenant_id: payload.tid, value });
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    }

    // Optionally update the tenant display_name in lockstep with the wizard.
    if (typeof body.display_name === 'string') {
      const dn = body.display_name.trim();
      if (dn) {
        await sb.from('tenants').update({ display_name: dn }).eq('id', payload.tid);
      }
    }
    if (typeof body.timezone === 'string') {
      const { error } = await sb.from('tenants').update({ timezone: body.timezone }).eq('id', payload.tid);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    }

    return jsonResponse({ ok: true });
  }

  // ── Seasons (PLAN.md U2, Doug 2026-10-08) ──────────────────────────────
  // One current season for the whole club, changed only by the board's
  // "Close 2026 and start 2027" button (it replaced "next season goes on
  // sale in"). The checklist after closing has items the board ticks and a
  // few Poolside can see for itself.
  const SEASON_ITEMS = [
    { id: 'prices', label: 'Check the membership prices', link: '/club/admin/payments.html?focus=prices' },
    { id: 'deadlines', label: 'Check the payment plan deadlines', link: '/club/admin/payments.html#plans' },
    { id: 'policies', label: 'Review the policies and waiver', link: '/club/admin/policies.html' },
    { id: 'opening', label: 'Set opening and closing day', link: '/club/admin/settings.html?focus=season#season', auto: true },
    { id: 'renewal', label: 'Send the renewal message to last season\'s members', link: '/club/admin/members.html#renewals', auto: true },
  ];
  async function seasonStatus() {
    const { data: row } = await sb.from('settings').select('value').eq('tenant_id', payload!.tid).maybeSingle();
    const sv = (row?.value ?? {}) as Record<string, unknown>;
    const { sellingYear } = await import('../_shared/membership_year.ts');
    const season = sellingYear(sv);
    const membership = (sv.membership ?? {}) as Record<string, unknown>;
    const [{ count: paid }, { count: lastPaid }, { data: sent }] = await Promise.all([
      sb.from('households').select('id', { count: 'exact', head: true }).eq('tenant_id', payload!.tid).eq('active', true).gte('paid_until_year', season),
      sb.from('households').select('id', { count: 'exact', head: true }).eq('tenant_id', payload!.tid).eq('active', true).eq('paid_until_year', season - 1),
      sb.from('audit_log').select('id').eq('tenant_id', payload!.tid).eq('kind', 'renewals.send_blast').contains('metadata', { year: season }).limit(1),
    ]);
    const ticks = (((sv.season_checklist ?? {}) as Record<string, Record<string, boolean>>)[String(season)]) ?? {};
    const seasonInfo = (sv.season ?? {}) as Record<string, unknown>;
    const autoDone: Record<string, boolean> = {
      opening: String(seasonInfo.start_date ?? '').startsWith(String(season)),
      renewal: (sent ?? []).length > 0,
    };
    return {
      season, pinned: Number(membership.year) > 2000, next: season + 1,
      paid: paid ?? 0, last_season_paid: lastPaid ?? 0,
      checklist: SEASON_ITEMS.map(i => ({ ...i, done: !!(ticks[i.id] || autoDone[i.id]) })),
      history: Array.isArray(sv.season_history) ? sv.season_history : [],
    };
  }

  if (action === 'season_status') {
    const st = await seasonStatus();
    // A club that never pressed the button had its season worked out from a
    // month; fix it now, so the season only ever changes on the button.
    if (!st.pinned) {
      const { data: row } = await sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle();
      const sv = (row?.value ?? {}) as Record<string, unknown>;
      await sb.from('settings').update({ value: { ...sv, membership: { ...((sv.membership ?? {}) as Record<string, unknown>), year: st.season } } }).eq('tenant_id', payload.tid);
      st.pinned = true;
    }
    return jsonResponse({ ok: true, ...st });
  }

  // Tick (or untick) a checklist item for the current season.
  if (action === 'season_check') {
    if (!(await requireOwner(sb, payload as never))) return jsonResponse({ ok: false, error: 'Only owners can change the season checklist' }, 403);
    const item = String(body.item ?? '');
    if (!SEASON_ITEMS.some(i => i.id === item)) return jsonResponse({ ok: false, error: 'Unknown item' }, 400);
    const st = await seasonStatus();
    const { data: row } = await sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle();
    const sv = (row?.value ?? {}) as Record<string, unknown>;
    const all = { ...((sv.season_checklist ?? {}) as Record<string, Record<string, boolean>>) };
    all[String(st.season)] = { ...(all[String(st.season)] ?? {}), [item]: body.done !== false };
    const { error } = await sb.from('settings').update({ value: { ...sv, season_checklist: all } }).eq('tenant_id', payload.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, ...(await seasonStatus()) });
  }

  // "Close 2026 and start 2027". `from` must be the current season, so a
  // second tap (or a stale page) can't skip a year. Families paid for the old
  // season stay members until January 1 of the new one (PLAN.md U3).
  if (action === 'close_season') {
    if (!(await requireOwner(sb, payload as never))) return jsonResponse({ ok: false, error: 'Only owners can start a new season' }, 403);
    const st = await seasonStatus();
    if (Number(body.from) !== st.season) return jsonResponse({ ok: false, error: `The current season is ${st.season}. Reload the page.` }, 409);
    const { data: row } = await sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle();
    const sv = (row?.value ?? {}) as Record<string, unknown>;
    const nowIso = new Date().toISOString();
    const history = [...(Array.isArray(sv.season_history) ? sv.season_history : []),
      { year: st.season, paid: st.paid, closed_at: nowIso, closed_by: payload.sub }].slice(-20);
    const next = {
      ...sv,
      membership: { ...((sv.membership ?? {}) as Record<string, unknown>), year: st.season + 1 },
      season_history: history,
    };
    const { error } = await sb.from('settings').update({ value: next }).eq('tenant_id', payload.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await sb.from('audit_log').insert({
      tenant_id: payload.tid, kind: 'season.closed', entity_type: 'tenant', entity_id: payload.tid,
      summary: `Closed the ${st.season} season (${st.paid} paid) and started ${st.season + 1}`,
      actor_id: payload.sub, actor_kind: 'tenant_admin', actor_label: payload.sub,
      metadata: { from: st.season, to: st.season + 1, paid: st.paid },
    });
    return jsonResponse({ ok: true, ...(await seasonStatus()) });
  }

  // ── setup_status ───────────────────────────────────────────────────────
  // THE setup checklist (J1, 2026-09-26). It replaced the setup wizard, the
  // "Finish setting up" page, a second dashboard checklist and the "are you
  // using the pool too?" card, which each kept a different list. The
  // dashboard shows it; other admin pages show a one-line reminder linking
  // to it. Every item opens the real settings screen, so there is exactly
  // one place to change each thing. Read-only, so any board member can see
  // it; "sign up your own family" is about the caller.
  if (action === 'setup_status') {
    const [tenantRes, settingsRes, policyRes, adminsRes, meRes] = await Promise.all([
      sb.from('tenants').select('display_name, slug, stripe_account_id, stripe_charges_enabled')
        .eq('id', payload.tid).maybeSingle(),
      sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle(),
      sb.from('policies').select('id', { count: 'exact', head: true })
        .eq('tenant_id', payload.tid).eq('active', true),
      // Who holds a board position (PLAN.md K5): the board is set up once
      // someone besides the founder holds one.
      sb.from('board_position_holders').select('admin_user_id, admin_users!inner(active)')
        .eq('tenant_id', payload.tid).eq('admin_users.active', true),
      sb.from('admin_users').select('linked_member_id, member_apply_dismissed')
        .eq('id', payload.sub).eq('tenant_id', payload.tid).maybeSingle(),
    ]);

    const tenant = (tenantRes.data || {}) as Record<string, unknown>;
    const sv = ((settingsRes.data?.value as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
    const branding = (sv.branding as Record<string, unknown> | undefined) ?? {};
    const hero = (sv.hero as Record<string, unknown> | undefined) ?? {};
    const pool = (sv.pool as Record<string, unknown> | undefined) ?? {};
    const club = (sv.club as Record<string, unknown> | undefined) ?? {};
    const payments = (sv.payments as Record<string, unknown> | undefined) ?? {};
    const onboarding = (sv.onboarding as Record<string, unknown> | undefined) ?? {};
    const tiers = (sv.membership_tiers as Array<unknown> | undefined) ?? [];
    const me = (meRes.data ?? {}) as Record<string, unknown>;

    const stripeLinked = !!tenant.stripe_account_id;
    const stripeReady = stripeLinked && !!tenant.stripe_charges_enabled;
    const venmoSet = !!(payments.venmo_handle && String(payments.venmo_handle).trim());

    // fix_url ends with ?focus=<id> where it can, so /js/focus-highlight.js
    // scrolls to and pulses the right section.
    const items = [
      { id: 'logo', label: 'Upload your club logo', done: !!(branding.logo_url || branding.logo),
        fix_url: '/club/admin/settings.html?focus=logo', fix_label: 'Upload logo',
        why: 'Shows in your header, the member app and emails.' },
      { id: 'hero', label: 'Write your front-page headline', done: !!(hero.headline && String(hero.headline).trim()),
        fix_url: '/club/admin/settings.html?focus=hero', fix_label: 'Write it',
        why: 'The big line at the top of your public page.' },
      { id: 'location', label: 'Set your pool location and hours',
        done: !!((club.location || (pool.lat && pool.lng)) && pool.opens_at && pool.closes_at),
        fix_url: '/club/admin/settings.html?focus=pool', fix_label: 'Set them',
        why: 'Shows on your public page, the member app and the calendar.' },
      { id: 'prices', label: 'Set your membership prices', done: tiers.length > 0,
        fix_url: '/club/admin/payments.html?focus=prices', fix_label: 'Set prices',
        why: 'The signup form needs at least one membership level to work.' },
      { id: 'payment', label: 'Choose how members pay', done: venmoSet || stripeReady,
        fix_url: '/club/admin/payments.html?focus=venmo', fix_label: 'Set up',
        why: stripeLinked && !stripeReady
          ? 'Stripe is connected but not finished, so cards don\'t work yet. Finish it on the Payments page, or add Venmo.'
          : 'Venmo (free, checked by hand) or cards through Stripe (paid automatically).' },
      { id: 'policies', label: 'Add your policies and waiver', done: (policyRes.count ?? 0) > 0,
        fix_url: '/club/admin/policies.html?focus=policies', fix_label: 'Add them',
        why: 'Families agree to these when they sign up.' },
      { id: 'self_signup', label: 'Sign up your own family', done: !!me.linked_member_id || !!me.member_apply_dismissed,
        fix_url: '/apply.html?prefill=admin', fix_label: 'Sign up',
        why: 'Same form your members use, so you see it the way they do. Not a swimmer? Mark it done.',
        can_skip: !me.linked_member_id && !me.member_apply_dismissed },
      { id: 'invite_board', label: 'Set up your board positions',
        done: new Set(((adminsRes.data ?? []) as Array<{ admin_user_id: string }>).map(h => h.admin_user_id)).size > 1,
        fix_url: '/club/admin/board.html', fix_label: 'Set up',
        why: 'Each position gets its own alerts and screens: the treasurer gets payments, the facilities person gets the gate.' },
      { id: 'share_link', label: 'Share your join link with members', done: !!onboarding.apply_link_shared,
        fix_url: '/club/admin/#apply-link-card', fix_label: 'Show me',
        why: `Families join at ${tenant.slug ? `${tenant.slug}.poolsideapp.com/apply.html` : 'your apply page'}.` },
    ];

    const done = items.filter(i => i.done).length;
    return jsonResponse({
      ok: true,
      done,
      total: items.length,
      percent: Math.round((done / items.length) * 100),
      complete: done === items.length,
      items,
    });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});
