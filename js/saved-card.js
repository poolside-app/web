/*
 * saved-card.js — the saved card on My family, and Remove my card (PLAN.md CM5)
 *
 * Doug 11/8: "have a button to remove their card… make sure though it will
 * auto reject all future payments". member_auth saved_card says what's saved;
 * remove_card takes it off at Stripe and here, and turns auto-renew off. A
 * payment plan with payments left keeps its card: they switch it on the plan
 * instead.
 *
 *   SavedCard.render(host, state, onRemove)
 *     state: { has_card, label, can_remove, reason }   onRemove(): Promise
 */
(function (w) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render(host, d, onRemove) {
    if (!host) return;
    if (!d || !d.has_card) {
      host.innerHTML = `
        <div class="card">
          <div class="card-eyebrow">Saved card</div>
          <p style="font-size:14px;margin:0;color:var(--muted)">No card saved. Nothing can be charged without you paying in the app.</p>
        </div>`;
      return;
    }
    const label = d.label || 'A saved card';
    host.innerHTML = `
      <div class="card">
        <div class="card-eyebrow">Saved card</div>
        <p style="font-size:15px;margin:0 0 10px"><b>${esc(label)}</b> is saved with the club's Stripe account.</p>
        ${d.can_remove
          ? `<button type="button" class="btn btn-ghost" id="sc-remove">Remove my card</button>
             <p style="font-size:12px;color:var(--muted);margin:10px 0 0">Removing it turns automatic renewal off. Past payments and receipts stay.</p>`
          : `<p style="font-size:13px;color:var(--muted);margin:0 0 10px;line-height:1.5">${esc(d.reason || '')}</p>
             <a class="btn btn-ghost" href="/m/#plan" style="display:inline-block;text-decoration:none">Switch card</a>`}
        <div id="sc-msg" style="font-size:13px;margin-top:8px"></div>
      </div>`;
    const btn = host.querySelector('#sc-remove');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!confirm(`Remove ${label}?\n\nNothing can be charged to it again, and automatic renewal turns off. Past payments and receipts stay.`)) return;
      const msg = host.querySelector('#sc-msg');
      btn.disabled = true; btn.textContent = 'Removing…';
      try { await onRemove(); }
      catch (e) {
        if (msg) { msg.style.color = 'var(--red,#b91c1c)'; msg.textContent = (e && e.message) || 'Could not remove it'; }
        btn.disabled = false; btn.textContent = 'Remove my card';
      }
    });
  }

  w.SavedCard = { render };
})(window);
