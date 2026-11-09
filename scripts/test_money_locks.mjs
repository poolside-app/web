#!/usr/bin/env node
// Locks on where the money goes, and who can change the board (PLAN.md CQ).
// Doug 11/8: a stolen full-access sign-in switching the club's Stripe account
// is "kinda a problem"; "Do the text confirm swapping that"; "Should we have
// something that has 2 people on the board that need to reply?"; and a
// new-season reminder "to check the Venmo and stripe accounts".
//
// Offline: the codes and the approvals against a pretend database (texts
// caught, never sent), every place they're wired in, and in Chrome the code
// prompt and the approval card. Costs nothing.
//
// Usage: node scripts/test_money_locks.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';
import { fakeDb } from './lib/fake_google.mjs';

globalThis.Deno = globalThis.Deno || { env: { get: () => undefined } };
const root = new URL('../', import.meta.url);
const read = rel => { try { return readFileSync(new URL(rel, root), 'utf8'); } catch { return ''; } };
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return ''; const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = v => JSON.stringify(v)?.slice(0, 260);

console.log('CQ1 · a fresh texted code');
{
  const su = await importTs(new URL('supabase/functions/_shared/step_up.ts', root));
  const T = { admin_users: [{ id: 'a1', tenant_id: 't', active: true, phone_e164: '+14085550001', email: 'a@x.com' }], admin_step_up_codes: [] };
  const sb = fakeDb(T);
  let sent = null;
  const send = async (to, code) => { sent = { to, code }; return 'text'; };
  const s = await su.startStepUp(sb, { tenantId: 't', adminId: 'a1', purpose: 'stripe_switch', clubName: 'Maple Grove', send });
  check('a code goes to their own phone, shown masked', s.ok && s.via === 'text' && s.to.endsWith('0001') && /^\d{6}$/.test(sent.code), short(s));
  check('only its sha256 is kept', T.admin_step_up_codes.length === 1 && !JSON.stringify(T.admin_step_up_codes).includes(sent.code));
  check('a wrong code fails and counts', !(await su.useStepUp(sb, { tenantId: 't', adminId: 'a1', purpose: 'stripe_switch', code: '000000' === sent.code ? '111111' : '000000' })) && T.admin_step_up_codes[0].attempts === 1);
  check('the right code for another change fails', !(await su.useStepUp(sb, { tenantId: 't', adminId: 'a1', purpose: 'payments_change', code: sent.code })));
  check('the right code works once', await su.useStepUp(sb, { tenantId: 't', adminId: 'a1', purpose: 'stripe_switch', code: sent.code })
    && !(await su.useStepUp(sb, { tenantId: 't', adminId: 'a1', purpose: 'stripe_switch', code: sent.code })));
  const s2 = await su.startStepUp(sb, { tenantId: 't', adminId: 'a1', purpose: 'approve', clubName: 'Maple Grove', send });
  T.admin_step_up_codes[T.admin_step_up_codes.length - 1].expires_at = new Date(Date.now() - 1000).toISOString();
  check('an old code fails', s2.ok && !(await su.useStepUp(sb, { tenantId: 't', adminId: 'a1', purpose: 'approve', code: sent.code })));
  await su.startStepUp(sb, { tenantId: 't', adminId: 'a1', purpose: 'approve', clubName: 'Maple Grove', send });
  const code = sent.code;
  for (let i = 0; i < 5; i++) await su.useStepUp(sb, { tenantId: 't', adminId: 'a1', purpose: 'approve', code: code === '999999' ? '888888' : '999999' });
  check('five wrong tries end it, even for the right code', !(await su.useStepUp(sb, { tenantId: 't', adminId: 'a1', purpose: 'approve', code })));
  await su.startStepUp(sb, { tenantId: 't', adminId: 'a1', purpose: 'approve', clubName: 'Maple Grove', send });
  await su.startStepUp(sb, { tenantId: 't', adminId: 'a1', purpose: 'approve', clubName: 'Maple Grove', send });
  const flood = await su.startStepUp(sb, { tenantId: 't', adminId: 'a1', purpose: 'approve', clubName: 'Maple Grove', send });
  check('at most 5 codes in 15 minutes', !flood.ok && /Too many/.test(flood.error), short(flood));
  const none = await su.checkStepUp(sb, { tenantId: 't', adminId: 'a1', purpose: 'full_access', code: null });
  check('no code: the function answers needs_code (428) and changes nothing', none?.status === 428 && none.body.needs_code === true && none.body.purpose === 'full_access');
  const T2 = { admin_users: [{ id: 'a2', tenant_id: 't', active: true, phone_e164: null, email: 'b@x.com' }], admin_step_up_codes: [] };
  const viaEmail = await su.startStepUp(fakeDb(T2), { tenantId: 't', adminId: 'a2', purpose: 'approve', clubName: 'Maple Grove', send: async (to) => to.phone ? 'text' : 'email' });
  check('no phone: the code is emailed', viaEmail.ok && viaEmail.via === 'email', short(viaEmail));
}

