/*
 * plan-picker.js — "Pay today" and "Paid off by" for a payment plan (PLAN.md M)
 *
 * Used by the join form, the signed-in renewal page and the renewal link. The
 * page asks the server for a quote (the plan on offer, priced), and this draws
 * it: the two choices, then every date and amount before the family commits.
 * No math happens here. When a choice changes, the page re-asks the server
 * and hands the new quote to update().
 *
 *   PlanPicker.mount(el, quote, onChange)   onChange({ today_cents, payoff_month })
 *   PlanPicker.update(quote)
 *   PlanPicker.choice()                     what to send to checkout, or null if it doesn't work yet
 *                                           (or the agreement isn't signed)
 *   await PlanPicker.settled()              before submitting: the quote matches what's on screen
 *
 * Under the schedule is the payment plan agreement, in js/plan-agreement.js's
 * words, and a second signature (PLAN.md CL2, Doug 11/7). Checkout refuses a
 * plan without it. A changed schedule needs signing again: they agreed to
 * other dates. Needs signature_pad (window.SignaturePad) loaded.
 */
(function () {
  let root = null, quote = null, onChange = null, timer = null, busy = false;
  let pad = null, padKey = '', ro = null;

  const money = c => '$' + (Number(c || 0) / 100).toFixed(2);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = key => (window.PoolTime && PoolTime.fmtDay)
    ? PoolTime.fmtDay(key, { month: 'short', day: 'numeric' })
    : key;

  function accessText(q) {
    if (q.access_when === 'card') return 'Your gate access and key fob start as soon as your card is saved.';
    if (q.access_when === 'first_payment') return 'Your gate access and key fob start with your first payment.';
    return 'Your gate access and key fob start once half your dues are paid.';
  }

  // The board's $1 test level (PLAN.md BN1): a fixed weekly plan, nothing to pick.
  function weekly(q) {
    const r = (q.choice && q.choice.rows) || [];
    const each = r[0] ? money(r[0].charge_cents) : '';
    return `
      <div style="font-size:13.5px;line-height:1.5;margin-top:12px">${esc(each)} today, then ${esc(each)} every week for ${Math.max(0, r.length - 1)} weeks. Each one waits for a board member to approve it on Money → Upcoming.</div>
      <div id="pp-result" style="margin-top:12px">${result(q)}</div>
      <div id="pp-sign"></div>`;
  }

  function controls(q) {
    if (q.weekly) return weekly(q);
    const c = q.choice || {};
    const today = c.today_cents ? (c.today_cents / 100).toFixed(c.today_cents % 100 ? 2 : 0) : '';
    return `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
        <label style="flex:1;min-width:140px;font:600 12px 'Inter';color:var(--muted,#64748b)">Pay today
          <div style="position:relative;margin-top:5px">
            <span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--muted,#64748b);font:500 15px 'Inter'">$</span>
            <input id="pp-today" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(today)}"
              style="width:100%;box-sizing:border-box;padding:11px 12px 11px 24px;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font:500 16px 'Inter'">
          </div>
        </label>
        <label style="flex:1;min-width:140px;font:600 12px 'Inter';color:var(--muted,#64748b)">Paid off by
          <select id="pp-month" style="display:block;width:100%;box-sizing:border-box;margin-top:5px;padding:11px 10px;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font:500 16px 'Inter';background:#fff">
            ${(q.months || []).map(m => `<option value="${esc(m.value)}" ${m.value === c.payoff_month ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div style="font-size:12px;color:var(--muted,#64748b);margin-top:6px">$0 today is fine: your card is saved and the first payment is next month.${q.min_payment_cents ? ` Anything you pay today is at least ${money(q.min_payment_cents)}.` : ''}</div>
      <div id="pp-result" style="margin-top:12px">${result(q)}</div>
      <div id="pp-sign"></div>`;
  }

  function result(q) {
    const c = q.choice;
    if (!c) return '';
    if (!c.ok) {
      const fix = c.min_today_cents && c.min_today_cents < q.total_cents
        ? `<button type="button" id="pp-fix" style="margin-top:10px;padding:9px 14px;border:0;border-radius:999px;background:var(--blue,#0a3b5c);color:#fff;font:600 13px 'Inter';cursor:pointer">Pay ${money(c.min_today_cents)} today instead</button>`
        : '';
      return `<div style="padding:12px 14px;border:1.5px solid #fecaca;background:#fef2f2;border-radius:10px;color:#7f1d1d;font-size:13.5px;line-height:1.5">${esc(c.error)}${fix ? '<div>' + fix + '</div>' : ''}</div>`;
    }
    const first = (c.checks || []).find(k => k.pct < 100);
    const rows = c.rows.map(r => `
      <tr>
        <td style="padding:7px 0;border-top:1px solid var(--border,#e2e8f0)">${r.today ? '<b>Today</b>' : esc(day(r.due_date))}</td>
        <td style="padding:7px 0;border-top:1px solid var(--border,#e2e8f0);text-align:right;font-variant-numeric:tabular-nums">${money(r.charge_cents)}</td>
      </tr>`).join('');
    const t = c.totals;
    const extras = [];
    if (t.plan_fee_cents) extras.push(`a ${money(t.plan_fee_cents)} payment-plan fee`);
    if (t.card_fee_cents) extras.push(`${money(t.card_fee_cents)} in card fees`);
    return `
      ${c.adjusted ? `<div style="font-size:13px;color:#92400e;background:#fef3c7;border-radius:10px;padding:10px 12px;margin-bottom:10px">To be paid up by the first deadline, this plan starts with ${money(c.today_cents)} today. You can change it.</div>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr><th style="text-align:left;font:600 11px 'Inter';letter-spacing:.05em;text-transform:uppercase;color:var(--muted,#64748b);padding-bottom:4px">When</th>
        <th style="text-align:right;font:600 11px 'Inter';letter-spacing:.05em;text-transform:uppercase;color:var(--muted,#64748b);padding-bottom:4px">Charged</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td style="padding:8px 0;border-top:2px solid var(--border,#e2e8f0);font-weight:700">Total</td>
        <td style="padding:8px 0;border-top:2px solid var(--border,#e2e8f0);text-align:right;font-weight:700">${money(t.charge_cents)}</td></tr></tfoot>
      </table>
      <div style="font-size:12.5px;color:var(--muted,#64748b);line-height:1.55;margin-top:8px">
        ${money(t.dues_cents)} in dues${extras.length ? ', plus ' + extras.join(' and ') : ''}.
        ${first ? `${money(first.paid_cents)} paid by ${esc(day(first.club_date || first.date))}, when ${Number(first.pct)}% is due.` : ''}
        Each payment is charged to your card automatically, with a receipt. ${esc(accessText(q))}
      </div>`;
  }

  // ── The payment plan agreement and its signature (PLAN.md CL2) ──────────
  function scheduleKey(q) {
    const c = q && q.choice;
    if (!c || !c.ok || !c.rows) return '';
    return JSON.stringify([c.rows.map(r => [r.due_date, r.charge_cents, !!r.today]), c.totals && c.totals.charge_cents]);
  }
  function agreementLines(q) {
    const c = q.choice, rows = c.rows || [];
    const todayRow = rows.find(r => r.today);
    return PlanAgreement.lines({
      clubName: q.club_name, todayDate: todayRow ? todayRow.due_date : '', rows,
      totalChargeCents: c.totals ? c.totals.charge_cents : 0, deadlines: q.deadlines || [],
      accessWhen: q.access_when, reactivationFeeCents: q.reactivation_fee_cents,
    });
  }
  function signHtml(q) {
    return `
      <div style="margin-top:16px;padding:14px;border:1.5px solid var(--border,#e2e8f0);border-radius:12px;background:#f8fafc">
        <div style="font:700 14px 'Inter';margin-bottom:6px">Payment plan agreement</div>
        <ul id="pp-agree" style="margin:0;padding-left:18px;font-size:13px;line-height:1.55">
          ${agreementLines(q).map(l => `<li style="margin:4px 0">${esc(l)}</li>`).join('')}
        </ul>
        <div style="font:600 13.5px 'Inter';margin:12px 0 6px;line-height:1.45">${esc(PlanAgreement.authorization(q.club_name))}</div>
        <div style="position:relative;border:1.5px dashed var(--border,#e2e8f0);border-radius:12px;background:#fff;height:130px">
          <canvas id="pp-canvas" style="width:100%;height:100%;display:block;touch-action:none"></canvas>
          <button type="button" id="pp-clear" style="position:absolute;top:6px;right:6px;padding:4px 10px;border:1px solid var(--border,#e2e8f0);border-radius:999px;background:#fff;font:600 12px 'Inter';color:var(--muted,#64748b);cursor:pointer">Clear</button>
        </div>
        <div style="font-size:12px;color:var(--muted,#64748b);margin-top:6px;line-height:1.5">Sign above to agree to the payment plan. If you change the plan, you sign again.</div>
      </div>`;
  }
  function drawSign(q) {
    const box = document.getElementById('pp-sign');
    if (!box) return;
    const key = scheduleKey(q);
    if (key && key === padKey && pad) return;   // the same schedule: keep their signature
    padKey = key; pad = null;
    if (ro) { ro.disconnect(); ro = null; }
    if (!key || !window.PlanAgreement) { box.innerHTML = ''; return; }
    box.innerHTML = signHtml(q);
    const c = document.getElementById('pp-canvas');
    if (!c || !window.SignaturePad) return;
    // Sized to how it shows; the picker can start hidden, so again once it shows.
    const fit = () => {
      const w = c.offsetWidth, h = c.offsetHeight;
      if (!w || !h) return;
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      if (c.width === Math.round(w * ratio) && c.height === Math.round(h * ratio)) return;
      const data = pad && pad.toData ? pad.toData() : null;
      c.width = Math.round(w * ratio); c.height = Math.round(h * ratio);
      c.getContext('2d').scale(ratio, ratio);
      if (pad) { pad.clear(); if (data && data.length) pad.fromData(data); }
    };
    fit();
    pad = new window.SignaturePad(c, { backgroundColor: 'rgba(0,0,0,0)' });
    if (window.ResizeObserver) { ro = new ResizeObserver(fit); ro.observe(c); }
    document.getElementById('pp-clear').addEventListener('click', () => { if (pad) pad.clear(); });
  }
  const unsigned = () => !pad || pad.isEmpty();

  function changed(immediate) {
    clearTimeout(timer);
    busy = true;
    const fire = () => {
      const raw = (document.getElementById('pp-today')?.value || '').replace(/[^0-9.]/g, '');
      const today_cents = raw ? Math.round(parseFloat(raw) * 100) : 0;
      const payoff_month = document.getElementById('pp-month')?.value || null;
      onChange && onChange({ today_cents, payoff_month });
    };
    if (immediate) fire(); else timer = setTimeout(fire, 450);
  }

  function wire() {
    const t = document.getElementById('pp-today');
    const m = document.getElementById('pp-month');
    if (t) t.addEventListener('input', () => changed(false));
    if (m) m.addEventListener('change', () => changed(true));
    wireFix();
  }
  function wireFix() {
    const f = document.getElementById('pp-fix');
    if (f) f.addEventListener('click', () => {
      const t = document.getElementById('pp-today');
      if (t) t.value = (quote.choice.min_today_cents / 100).toFixed(quote.choice.min_today_cents % 100 ? 2 : 0);
      changed(true);
    });
  }

  window.PlanPicker = {
    mount(el, q, cb) {
      root = el; quote = q; onChange = cb;
      if (!root) return;
      if (!q || !q.available) {
        root.innerHTML = `<div style="font-size:13.5px;color:var(--muted,#64748b);margin-top:10px">${esc(q?.reason || 'Payment plans are not available.')}</div>`;
        return;
      }
      padKey = ''; pad = null;
      root.innerHTML = controls(q);
      wire();
      drawSign(q);
    },
    update(q) {
      const wasWeekly = !!(quote && quote.weekly);
      quote = q; busy = false;
      if (!root || !document.body.contains(root)) return;
      if (!q || !q.available || !!q.weekly !== wasWeekly) { this.mount(root, q, onChange); return; }
      const box = document.getElementById('pp-result');
      if (!box) { this.mount(root, q, onChange); return; }
      // The family may still be typing: leave the inputs alone, except to
      // show an amount the server chose for them.
      const t = document.getElementById('pp-today');
      if (t && q.choice && q.choice.adjusted && document.activeElement !== t) {
        t.value = (q.choice.today_cents / 100).toFixed(q.choice.today_cents % 100 ? 2 : 0);
      }
      const m = document.getElementById('pp-month');
      if (m && q.choice && m.value !== q.choice.payoff_month) m.value = q.choice.payoff_month;
      box.innerHTML = result(q);
      wireFix();
      drawSign(q);
    },
    choice() {
      const c = quote && quote.choice;
      if (!c || !c.ok || unsigned()) return null;
      return { today_cents: c.today_cents, payoff_month: c.payoff_month, plan_signature: pad.toDataURL('image/png') };
    },
    /** Wait (up to 5 seconds) for a quote the family just changed. */
    async settled() {
      for (let i = 0; busy && i < 50; i++) await new Promise(r => setTimeout(r, 100));
    },
    /** The page's quote request failed: stop waiting for it. */
    failed() { busy = false; },
    error() {
      const c = quote && quote.choice;
      if (c && c.ok) return unsigned() ? 'Sign the payment plan agreement under your schedule.' : null;
      return c && !c.ok ? c.error : (quote && !quote.available ? quote.reason : null);
    },
    /** For tests: the agreement's signature pad. */
    __pad() { return pad; },
  };
})();
