// =============================================================================
// share_page.ts — the HTML a scraper sees when a member shares their club
// =============================================================================
// Split out of tenant_share so it can be tested without Deno or a database.
//
// Escaping is the reason it is worth testing separately. Club names go
// straight into <meta content="..."> attributes, and a club called
// Bob's "Pool" Club would otherwise close the attribute early — breaking the
// preview card at best, and at worst letting a club name put markup into a
// page that every neighbor is being invited to open.
// =============================================================================

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export type SharePageInput = {
  slug: string;
  displayName: string;
  heroHeadline?: string | null;
  heroTagline?: string | null;
  primaryColor?: string | null;
  /** Best available: an explicit share image, else the club gallery, else the logo. */
  shareImage?: string | null;
  /** Cheapest membership tier in cents, for the "what does it cost" line. */
  fromCents?: number | null;
  /** Referral code, carried through to the application form. */
  ref?: string | null;
};

export function shareDescription(input: SharePageInput): string {
  const tagline = String(input.heroTagline ?? '').trim();
  const from = Number(input.fromCents ?? 0);
  // Answering "what does it cost" on the card itself is the point: it is the
  // first question every neighbor asks and no club page answers it up front.
  const price = from > 0
    ? `Family memberships from $${Math.round(from / 100).toLocaleString('en-US')} a year.`
    : '';
  return [tagline, price].filter(Boolean).join(' ')
    || `Join ${input.displayName} — apply online in a few minutes.`;
}

export function renderSharePage(input: SharePageInput): string {
  const name      = String(input.displayName || 'Our pool club');
  const headline  = String(input.heroHeadline ?? '').trim() || name;
  const color     = String(input.primaryColor ?? '') || '#0a3b5c';
  const image     = String(input.shareImage ?? '').trim();
  const ref       = String(input.ref ?? '').trim();
  const clubUrl   = `https://${input.slug}.poolsideapp.com`;
  const canonical = `${clubUrl}/join`;
  const applyHref = `${clubUrl}/apply.html${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
  const description = shareDescription({ ...input, displayName: name });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join ${esc(name)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">

<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(name)}">
<meta property="og:title" content="Join ${esc(name)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
${image ? `<meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(name)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="Join ${esc(name)}">
<meta name="twitter:description" content="${esc(description)}">
${image ? `<meta name="twitter:image" content="${esc(image)}">` : ''}
<meta name="theme-color" content="${esc(color)}">

<style>
  :root { --brand: ${esc(color)}; }
  * { box-sizing: border-box; }
  body { margin:0; background:#fefdfb; color:#0f172a;
         font:17px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .wrap { max-width:34rem; margin:0 auto; padding:32px 22px 64px; }
  .hero { border-radius:16px; overflow:hidden; margin:0 0 24px; background:#e6eef5; }
  .hero img { display:block; width:100%; height:auto; }
  h1 { font-size:30px; line-height:1.15; margin:0 0 10px; letter-spacing:-.02em; }
  .lede { font-size:18px; color:#475569; margin:0 0 26px; }
  .btn { display:block; text-align:center; background:var(--brand); color:#fff;
         text-decoration:none; font-weight:700; font-size:17px;
         padding:15px 22px; border-radius:12px; }
  .btn.ghost { background:transparent; color:var(--brand);
               border:1.5px solid #cbd5e1; font-weight:600; margin-top:10px; }
  .note { font-size:14px; color:#64748b; margin:22px 0 0; }
  footer { margin-top:40px; padding-top:18px; border-top:1px solid #e5e7eb;
           font-size:13px; color:#94a3b8; }
  footer a { color:#64748b; }
</style>
</head>
<body>
  <div class="wrap">
    ${image ? `<div class="hero"><img src="${esc(image)}" alt="${esc(name)}"></div>` : ''}
    <h1>${esc(headline)}</h1>
    <p class="lede">${esc(description)}</p>
    <a class="btn" href="${esc(applyHref)}">Apply to join</a>
    <a class="btn ghost" href="${esc(clubUrl)}/">See the club page</a>
    ${ref ? `<p class="note">A member sent you this, and they will be credited when you join.</p>` : ''}
    <p class="note">Applying takes a few minutes. The board reviews it and you will hear back by email.</p>
    <footer>${esc(name)} runs on <a href="https://poolsideapp.com/">Poolside</a>.</footer>
  </div>
</body>
</html>`;
}
