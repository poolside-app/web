/* =============================================================================
 * refund-review.js — the board's choices after a refund or chargeback (PLAN.md BT)
 * =============================================================================
 * Doug, 11/4: "keep them a member until the board member does something about
 * it... make sure that we have proper options on all refunds". One look for
 * Money → Payments → Refunds and chargebacks and for a signup's details. The
 * page fetches the reviews (payments_admin refund_reviews) and sends the
 * choice (refund_decide); the choices themselves come from the server
 * (_shared/refund_review.ts).
 *
 *   RefundReview.render(box, reviews, { decide: async (review, choice, extra) => ({ done }) })
 * ============================================================================= */
(function () {
  'use strict';

  var CSS = '.rr-item{padding:14px 0;border-top:1px solid var(--border,#e2e8f0)}'
    + '.rr-item:first-child{border-top:0;padding-top:4px}'
    + '.rr-head{display:flex;justify-content:space-between;gap:10px;align-items:baseline;font-size:14px}'
    + '.rr-amt{font-weight:700;white-space:nowrap}'
    + '.rr-what{font-size:12.5px;color:var(--muted,#64748b);margin-top:2px}'
    + '.rr-note{font-size:13px;line-height:1.5;margin:8px 0;padding:9px 11px;border-radius:9px;background:#fef3c7;color:#78350f}'
    + '.rr-note.dispute{background:#fee2e2;color:#7f1d1d}'
    + '.rr-fob{display:flex;gap:8px;align-items:center;font-size:13px;padding:3px 0;cursor:pointer}'
    + '.rr-paid{font-size:12.5px;color:var(--muted,#64748b);margin:6px 0 2px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}'
    + '.rr-paid select{font:13px Inter,system-ui,sans-serif;padding:5px 8px;border:1.5px solid var(--border,#e2e8f0);border-radius:8px}'
    + '.rr-choices{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}'
    + '.rr-btn{padding:9px 14px;border-radius:10px;font:600 13px Inter,system-ui,sans-serif;cursor:pointer;border:1.5px solid var(--blue,#0a3b5c);background:var(--blue,#0a3b5c);color:#fff}'
    + '.rr-btn.danger{background:#fff;color:#b91c1c;border-color:#fca5a5}'
    + '.rr-btn:disabled{opacity:.5;cursor:default}'
    + '.rr-hints{margin:8px 0 0;padding:0;list-style:none;font-size:12px;line-height:1.5;color:var(--muted,#64748b)}'
    + '.rr-msg{font-size:12.5px;margin-top:8px;color:#14532d;font-weight:600}'
    + '.rr-msg.err{color:#b91c1c}'
    + '.rr-done .rr-choices,.rr-done .rr-hints,.rr-done .rr-paid,.rr-done .rr-fobs{display:none}';

  function addCss() {
    if (document.getElementById('rr-css')) return;
    var st = document.createElement('style');
    st.id = 'rr-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function money(c) {
    return c == null ? '' : '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function day(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  /** "Refund: Rivera Family", "Partial refund: …", "Chargeback: …". */
  function title(r) {
    return (r.dispute ? 'Chargeback' : r.partial ? 'Partial refund' : 'Refund') + ': ' + (r.family || 'a payment Poolside couldn\'t match');
  }

  function itemHtml(r) {
    var fobs = r.fobs || [];
    var ticks = r.item === 'keyfobs' && fobs.length > 1 && r.choices.some(function (c) { return c.key === 'fobs_off'; })
      ? '<div class="rr-fobs">' + fobs.map(function (f) {
          var live = f.status === 'active' || f.status === 'requested';
          var label = f.status === 'active' ? 'Fob ••' + esc(f.tail || '') + ' (in use)'
            : f.status === 'requested' ? 'A fob not handed out yet' : 'Fob ••' + esc(f.tail || '') + ' (already off)';
          return '<label class="rr-fob"><input type="checkbox" data-fob="' + esc(f.id) + '"' + (live ? ' checked' : ' disabled') + '> ' + label + '</label>';
        }).join('') + '</div>'
      : '';
    var paid = r.paid_by
      ? '<label class="rr-paid">If they paid another way: <select data-paid-by><option value="">They didn\'t</option>'
        + '<option value="check">Check</option><option value="cash">Cash</option><option value="venmo">Venmo</option></select></label>'
      : '';
    return '<div class="rr-item" data-id="' + esc(r.id) + '">'
      + '<div class="rr-head"><b>' + esc(title(r)) + '</b><span class="rr-amt">' + esc(money(r.amount_cents)) + '</span></div>'
      + '<div class="rr-what">For ' + esc(r.what) + (r.created_at ? ' · ' + esc(day(r.created_at)) : '') + '</div>'
      + '<div class="rr-note' + (r.dispute ? ' dispute' : '') + '">' + esc(r.note) + '</div>'
      + ticks + paid
      + '<div class="rr-choices">' + r.choices.map(function (c) {
          return '<button type="button" class="rr-btn' + (c.danger ? ' danger' : '') + '" data-choice="' + esc(c.key) + '">' + esc(c.label) + '</button>';
        }).join('') + '</div>'
      + '<ul class="rr-hints">' + r.choices.map(function (c) { return '<li><b>' + esc(c.label) + ':</b> ' + esc(c.hint) + '</li>'; }).join('') + '</ul>'
      + '<div class="rr-msg"></div>'
      + '</div>';
  }

  function render(box, reviews, opts) {
    addCss();
    box.innerHTML = reviews.map(itemHtml).join('');
    box.querySelectorAll('.rr-item').forEach(function (el) {
      el.addEventListener('click', async function (ev) {
        var btn = ev.target.closest('button[data-choice]');
        if (!btn) return;
        ev.stopPropagation();
        var r = reviews.find(function (x) { return x.id === el.dataset.id; });
        var c = r && r.choices.find(function (x) { return x.key === btn.dataset.choice; });
        if (!c) return;
        var msg = el.querySelector('.rr-msg');
        var extra = {};
        var sel = el.querySelector('select[data-paid-by]');
        if (sel && c.key === 'keep' && sel.value) extra.paid_by = sel.value;
        var ticks = Array.prototype.slice.call(el.querySelectorAll('input[data-fob]'));
        if (ticks.length && c.key === 'fobs_off') {
          extra.fob_ids = ticks.filter(function (t) { return t.checked; }).map(function (t) { return t.dataset.fob; });
          if (!extra.fob_ids.length) { msg.className = 'rr-msg err'; msg.textContent = 'Tick a fob first.'; return; }
        }
        if (c.danger && !window.confirm(c.label + '?\n\n' + c.hint)) return;
        var buttons = el.querySelectorAll('button[data-choice]');
        buttons.forEach(function (b) { b.disabled = true; });
        msg.className = 'rr-msg';
        msg.textContent = 'Saving…';
        try {
          var out = await opts.decide(r, c.key, extra);
          msg.textContent = '✓ ' + ((out && out.done) || 'Done.');
          el.classList.add('rr-done');
          if (opts.after) opts.after(r, c.key, out);
        } catch (e) {
          msg.className = 'rr-msg err';
          msg.textContent = (e && e.message) || 'That didn\'t save. Try again.';
          buttons.forEach(function (b) { b.disabled = false; });
        }
      });
    });
  }

  window.RefundReview = { render: render, title: title };
})();
