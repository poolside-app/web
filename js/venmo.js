/*
 * venmo.js — the Venmo note and link (PLAN.md BC1, Doug 10/19)
 *
 * The same as supabase/functions/_shared/venmo.ts: every "Pay with Venmo"
 * button opens Venmo to the club's handle with the amount and a note like
 * "Cabana Club 2027 dues - Frevele - #K7Q2" filled in. The code is what the
 * board looks for in Venmo. scripts/test_venmo_codes.mjs checks both agree.
 */
(function () {
  'use strict';
  function familyShort(name) {
    return String(name == null ? '' : name).trim().replace(/^the\s+/i, '').replace(/\s+family$/i, '').trim() || 'Family';
  }
  function note(a) {
    const parts = [(String(a.club || '').trim() + ' ' + String(a.what || '').trim()).trim(), familyShort(a.family)];
    if (a.code) parts.push('#' + a.code);
    return parts.filter(Boolean).join(' - ').slice(0, 120);
  }
  function link(a) {
    const h = String(a.handle || '').trim().replace(/^@+/, '');
    const amt = a.amountCents > 0 ? '&amount=' + (a.amountCents / 100).toFixed(2) : '';
    return 'https://venmo.com/' + encodeURIComponent(h) + '?txn=pay' + amt + '&note=' + encodeURIComponent(a.note);
  }
  window.PoolsideVenmo = { familyShort: familyShort, note: note, link: link };
})();
