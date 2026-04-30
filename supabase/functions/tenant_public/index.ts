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
      logo_url:             v.branding?.logo_url ?? null,
      primary_color:        v.branding?.primary_color ?? null,
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

  // Public-visibility documents only — members see member-visibility ones via
  // their own authenticated endpoint (member_auth.me already returns them; for
  // now public surface is enough).
  const { data: docsData } = await sb.from('documents')
    .select('id, title, description, url, sort_order')
    .eq('tenant_id', tenant.id)
    .eq('active', true)
    .eq('visibility', 'public')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(20);
  const documents = docsData ?? [];

  // Latest 5 active posts (pinned first), public — surfaces on the landing page.
  const { data: postsData } = await sb.from('posts')
    .select('id, title, body, pinned, published_at')
    .eq('tenant_id', tenant.id)
    .eq('active', true)
    .order('pinned', { ascending: false })
    .order('published_at', { ascending: false })
    .limit(5);
  const posts = postsData ?? [];

  // Wider event window so the month-grid calendar on public + member pages
  // has data to draw past, current, and future months without re-fetching.
  // Clients still derive a "next 5 upcoming" view client-side for the
  // Coming-up section.
  const since = new Date(Date.now() - 60  * 86400_000).toISOString();
  const until = new Date(Date.now() + 365 * 86400_000).toISOString();
  const { data: eventsData } = await sb.from('events')
    .select('id, title, body, kind, location, starts_at, ends_at, all_day, source_url, recurrence, recurrence_until')
    .eq('tenant_id', tenant.id)
    .eq('active', true)
    .gte('starts_at', since)
    .lte('starts_at', until)
    .order('starts_at', { ascending: true })
    .limit(300);
  const events = eventsData ?? [];

  // Photo gallery — admin-curated order, capped at 24 for landing-page weight.
  const { data: photosData } = await sb.from('photos')
    .select('id, url, caption')
    .eq('tenant_id', tenant.id)
    .eq('active', true)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(24);
  const photos = photosData ?? [];

  // Active programs (swim lessons / yoga / camp). Spots-left would require a
  // count(*) per program — skip on the public payload to keep this read cheap;
  // the dedicated `programs.list_public` action fills in spots_left when the
  // member actually opens the booking surface.
  const { data: programsData } = await sb.from('programs')
    .select('id, name, description, audience, weekdays, start_time, end_time, start_date, end_date, capacity, price_cents, instructor, location')
    .eq('tenant_id', tenant.id)
    .eq('active', true)
    .order('start_date', { ascending: true, nullsFirst: false })
    .limit(50);
  const programs = programsData ?? [];

  // Strip the internal id from the response — clients don't need it.
  // Membership tiers (Family / Single / Senior etc.) — admin defines the
  // list via Settings → Tiers. Applicants pick one on Step 4 of the apply
  // form. Empty array = no tier picker shown (graceful fallback).
  const rawTiers = (settings?.value as Record<string, unknown> | undefined)?.membership_tiers;
  const tiers = Array.isArray(rawTiers) ? rawTiers : [];

  const { id: _id, ...publicTenant } = tenant;
  return jsonResponse({ ok: true, tenant: publicTenant, public_settings, posts, events, photos, documents, programs, tiers });
});
