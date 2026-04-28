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
    .select('slug, display_name, status, plan, custom_domain')
    .eq('slug', slug)
    .maybeSingle();

  if (!tenant) return jsonResponse({ ok: false, error: 'Not found' }, 404);
  return jsonResponse({ ok: true, tenant });
});
