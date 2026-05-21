// =============================================================================
// tenant_icon — Per-tenant PNG icon for iOS apple-touch-icon + favicons
// =============================================================================
// Why this exists:
//   iOS Safari's "Add to Home Screen" reads the page DOM at the moment the
//   user taps the share menu. Our pages set apple-touch-icon's href via JS
//   AFTER tenant_public returns — so if the user is fast (or the network
//   is slow), iOS sees an empty href and falls back to a screenshot of the
//   page. Doug hit this 2026-05-22.
//
//   The fix: serve the right per-tenant icon at the conventional path
//   `/apple-touch-icon.png` via a Vercel rewrite → this function. iOS
//   auto-discovers root-level apple-touch-icon.png without any JS, so the
//   home-screen install picks up the correct icon regardless of page state.
//
// Behavior:
//   GET /functions/v1/tenant_icon?slug=<club>[&size=180|192|512]
//     → 302 redirect to branding.icon_192_url (or icon_512_url for size=512)
//     → if no tenant icon: 302 to the default Poolside icon
//
// Vercel routes /apple-touch-icon.png and /apple-touch-icon-precomposed.png
// on tenant subdomains to this. Apex/www get the generic Poolside icon.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const DEFAULT_ICON_192 = 'https://poolsideapp.com/icon-192.png';
const DEFAULT_ICON_512 = 'https://poolsideapp.com/icon-512.png';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function redirect(to: string) {
  return new Response(null, {
    status: 302,
    headers: {
      ...cors,
      'location': to,
      // Short cache so a brand change appears within a few minutes for new
      // installs. (Already-installed PWAs cache the icon themselves, but
      // that's iOS's call, not ours.)
      'cache-control': 'public, max-age=300',
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = new URL(req.url);
  const slug = (url.searchParams.get('slug') ?? '').trim().toLowerCase();
  const size = (url.searchParams.get('size') ?? '180').trim();
  // 180 (default iOS apple-touch-icon), 192 (Android home), 512 (splash).
  const prefer512 = size === '512';

  // No slug = apex/www → generic Poolside icon.
  if (!slug) return redirect(prefer512 ? DEFAULT_ICON_512 : DEFAULT_ICON_192);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: tenant } = await sb.from('tenants')
    .select('id, status').eq('slug', slug).maybeSingle();
  if (!tenant || tenant.status === 'churned') {
    return redirect(prefer512 ? DEFAULT_ICON_512 : DEFAULT_ICON_192);
  }

  const { data: settings } = await sb.from('settings')
    .select('value').eq('tenant_id', tenant.id).maybeSingle();
  const v = (settings?.value ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const branding = v.branding ?? {};

  const icon192 = (branding.icon_192_url as string | null) || DEFAULT_ICON_192;
  const icon512 = (branding.icon_512_url as string | null) || DEFAULT_ICON_512;

  return redirect(prefer512 ? icon512 : icon192);
});
