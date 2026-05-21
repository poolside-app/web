// =============================================================================
// tenant_manifest — Per-tenant Web App Manifest (PWA install)
// =============================================================================
// Vercel rewrites /manifest.webmanifest on <slug>.poolsideapp.com to:
//   https://<sb>.supabase.co/functions/v1/tenant_manifest?slug=<slug>
// (the `has` rule with named capture group :slug forwards the subdomain).
//
// The function looks up the tenant, reads branding (primary_color +
// generated icon URLs from settings.value.branding), and returns a JSON
// manifest. Chrome/Android use this for "Add to home screen". iOS Safari
// largely ignores manifests but still installs via apple-touch-icon meta —
// pages set that one client-side from the same icon URLs.
// =============================================================================
//
// Action: GET ?slug=<club-slug>
// Response: application/manifest+json
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// Default Poolside icons — used as fallback when a tenant hasn't generated
// their own yet. These live as static assets in the public bucket.
const DEFAULT_ICON_192 = 'https://poolsideapp.com/icon-192.png';
const DEFAULT_ICON_512 = 'https://poolsideapp.com/icon-512.png';

function manifest(name: string, themeColor: string, icon192: string, icon512: string, opts?: { admin?: boolean }) {
  const isAdmin = !!opts?.admin;
  // Admin pages get start_url=/club/admin/ so saving an admin page to the
  // iOS home screen opens the admin dashboard (not the member portal) when
  // tapped. Doug 2026-05-22: he was getting "logged out" after Add to Home
  // Screen — actual cause was start_url='/m/' sending him to the member
  // sign-in page where his admin session didn't apply.
  return {
    name: isAdmin ? `${name} — Admin` : name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: `${name} — pool club app`,
    start_url: isAdmin ? '/club/admin/' : '/m/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f4f1eb',
    theme_color: themeColor,
    icons: [
      { src: icon192, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: icon512, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = new URL(req.url);
  const slug = (url.searchParams.get('slug') ?? '').trim().toLowerCase();
  // ?admin=1 → admin-side manifest with start_url=/club/admin/. Set by
  // admin-flags.js on every admin page (search params on the <link rel="manifest">).
  const isAdmin = url.searchParams.get('admin') === '1';

  // Generic Poolside manifest if no slug — when someone hits poolsideapp.com root.
  if (!slug) {
    return new Response(JSON.stringify(manifest('Poolside', '#0a3b5c', DEFAULT_ICON_192, DEFAULT_ICON_512, { admin: isAdmin })), {
      headers: {
        ...cors,
        'content-type': 'application/manifest+json; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: tenant } = await sb.from('tenants')
    .select('id, slug, display_name, status')
    .eq('slug', slug).maybeSingle();

  if (!tenant || tenant.status === 'churned') {
    return new Response(JSON.stringify(manifest('Poolside', '#0a3b5c', DEFAULT_ICON_192, DEFAULT_ICON_512, { admin: isAdmin })), {
      status: 200,
      headers: {
        ...cors,
        'content-type': 'application/manifest+json; charset=utf-8',
        'cache-control': 'public, max-age=300',  // shorter so a typo subdomain self-heals quickly
      },
    });
  }

  const { data: settings } = await sb.from('settings')
    .select('value').eq('tenant_id', tenant.id).maybeSingle();
  const v = (settings?.value ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const branding = v.branding ?? {};

  const themeColor = (branding.primary_color as string | null) || '#0a3b5c';
  const icon192    = (branding.icon_192_url as string | null) || DEFAULT_ICON_192;
  const icon512    = (branding.icon_512_url as string | null) || DEFAULT_ICON_512;
  const name       = tenant.display_name || 'Poolside';

  return new Response(JSON.stringify(manifest(name, themeColor, icon192, icon512, { admin: isAdmin })), {
    headers: {
      ...cors,
      'content-type': 'application/manifest+json; charset=utf-8',
      // Short cache so a brand change shows up on the next install attempt;
      // already-installed apps cache the manifest themselves.
      'cache-control': 'public, max-age=300',
    },
  });
});
