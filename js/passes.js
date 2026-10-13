/* =============================================================================
 * passes.js — door passes, on the Keyfobs tab and the board home (PLAN.md AR4)
 * =============================================================================
 * Doug, 10/13: "a special all access? For a specific length? Like when
 * someone volunteers for something and needs to get into a pump room."
 * Any board member gives a family extra doors for a set time; the family
 * opens them from the app until it ends (or the board ends it early). A
 * pass can also go to someone outside the club by name and mobile: they're
 * texted a private link (/pass.html) that opens the doors during the pass
 * (PLAN.md AS3). A
 * paid party gets the party doors for its day by itself. Calls gate_admin
 * pass_list / pass_families / pass_create / pass_end. Times are the pool's
 * (needs /js/pooltime.js).
 *
 *   PoolsidePasses.mount(element)   // the panel, in a page
 *   PoolsidePasses.open()           // the panel in a pop-up
 * ============================================================================= */
(function () {
  'use strict';
  var FN = 'https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/gate_admin';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  async function call(action, extra) {
    var t = localStorage.getItem('poolside_tenant_token');
    var r = await fetch(FN, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t },
      body: JSON.stringify(Object.assign({ action: action }, extra || {})) });
    return r.json();
  }
  function when(iso) {
    return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function timeOnly(iso) { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function span(p) {
    var a = PoolTime.dayKey(new Date(p.starts_at)), b = PoolTime.dayKey(new Date(p.ends_at));
    return a === b ? when(p.starts_at) + '–' + timeOnly(p.ends_at) : when(p.starts_at) + ' to ' + when(p.ends_at);
  }

  function css() {
    if (document.getElementById('pp-css')) return;
    var s = document.createElement('style');
    s.id = 'pp-css';
    s.textContent = [
      '.pp-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}',
      '.pp-head b{font:600 17px Fraunces,Georgia,serif}',
      '.pp-lede{font-size:12.5px;color:#5d6b81;margin:0 0 10px;line-height:1.5}',
      '.pp-list{background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden}',
      '.pp-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 14px;border-top:1px solid #e5e7eb;font-size:13.5px}',
      '.pp-row:first-child{border-top:0}',
      '.pp-row .w{flex:1;min-width:190px}',
      '.pp-row .m{font-size:12.5px;color:#5d6b81}',
      '.pp-tag{display:inline-block;padding:2px 8px;border-radius:999px;font:700 10.5px Inter,sans-serif;text-transform:uppercase;letter-spacing:.04em;background:#dcfce7;color:#15803d;margin-left:6px}',
      '.pp-tag.soon{background:#e6eef5;color:#0a3b5c}.pp-tag.done{background:#f1f5f9;color:#64748b}',
      '.pp-btn{padding:8px 14px;border-radius:10px;font:600 13px Inter,sans-serif;border:1.5px solid #e5e7eb;background:#fff;color:#0a3b5c;cursor:pointer}',
      '.pp-btn.go{background:#0a3b5c;border-color:#0a3b5c;color:#fff}',
      '.pp-form{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px;margin-bottom:10px;display:grid;gap:10px}',
      '.pp-form label{display:block;font-size:12.5px;font-weight:600;color:#5d6b81;margin-bottom:4px}',
      '.pp-form input[type=text],.pp-form input[type=search],.pp-form input[type=datetime-local]{width:100%;font:14px/1.4 Inter,sans-serif;border:1.5px solid #e5e7eb;border-radius:10px;padding:9px 11px;box-sizing:border-box}',
      '.pp-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '@media (max-width:520px){.pp-two{grid-template-columns:1fr}}',
      '.pp-doors{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:14px}',
      '.pp-doors label{display:inline-flex;align-items:center;gap:6px;font-weight:500;color:#0f172a;margin:0;white-space:nowrap}',
      '.pp-doors input[type=checkbox],.pp-doors input[type=radio]{width:auto;margin:0;padding:0}',
      '.pp-fams{border:1px solid #e5e7eb;border-radius:10px;margin-top:6px;max-height:190px;overflow:auto}',
      '.pp-fams button{display:block;width:100%;text-align:left;border:0;border-top:1px solid #f1f5f9;background:#fff;padding:8px 11px;font:14px Inter,sans-serif;cursor:pointer}',
      '.pp-fams button:first-child{border-top:0}.pp-fams button:hover{background:#f7f3eb}',
      '.pp-fams small{color:#5d6b81;margin-left:6px}',
      '.pp-err{color:#dc2626;font-size:13px}',
      '#passes-scrim{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:200;display:flex;align-items:flex-end;justify-content:center;overscroll-behavior:contain}',
      '#passes-scrim .pp-sheet{background:#fefdfb;width:100%;max-width:640px;max-height:88vh;overflow:auto;border-radius:18px 18px 0 0;padding:16px 16px 28px}',
      '@media (min-width:700px){#passes-scrim{align-items:center}#passes-scrim .pp-sheet{border-radius:18px}}',
    ].join('');
    document.head.appendChild(s);
  }

  function mount(el) {
    css();
    var st = { passes: [], doors: [], families: null, giving: false, picked: null, err: '', who: 'family', given: null };

    async function load() {
      var r = await call('pass_list');
      if (!r.ok) { el.innerHTML = '<div class="pp-err">' + esc(r.error || 'Could not load passes') + '</div>'; return; }
      st.passes = r.passes || []; st.doors = r.doors || [];
      paint();
    }

    function rowHtml(p) {
      var now = Date.now(), s = Date.parse(p.starts_at), e = Date.parse(p.ends_at);
      var ended = p.ended_at || e <= now;
      var tag = ended ? '<span class="pp-tag done">Ended</span>' : s > now ? '<span class="pp-tag soon">Upcoming</span>' : '<span class="pp-tag">Now</span>';
      var by = p.source_kind === 'party' ? 'from the party' : p.given_by ? 'given by ' + esc(p.given_by) : '';
      return '<div class="pp-row"><div class="w"><b>' + esc(p.family_name) + '</b> · ' + esc((p.door_names || []).join(', ')) + tag
        + '<div class="m">' + esc(span(p)) + (p.note ? ' · ' + esc(p.note) : '') + (by ? ' · ' + by : '') + '</div></div>'
        + (ended ? '' : '<button type="button" class="pp-btn" data-end="' + esc(p.id) + '">End now</button>') + '</div>';
    }

    function formHtml() {
      var today = PoolTime.todayKey();
      var from = PoolTime.toInput(new Date().toISOString()).slice(0, 14) + '00';
      var to = PoolTime.toInput(PoolTime.atTime(today, 20, 30).toISOString());
      if (to <= from) to = PoolTime.toInput(new Date(Date.now() + 3 * 3600e3).toISOString());
      var guest = st.who === 'guest';
      return '<div class="pp-form">'
        + '<div class="pp-doors" role="radiogroup" aria-label="Who"><label><input type="radio" name="pp-who" value="family"' + (guest ? '' : ' checked') + '> A member family</label>'
        + '<label><input type="radio" name="pp-who" value="guest"' + (guest ? ' checked' : '') + '> Someone else</label></div>'
        + (guest
          ? '<div class="pp-two"><div><label for="pp-gname">Their name</label><input id="pp-gname" type="text" maxlength="80" placeholder="Sam (pool tech)"></div>'
            + '<div><label for="pp-gphone">Their mobile</label><input id="pp-gphone" type="text" inputmode="tel" autocomplete="off" placeholder="(925) 555-0123"></div></div>'
          : '<div><label for="pp-fam">Family</label><input id="pp-fam" type="search" autocomplete="off" placeholder="Type a family name or address"'
            + (st.picked ? ' value="' + esc(st.picked.family_name) + '"' : '') + '><div class="pp-fams" id="pp-fams" style="display:none"></div></div>')
        + '<div><label>Doors</label><div class="pp-doors">'
        + (st.doors.length > 1 ? '<label><input type="checkbox" id="pp-all"> <b>All doors</b></label>' : '')
        + st.doors.map(function (d) { return '<label><input type="checkbox" class="pp-door" value="' + esc(d.key) + '"> ' + esc(d.name) + '</label>'; }).join('')
        + '</div></div>'
        + '<div class="pp-two"><div><label for="pp-from">From</label><input id="pp-from" type="datetime-local" value="' + esc(from) + '"></div>'
        + '<div><label for="pp-to">To</label><input id="pp-to" type="datetime-local" value="' + esc(to) + '"></div></div>'
        + '<div><label for="pp-note">Note (optional)</label><input id="pp-note" type="text" maxlength="200" placeholder="Pump room: pool chemicals"></div>'
        + (guest
          ? '<div class="pp-lede" style="margin:0">Text it: we\'ll text them a private link that opens these doors during the pass, no app needed. Anyone with the link can use it until it ends.</div>'
          : '<div class="pp-doors"><label><input type="checkbox" id="pp-text"> Text it to them too (they always get a pop-up)</label></div>')
        + '<div class="pp-err" id="pp-err">' + esc(st.err) + '</div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pp-btn go" id="pp-give">Give the pass</button><button type="button" class="pp-btn" id="pp-cancel">Cancel</button></div>'
        + '</div>';
    }

    function givenHtml() {
      var g = st.given;
      if (!g) return '';
      return '<div class="pp-form" style="background:#f0fdf4;border-color:#bbf7d0">'
        + '<div><b>Pass given.</b> ' + (g.texted ? 'We texted it.' : g.text_error ? 'The text didn\'t go out (' + esc(g.text_error) + ').' : '') + '</div>'
        + (g.link ? '<div><label>Their link (to send another way if needed)</label><input type="text" readonly value="' + esc(g.link) + '" onclick="this.select()"></div>' : '')
        + '<div><button type="button" class="pp-btn" id="pp-given-ok">OK</button></div></div>';
    }

    function paint() {
      var live = st.passes.filter(function (p) { return !p.ended_at && Date.parse(p.ends_at) > Date.now(); });
      var done = st.passes.filter(function (p) { return !(live.indexOf(p) >= 0); });
      el.innerHTML = '<div class="pp-head"><b>Passes</b>' + (st.giving ? '' : '<button type="button" class="pp-btn go" id="pp-new">Give a pass</button>') + '</div>'
        + '<p class="pp-lede">Extra doors for a set time, opened from the family\'s app: a volunteer job, all access for a day. A paid party gets its doors for the day by itself.</p>'
        + (st.giving ? formHtml() : '') + givenHtml()
        + (live.length ? '<div class="pp-list">' + live.map(rowHtml).join('') + '</div>' : (st.giving ? '' : '<div class="pp-lede" style="padding:10px 0">No passes right now.</div>'))
        + (done.length ? '<details style="margin-top:8px"><summary style="cursor:pointer;font:600 13px Inter,sans-serif;color:#0a3b5c">Ended this week (' + done.length + ')</summary><div class="pp-list" style="margin-top:6px">' + done.map(rowHtml).join('') + '</div></details>' : '');
      wire();
    }

    function wire() {
      var nb = el.querySelector('#pp-new');
      if (nb) nb.onclick = async function () {
        st.giving = true; st.err = ''; st.picked = null;
        if (!st.families) { var r = await call('pass_families'); st.families = (r && r.families) || []; }
        paint();
        var f = el.querySelector('#pp-fam'); if (f) f.focus();
      };
      el.querySelectorAll('[data-end]').forEach(function (b) {
        b.onclick = async function () {
          if (!confirm('End this pass now? Their door buttons go away.')) return;
          b.disabled = true;
          var r = await call('pass_end', { id: b.dataset.end });
          if (!r.ok) { alert(r.error || 'Could not end it'); b.disabled = false; return; }
          load();
        };
      });
      var ok = el.querySelector('#pp-given-ok');
      if (ok) ok.onclick = function () { st.given = null; paint(); };
      if (!st.giving) return;
      el.querySelectorAll('input[name="pp-who"]').forEach(function (r) {
        r.onchange = function () { st.who = r.value; st.err = ''; paint(); };
      });
      var fam = el.querySelector('#pp-fam'), list = el.querySelector('#pp-fams');
      if (fam) fam.oninput = function () {
        st.picked = null;
        var q = fam.value.trim().toLowerCase();
        var hits = q ? st.families.filter(function (h) { return (h.family_name || '').toLowerCase().indexOf(q) >= 0 || (h.address || '').toLowerCase().indexOf(q) >= 0; }).slice(0, 8) : [];
        list.style.display = hits.length ? '' : 'none';
        list.innerHTML = hits.map(function (h) { return '<button type="button" data-id="' + esc(h.id) + '">' + esc(h.family_name) + (h.address ? '<small>' + esc(h.address) + '</small>' : '') + '</button>'; }).join('');
        list.querySelectorAll('button').forEach(function (b) {
          b.onclick = function () {
            st.picked = st.families.find(function (h) { return h.id === b.dataset.id; });
            fam.value = st.picked.family_name; list.style.display = 'none';
          };
        });
      };
      var all = el.querySelector('#pp-all');
      if (all) all.onchange = function () { el.querySelectorAll('.pp-door').forEach(function (c) { c.checked = all.checked; }); };
      el.querySelector('#pp-cancel').onclick = function () { st.giving = false; st.err = ''; paint(); };
      el.querySelector('#pp-give').onclick = async function () {
        var errEl = el.querySelector('#pp-err');
        var doors = Array.prototype.map.call(el.querySelectorAll('.pp-door:checked'), function (c) { return c.value; });
        var guest = st.who === 'guest';
        var who = guest
          ? { who: 'guest', guest_name: el.querySelector('#pp-gname').value.trim(), guest_phone: el.querySelector('#pp-gphone').value.trim() }
          : { who: 'family', household_id: st.picked && st.picked.id, text: !!(el.querySelector('#pp-text') || {}).checked };
        if (guest && (!who.guest_name || !who.guest_phone)) { errEl.textContent = 'Give their name and mobile.'; return; }
        if (!guest && !st.picked) { errEl.textContent = 'Pick a family from the list.'; return; }
        if (!doors.length) { errEl.textContent = 'Pick at least one door.'; return; }
        var starts = PoolTime.fromInput(el.querySelector('#pp-from').value), ends = PoolTime.fromInput(el.querySelector('#pp-to').value);
        if (!starts || !ends) { errEl.textContent = 'Give a from and a to.'; return; }
        var btn = this; btn.disabled = true; btn.textContent = 'Giving…';
        var r = await call('pass_create', Object.assign(who, { doors: doors, starts_at: starts, ends_at: ends, note: el.querySelector('#pp-note').value }));
        if (!r.ok) { errEl.textContent = r.error || 'Could not give it'; btn.disabled = false; btn.textContent = 'Give the pass'; return; }
        st.giving = false; st.err = ''; st.who = 'family';
        st.given = (r.link || r.texted || r.text_error) ? { link: r.link, texted: r.texted, text_error: r.text_error } : null;
        load();
      };
    }

    el.innerHTML = '<div class="pp-lede">Loading passes…</div>';
    load();
  }

  function open() {
    css();
    var old = document.getElementById('passes-scrim'); if (old) old.remove();
    var scrim = document.createElement('div');
    scrim.id = 'passes-scrim';
    scrim.className = 'scrim open';
    scrim.innerHTML = '<div class="pp-sheet" role="dialog" aria-label="Passes"><div style="text-align:right"><button type="button" class="pp-btn" id="pp-close">Close</button></div><div id="pp-host"></div></div>';
    document.body.appendChild(scrim);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) scrim.remove(); });
    scrim.querySelector('#pp-close').onclick = function () { scrim.remove(); };
    mount(scrim.querySelector('#pp-host'));
  }

  window.PoolsidePasses = { mount: mount, open: open };
})();
