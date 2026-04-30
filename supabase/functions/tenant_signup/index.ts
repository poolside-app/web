// =============================================================================
// tenant_signup — Public-facing tenant creation
// =============================================================================
// No-auth Edge Function called from /signup.html on the public marketing site.
// Creates a new tenant + their first admin_user atomically. After this
// returns ok, the new admin can immediately log in at the tenant's admin URL.
//
// Body:
//   { slug, display_name, email, password, plan? }
//
// Returns:
//   { ok, slug, display_name }   on success
//   { ok: false, error: '...' }  on validation/conflict (200 status; let the
//                                client read the message)
//
// Required env (auto-injected):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import bcrypt from 'https://esm.sh/bcryptjs@2.4.3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

// Adds <slug>.poolsideapp.com to the Vercel project so the tenant's URL
// works immediately after signup. Idempotent (409 = already exists, treat
// as success). Best-effort: never fails the surrounding tenant creation;
// if Vercel rejects, we log it and the admin can add the domain manually.
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
    if (res.status === 409) return { ok: true };  // already on the project
    const txt = await res.text();
    console.warn(`[tenant_signup] Vercel domain add failed for ${domain}:`, res.status, txt);
    return { ok: false, error: `Vercel ${res.status}: ${txt.slice(0, 200)}` };
  } catch (e) {
    console.warn(`[tenant_signup] Vercel API error:`, e);
    return { ok: false, error: String(e) };
  }
}

// Subdomains we reserve for our own use, to prevent tenants from grabbing
// admin / www / api / etc. and breaking the platform.
const RESERVED_SLUGS = new Set([
  'admin', 'www', 'api', 'app', 'mail', 'email', 'smtp', 'imap',
  'support', 'help', 'docs', 'blog', 'home', 'about', 'pricing',
  'signup', 'login', 'logout', 'register', 'contact',
  'status', 'health', 'staging', 'dev', 'test', 'demo',
  'poolside', 'poolsideapp', 'getpoolside',
  'club-demo', 'preview', 'production',
  'public', 'private', 'internal',
]);

