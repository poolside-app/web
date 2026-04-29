// =============================================================================
// tenants_admin — Provider-side tenant management
// =============================================================================
// Authenticated by provider-admin JWT (HS256 with ADMIN_JWT_SECRET, kind='provider').
// Uses service role for DB access (bypasses RLS).
//
// Actions:
//
//   { action: 'list' }
//     → { ok, tenants: [...] }
//
//   { action: 'create', slug, display_name, plan?, status? }
//     → { ok, tenant }
//
//   { action: 'update', id, ...patch }
//     → { ok, tenant }
//
//   { action: 'delete', id }   ← soft-delete (status = 'churned')
//     → { ok }
//
// All actions require Authorization: Bearer <provider-admin token>.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import bcrypt from 'https://esm.sh/bcryptjs@2.4.3';
import { create, verify, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

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

async function verifyProviderToken(token: string): Promise<string | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const payload = await verify(token, key) as { sub?: string; kind?: string };
    if (payload.kind !== 'provider' || !payload.sub) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

const VALID_PLANS = ['free', 'starter', 'pro', 'enterprise'];
const VALID_STATUSES = ['trial', 'active', 'suspended', 'churned'];

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// Same helper as in tenant_signup — adds <slug>.poolsideapp.com to the Vercel
// project. Best-effort; if Vercel hiccups, the tenant is still created.
async function addVercelSubdomain(slug: string): Promise<{ ok: boolean; error?: string }> {
  const token     = Deno.env.get('VERCEL_API_TOKEN');
  const projectId = Deno.env.get('VERCEL_PROJECT_ID');
  if (!token || !projectId) {
    return { ok: false, error: 'VERCEL_API_TOKEN or VERCEL_PROJECT_ID not set' };
  }
  const domain = `${slug}.poolsideapp.com`;
  try {
    const res = await fetch(`https://api.vercel.com/v10/projects/${projectId}/domains`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: domain }),
    });
    if (res.ok) return { ok: true };
    if (res.status === 409) return { ok: true };
    const txt = await res.text();
    console.warn(`[tenants_admin] Vercel domain add failed for ${domain}:`, res.status, txt);
    return { ok: false, error: `Vercel ${res.status}: ${txt.slice(0, 200)}` };
  } catch (e) {
    console.warn(`[tenants_admin] Vercel API error:`, e);
    return { ok: false, error: String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  // Verify token
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const adminId = token ? await verifyProviderToken(token) : null;
  if (!adminId) return jsonResponse({ ok: false, error: 'Invalid or expired session' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Confirm provider admin still active
  const { data: caller } = await sb.from('provider_admins')
    .select('id, active, is_super').eq('id', adminId).maybeSingle();
  if (!caller || !caller.active) {
    return jsonResponse({ ok: false, error: 'Provider admin not found or inactive' }, 401);
  }

  // ── list ───────────────────────────────────────────────────────────────
  if (action === 'list') {
    const { data, error } = await sb.from('tenants')
      .select('id, slug, display_name, custom_domain, status, plan, trial_ends_at, stripe_customer_id, notes, created_at, updated_at')
      .order('created_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    // Optional: enrich with member counts per tenant
    const ids = (data ?? []).map(t => t.id);
    let counts: Record<string, number> = {};
    if (ids.length) {
      const { data: countRows } = await sb.from('households')
        .select('tenant_id, id')
        .in('tenant_id', ids);
      counts = (countRows ?? []).reduce((acc, r) => {
        acc[r.tenant_id as string] = (acc[r.tenant_id as string] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
    }
    const enriched = (data ?? []).map(t => ({
      ...t,
      household_count: counts[t.id as string] || 0,
    }));
    return jsonResponse({ ok: true, tenants: enriched });
  }

  // ── create ─────────────────────────────────────────────────────────────
  if (action === 'create') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    const display_name = String(body.display_name ?? '').trim();
    if (!slug) return jsonResponse({ ok: false, error: 'Slug is required' }, 400);
    if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(slug)) {
      return jsonResponse({ ok: false, error: 'Slug must be 2–30 chars, lowercase letters / numbers / hyphens, starting with a letter or number' }, 400);
    }
    if (!display_name) return jsonResponse({ ok: false, error: 'Display name is required' }, 400);

    const plan = strOrNull(body.plan) ?? 'free';
    if (!VALID_PLANS.includes(plan)) {
      return jsonResponse({ ok: false, error: `Plan must be one of: ${VALID_PLANS.join(', ')}` }, 400);
    }
    const status = strOrNull(body.status) ?? 'trial';
    if (!VALID_STATUSES.includes(status)) {
      return jsonResponse({ ok: false, error: `Status must be one of: ${VALID_STATUSES.join(', ')}` }, 400);
    }
    const notes = strOrNull(body.notes);

    const { data, error } = await sb.from('tenants').insert({
      slug, display_name, plan, status, notes,
    }).select().single();
    if (error) {
      if (error.message.includes('duplicate') || error.message.includes('unique')) {
        return jsonResponse({ ok: false, error: `Slug "${slug}" is already taken` }, 409);
      }
      return jsonResponse({ ok: false, error: error.message }, 500);
    }

    // Seed an empty settings row
    await sb.from('settings').insert({ tenant_id: data.id, value: {} });

    // Auto-provision the Vercel subdomain
    const vercel = await addVercelSubdomain(data.slug);

    return jsonResponse({
      ok: true,
      tenant: data,
      subdomain_provisioned: vercel.ok,
      subdomain_warning: vercel.ok ? null : vercel.error,
    });
  }

  // ── update ─────────────────────────────────────────────────────────────
  if (action === 'update') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    const patch: Record<string, unknown> = {};
    if (body.display_name !== undefined) {
      const v = String(body.display_name ?? '').trim();
      if (!v) return jsonResponse({ ok: false, error: 'Display name cannot be empty' }, 400);
      patch.display_name = v;
    }
    if (body.plan !== undefined) {
      const v = String(body.plan).toLowerCase();
      if (!VALID_PLANS.includes(v)) {
        return jsonResponse({ ok: false, error: `Plan must be one of: ${VALID_PLANS.join(', ')}` }, 400);
      }
      patch.plan = v;
    }
    if (body.status !== undefined) {
      const v = String(body.status).toLowerCase();
      if (!VALID_STATUSES.includes(v)) {
        return jsonResponse({ ok: false, error: `Status must be one of: ${VALID_STATUSES.join(', ')}` }, 400);
      }
      patch.status = v;
    }
    if (body.custom_domain !== undefined) patch.custom_domain = strOrNull(body.custom_domain);
    if (body.notes !== undefined)         patch.notes         = strOrNull(body.notes);
    if (body.trial_ends_at !== undefined) patch.trial_ends_at = body.trial_ends_at;

    if (Object.keys(patch).length === 0) {
      return jsonResponse({ ok: true, noop: true });
    }

    const { data, error } = await sb.from('tenants').update(patch).eq('id', id).select().single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, tenant: data });
  }

  // ── list_admins ────────────────────────────────────────────────────────
  if (action === 'list_admins') {
    const tenant_id = String(body.tenant_id ?? '');
    if (!tenant_id) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    const { data, error } = await sb.from('admin_users')
      .select('id, email, username, display_name, is_super, is_default_pw, active, created_at')
      .eq('tenant_id', tenant_id)
      .order('created_at', { ascending: true });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, admins: data ?? [] });
  }

  // ── create_admin ───────────────────────────────────────────────────────
  // Provider creates the first (or an additional) tenant admin. Sets
  // is_default_pw=true so the new admin is forced to change the password
  // on first login.
  if (action === 'create_admin') {
    const tenant_id    = String(body.tenant_id ?? '');
    const email        = String(body.email ?? '').trim().toLowerCase();
    const password     = String(body.password ?? '');
    const display_name = strOrNull(body.display_name) ?? (email ? email.split('@')[0] : null);
    if (!tenant_id) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    if (!email || !email.includes('@') || email.length > 200) {
      return jsonResponse({ ok: false, error: 'Valid email is required' }, 400);
    }
    if (!password || password.length < 10) {
      return jsonResponse({ ok: false, error: 'Password must be at least 10 characters' }, 400);
    }

    const { data: tenant } = await sb.from('tenants')
      .select('id').eq('id', tenant_id).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Tenant not found' }, 404);

    const { data: clash } = await sb.from('admin_users')
      .select('id').eq('tenant_id', tenant_id)
      .or(`email.eq.${email},username.eq.${email}`).maybeSingle();
    if (clash) return jsonResponse({ ok: false, error: 'An admin with that email already exists for this tenant' }, 409);

    const password_hash = await bcrypt.hash(password, 10);
    const { data: admin, error: aErr } = await sb.from('admin_users').insert({
      tenant_id, username: email, email, password_hash, display_name,
      is_super: true, is_default_pw: true, active: true,
    }).select('id, email, display_name').single();
    if (aErr || !admin) return jsonResponse({ ok: false, error: aErr?.message || 'Could not create admin' }, 500);

    // Assign the system 'super-admin' role if it exists (best-effort).
    const { data: superRole } = await sb.from('admin_roles')
      .select('id').eq('slug', 'super-admin').is('tenant_id', null).maybeSingle();
    if (superRole) {
      await sb.from('admin_user_roles').insert({
        admin_user_id: admin.id, admin_role_id: superRole.id,
      });
    }
    return jsonResponse({ ok: true, admin });
  }

  // ── impersonate ────────────────────────────────────────────────────────
  // Provider mints a short-lived tenant_admin token for any tenant. Used
  // for in-product support and to access tenants that don't have an admin
  // yet (e.g. seeded tenants like bishopestates). Token is 1 hour so the
  // blast radius stays small if it leaks.
  if (action === 'impersonate') {
    const tenant_id = String(body.tenant_id ?? '');
    if (!tenant_id) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    if (!JWT_SECRET) return jsonResponse({ ok: false, error: 'ADMIN_JWT_SECRET not set' }, 500);

    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name').eq('id', tenant_id).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Tenant not found' }, 404);

    // Find any active super_admin user. If none, manufacture a synthetic
    // identity so the provider can still poke around — but mark the token
    // so the rest of the system can audit it later if we want.
    const { data: existing } = await sb.from('admin_users')
      .select('id, email, display_name, is_super')
      .eq('tenant_id', tenant_id).eq('active', true)
      .order('is_super', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1).maybeSingle();

    let sub: string;
    let displayName: string;
    let email: string;
    let synthetic = false;

    if (existing) {
      sub = existing.id as string;
      email = (existing.email as string) || '';
      displayName = (existing.display_name as string) || email || 'Provider';
    } else {
      // No real admin user exists. Use the provider admin's own id as the
      // sub so foreign keys never resolve to a real tenant admin row.
      sub = adminId;  // provider admin id
      email = 'provider@poolsideapp.com';
      displayName = 'Provider (impersonating)';
      synthetic = true;
    }

    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const token = await create(
      { alg: 'HS256', typ: 'JWT' },
      {
        sub, kind: 'tenant_admin',
        tid: tenant.id, slug: tenant.slug,
        impersonated_by: adminId,
        synthetic,
        exp: getNumericDate(60 * 60 * 24),  // 24 hours — long enough that provider
                                            // testing doesn't churn through tokens
      },
      key,
    );
    return jsonResponse({
      ok: true,
      token,
      tenant: { slug: tenant.slug, display_name: tenant.display_name },
      user:   { id: sub, email, display_name: displayName },
      synthetic,
    });
  }

  // ── impersonate_member ─────────────────────────────────────────────────
  // Provider mints a 24-hour member token for any active household member of
  // the tenant. Lets us test the /m/ surface end-to-end without bouncing
  // through email magic links. Body can specify member_id; if not, we pick
  // the most recently active member of the tenant.
  if (action === 'impersonate_member') {
    const tenant_id = String(body.tenant_id ?? '');
    if (!tenant_id) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    if (!JWT_SECRET) return jsonResponse({ ok: false, error: 'ADMIN_JWT_SECRET not set' }, 500);

    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name').eq('id', tenant_id).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Tenant not found' }, 404);

    let member;
    const memberId = strOrNull(body.member_id);
    if (memberId) {
      const { data } = await sb.from('household_members')
        .select('id, name, email, household_id, active')
        .eq('id', memberId).eq('tenant_id', tenant_id).maybeSingle();
      member = data;
    } else {
      // Most recently seen → most recently created → first active member
      const { data } = await sb.from('household_members')
        .select('id, name, email, household_id, active, last_seen_at, created_at')
        .eq('tenant_id', tenant_id).eq('active', true)
        .order('last_seen_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(1).maybeSingle();
      member = data;
    }
    if (!member || !member.active) {
      return jsonResponse({ ok: false, error: 'No active household member to impersonate. Add one first via Households.' }, 404);
    }

    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const token = await create(
      { alg: 'HS256', typ: 'JWT' },
      {
        sub: member.id, kind: 'member',
        tid: tenant.id, slug: tenant.slug, hid: member.household_id,
        impersonated_by: adminId,
        exp: getNumericDate(60 * 60 * 24),  // 24 hours
      },
      key,
    );
    return jsonResponse({
      ok: true,
      token,
      tenant: { slug: tenant.slug, display_name: tenant.display_name },
      user: { id: member.id, name: member.name, email: member.email },
    });
  }

  // ── seed_demo_data ─────────────────────────────────────────────────────
  // Provider-only: fill a tenant with realistic households, events, posts,
  // and photos so every surface has content to look at. Idempotent-ish:
  // existing data is left alone unless `wipe: true` is passed.
  if (action === 'seed_demo_data') {
    const tenant_id = String(body.tenant_id ?? '');
    if (!tenant_id) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    const wipe = body.wipe === true;

    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name').eq('id', tenant_id).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Tenant not found' }, 404);

    if (wipe) {
      // Cascade FKs handle most child rows; deleting parent records here.
      await sb.from('photos').delete().eq('tenant_id', tenant_id);
      await sb.from('posts').delete().eq('tenant_id', tenant_id);
      await sb.from('events').delete().eq('tenant_id', tenant_id);
      await sb.from('party_bookings').delete().eq('tenant_id', tenant_id);
      await sb.from('households').delete().eq('tenant_id', tenant_id);
    }

    // ── households + members ──────────────────────────────────────────
    // Phone collisions across tenants are fine — index is per-tenant active.
    // Stamp the phone block per-call so re-seeds without wipe still work.
    const stamp = String(Date.now()).slice(-5);
    const FAMILIES = [
      { fam: 'Lopez',  primary: ['Maria',  '+155501' + stamp + '01'], spouse: ['Carlos', '+155501' + stamp + '02'], kids: [['Sofia','teen'], ['Diego','child']] },
      { fam: 'Patel',  primary: ['Aisha',  '+155501' + stamp + '03'], spouse: ['Raj',    '+155501' + stamp + '04'], kids: [['Zara','child']] },
      { fam: 'Carter', primary: ['James',  '+155501' + stamp + '05'], spouse: ['Emma',   '+155501' + stamp + '06'], kids: [['Lily','teen'], ['Noah','child'], ['Ava','child']] },
      { fam: 'OBrien', primary: ['Sean',   '+155501' + stamp + '07'], spouse: ['Megan',  '+155501' + stamp + '08'], kids: [] },
      { fam: 'Nguyen', primary: ['Linh',   '+155501' + stamp + '09'], spouse: ['Tuan',   '+155501' + stamp + '10'], kids: [['Khoa','teen']] },
    ];

    const householdsCreated: string[] = [];
    const membersCreated: string[] = [];
    for (let i = 0; i < FAMILIES.length; i++) {
      const f = FAMILIES[i];
      const { data: hh, error: hhErr } = await sb.from('households').insert({
        tenant_id, family_name: `The ${f.fam}s`, tier: 'family',
        fob_number: `${1000 + i}`,
        dues_paid_for_year: i % 2 === 0,
        paid_until_year: new Date().getFullYear(),
        address: `${100 + i * 4} Maple Street`, city: 'Concord', zip: '94521',
        active: true,
      }).select('id').single();
      if (hhErr || !hh) continue;
      householdsCreated.push(hh.id);

      // Primary contact
      const { data: pm } = await sb.from('household_members').insert({
        tenant_id, household_id: hh.id,
        name: `${f.primary[0]} ${f.fam}`, phone_e164: f.primary[1],
        email: `${f.primary[0].toLowerCase()}.${f.fam.toLowerCase()}@example.com`,
        role: 'primary', can_unlock_gate: true, can_book_parties: true,
        active: true, confirmed_at: new Date().toISOString(),
      }).select('id').single();
      if (pm) membersCreated.push(pm.id);

      // Spouse + kids
      const { data: sp } = await sb.from('household_members').insert({
        tenant_id, household_id: hh.id,
        name: `${f.spouse[0]} ${f.fam}`, phone_e164: f.spouse[1],
        email: `${f.spouse[0].toLowerCase()}.${f.fam.toLowerCase()}@example.com`,
        role: 'adult', can_unlock_gate: true, can_book_parties: true,
        active: true, confirmed_at: new Date().toISOString(),
      }).select('id').single();
      if (sp) membersCreated.push(sp.id);

      for (const [kidName, kidRole] of f.kids) {
        const { data: kid } = await sb.from('household_members').insert({
          tenant_id, household_id: hh.id,
          name: `${kidName} ${f.fam}`, role: kidRole,
          can_unlock_gate: kidRole === 'teen', can_book_parties: false,
          active: true, confirmed_at: new Date().toISOString(),
        }).select('id').single();
        if (kid) membersCreated.push(kid.id);
      }
    }

    // ── events ────────────────────────────────────────────────────────
    const day = 86400_000;
    const now = Date.now();
    const at = (offset: number, h: number) => {
      const d = new Date(now + offset * day);
      d.setHours(h, 0, 0, 0);
      return d.toISOString();
    };
    const eventsToInsert = [
      { title: 'Memorial Day BBQ',     kind: 'party',     starts_at: at(7,  12), ends_at: at(7,  18), location: 'Pool deck',  body: 'Burgers + dogs on us. Bring a side to share.' },
      { title: 'Summer Swim Meet',     kind: 'swim_meet', starts_at: at(14, 9),  ends_at: at(14, 12), location: 'Main pool',  body: 'Home meet vs. Twin Oaks. Cheer loud!' },
      { title: 'Pool closed for chemicals', kind: 'closure', starts_at: at(3,  8), ends_at: at(3,  18), location: 'Whole pool', body: 'Annual deep treatment. Back to normal hours next day.' },
      { title: 'Board Meeting',        kind: 'meeting',   starts_at: at(10, 19), ends_at: at(10, 20), location: 'Clubhouse', body: 'All members welcome.' },
    ];
    const eventsCreated: string[] = [];
    for (const ev of eventsToInsert) {
      const { data } = await sb.from('events').insert({
        tenant_id, ...ev, all_day: false, active: true,
      }).select('id').single();
      if (data) eventsCreated.push(data.id);
    }

    // ── posts ─────────────────────────────────────────────────────────
    const postsToInsert = [
      { title: '🏊 Welcome to the 2026 season!', body: "Pool's open Memorial Day through Labor Day. Hours are posted on the home page. Sign in with your email to see your household, request parties, and get notified when things change.", pinned: true },
      { title: 'Dues reminder',          body: 'Annual dues are due May 15. Click "Pay via Venmo" on the home page or drop a check at the clubhouse. Late fee kicks in May 16.', pinned: false },
      { title: 'Lifeguard hiring',        body: "We're short two lifeguards for July. If you have a teen with current certification, send them our way!", pinned: false },
    ];
    const postsCreated: string[] = [];
    for (const p of postsToInsert) {
      const { data } = await sb.from('posts').insert({
        tenant_id, ...p, active: true,
      }).select('id').single();
      if (data) postsCreated.push(data.id);
    }

    // ── photos (placeholder service, stable seeds) ────────────────────
    const photoSeeds = ['poolsideA', 'poolsideB', 'poolsideC', 'poolsideD', 'poolsideE', 'poolsideF'];
    const photosCreated: string[] = [];
    for (let i = 0; i < photoSeeds.length; i++) {
      const url = `https://picsum.photos/seed/${photoSeeds[i]}/1200/800`;
      const { data } = await sb.from('photos').insert({
        tenant_id, url, sort_order: i,
        caption: i === 0 ? 'Opening weekend, summer 2026' : null,
        active: true,
      }).select('id').single();
      if (data) photosCreated.push(data.id);
    }

    return jsonResponse({
      ok: true,
      summary: {
        households: householdsCreated.length,
        members:    membersCreated.length,
        events:     eventsCreated.length,
        posts:      postsCreated.length,
        photos:     photosCreated.length,
        wiped:      wipe,
      },
    });
  }

  // ── delete (soft) ──────────────────────────────────────────────────────
  if (action === 'delete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('tenants')
      .update({ status: 'churned' }).eq('id', id);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});
