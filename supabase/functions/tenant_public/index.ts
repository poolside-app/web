// =============================================================================
// tenant_public — No-auth lookup for tenant landing page
// =============================================================================
// Called from <slug>.poolsideapp.com to fetch public, safe-to-display info
// about the tenant whose subdomain was hit. Returns nothing sensitive — just
// what the public landing page needs to render.
//
// Body: { slug }
// Returns:
//   { ok: true, tenant: { slug, display_name, status, plan, custom_domain } }
//   { ok: false, error: 'Not found' }   404 if no such slug
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const slug = String(body.slug ?? '').trim().toLowerCase();
  if (!slug) return jsonResponse({ ok: false, error: 'slug required' }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: tenant } = await sb.from('tenants')
    .select('id, slug, display_name, status, plan, custom_domain')
    .eq('slug', slug)
    .maybeSingle();

  if (!tenant) return jsonResponse({ ok: false, error: 'Not found' }, 404);

  // Pull a SANITIZED slice of settings.value for public landing pages.
  // Internal flags (e.g. setup_wizard_complete) are deliberately excluded.
  const { data: settings } = await sb.from('settings')
    .select('value').eq('tenant_id', tenant.id).maybeSingle();
  const v = (settings?.value ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const public_settings = {
    hero: {
      eyebrow:  v.hero?.eyebrow  ?? null,
      headline: v.hero?.headline ?? null,
      tagline:  v.hero?.tagline  ?? null,
    },
    branding: {
      background_photo_url: v.branding?.background_photo_url ?? null,
    },
    club: {
      location: v.club?.location ?? null,
    },
    pool: {
      opens_at:  v.pool?.opens_at  ?? null,
      closes_at: v.pool?.closes_at ?? null,
    },
    payments: {
      venmo_handle: v.payments?.venmo_handle ?? null,
      paypal_link:  v.payments?.paypal_link  ?? null,
    },
    features: {
      swim_lessons: !!v.features?.swim_lessons,
      parties:      !!v.features?.parties,
      keyfobs:      !!v.features?.keyfobs,
      gate:         !!v.features?.gate,
    },
  };

  // Latest 5 active posts (pinned first), public — surfaces on the landing page.
  const { data: postsData } = await sb.from('posts')
    .select('id, title, body, pinned, published_at')
    .eq('tenant_id', tenant.id)
    .eq('active', true)
    .order('pinned', { ascending: false })
    .order('published_at', { ascending: false })
    .limit(5);
  const posts = postsData ?? [];

  // Next 5 upcoming events (starting now or later, soonest first).
  const nowIso = new Date().toISOString();
  const { data: eventsData } = await sb.from('events')
    .select('id, title, body, kind, location, starts_at, ends_at, all_day')
    .eq('tenant_id', tenant.id)
    .eq('active', true)
    .gte('starts_at', nowIso)
    .order('starts_at', { ascending: true })
    .limit(5);
  const events = eventsData ?? [];

  // Strip the internal id from the response — clients don't need it.
  const { id: _id, ...publicTenant } = tenant;
  return jsonResponse({ ok: true, tenant: publicTenant, public_settings, posts, events });
});