const VALID_PLANS = ['free', 'starter', 'pro', 'enterprise'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }

  const slug         = String(body.slug ?? '').trim().toLowerCase();
  const display_name = String(body.display_name ?? '').trim();
  const email        = String(body.email ?? '').trim().toLowerCase();
  const password     = String(body.password ?? '');
  const plan         = String(body.plan ?? 'free').toLowerCase();

  // ── Validation ─────────────────────────────────────────────────────────
  if (!display_name || display_name.length < 2) {
    return jsonResponse({ ok: false, error: 'Club name is required (at least 2 characters)' });
  }
  if (display_name.length > 100) {
    return jsonResponse({ ok: false, error: 'Club name is too long (max 100 characters)' });
  }
  if (!slug) {
    return jsonResponse({ ok: false, error: 'Subdomain is required' });
  }
  if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(slug)) {
    return jsonResponse({ ok: false, error: 'Subdomain must be 2–30 chars, lowercase letters / numbers / hyphens, starting with a letter or number' });
  }
  if (RESERVED_SLUGS.has(slug)) {
    return jsonResponse({ ok: false, error: `"${slug}" is reserved — pick another.` });
  }
  if (!email || !email.includes('@') || email.length > 200) {
    return jsonResponse({ ok: false, error: 'Valid email is required' });
  }
  if (!password || password.length < 10) {
    return jsonResponse({ ok: false, error: 'Password must be at least 10 characters' });
  }
  if (!VALID_PLANS.includes(plan)) {
    return jsonResponse({ ok: false, error: 'Invalid plan' });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── Pre-check: slug must not already be taken (cheaper than catching the
  // unique-violation, and gives a friendlier error).
  {
    const { data: existing } = await sb.from('tenants')
      .select('id').eq('slug', slug).maybeSingle();
    if (existing) {
      return jsonResponse({ ok: false, error: `The subdomain "${slug}" is already taken — pick another.` });
    }
  }

  // ── Create tenant ──────────────────────────────────────────────────────
  const { data: tenant, error: tErr } = await sb.from('tenants').insert({
    slug,
    display_name,
    plan,
    status: 'trial',
    notes: `Self-served signup at ${new Date().toISOString()}`,
  }).select('id, slug, display_name, status, plan, trial_ends_at').single();

  if (tErr || !tenant) {
    // Catch the race-condition path where two signups raced for the same slug
    if (tErr?.message?.includes('duplicate') || tErr?.message?.includes('unique')) {
      return jsonResponse({ ok: false, error: `The subdomain "${slug}" is already taken — pick another.` });
    }
    return jsonResponse({ ok: false, error: tErr?.message || 'Failed to create tenant' }, 500);
  }

  // ── Create the first admin user (the person signing up) ────────────────
  const password_hash = await bcrypt.hash(password, 10);
  const { data: admin, error: uErr } = await sb.from('admin_users').insert({
    tenant_id: tenant.id,
    username: email,
    email,
    password_hash,
    display_name: email.split('@')[0],
    is_super: true,        // first admin of a fresh tenant is the org owner
    is_default_pw: false,  // they just typed the password themselves
    active: true,
  }).select('id').single();

  if (uErr || !admin) {
    // Roll back the tenant to avoid orphans
    await sb.from('tenants').delete().eq('id', tenant.id);
    return jsonResponse({ ok: false, error: uErr?.message || 'Failed to create admin user' }, 500);
  }

  // ── Assign the system 'super-admin' role ───────────────────────────────
  const { data: superRole } = await sb.from('admin_roles')
    .select('id').eq('slug', 'super-admin').is('tenant_id', null).maybeSingle();
  if (superRole) {
    await sb.from('admin_user_roles').insert({
      admin_user_id: admin.id,
      admin_role_id: superRole.id,
    });
  }

  // ── Seed empty settings row so the wizard has a place to write to ──────
  await sb.from('settings').insert({
    tenant_id: tenant.id,
    value: { setup_wizard_complete: false },
  });

  // ── Seed default policies (BE parity: 5 placeholder texts the club edits) ─
  await sb.from('policies').insert([
    { tenant_id: tenant.id, slug: 'rules',  title: 'Pool Rules',        body: "Replace this with your club's rules — the things every member should know before opening the gate.\n\n- Pool hours\n- Guest rules\n- Children supervision rules\n- No glass on the deck\n- No running on the deck",                                                                                                                                                                                                                                                                                            sort_order: 1, required_for_apply: true },
    { tenant_id: tenant.id, slug: 'guest',  title: 'Guest Policy',      body: "Replace this with your club's guest policy.\n\n- Max guests per household per day\n- Guests must sign in\n- Per-guest fee, paid by the host\n- Host is responsible for guest conduct",                                                                                                                                                                                                                                                                                                       sort_order: 2, required_for_apply: true },
    { tenant_id: tenant.id, slug: 'party',  title: 'Party Policy',      body: "Replace this with your club's party rental rules.\n\n- Parties must be requested through the app and approved\n- Maximum N additional guests\n- Cleanup is host's responsibility\n- Cleaning deposit refunded after inspection\n- Music down by 9pm",                                                                                                                                                                                                                                       sort_order: 3, required_for_apply: true },
    { tenant_id: tenant.id, slug: 'sitter', title: 'Babysitter Policy', body: "Replace this with your club's babysitter / nanny policy.\n\n- Sitters admitted only with written authorization from the household\n- Minimum age 16\n- Add the sitter to your household via the app before they arrive\n- Sitter counts as a guest for guest-pass purposes",                                                                                                                                                                                                              sort_order: 4, required_for_apply: true },
    { tenant_id: tenant.id, slug: 'waiver', title: 'Liability Waiver',  body: "Replace this with your club's liability waiver.\n\nThis is the legal text each adult applicant agrees to. Common elements:\n- Acknowledgment that swimming carries inherent risks\n- Release of the club / board / lifeguards from ordinary-negligence claims\n- Permission for emergency medical care of minors in the household\n- Authorization to use photos taken at the club in club communications\n\nHave your board / insurer / attorney approve the language before going live.",      sort_order: 5, required_for_apply: true },
  ]);

  // ── Auto-provision the Vercel subdomain so <slug>.poolsideapp.com works
  // immediately. Best-effort — never fails the signup if Vercel hiccups.
  const vercel = await addVercelSubdomain(tenant.slug);

  return jsonResponse({
    ok: true,
    slug: tenant.slug,
    display_name: tenant.display_name,
    trial_ends_at: tenant.trial_ends_at,
    subdomain_provisioned: vercel.ok,
    subdomain_warning: vercel.ok ? null : vercel.error,
  });
});
