/*
 * approvals.js — changes waiting for a second board member (PLAN.md CQ3)
 *
 * Doug 11/8: "Should we have something that has 2 people on the board that
 * need to reply? So it's extra secure?". Switching Stripe accounts, a new
 * Venmo handle and giving someone full access wait until the Treasurer or
 * another full-access board member approves (_shared/pending_change.ts).
 * On the board home, Payments and Board pages this shows a card of what's
 * waiting: Approve (with your own texted code, js/step-up.js) or Stop it for
 * the approvers, Take it back for the one who asked. The approval text and
 * to-do open /club/admin/#approve=<id>, which opens that one.
 * Needs js/step-up.js. Nothing shows in a look-only preview.
 */
(function (w) {
  var AUTH = 'https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/tenant_admin_auth';
  function tok() { try { return localStorage.getItem('poolside_tenant_token') || ''; } catch (_) { return ''; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  async function call(action, extra) {
    var res = await fetch(AUTH, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok() },
      body: JSON.stringify(Object.assign({ action: action }, extra || {})) });
    return res.json().catch(function () { return { ok: false }; });
  }
  function ago(iso) {
    var m = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60000));
    return m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' hr ago' : Math.round(m / 1440) + ' days ago';
  }

  function cardHtml(list, focus) {
    return '<div style="font:700 15px Inter,system-ui,sans-serif;color:#7c2d12;margin-bottom:6px">🔐 Waiting for a second board member</div>' +
      list.map(function (c) {
        var on = c.id === focus;
        return '<div data-change="' + esc(c.id) + '" style="padding:10px 0;border-top:1px solid #fde68a' + (on ? ';background:#fff7ed;margin:0 -12px;padding:10px 12px;border-radius:10px' : '') + '">' +
          '<div style="font-size:14px;line-height:1.45;color:#0f172a"><b>' + esc(c.asked_by) + '</b> asked to ' + esc(c.summary) + '.</div>' +
          '<div style="font-size:12.5px;color:#92400e;margin:2px 0 8px">' + esc(ago(c.created_at)) + '. Nothing changes until it\'s approved' + (c.kind === 'full_access' ? '' : ', so payments keep going where they go now') + '.</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          (c.can_approve ? '<button type="button" data-act="approve" style="padding:8px 14px;border:0;border-radius:10px;background:#0a3b5c;color:#fff;font:600 13px Inter,system-ui,sans-serif;cursor:pointer">Approve</button>' +
            '<button type="button" data-act="stop" style="padding:8px 14px;border:1.5px solid #e2e8f0;border-radius:10px;background:#fff;font:600 13px Inter,system-ui,sans-serif;cursor:pointer">Stop it</button>'
            : c.mine ? '<button type="button" data-act="stop" style="padding:8px 14px;border:1.5px solid #e2e8f0;border-radius:10px;background:#fff;font:600 13px Inter,system-ui,sans-serif;cursor:pointer">Take it back</button>'
            : '<span style="font-size:12.5px;color:#64748b">The Treasurer or someone with full access approves it.</span>') +
          '</div><div data-msg style="font-size:13px;margin-top:6px"></div></div>';
      }).join('');
  }

  async function decide(id, approve, msgEl) {
    if (!approve && !confirm('Stop this change? Nothing changes, and they can ask again.')) return;
    var r = approve
      ? await w.StepUp.run(function (code) { return call('change_decide', { id: id, approve: true, step_up_code: code }); })
      : await call('change_decide', { id: id, approve: false });
    if (r && r.cancelled) return;
    if (!r || !r.ok) { if (msgEl) { msgEl.style.color = '#b91c1c'; msgEl.textContent = (r && r.error) || 'Could not save that'; } return; }
    if (msgEl) { msgEl.style.color = '#15803d'; msgEl.textContent = approve ? '✓ Approved. It\'s done.' : '✓ Stopped.'; }
    setTimeout(mount, 1400);
  }

  async function mount() {
    var focus = (/#approve=([\w-]+)/.exec(location.hash) || [])[1] || null;
    var r = await call('changes');
    var card = document.getElementById('changes-card');
    var list = (r && r.ok && r.changes) || [];
    if (!list.length) { if (card) card.remove(); return; }
    if (!card) {
      card = document.createElement('div');
      card.id = 'changes-card';
      card.style.cssText = 'background:linear-gradient(135deg,#fffbeb,#fef3c7);border:1px solid #fde68a;border-radius:14px;padding:14px 18px;width:calc(100% - 44px);max-width:1036px;margin:18px auto 0;box-sizing:border-box';
      var main = document.getElementById('main') || document.querySelector('main');
      if (main && main.parentNode) main.parentNode.insertBefore(card, main); else document.body.prepend(card);
    }
    card.innerHTML = cardHtml(list, focus);
    card.querySelectorAll('[data-change]').forEach(function (row) {
      var id = row.getAttribute('data-change'), msg = row.querySelector('[data-msg]');
      row.querySelectorAll('button[data-act]').forEach(function (b) {
        b.onclick = function () { decide(id, b.getAttribute('data-act') === 'approve', msg); };
      });
    });
    if (focus) { try { card.scrollIntoView({ block: 'start' }); } catch (_) {} }
  }

  w.Approvals = { mount: mount };
  // Not in a look-only preview (js/board-view.js), and once the page is in.
  document.addEventListener('DOMContentLoaded', function () { if (!w.BoardView && tok()) mount(); });
})(window);
