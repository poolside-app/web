#!/usr/bin/env node
// Targeted check for the signup fixes (PLAN.md BG4, from the 10/20 audit):
// families stop at 8 people (Doug 10/20); a paid card signup that can't be
// approved opens a to-do; a plan signup gets its Sign in button; a level can
// say how many people it covers; unpaid card signups are checked with Stripe
// before they're deleted; a released party paid late is re-booked; the
// welcome text goes whenever there's a phone; policies are recorded by the
// club's own list. Offline: the rules and the wiring.
//
// Usage: node scripts/test_signup_fixes.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const migs = pat => readdirSync(new URL('supabase/migrations/', root)).filter(f => pat.test(f)).map(f => read(`supabase/migrations/${f}`)).join('\n');
const short = o => String(JSON.stringify(o)).slice(0, 300);
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

const apply = read('apply.html');
const apps = read('supabase/functions/applications/index.ts');
const hook = read('supabase/functions/stripe_webhook/index.ts');
const submit = (apps.split("if (action === 'submit')")[1] || '').split("if (action === '")[0];

console.log('BG4 · families stop at 8 (item 9)');
check('the form stops at 8 people and says to ask the board', /MAX_PEOPLE = 8/.test(apply) && /Up to 8 people per membership/.test(apply));
check('the server refuses more than 8 too', /MAX_PEOPLE_PER_HOUSEHOLD = 8/.test(apps) && /Up to 8 people per membership/.test(apps));