console.log('CQ3 · a second board member approves');
const pc = await importTs(new URL('supabase/functions/_shared/pending_change.ts', root));
const texts = [];
pc.notifyDeps.sms = async (sb, tid, to, body) => { texts.push({ to, body }); return true; };
const club = () => ({
  tenants: [{ id: 't', display_name: 'Maple Grove', slug: 'maplegrove', stripe_account_id: 'acct_OLD' }],
  settings: [{ tenant_id: 't', value: { payments: { venmo_handle: 'maplegrove', pass_stripe_fee: true } } }],
  admin_users: [
    { id: 'pres', tenant_id: 't', active: true, display_name: 'Mei Chen', role_template: 'owner', roles: ['owner'], phone_e164: '+14085550001' },
    { id: 'vp', tenant_id: 't', active: true, display_name: 'Sam Brooks', role_template: 'owner', roles: ['owner'], phone_e164: '+14085550002' },
    { id: 'treas', tenant_id: 't', active: true, display_name: 'Erik Larsen', role_template: 'custom', roles: ['custom'], phone_e164: '+14085550003' },
    { id: 'sec', tenant_id: 't', active: true, display_name: 'Ana Ruiz', role_template: 'custom', roles: ['custom'], phone_e164: '+14085550004' },
    { id: 'gate', tenant_id: 't', active: true, display_name: 'Lifeguard', role_template: 'gate_attendant', roles: ['gate_attendant'], phone_e164: '+14085550005' },
  ],
  board_positions: [{ id: 'p-treas', tenant_id: 't', slug: 'treasurer', title: 'Treasurer' }],
  board_position_holders: [{ position_id: 'p-treas', admin_user_id: 'treas', tenant_id: 't' }],
  pending_changes: [], admin_tasks: [], audit_log: [],
});
{
  const T = club(), sb = fakeDb(T);
  const ap = (await pc.approversFor(sb, 't', 'pres')).map(a => a.id).sort();
  check('approvers: the Treasurer and anyone else with full access, never the one who asked', JSON.stringify(ap) === JSON.stringify(['treas', 'vp']), short(ap));
  texts.length = 0;
  const r = await pc.requestChange(sb, { tenantId: 't', kind: 'payments_change', requestedBy: 'pres', payload: { venmo_handle: 'thief' }, summary: "change the club's Venmo to @thief" });
  check('asking makes a waiting change, and changes nothing yet', T.pending_changes.length === 1 && T.pending_changes[0].status === 'waiting' && T.settings[0].value.payments.venmo_handle === 'maplegrove');
  check('each approver gets a to-do and a text with the link', T.admin_tasks.filter(t => t.kind === 'change.approve').map(t => t.assigned_admin_id).sort().join() === 'treas,vp'
    && ['+14085550002', '+14085550003'].every(p => texts.some(x => x.to === p && /#approve=/.test(x.body) && /Mei Chen asked to change the club's Venmo to @thief/.test(x.body))), short(texts));
  check('the one who asked and the lifeguard get no text', !texts.some(x => x.to === '+14085550001' || x.to === '+14085550005'));
  const bad = await pc.decideChange(sb, { id: r.id, tenantId: 't', by: 'sec', approve: true });
  check('a board member who isn\'t an approver can\'t approve', !bad.ok && /Treasurer or someone with full access/.test(bad.error), short(bad));
  const own = await pc.decideChange(sb, { id: r.id, tenantId: 't', by: 'pres', approve: true });
  check('the one who asked can\'t approve it', !own.ok && /second board member/.test(own.error), short(own));
  texts.length = 0;
  const ok = await pc.decideChange(sb, { id: r.id, tenantId: 't', by: 'treas', approve: true });
  check('the Treasurer approves: the new Venmo is saved, the rest of payments kept', ok.ok && T.settings[0].value.payments.venmo_handle === 'thief' && T.settings[0].value.payments.pass_stripe_fee === true, short(T.settings[0]));
  check('…the to-dos are done, and the one who asked hears', T.admin_tasks.every(t => t.completed_at) && texts.some(x => x.to === '+14085550001' && /Erik Larsen approved/.test(x.body)), short(texts));
  const again = await pc.decideChange(sb, { id: r.id, tenantId: 't', by: 'vp', approve: false });
  check('a decided change can\'t be decided again', !again.ok && /already approved/.test(again.error));
}
{
  const T = club(), sb = fakeDb(T);
  const r = await pc.requestChange(sb, { tenantId: 't', kind: 'stripe_switch', requestedBy: 'pres', payload: { from_account: 'acct_OLD' }, summary: 'switch the club to a different Stripe account' });
  const ok = await pc.decideChange(sb, { id: r.id, tenantId: 't', by: 'vp', approve: true });
  check('approving the Stripe switch sets the old account aside, so Connect Stripe starts the new one', ok.ok && T.tenants[0].stripe_account_id === null && T.audit_log.some(a => a.kind === 'stripe.account_switched'), short(T.tenants[0]));
}
{
  const T = club(), sb = fakeDb(T);
  const r = await pc.requestChange(sb, { tenantId: 't', kind: 'full_access', targetAdminId: 'sec', requestedBy: 'pres', summary: 'give Ana Ruiz full access' });
  const stop = await pc.decideChange(sb, { id: r.id, tenantId: 't', by: 'vp', approve: false });
  check('stopping it: nothing changes', stop.ok && stop.status === 'stopped' && T.admin_users.find(a => a.id === 'sec').role_template === 'custom');
  const r2 = await pc.requestChange(sb, { tenantId: 't', kind: 'full_access', targetAdminId: 'sec', requestedBy: 'pres', summary: 'give Ana Ruiz full access' });
  const ok = await pc.decideChange(sb, { id: r2.id, tenantId: 't', by: 'treas', approve: true });
  check('approving full access makes them an owner', ok.ok && T.admin_users.find(a => a.id === 'sec').role_template === 'owner');
  const r3 = await pc.requestChange(sb, { tenantId: 't', kind: 'full_access', targetAdminId: 'treas', requestedBy: 'pres', summary: 'give Erik full access' });
  const back = await pc.decideChange(sb, { id: r3.id, tenantId: 't', by: 'pres', approve: false });
  check('the one who asked can take it back', back.ok && back.status === 'cancelled');
  const r4 = await pc.requestChange(sb, { tenantId: 't', kind: 'payments_change', requestedBy: 'pres', payload: { venmo_handle: 'a' }, summary: 'x' });
  await pc.requestChange(sb, { tenantId: 't', kind: 'payments_change', requestedBy: 'pres', payload: { venmo_handle: 'b' }, summary: 'y' });
  check('asking again replaces the earlier ask', T.pending_changes.find(c => c.id === r4.id).status === 'cancelled' && T.pending_changes.filter(c => c.kind === 'payments_change' && c.status === 'waiting').length === 1);
  const r5 = await pc.requestChange(sb, { tenantId: 't', kind: 'stripe_switch', requestedBy: 'pres', summary: 'switch' });
  T.pending_changes.find(c => c.id === r5.id).expires_at = new Date(Date.now() - 1000).toISOString();
  const old = await pc.decideChange(sb, { id: r5.id, tenantId: 't', by: 'vp', approve: true });
  check('after 7 days it expires, unchanged', !old.ok && /expired/.test(old.error) && T.tenants[0].stripe_account_id === 'acct_OLD');
}
{
  const T = club();
  T.admin_users = T.admin_users.filter(a => a.id === 'pres' || a.id === 'sec');
  T.board_position_holders = [];
  const sb = fakeDb(T);
  texts.length = 0;
  const r = await pc.requestChange(sb, { tenantId: 't', kind: 'stripe_switch', requestedBy: 'pres', summary: 'switch the club to a different Stripe account' });
  // Doug 11/8: "Do everything the same Minus message goes to poolside. If I'm the only person, I can get a text code and it will work".
  check('nobody else on the board: their own code is enough, it happens at once', r.applied && T.tenants[0].stripe_account_id === null && T.pending_changes[0].status === 'approved', short({ r, t: T.tenants[0] }));
  check('…and nothing goes to Poolside', !texts.length, short(texts));
  const T2 = club(); T2.admin_users = T2.admin_users.filter(a => a.id === 'pres' || a.id === 'sec'); T2.board_position_holders = [];
  const r2 = await pc.requestChange(fakeDb(T2), { tenantId: 't', kind: 'payments_change', requestedBy: 'pres', payload: { venmo_handle: 'newclub' }, summary: "change the club's Venmo to @newclub" });
  check('…the same for a new Venmo', r2.applied && T2.settings[0].value.payments.venmo_handle === 'newclub');
  const T3 = club(), sb3 = fakeDb(T3);
  const r3 = await pc.requestChange(sb3, { tenantId: 't', kind: 'stripe_switch', requestedBy: 'pres', summary: 'switch' });
  check('with someone else on the board, it still waits for them', !r3.applied && T3.pending_changes[0].status === 'waiting' && T3.tenants[0].stripe_account_id === 'acct_OLD');
  const ok = await pc.decideChange(sb3, { id: r3.id, tenantId: null, by: null, poolside: true, approve: true });
  check('Poolside can still decide one from the provider console', ok.ok && T3.tenants[0].stripe_account_id === null && T3.pending_changes[0].decided_by_poolside === true);
}

console.log('CQ3 · full access on the Board page');
{
  const pd = await importTs(new URL('supabase/functions/_shared/positions_db.ts', root));
  const T = club();
  T.board_positions = [{ id: 'p-pres', tenant_id: 't', slug: 'president', title: 'President', full_access: true, notices: [], scopes: [], sort: 0 },
    { id: 'p-sec', tenant_id: 't', slug: 'secretary', title: 'Secretary', full_access: false, notices: [], scopes: ['events'], sort: 1 },
    { id: 'p-treas', tenant_id: 't', slug: 'treasurer', title: 'Treasurer', full_access: false, notices: [], scopes: ['payments'], sort: 2 }];
  T.board_position_holders = [{ position_id: 'p-pres', admin_user_id: 'pres', tenant_id: 't' }, { position_id: 'p-sec', admin_user_id: 'sec', tenant_id: 't' },
    { position_id: 'p-treas', admin_user_id: 'treas', tenant_id: 't' }, { position_id: 'p-pres', admin_user_id: 'sec', tenant_id: 't' }];
  const sb = fakeDb(T);
  const b = await pd.loadBoard(sb, 't');
  check('giving Ana the President position would hand her full access', pd.grantsFullAccess(b, ['sec']) && !pd.grantsFullAccess(b, ['pres']));
  const r = await pd.syncLogins(sb, 't', ['sec'], b, { by: 'pres' });
  const ana = T.admin_users.find(a => a.id === 'sec');
  check('her full access waits: meanwhile she has her other position\'s screens', r.waiting.includes('sec') && ana.role_template === 'custom' && JSON.stringify(ana.scopes) === '["events"]', short(ana));
  check('…and a change waits for the Treasurer or another owner', T.pending_changes.some(c => c.kind === 'full_access' && c.target_admin_id === 'sec' && c.status === 'waiting' && c.requested_by === 'pres'));
  const r2 = await pd.syncLogins(sb, 't', ['pres'], await pd.loadBoard(sb, 't'), { by: 'pres' });
  check('someone who already has full access keeps it, nothing to approve', !r2.waiting.length && T.admin_users.find(a => a.id === 'pres').role_template === 'owner');
}

console.log('CQ · where it\'s wired in');
{
  const mig = readdirSync(new URL('supabase/migrations/', root)).filter(f => /money_locks/.test(f));
  const sql = mig.length ? read(`supabase/migrations/${mig[0]}`) : '';
  check('a migration: the codes and the waiting changes, private to the functions', /create table if not exists public\.admin_step_up_codes/.test(sql) && /create table if not exists public\.pending_changes/.test(sql) && (sql.match(/enable row level security/g) || []).length === 2);
  const sc = read('supabase/functions/stripe_connect/index.ts');
  const sw = between(sc, "action === 'switch_account'", "action === 'sync'");
  check('switching Stripe: a code, then a second board member; nothing is set aside meanwhile', /purpose: 'stripe_switch'/.test(sw) && /requestChange\(/.test(sw) && !/forgetAccount\(/.test(sw) && sw.indexOf('checkStepUp') < sw.indexOf('requestChange'));
  const ts = read('supabase/functions/tenant_settings/index.ts');
  const save = between(ts, "if (action === 'save')", "if (action === '");
  check('changing the Venmo or PayPal: a code; a new one waits; setting it the first time needs neither', /purpose: 'payments_change'/.test(save) && /norm\(cur\[k\]\) !== ''/.test(save) && /kind: 'payments_change'/.test(save) && /delete pv\[k\]/.test(save));
  const bd = read('supabase/functions/board/index.ts');
  check('the Board page: a code before giving full access (holders and the position), and it waits', /grantsFullAccess\(after, added\)/.test(bd) && /grantsFullAccess\(after, holderIds\)/.test(bd) && (bd.match(/codeFor\('full_access'\)/g) || []).length === 2 && /by: payload\.synthetic \? null : me\.id/.test(bd));
  const ta = read('supabase/functions/tenant_admin_auth/index.ts');
  const inv = between(ta, "action === 'invite_admin'", "action === 'update_admin_title'");
  check('inviting someone with full access: a code, and their full access waits', /purpose: 'full_access'/.test(inv) && /kind: 'full_access'/.test(inv) && /role_template = 'custom'/.test(inv));
  check('making someone an owner by role: the same', /purpose: 'full_access'/.test(between(ta, "action === 'update_admin_role'", "action === 'deactivate_admin'")));
  check('bringing back someone who had full access: the same', /purpose: 'full_access'/.test(between(ta, "action === 'reactivate_admin'", "action === 'dismiss_member_apply'")));
  const dec = between(ta, "action === 'step_up_start' || action === 'changes' || action === 'change_decide'", "action === 'list_admins'");
  check('approving takes the approver\'s own code; never in a preview or a Poolside visit', /purpose: 'approve'/.test(dec) && /viewing_by/.test(dec) && /impersonated_by/.test(dec));
  const tad = read('supabase/functions/tenants_admin/index.ts');
  check('Poolside decides from the provider console', /action === 'changes'/.test(tad) && /poolside: true/.test(tad) && /id="changes"/.test(read('admin/index.html')) && /change_decide/.test(read('admin/index.html')));
}

console.log('CQ2 · heads-up texts');
{
  check('every member texted: a heads-up to full access', /headsUp\(/.test(read('supabase/functions/sms_blasts/index.ts')));
  check('every household downloaded: a heads-up too', /action === 'export_note'/.test(read('supabase/functions/tenant_settings/index.ts')) && /export_note/.test(between(read('club/admin/members.html'), 'function exportCsv', '\n}\n')));
}

console.log('CQ4 · the new season\'s reminder');
{
  const ts = read('supabase/functions/tenant_settings/index.ts');
  check('"Check that payments still go to the club", with the Stripe account and Venmo as they are now', /id: 'payments_dest'/.test(ts) && /Stripe account …/.test(ts) && /Venmo @/.test(ts));
}

console.log('CQ · the pages');
{
  for (const f of ['club/admin/index.html', 'club/admin/payments.html', 'club/admin/board.html']) {
    const p = read(f);
    check(`${f.split('/').pop()} loads the code prompt and the approvals card`, /\/js\/step-up\.js/.test(p) && /\/js\/approvals\.js/.test(p));
  }
  const pay = read('club/admin/payments.html');
  check('Payments: the Stripe switch and the Venmo save go through the code prompt', /StepUp\.run\(code => api\(STRIPE_URL, 'switch_account'/.test(pay) && /StepUp\.run\(code => api\(SETTINGS_URL, 'save'/.test(pay));
  const bp = read('club/admin/board.html');
  check('Board: positions, holders, invites and undo-remove go through it', ['save_position', 'set_holders', 'invite_admin', 'reactivate_admin'].every(a => new RegExp(`StepUp\\.run\\(code => (board|admin)\\('${a}'`).test(bp)));

  const { launch } = await import('./demo_video/harness.mjs');
  const b = await launch(), p = await b.newPage();
  await p.setViewport({ width: 390, height: 844 });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setContent(`<!doctype html><meta charset=utf-8><body><main id="main"></main>
    <script>
      window.__calls = [];
      window.fetch = async (url, o) => {
        const body = JSON.parse(o.body); window.__calls.push(body);
        const json = d => ({ json: async () => d });
        if (body.action === 'step_up_start') return json({ ok: true, via: 'text', to: '(•••) •••-0002' });
        if (body.action === 'changes') return json({ ok: true, changes: [{ id: 'c1', kind: 'payments_change', summary: "change the club's Venmo to @new", created_at: new Date().toISOString(), asked_by: 'Mei Chen', mine: false, can_approve: true }] });
        if (body.action === 'change_decide') return json(body.step_up_code === '123456' ? { ok: true, status: 'approved' } : { ok: false, needs_code: true, purpose: 'approve', error: 'Enter the code we text you to approve a change.' });
        return json({ ok: false });
      };
    </script>
    <script>${read('js/step-up.js')}</script><script>${read('js/approvals.js')}</script></body>`);
  await p.evaluate(() => Approvals.mount());
  await new Promise(r => setTimeout(r, 200));
  const card = await p.evaluate(() => (document.getElementById('changes-card') || {}).textContent || '');
  check('the card: who asked for what, with Approve and Stop it', /Mei Chen asked to change the club's Venmo to @new/.test(card) && /Approve/.test(card) && /Stop it/.test(card), card.replace(/\s+/g, ' ').slice(0, 200));
  await p.evaluate(() => document.querySelector('#changes-card button[data-act="approve"]').click());
  await new Promise(r => setTimeout(r, 300));
  const prompt = await p.evaluate(() => { const s = document.getElementById('stepup-scrim'); return s && s.style.display === 'flex' ? s.textContent : null; });
  check('Approve asks for the code texted to them', !!prompt && /•••-0002/.test(prompt), String(prompt).slice(0, 160));
  await p.evaluate(() => { document.getElementById('stepup-code').value = '123456'; document.getElementById('stepup-ok').click(); });
  await new Promise(r => setTimeout(r, 300));
  const calls = await p.evaluate(() => window.__calls.map(c => `${c.action}:${c.step_up_code ?? ''}`));
  const done = await p.evaluate(() => (document.querySelector('#changes-card [data-msg]') || {}).textContent || '');
  check('…and approves with it', calls.includes('change_decide:123456') && /Approved/.test(done), short({ calls, done }));
  check('no page errors', !errs.length, errs.join('; '));
  await b.close();
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
