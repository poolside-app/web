/*
 * step-up.js — a fresh texted code before a dangerous change (PLAN.md CQ1)
 *
 * Doug 11/8: "Do the text confirm swapping that". Switching Stripe accounts,
 * changing the Venmo handle, giving someone full access and approving one of
 * those ask for a code texted to the person's own phone (_shared/step_up.ts).
 *
 *   const r = await StepUp.run(code => call(url, action, { ...extra, step_up_code: code }));
 *
 * The call is made; when the answer says it needs a code, one is texted
 * (tenant_admin_auth step_up_start) and the person types it in, and the call
 * is made again with it. Returns the last answer, or { ok: false, cancelled: true }.
 */
(function (w) {
  var AUTH = 'https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/tenant_admin_auth';
  function tok() { try { return localStorage.getItem('poolside_tenant_token') || ''; } catch (_) { return ''; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  async function send(purpose) {
    var res = await fetch(AUTH, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok() },
      body: JSON.stringify({ action: 'step_up_start', purpose: purpose }) });
    return res.json().catch(function () { return { ok: false, error: 'Could not send a code' }; });
  }

  function box() {
    var el = document.getElementById('stepup-scrim');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'stepup-scrim';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:1000;display:none;align-items:center;justify-content:center;padding:16px';
    el.innerHTML = '<div role="dialog" aria-modal="true" aria-labelledby="stepup-title" style="background:#fff;border-radius:16px;padding:22px;width:100%;max-width:380px;box-shadow:0 20px 60px rgba(10,59,92,.25);font-family:Inter,system-ui,sans-serif;color:#0f172a">' +
      '<h2 id="stepup-title" style="margin:0 0 6px;font:600 20px Fraunces,Georgia,serif;color:#0a3b5c">🔐 Enter your code</h2>' +
      '<p id="stepup-text" style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#334155"></p>' +
      '<input id="stepup-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="width:100%;box-sizing:border-box;padding:12px 14px;border:1.5px solid #e2e8f0;border-radius:10px;font:600 22px Inter,system-ui,sans-serif;letter-spacing:.2em;text-align:center">' +
      '<div id="stepup-err" style="color:#b91c1c;font-size:13px;margin-top:8px;min-height:1em"></div>' +
      '<div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:12px;flex-wrap:wrap">' +
      '<button type="button" id="stepup-resend" style="background:none;border:0;padding:0;font:600 13px Inter,system-ui,sans-serif;color:#0a3b5c;text-decoration:underline;cursor:pointer">Send a new code</button>' +
      '<span style="display:flex;gap:8px"><button type="button" id="stepup-cancel" style="padding:10px 14px;border:1.5px solid #e2e8f0;border-radius:10px;background:#fff;font:600 14px Inter,system-ui,sans-serif;cursor:pointer">Cancel</button>' +
      '<button type="button" id="stepup-ok" style="padding:10px 16px;border:0;border-radius:10px;background:#0a3b5c;color:#fff;font:600 14px Inter,system-ui,sans-serif;cursor:pointer">Confirm</button></span></div></div>';
    document.body.appendChild(el);
    return el;
  }

  // Ask for the code: texts one first (unless `resent` already did), then waits for Confirm or Cancel.
  async function ask(purpose, message, wrong) {
    var el = box(), input = el.querySelector('#stepup-code'), err = el.querySelector('#stepup-err'), text = el.querySelector('#stepup-text');
    if (!wrong) {
      var s = await send(purpose);
      if (!s.ok) { alert(s.error || 'Could not send a code'); return null; }
      text.innerHTML = esc(message || 'Enter the code we sent you.') + '<br><span style="color:#64748b;font-size:13px">We ' + (s.via === 'email' ? 'emailed it to ' : 'texted it to ') + esc(s.to) + '. It works for 10 minutes.</span>';
      err.textContent = '';
    } else {
      err.textContent = message || "That code isn't right.";
    }
    input.value = '';
    el.style.display = 'flex';
    setTimeout(function () { try { input.focus(); } catch (_) {} }, 50);
    return new Promise(function (resolve) {
      function done(v) { el.style.display = 'none'; el.querySelector('#stepup-ok').onclick = el.querySelector('#stepup-cancel').onclick = el.querySelector('#stepup-resend').onclick = input.onkeydown = null; resolve(v); }
      el.querySelector('#stepup-ok').onclick = function () { var v = input.value.replace(/\D/g, ''); if (v.length !== 6) { err.textContent = 'Enter the 6 numbers.'; return; } done(v); };
      el.querySelector('#stepup-cancel').onclick = function () { done(null); };
      el.querySelector('#stepup-resend').onclick = async function () { var s = await send(purpose); err.textContent = s.ok ? 'Sent a new one.' : (s.error || 'Could not send a code'); };
      input.onkeydown = function (e) { if (e.key === 'Enter') el.querySelector('#stepup-ok').click(); };
    });
  }

  async function run(call) {
    var r = await call(null);
    for (var i = 0; r && r.needs_code && i < 5; i++) {
      var code = await ask(r.purpose, r.error, i > 0);
      if (code == null) return { ok: false, cancelled: true, error: 'Canceled' };
      r = await call(code);
    }
    return r;
  }

  w.StepUp = { run: run };
})(window);