console.log('BG4 · a paid card signup that can\'t be approved (item 10)');
check('the board gets a to-do with the reason', /application\.approve_failed/.test(hook) && /couldn.t be approved/i.test(hook));
const appBranch = (hook.split("if (kind === 'application' && md.application_id)")[1] || '').split("// ── Payment plans")[0];
const closeAt = appBranch.indexOf("// Close any related admin tasks");
const taskAt = appBranch.indexOf('approveFailedTask(');
check('…opened after the step that closes the signup\'s to-dos', closeAt > 0 && taskAt > closeAt, `${closeAt} ${taskAt}`);
check('…for plan signups too', /approveFailedTask\(/.test((hook.split("kind === 'payment_plan_first' || kind === 'payment_plan_setup'")[1] || '').slice(0, 4000)));
check('it goes to the signups person', /'application\.approve_failed': 'signups'/.test(read('supabase/functions/_shared/positions.ts')));

console.log('BG4 · the plan signup\'s Sign in button (item 11)');
check('the webhook stamps when a plan starts', /plan_started_at: now/.test(hook) && /applications add column if not exists plan_started_at/.test(migs(/plan_started/)));
const pps = (apps.split("if (action === 'post_payment_signin')")[1] || '').split("if (action === '")[0];
check('the sign-in button accepts a plan\'s start as the payment time', /plan_started_at/.test(pps));

console.log('BG4 · levels say how many people they cover (item 18)');
let fit = null;
try { fit = await importTs(new URL('supabase/functions/_shared/tier_fit.ts', root)); } catch (e) { check('the rule lives in _shared/tier_fit.ts', false, e.message); }
if (fit) {
  const tiers = [{ slug: 'family', label: 'Family' }, { slug: 'single', label: 'Single', max_people: 1 }];
  check('Single fits one person', fit.tierFitError(tiers, 'single', 1) === null);
  check('Single doesn\'t fit four, and says why', /covers 1 person/.test(fit.tierFitError(tiers, 'single', 4) || ''), fit.tierFitError(tiers, 'single', 4));
  check('a level with no limit fits anyone', fit.tierFitError(tiers, 'family', 8) === null);
}
check('signup refuses a level that doesn\'t fit', /tierFitError\(/.test(submit));
check('the form greys out levels that don\'t fit', /max_people/.test(apply) && /\.disabled = /.test(apply.split('function applyTierDefault')[1] || ''));
check('Money setup has "Covers up to" per level', /Covers up to/.test(read('club/admin/payments.html')) && /max_people/.test(read('club/admin/payments.html')));
check('Bishop\'s Single covers one person', /max_people/.test(migs(/tier_max_people/)));

console.log('BS3 · a level can say the fewest people it covers (Doug 11/4: "family needs 2 or more")');
if (fit) {
  const tiers = [{ slug: 'family', label: 'Family', min_people: 2 }, { slug: 'single', label: 'Single', max_people: 1 }];
  const one = fit.tierFitError(tiers, 'family', 1);
  check('Family doesn\'t fit one person when Single does, and says so', /Family is for 2 or more people/.test(one || '') && /Single covers just you/.test(one || ''), one);
  check('Family fits two', fit.tierFitError(tiers, 'family', 2) === null);
  check('Single still fits one and not two', fit.tierFitError(tiers, 'single', 1) === null && !!fit.tierFitError(tiers, 'single', 2));
  check('with no level for one person, one person can still pick Family', fit.tierFitError([{ slug: 'family', label: 'Family', min_people: 2 }], 'family', 1) === null);
  check('…or when the only smaller level is also too small for them', fit.tierFitError([{ slug: 'family', label: 'Family', min_people: 3 }, { slug: 'single', label: 'Single', max_people: 1 }], 'family', 2) === null);
  const big = fit.tierFitError([{ slug: 'big', label: 'Big', min_people: 4 }, { slug: 'couple', label: 'Couple', min_people: 2, max_people: 3 }], 'big', 2);
  check('the note names the level that fits', /Big is for 4 or more people/.test(big || '') && /Couple covers your family/.test(big || ''), big);
  check('the form asks the same rule', typeof fit.pickableTiers === 'function'
    && JSON.stringify(fit.pickableTiers(tiers, 1).map(t => t.slug)) === '["single"]'
    && JSON.stringify(fit.pickableTiers(tiers, 3).map(t => t.slug)) === '["family"]');
}
const tierFn = apply.split('function applyTierDefault')[1] || '';
check('the form greys out a level that\'s too big for the family', /min_people/.test(tierFn) && /or more people/.test(apply));
check('each level says "For 2 or more people" on the form', /For \$\{min\} or more people/.test(apply));
const pay = read('club/admin/payments.html');
check('Money setup has "At least (people)" per level, saved as min_people', /At least \(people\)/.test(pay) && /min_people: parseInt\(get\('min_people'\)/.test(pay));
check('…and keeps it out of the level\'s extra fields', /\{ slug, label, price_cents, description, max_people, min_people, \.\.\.rest \}/.test(pay));
check('Bishop\'s Family is for 2 or more', /min_people/.test(migs(/tier_min_people/)) && /'family'/.test(migs(/tier_min_people/)));
const starter = read('supabase/functions/tenant_signup/index.ts');
check('new clubs start with Family at least 2 and Single up to 1', /slug: 'family'[^}]*min_people: 2/.test(starter) && /slug: 'single'[^}]*max_people: 1/.test(starter));

console.log('BS2 · every birthday is required on the signup form');
const step2 = (apply.split('CURRENT_STEP === 2')[1] || '').split('CURRENT_STEP === 3')[0];
check('the form stops on a missing birthday, under that field', /Date of birth is required/.test(step2) && /showField\(/.test(step2));
check('…for adults and children', /\['adult', 'child'\]/.test(step2) && /data-\$\{kind\}/.test(step2));
check('the server refuses a person with no birthday', /date of birth/i.test(submit) && /\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(submit));
for (const f of ['scripts/test_payments.mjs', 'scripts/lib/flex_plan_live.mjs']) {
  check(`${f} sends a birthday with each adult`, /adults: \[\{ name: [^\]]*dob: '/.test(read(f)));
}
check('scripts/e2e.py sends a birthday with each adult', !/'adults': \[\s*\{ 'name': f'Pat Full \{STAMP\}',\s+'email'/.test(read('scripts/e2e.py')));

console.log('BS2, BS3 · the signup form itself (offline, in Chrome)');
{
  const { launch, attach, FAMILY } = await import('./demo_video/harness.mjs');
  const { respond } = await import('./demo_video/data.mjs');
  const LEVELS = [{ slug: 'family', label: 'Family', price_cents: 60000, min_people: 2 }, { slug: 'single', label: 'Single', price_cents: 30000, max_people: 1 }];
  const answer = (f, body, ctx) => f === 'tenant_public' ? { ...respond(f, body, ctx), tiers: LEVELS } : respond(f, body, ctx);
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await attach(page, { answer });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(FAMILY + '/apply.html', { waitUntil: 'networkidle0', timeout: 45000 });
    await new Promise(r => setTimeout(r, 500));
    const levels = async (adults, kids) => page.evaluate(async (a, k) => {
      document.getElementById('acount').value = String(a); document.getElementById('ccount').value = String(k);
      rebuildPeople(); applyTierDefault();
      return { radios: [...document.querySelectorAll('input[name="tier_slug"]')].map(r => ({ v: r.value, off: r.disabled, on: r.checked })),
        note: document.getElementById('tier-note')?.textContent || '', box: document.getElementById('tiers-box').innerText };
    }, adults, kids);
    const one = await levels(1, 0);
    const fam1 = one.radios.find(r => r.v === 'family'), single1 = one.radios.find(r => r.v === 'single');
    check('one person: Family is greyed out and Single is picked', fam1?.off && !single1?.off && single1?.on, short(one.radios));
    check('…with the note "Family is for 2 or more people. Single covers just you."', one.note === 'Family is for 2 or more people. Single covers just you.', one.note);
    check('Family says "For 2 or more people"', /For 2 or more people/.test(one.box), one.box.slice(0, 200));
    const two = await levels(1, 1);
    check('a parent and a child: Family can be picked, Single can\'t', !two.radios.find(r => r.v === 'family')?.off && two.radios.find(r => r.v === 'single')?.off, short(two.radios));
    // Step 2 with a name and no birthday.
    const stop = await page.evaluate(async () => {
      document.getElementById('acount').value = '1'; document.getElementById('ccount').value = '1'; rebuildPeople();
      showStep(2);
      document.querySelector('[data-adult="0"][data-field="name"]').value = 'Pat Test';
      document.querySelector('[data-adult="0"][data-field="dob"]').value = '1980-01-01';
      document.querySelector('[data-child="0"][data-field="name"]').value = 'Kid Test';
      document.querySelector('[data-child="0"][data-field="dob"]').value = '';
      _goNext();
      const err = document.querySelector('.field-err');
      const kidMissing = { step: CURRENT_STEP, err: err?.textContent || '', under: err?.previousElementSibling?.dataset?.child ?? null };
      document.querySelector('[data-adult="0"][data-field="dob"]').value = '';
      document.querySelector('[data-child="0"][data-field="dob"]').value = '2015-01-01';
      _goNext();
      const err2 = document.querySelector('.field-err');
      return { kidMissing, adultMissing: { step: CURRENT_STEP, err: err2?.textContent || '', under: err2?.previousElementSibling?.dataset?.adult ?? null } };
    });
    check('a child with no birthday stops the form, under that field', stop.kidMissing.step === 2 && stop.kidMissing.err === 'Date of birth is required' && stop.kidMissing.under === '0', short(stop.kidMissing));
    check('so does an adult with no birthday', stop.adultMissing.step === 2 && stop.adultMissing.err === 'Date of birth is required' && stop.adultMissing.under === '0', short(stop.adultMissing));
    check('no page errors', !errors.length, errors.join(' | '));
  } finally { await browser.close(); }
}

console.log('BS4 · a card signup that hasn\'t paid isn\'t the board\'s to approve');
let card = null;
try { card = await importTs(new URL('supabase/functions/_shared/card_signup.ts', root)); } catch (e) { check('the rule lives in _shared/card_signup.ts', false, e.message); }
if (card) {
  const w = card.waitingOnCard;
  const base = { status: 'pending', payment_status: 'unpaid', payment_method: 'stripe', claim_source: null };
  check('a declined or unfinished card signup is waiting on the card', w(base) === true);
  check('…so is a payment plan whose first payment didn\'t go through', w({ ...base, payment_method: 'stripe_plan' }) === true);
  check('a paid card signup isn\'t', w({ ...base, payment_status: 'paid' }) === false);
  check('a plan that started isn\'t', w({ ...base, payment_method: 'stripe_plan', payment_status: 'pending' }) === false);
  check('a Venmo, check or decide-later signup isn\'t', ['venmo', 'check', null].every(m => w({ ...base, payment_method: m }) === false));
  check('an approved one isn\'t', w({ ...base, status: 'approved' }) === false);
  check('an imported family\'s claimed signup isn\'t (the club is chasing them)', w({ ...base, claim_source: 'csv_import' }) === false);
}
const listBranch = (apps.split("if (action === 'list')")[1] || '').split("if (action === '")[0];
check('Needs attention leaves them out', /waitingOnCard/.test(listBranch) && /needs_attention/.test(listBranch));
const approveBranch = (apps.split("if (action === 'approve')")[1] || '').split("if (action === '")[0];
check('the server won\'t approve one', /waitingOnCard\(app\)/.test(approveBranch) && /haven\\?'t paid by card yet/.test(approveBranch));

console.log('BS4 · the Signups list (offline, in Chrome)');
{
  const { launch, attach, BOARD } = await import('./demo_video/harness.mjs');
  const { respond } = await import('./demo_video/data.mjs');
  const row = (id, extra) => ({ id, tenant_id: 't', family_name: id + ' Family', primary_name: 'Pat ' + id, primary_email: id.toLowerCase() + '@example.com',
    status: 'pending', payment_status: 'unpaid', payment_method: 'stripe', num_adults: 1, num_kids: 0, reminder_count: 0,
    created_at: '2027-06-01T17:00:00Z', adults_json: [], children_json: [], ...extra });
  const ROWS = [row('Declined', {}), row('Venmo', { payment_method: 'venmo' })];
  const answer = (f, body, ctx) => f === 'applications' && body.action === 'list' ? { ok: true, applications: ROWS } : respond(f, body, ctx);
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });
    await attach(page, { answer });
    await page.goto(BOARD + '/club/admin/members.html#applications', { waitUntil: 'networkidle0', timeout: 45000 });
    await page.waitForSelector('#app-list .app', { timeout: 10000 }).catch(() => {});
    const rows = await page.evaluate(() => [...document.querySelectorAll('#app-list .app')].map(el => ({ id: el.dataset.id, text: el.innerText,
      approve: !!el.querySelector('[data-act="approve"]'), reject: !!el.querySelector('[data-act="reject"]') })));
    const declined = rows.find(r => r.id === 'Declined'), venmo = rows.find(r => r.id === 'Venmo');
    check('an unpaid card signup says "Card not paid"', /card not paid/i.test(declined?.text || ''), short(declined));
    check('…with no Approve or Reject', declined && !declined.approve && !declined.reject, short(declined));
    check('a Venmo signup still has its Approve', !!venmo?.approve, short(venmo));
    await page.click('#app-list .app[data-id="Declined"]').catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    const modal = await page.evaluate(() => {
      const shown = id => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none'; };
      return { explain: document.getElementById('am-state-explainer')?.innerText || '', approve: shown('am-approve') || shown('am-approve-venmo'),
        reject: shown('am-reject'), purge: shown('am-purge') };
    });
    check('its details say they didn\'t finish paying and it goes after 24 hours', /didn.t finish paying/.test(modal.explain) && /24 hours/.test(modal.explain), modal.explain);
    check('…with no Approve or Reject, and Delete for good still there', !modal.approve && !modal.reject && modal.purge, short(modal));
  } finally { await browser.close(); }
}

console.log('BG4 · unpaid card signups (item 19)');
const cleanup = (apps.split("if (action === 'cron_cleanup_abandoned')")[1] || '').split("if (action === '")[0];
check('waits 24 hours, not 60 minutes', /24 \* 60 \* 60 \* 1000/.test(cleanup) && !/60 \* 60 \* 1000\)\.toISOString/.test(cleanup.replace('24 * 60 * 60 * 1000', '')));
check('asks Stripe first and keeps a paid one', /checkout\/sessions\//.test(cleanup) && /payment_status === 'paid'/.test(cleanup));

console.log('BG4 · a released party paid late (item 20)');
const party = (hook.split("if (kind === 'party_booking' && md.party_id && tenantId)")[1] || '').split("// Fundraiser donations")[0];
check('re-booked when the time is still free', /released/.test(party) && /status: 'approved'/.test(party));
check('a canceled or turned-down party paid late gets a refund to-do', /party\.refund_needed/.test(party) && /rejected/.test(party));

console.log('BG4 · the welcome text (item 21)');
check('approval texts the family whenever there\'s a phone', /if \(app\.primary_email \|\| app\.primary_phone\)/.test(apps));

console.log('BG4 · policies by the club\'s own list (item 13)');
check('no fixed list of five policy names', !/\['rules','guest','party','sitter','waiver'\]/.test(apps));
check('signup reads the club\'s active policies', /from\('policies'\)/.test(submit) && /required_for_apply/.test(submit));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
