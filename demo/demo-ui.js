// =============================================================================
// demo-ui.js — runs first on every page of the demo club (PLAN.md BG9)
// =============================================================================
// Added by demo-sw.js. Sets the demo's date (a Saturday in June, when the pool
// is busy), keeps the demo board member and family signed in, shows the
// "Demo club" banner, and shows a note whenever a button would have texted,
// emailed, charged or opened a door in a real club.
// =============================================================================
(function () {
  // Must match DEMO_NOW in scripts/demo_video/data.mjs (test_demo_site checks).
  var DEMO_NOW = Date.parse('2027-06-19T10:40:00-07:00');
  var shift = DEMO_NOW - Date.now();
  var RealDate = Date;
  function DemoDate() {
    var a = Array.prototype.slice.call(arguments);
    return a.length ? new (Function.prototype.bind.apply(RealDate, [null].concat(a)))() : new RealDate(RealDate.now() + shift);
  }
  DemoDate.prototype = RealDate.prototype;
  DemoDate.now = function () { return RealDate.now() + shift; };
  DemoDate.parse = RealDate.parse; DemoDate.UTC = RealDate.UTC;
  // eslint-disable-next-line no-global-assign
  Date = DemoDate;

  var TOKEN = 'demo.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6ImRlbW8ifQ.demo';
  try {
    if (!localStorage.getItem('poolside_tenant_token')) {
      localStorage.setItem('poolside_tenant_token', TOKEN);
      localStorage.setItem('poolside_tenant_user', JSON.stringify({ id: 'demo-board', display_name: 'Sam Brooks' }));
      localStorage.setItem('poolside_tenant_tenant', JSON.stringify({ slug: 'demo', display_name: 'Maple Grove Swim Club' }));
    }
    if (!localStorage.getItem('poolside_member_token')) {
      localStorage.setItem('poolside_member_token', TOKEN);
      localStorage.setItem('poolside_member_tenant', 'demo');
    }
  } catch (_) { /* private mode: the pages still show */ }

  function css() {
    var s = document.createElement('style');
    s.textContent = '#demo-bar{background:#0b3954;color:#fff;font:600 13px/1.4 -apple-system,system-ui,sans-serif;padding:8px max(12px,env(safe-area-inset-left));display:flex;gap:8px 14px;align-items:center;flex-wrap:wrap;justify-content:center;text-align:center}'
      + '#demo-bar a,#demo-bar button{color:#fff;font:inherit;background:rgba(255,255,255,.14);border:0;border-radius:999px;padding:4px 10px;text-decoration:none;cursor:pointer}'
      + '#demo-note{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));transform:translateX(-50%);max-width:min(92vw,460px);background:#111827;color:#fff;font:500 14px/1.45 -apple-system,system-ui,sans-serif;padding:12px 16px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);z-index:2147483647;opacity:0;transition:opacity .2s;pointer-events:none}'
      + '#demo-note.show{opacity:1}#demo-note b{color:#fcd34d}';
    document.head.appendChild(s);
  }
  function bar() {
    if (document.getElementById('demo-bar')) return;
    var b = document.createElement('div');
    b.id = 'demo-bar';
    b.innerHTML = '<span>🧪 Demo club. Maple Grove is made up: nothing here is real, and nothing is sent.</span>'
      + '<a href="/club/admin/">Board side</a><a href="/m/">Member app</a><button type="button" id="demo-reset">Start over</button>';
    document.body.insertBefore(b, document.body.firstChild);
    document.getElementById('demo-reset').addEventListener('click', function () {
      try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}
      if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'demo-reset' });
      location.href = '/';
    });
  }
  var timer = null;
  function note(text) {
    var n = document.getElementById('demo-note');
    if (!n) { n = document.createElement('div'); n.id = 'demo-note'; n.setAttribute('role', 'status'); document.body.appendChild(n); }
    n.innerHTML = '<b>Demo:</b> ';
    n.appendChild(document.createTextNode(text + ' Nothing was sent.'));
    n.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(function () { n.classList.remove('show'); }, 5200);
  }
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'demo-would') note(e.data.text);
    });
  }
  function ready() { css(); bar(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
