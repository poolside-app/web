// =============================================================================
// tenant_share — the page a member actually shares
// =============================================================================
// Served at https://<slug>.poolsideapp.com/join via a vercel.json rewrite, the
// same pattern tenant_manifest and tenant_icon already use.
//
// It exists because club/index.html is rendered entirely in the browser: its
// static HTML says `<title>Loading…</title>` and carries no Open Graph tags at
// all. Nextdoor, Facebook, iMessage and every other unfurler fetches HTML and
// does NOT run JavaScript, so a member pasting their club's link into a
// neighborhood group produced a preview card that said, literally, "Loading…".
// That is the single worst possible thing for the one channel that actually
// brings a neighborhood pool club members.
//
// So this returns real server-rendered HTML: correct meta tags for the
// scraper, and a genuine join page for the human who clicks. No redirect —
// somebody arriving from a Nextdoor post should land on something that tells
// them what the club is and costs, not bounce through a loading screen.
//
// ?ref=CODE carries a member's referral code through to the application form,
// so the neighbor who shared it still gets credited.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { renderSharePage } from '../_shared/share_page.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function page(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Short cache: unfurlers cache aggressively on their own side, and a
      // club that fixes a typo in its tagline should not wait a day.
      'cache-control': 'public, max-age=300, s-maxage=300',
      'x-robots-tag': 'all',
    },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const slug = (url.searchParams.get('slug') ?? '').trim().toLowerCase();
  const ref  = (url.searchParams.get('ref') ?? '').trim().toUpperCase().slice(0, 32);

  if (!slug) {
    return page(`<!doctype html><meta charset="utf-8"><title>Poolside</title>
      <meta http-equiv="refresh" content="0;url=https://poolsideapp.com/">`, 404);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: tenant } = await sb.from('tenants')
    .select('id, slug, display_name, status').eq('slug', slug).maybeSingle();

  if (!tenant || tenant.status === 'churned') {
    return page(`<!doctype html><meta charset="utf-8"><title>Club not found — Poolside</title>
      <meta name="robots" content="noindex">
      <body style="font:16px/1.6 system-ui;padding:40px;max-width:32rem;margin:0 auto">
      <h1>We couldn't find that club</h1>
      <p><a href="https://poolsideapp.com/">Poolside</a></p>`, 404);
  }

  const clubUrl = `https://${tenant.slug}.poolsideapp.com`;

  const [{ data: settingsRow }, { data: photos }] = await Promise.all([
    sb.from('settings').select('value').eq('tenant_id', tenant.id).maybeSingle(),
    sb.from('photos').select('url').eq('tenant_id', tenant.id).eq('active', true)
      .order('sort_order', { ascending: true }).limit(1),
  ]);
  const sv = (settingsRow?.value ?? {}) as Record<string, unknown>;
  const branding = (sv.branding ?? {}) as Record<string, unknown>;

  const tiers = (sv.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];
  const prices = tiers.map(t => Number(t.price_cents ?? 0)).filter(n => n > 0);

  return page(renderSharePage({
    slug: String(tenant.slug),
    displayName: String(tenant.display_name || 'Our pool club'),
    heroHeadline: String(sv.hero_headline ?? ''),
    heroTagline: String(sv.hero_tagline ?? ''),
    primaryColor: String(branding.primary_color ?? ''),
    // Best first. A club's own gallery photo needs no setup and stays current
    // on its own, which beats asking a volunteer board to maintain a dedicated
    // share image they will never think about again.
    shareImage:
      String(branding.share_image_url ?? '') ||
      String(photos?.[0]?.url ?? '') ||
      String(branding.logo_url ?? ''),
    fromCents: prices.length ? Math.min(...prices) : 0,
    ref,
  }));
});
