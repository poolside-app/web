/* =============================================================================
 * setup-list.js — the club setup list, on the board home and the Setup tab
 * =============================================================================
 * PLAN.md J1 (one list, from tenant_settings `setup_status`), CD (Doug 11/6:
 * "We can select who deals with the setup… might not always be the
 * president"). The server says who handles setup (`mine`, the Club setup
 * alert, else the President) and shapes the steps:
 *   - whoever handles it: every step; on the home, foldable with Hide for now;
 *   - full access: every step on the Setup tab;
 *   - everyone else: only "Sign up your own family", which is theirs.
 * A step saved only with full access, for someone without it, says so
 * (`needs_full`) instead of showing a button that would fail.
 *
 *   SetupList.render(el, data, { club, tab, folded, token, authUrl, onChange })
 * ============================================================================= */
(function () {
  'use strict';
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  function row(it) {
    var acts = '';
    if (!it.done) {
      acts = it.needs_full
        ? '<div data-needs-full="' + esc(it.id) + '" style="margin-left:auto;align-self:center;font-size:12px;font-weight:600;color:#92400e;background:#fffbeb;border:1px dashed #fcd34d;border-radius:8px;padding:6px 10px">Needs full access: ask the President</div>'
        : '<div class="su-acts" style="display:flex;gap:6px;flex-wrap:wrap;margin-left:auto;align-self:center">' +
            '<a href="' + esc(it.fix_url) + '" data-setup="' + esc(it.id) + '" style="padding:6px 12px;background:var(--blue,#0a3b5c);color:#fff;text-decoration:none;border-radius:8px;font:600 12px Inter,sans-serif;white-space:nowrap">' + esc(it.fix_label) + ' →</a>' +
            (it.can_skip ? '<button type="button" data-skip="' + esc(it.id) + '" style="padding:6px 10px;border-radius:8px;font:600 12px Inter,sans-serif;background:transparent;border:1.5px solid #fde68a;color:#7c2d12;cursor:pointer;white-space:nowrap">I don\'t swim here</button>' : '') +
          '</div>';
    }
    // Words beside the box; the buttons go under them when they don't fit (PLAN.md CC7).
    return '<div style="display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px 12px;padding:10px 14px;background:#fff;border:1px solid #fde68a;border-radius:10px">' +
      '<div style="flex:0 0 22px;font-size:17px;text-align:center;color:' + (it.done ? '#15803d' : '#92400e') + '">' + (it.done ? '✓' : '☐') + '</div>' +
      '<div style="flex:1 1 190px;min-width:0">' +
        '<div style="font-weight:600;font-size:14px;' + (it.done ? 'color:#15803d;text-decoration:line-through' : 'color:#0f172a') + '">' + esc(it.label) + '</div>' +
        (it.done ? '' : '<div style="font-size:12px;color:#78350f;margin-top:2px;line-height:1.45">' + esc(it.why || '') + '</div>') +
      '</div>' + acts + '</div>';
  }
  function rows(items) { return '<div style="display:flex;flex-direction:column;gap:8px">' + items.map(row).join('') + '</div>'; }

  /** The HTML for this person: the whole list, their own step, or nothing (''). */
  function html(data, o) {
    o = o || {};
    var items = data.items || [];
    var head = '🎯 Setup: ' + (Number(data.done) || 0) + ' of ' + (Number(data.total) || 0) + ' done';
    var whole = data.mine || (o.tab && data.full_access);
    if (whole) {
      if (!o.tab && o.folded) {
        return '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">' +
          '<b style="color:#7c2d12">' + head + '</b>' +
          '<button type="button" id="setup-unfold" style="padding:6px 12px;border-radius:8px;font:600 12px Inter,sans-serif;background:#0a3b5c;color:#fff;border:0;cursor:pointer">Show the list</button></div>';
      }
      var lede = data.mine
        ? 'Each one opens the screen where it\'s set. Finish these and ' + esc(o.club || 'your club') + ' is ready for members.'
        : 'The ' + esc(data.who || 'President') + ' handles the club\'s setup. Each one opens the screen where it\'s set.';
      return '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:12px">' +
          '<div><h2 style="margin:0 0 4px;color:#7c2d12">' + head + '</h2>' +
          '<p style="margin:0;font-size:13px;color:#92400e;line-height:1.5">' + lede + '</p></div>' +
          (o.tab ? '' : '<button type="button" id="setup-fold" style="padding:6px 10px;border-radius:8px;font:600 12px Inter,sans-serif;background:transparent;border:0;color:#7c2d12;cursor:pointer;text-decoration:underline">Hide for now</button>') +
        '</div>' + rows(items);
    }
    // Not theirs: only their own step, Sign up your own family.
    var own = items.filter(function (i) { return !i.done; });
    if (!o.tab) return own.length ? rows(own) : '';
    return '<p style="margin:0 0 12px;font-size:14px;color:#7c2d12;line-height:1.5"><b>The ' + esc(data.who || 'President') + ' handles the club\'s setup.</b> ' +
      'Who does it is set on Settings → Board, with the Club setup alert.</p>' +
      (own.length ? rows(own) : '<p style="margin:0;font-size:13.5px;color:#92400e">Nothing here for you to do.</p>');
  }

  function render(el, data, o) {
    o = o || {};
    if (!el) return '';
    var out = html(data, o);
    el.innerHTML = out;
    var skip = el.querySelector('[data-skip="self_signup"]');
    if (skip) skip.addEventListener('click', async function () {
      try {
        await fetch(o.authUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + o.token },
          body: JSON.stringify({ action: 'dismiss_member_apply' }),
        });
      } catch (_) { /* shows again next load */ }
      if (o.onChange) o.onChange();
    });
    var fold = function (v) { try { localStorage.setItem('poolside_setup_folded', v ? '1' : '0'); } catch (_) {} if (o.onChange) o.onChange(); };
    var f = el.querySelector('#setup-fold'); if (f) f.addEventListener('click', function () { fold(true); });
    var u = el.querySelector('#setup-unfold'); if (u) u.addEventListener('click', function () { fold(false); });
    // The join-link step points at the signup link at the bottom of the home.
    var share = el.querySelector('[data-setup="share_link"]');
    if (share) share.addEventListener('click', function (e) {
      var target = document.getElementById('apply-link-card');
      if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    });
    return out;
  }

  window.SetupList = { html: html, render: render };
})();
