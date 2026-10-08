/* =============================================================================
 * renew-sign.js — accept the policies and sign, on both renewal pages
 * =============================================================================
 * PLAN.md R6 (Doug, 2026-10-08): renewing shows everything filled in, but
 * the family accepts the club's policies again and the person who opened the
 * account signs before paying. renew.html (the emailed link) and
 * m/renew.html (the app) both use this; checkout refuses an unsigned renewal.
 *
 * The pages redraw themselves on every change (a code, the plan, keyfobs),
 * so this keeps its own state: which policies were accepted and the drawn
 * signature, put back into the new canvas after each redraw.
 *
 * Needs signature_pad (window.SignaturePad) loaded first.
 *
 *   RenewSign.init({ slug, signerName, signedAt, canSign })  → Promise
 *   RenewSign.html()      the card's placeholder, for the page's render()
 *   RenewSign.mount()     fill it in after render()
 *   RenewSign.signed()    already signed on the server
 *   RenewSign.problem()   null when ready to sign, else what's missing
 *   RenewSign.payload()   { accepted, signature }
 *   RenewSign.markSigned(iso)
 * ============================================================================= */
(function () {
  'use strict';
  const SUPABASE_URL = 'https://sdewylbddkcvidwosgxo.supabase.co';
  let POLICIES = [];          // [{ slug, title, body, required_for_apply }]
  let ACCEPTED = {};          // slug → true
  let SIGNATURE = null;       // PNG data URL
  let SIGNER = '';
  let SIGNED_AT = null;
  let CAN_SIGN = true;
  let PAD = null;
  let LOADED = false;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const required = () => POLICIES.filter(p => p.required_for_apply);

  async function init(opts) {
    SIGNER = opts.signerName || 'The person who opened the account';
    SIGNED_AT = opts.signedAt || null;
    CAN_SIGN = opts.canSign !== false;
    if (LOADED) return;
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/policies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'list_public', slug: opts.slug }),
      }).then(x => x.json());
      POLICIES = (r && r.ok && r.policies) || [];
      LOADED = true;
    } catch (_) { POLICIES = []; }
    ensureModal();
  }

  function html() { return '<div class="card" id="renew-sign-card"></div>'; }

  function mount() {
    const el = document.getElementById('renew-sign-card');
    if (!el) return;
    if (SIGNED_AT) {
      const day = new Date(SIGNED_AT).toLocaleDateString([], { month: 'short', day: 'numeric' });
      el.innerHTML = `<h2>Policies and signature</h2>
        <p style="font-size:14px;margin:0;color:#15803d;font-weight:600">✓ Policies accepted and signed by ${esc(SIGNER)} on ${esc(day)}.</p>`;
      return;
    }
    const req = required();
    const all = req.every(p => ACCEPTED[p.slug]);
    const btn = (p, i) => {
      const done = !!ACCEPTED[p.slug];
      return `<button type="button" data-policy="${esc(p.slug)}" style="display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;text-align:left;padding:11px 13px;margin:0 0 8px;border:1.5px solid ${done ? '#86efac' : 'var(--border)'};border-radius:12px;background:${done ? '#f0fdf4' : '#fff'};font:600 14px 'Inter',sans-serif;color:var(--text,#0f172a);cursor:pointer">
        <span>${i + 1}. ${esc(p.title)}${p.required_for_apply ? '' : ' <span style="font-weight:500;color:var(--muted);font-size:12px">(to read)</span>'}</span>
        <span style="font-size:12.5px;color:${done ? '#15803d' : 'var(--blue)'};white-space:nowrap">${done ? '✓ Accepted' : p.required_for_apply ? 'Read and accept' : 'Read'}</span>
      </button>`;
    };
    el.innerHTML = `<h2>Policies and signature</h2>
      <p style="font-size:13.5px;color:var(--muted);margin:0 0 12px;line-height:1.5">Before renewing, read and accept the club's policies. ${esc(SIGNER)} signs for the family.</p>
      ${POLICIES.map(btn).join('')}
      ${!CAN_SIGN ? `<p style="font-size:13.5px;margin:10px 0 0;padding:10px 12px;border-radius:10px;background:#fef3c7;color:#7c2d12">${esc(SIGNER)} opened your membership, so they sign for the family. Ask them to renew from their app or from the link the club emailed them.</p>`
        : all ? `<div style="margin-top:14px">
          <div style="font:600 13.5px 'Inter',sans-serif;margin-bottom:6px">${esc(SIGNER)}, sign here</div>
          <div style="position:relative;border:1.5px dashed var(--border);border-radius:12px;background:#fff;height:150px">
            <canvas id="rs-canvas" style="width:100%;height:100%;display:block;touch-action:none"></canvas>
            <button type="button" id="rs-clear" style="position:absolute;top:6px;right:6px;padding:4px 10px;border:1px solid var(--border);border-radius:999px;background:#fff;font:600 12px 'Inter',sans-serif;color:var(--muted);cursor:pointer">Clear</button>
          </div>
          <p style="font-size:12px;color:var(--muted);margin:6px 0 0;line-height:1.5">By signing, you agree to these policies for everyone on your membership this season.</p>
        </div>`
        : `<p style="font-size:12.5px;color:var(--muted);margin:6px 0 0">✍️ The signature box opens once you've accepted ${req.length === 1 ? 'the policy' : 'every policy'}.</p>`}`;
    el.querySelectorAll('[data-policy]').forEach(b => b.addEventListener('click', () => openPolicy(b.dataset.policy)));
    const c = document.getElementById('rs-canvas');
    if (c && window.SignaturePad) {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      c.width = c.offsetWidth * ratio; c.height = c.offsetHeight * ratio;
      c.getContext('2d').scale(ratio, ratio);
      PAD = new window.SignaturePad(c, { backgroundColor: 'rgba(0,0,0,0)' });
      if (SIGNATURE) PAD.fromDataURL(SIGNATURE, { ratio, width: c.offsetWidth, height: c.offsetHeight });
      PAD.addEventListener('endStroke', () => { SIGNATURE = PAD.isEmpty() ? null : PAD.toDataURL('image/png'); });
      document.getElementById('rs-clear').addEventListener('click', () => { PAD.clear(); SIGNATURE = null; });
    }
  }

  function ensureModal() {
    if (document.getElementById('rs-scrim')) return;
    const d = document.createElement('div');
    d.id = 'rs-scrim';
    d.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:400;display:none;align-items:flex-start;justify-content:center;overflow-y:auto;padding:24px 14px';
    d.innerHTML = `<div style="background:#fff;border-radius:18px;padding:22px;width:100%;max-width:620px;box-shadow:0 20px 60px rgba(10,59,92,.18)">
      <h2 id="rs-title" style="margin:0 0 10px"></h2>
      <div id="rs-body" style="white-space:pre-wrap;font-size:14px;line-height:1.6;color:var(--text,#0f172a);max-height:60vh;overflow-y:auto"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap">
        <button type="button" id="rs-close" style="padding:10px 16px;border:1.5px solid var(--border);border-radius:10px;background:#fff;font:600 14px 'Inter',sans-serif;cursor:pointer">Close</button>
        <button type="button" id="rs-accept" style="padding:10px 18px;border:0;border-radius:10px;background:var(--blue,#0a3b5c);color:#fff;font:600 14px 'Inter',sans-serif;cursor:pointer">I accept</button>
      </div>
    </div>`;
    document.body.appendChild(d);
    d.addEventListener('click', e => { if (e.target === d) closePolicy(); });
    document.getElementById('rs-close').addEventListener('click', closePolicy);
  }
  function openPolicy(slug) {
    const p = POLICIES.find(x => x.slug === slug);
    if (!p) return;
    document.getElementById('rs-title').textContent = p.title;
    document.getElementById('rs-body').textContent = p.body || '';
    const acc = document.getElementById('rs-accept');
    acc.style.display = p.required_for_apply ? '' : 'none';
    acc.onclick = () => { ACCEPTED[slug] = true; closePolicy(); mount(); };
    document.getElementById('rs-scrim').style.display = 'flex';
  }
  function closePolicy() { document.getElementById('rs-scrim').style.display = 'none'; }

  function problem() {
    if (SIGNED_AT) return null;
    if (!CAN_SIGN) return `${SIGNER} needs to sign this renewal.`;
    const missing = required().filter(p => !ACCEPTED[p.slug]).length;
    if (missing) return `Accept ${missing === 1 ? 'the policy' : 'all ' + missing + ' policies'} first.`;
    if (!SIGNATURE) return 'Sign in the box first.';
    return null;
  }
  function payload() {
    const accepted = {};
    for (const p of required()) accepted[p.slug] = !!ACCEPTED[p.slug];
    return { accepted, signature: SIGNATURE };
  }

  window.RenewSign = {
    init, html, mount, problem, payload,
    signed: () => !!SIGNED_AT,
    markSigned: iso => { SIGNED_AT = iso || new Date().toISOString(); },
  };
})();
