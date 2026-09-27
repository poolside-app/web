#!/usr/bin/env node
// Targeted check for plans, discounts, referrals and codes (PLAN.md H4–H7).
// Offline checks cost nothing. The live part runs against Bishop in test
// mode with a temporary family it removes afterward.
//
// Usage: node scripts/test_money.mjs [--offline]   (ONLY=H5 limits the live part)
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import vm from 'node:vm';
import { importTs } from './lib/importts.mjs';
import { makeTempMember, purgeTestFamilies } from './lib/testdata.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const between = (src, from, to) => { const i = src.indexOf(from); return i < 0 ? '' : src.slice(i, to ? src.indexOf(to, i + from.length) : undefined); };
const OFFLINE = process.argv.includes('--offline');
// ONLY=H5 (or H4,H5) runs just those live parts.
const ONLY = (process.env.ONLY || '').split(',').map(x => x.trim()).filter(Boolean);
const live = step => !OFFLINE && (!ONLY.length || ONLY.includes(step));

let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  return ok;
}
const short = o => String(JSON.stringify(o)).slice(0, 240);
const env = Object.fromEntries(read('.env.local')
  .split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const { SUPABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, ADMIN_JWT_SECRET } = env;
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-money/1.0' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const b64url = b => Buffer.from(b).toString('base64url');
function jwt(p) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + 600 }));
  return `${h}.${body}.${createHmac('sha256', ADMIN_JWT_SECRET).update(`${h}.${body}`).digest('base64url')}`;
}
async function fn(name, action, token, extra = {}) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, ...extra }),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

// ── H4: plan deadlines across New Year ───────────────────────────────────
console.log('H4 · payment plan deadlines (offline)');
{
  const ps = await importTs(new URL('supabase/functions/_shared/payment_schedule.ts', root));
  // "50% by December 1, the rest by May 1", for the 2027 season, with next
  // season going on sale in December.
  const plan = { enabled: true, milestones: [{ date: '05-01', min_pct: 100, label: 'Paid in full' }, { date: '12-01', min_pct: 50 }] };
  const rules = ps.resolveRules(plan, 2027, 12);
  check('H4: a December deadline falls in the year before the season',
    short(rules.milestones.map(m => [m.date, m.min_pct])) === short([['2026-12-01', 50], ['2027-05-01', 100]]), short(rules.milestones));

  // Joining on December 15, after the December deadline: the share that was
  // due by then is due now, so a plan can still be made.
  const gen = ps.generateSchedule({ totalCents: 60000, rules, count: 4, startDate: '2026-12-15' });
  check('H4: joining after a deadline puts its share in the first payment',
    gen.ok && gen.installments[0].due_date === '2026-12-15' && gen.installments[0].amount_cents >= 30000
      && gen.installments.at(-1).due_date === '2027-05-01'
      && gen.installments.reduce((n, i) => n + i.amount_cents, 0) === 60000, short(gen));
  const v = gen.ok && ps.validateSchedule({ installments: gen.installments, rules, totalCents: 60000, startDate: '2026-12-15' });
  check('H4: and the server accepts that schedule', v && v.ok, short(v));

  const terms = ps.twoPaymentTerms && ps.twoPaymentTerms(plan, 2027, 12);
  check('H4: the signup form\'s pay-in-two uses the season\'s dates',
    terms && terms.first_pct === 50 && terms.final_due_date === '2027-05-01', short(terms));

  check('H4: keyfobs aren\'t switched off over a fall deadline',
    ps.enforcementDate(plan, 2027, 12) === '2027-05-01', ps.enforcementDate(plan, 2027, 12));

  // Same-year plans keep working.
  const summer = ps.resolveRules({ milestones: [{ date: '04-01', min_pct: 75 }, { date: '07-01', min_pct: 100 }] }, 2027, 12);
  check('H4: a spring-and-summer plan is unchanged',
    short(summer.milestones.map(m => m.date)) === short(['2027-04-01', '2027-07-01']), short(summer.milestones));

  // The board screen: sorted by season, and the last one is "the rest".
  const page = read('club/admin/payments.html');
  const src = between(page, '// ── Payment deadlines (milestones)', '// ── Setup: Payment plans');
  const box = { document: { getElementById: id => ({ checked: id === 'plan-enabled' }) }, console };
  vm.createContext(box);
  try {
    vm.runInContext(src.replace(/\blet MILESTONES\b/, 'var MILESTONES').replace(/\blet OPENS_MONTH\b/, 'var OPENS_MONTH'), box);
    vm.runInContext(`MILESTONES = [{ date: '05-01', min_pct: 1, label: '' }, { date: '12-01', min_pct: 50, label: '' }]; OPENS_MONTH = 12;`, box);
    const problem = vm.runInContext('milestoneProblem()', box);
    const order = vm.runInContext('seasonSorted(MILESTONES).map(m => m.date + ":" + m.min_pct).join(",")', box);
    check('H4: the board can save "50% by Dec 1, the rest by May 1"',
      problem === '' && order === '12-01:50,05-01:100', `${problem} | ${order}`);
    check('H4: the last deadline has no % box; it says "the rest"',
      /The rest \(100%\)/.test(src) && /isLast/.test(src), 'no "The rest (100%)" row');
  } catch (e) {
    check('H4: the board can save "50% by Dec 1, the rest by May 1"', false, e.message);
  }
  const apply = read('apply.html');
  check('H4: the signup form hides pay-in-two once its last deadline has passed',
    /plan\.final_due_date > today/.test(apply), 'no final_due_date check');
}

// ── H5: the price after discounts (offline) ─────────────────────────────
console.log('\nH5 · discounts come off the price (offline)');
{
  let pr = null;
  try { pr = await importTs(new URL('supabase/functions/_shared/pricing.ts', root)); }
  catch (e) { check('H5: the pricing rules exist', false, e.message); }
  if (pr) {
    const early = { id: 'c1', code: 'EARLYBIRD', amount_cents: 5000, percent_off: null, active: true, expires_on: '2027-03-01', max_uses: null };
    const ten = { id: 'c2', code: 'TEN', amount_cents: null, percent_off: 10, active: true };
    const small = { id: 'c3', code: 'SMALL', amount_cents: 1000, active: true };

    const a = pr.priceMembership({ baseCents: 60000, code: early });
    check('H5: a $50 code takes $50 off', a.amount_due_cents === 55000 && a.discount_kind === 'code' && a.discount_code_id === 'c1', short(a));
    const b = pr.priceMembership({ baseCents: 60000, code: ten });
    check('H5: a 10% code takes 10% off', b.amount_due_cents === 54000 && b.discount_cents === 6000, short(b));

    const c = pr.priceMembership({ baseCents: 60000, code: early, referralOffCents: 2500 });
    check('H5: code vs referral: the bigger one applies, and they\'re told',
      c.discount_kind === 'code' && c.amount_due_cents === 55000 && /one discount/i.test(c.note || ''), short(c));
    const d = pr.priceMembership({ baseCents: 60000, code: small, referralOffCents: 2500 });
    check('H5: a smaller code loses to the referral discount',
      d.discount_kind === 'referral' && d.amount_due_cents === 57500 && d.discount_code_id === null && /one discount/i.test(d.note || ''), short(d));

    const e = pr.priceMembership({ baseCents: 60000, code: early, creditCents: 10000 });
    check('H5: referral credit comes off too, after the discount', e.credit_cents === 10000 && e.amount_due_cents === 45000, short(e));
    const f = pr.priceMembership({ baseCents: 60000, creditCents: 70000 });
    check('H5: credit never takes the price below $0', f.credit_cents === 60000 && f.amount_due_cents === 0, short(f));
    const g = pr.priceMembership({ baseCents: 60000, code: { id: 'c4', code: 'FREE', percent_off: 100, active: true } });
    check('H5: a 100% code makes it $0', g.amount_due_cents === 0, short(g));

    check('H5: an expired or used-up code is refused with a reason',
      /ended|expired/i.test(pr.codeProblem(early, '2027-03-02', 0) || '') && pr.codeProblem(early, '2027-03-01', 0) === null
        && /used up/i.test(pr.codeProblem({ ...small, max_uses: 3 }, '2027-01-01', 3) || '') && /isn't active|not active/i.test(pr.codeProblem({ ...small, active: false }, '2027-01-01', 0) || ''),
      short([pr.codeProblem(early, '2027-03-02', 0), pr.codeProblem({ ...small, max_uses: 3 }, '2027-01-01', 3)]));
    const rs = pr.referralSettings({});
    check('H5: referral settings default to $100 reward, $25 off, 30 days',
      rs.reward_cents === 10000 && rs.new_family_cents === 2500 && rs.wait_days === 30, short(rs));
    check('H5: codes are matched without case or spaces', pr.normalizeCode(' early bird ') === 'EARLYBIRD', pr.normalizeCode(' early bird '));
  }
}

// ── H5: the board sees what the family owes (offline) ──────────────────
{
  const mem = read('club/admin/members.html');
  const inline = between(mem, 'async function inlineApprove', '\n  }\n');
  check('H5: one-click Approve keeps the level the family picked (it sets next year\'s price)',
    inline && !/tier:\s*'family'/.test(inline), 'inlineApprove sends tier: family');
  check('H5: the Venmo check shows the amount after discount',
    /amount_due_cents/.test(between(mem, "const helper = document.getElementById('am-venmo-helper')", 'am-venmo-link')), 'modal uses the list price');
  const apps = read('supabase/functions/applications/index.ts');
  check('H5: the board\'s application list includes the price fields',
    /const FIELDS = '[^']*amount_due_cents[^']*payment_reference/.test(apps), 'FIELDS lacks amount_due_cents');
}

// ── H7: discount codes (offline) ────────────────────────────────────────
console.log('\nH7 · discount codes (offline)');
{
  const money = read('club/admin/payments.html');
  check('H7: Money setup has a Discounts section for codes',
    /id="discounts-card"/.test(money) && /data-focus="discounts"/.test(money) && /codes_list/.test(money) && /code_save/.test(money), 'no discounts card');
  const pa = read('supabase/functions/payments_admin/index.ts');
  check('H7: the server lists, saves and switches off codes (payments permission)',
    /action === 'codes_list'/.test(pa) && /action === 'code_save'/.test(pa) && /action === 'code_off'/.test(pa), 'missing actions');
  check('H7: "Mark paid" records the discount too', (pa.match(/recordDiscountUse/g) || []).length >= 2, 'mark_paid skips recordDiscountUse');
  const pub = read('supabase/functions/tenant_public/index.ts');
  check('H7: the member home shows codes marked for it, not the old early-bird setting',
    /home_codes/.test(pub) && !/early_bird/.test(pub) && /home_codes/.test(read('m/index.html')) && !/early_bird/.test(read('m/index.html')), 'still early_bird');
  const ren = read('supabase/functions/renewals/index.ts');
  check('H7: the renewal blast mentions a home code instead of early bird', /show_on_home/.test(ren) && !/early_bird/.test(ren), 'renewals still reads early_bird');
}

// ── Live ─────────────────────────────────────────────────────────────────
if (live('H4')) {
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`);
  const ownerTok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
  const [{ plan: savedPlan }] = await sql(`select value->'payments'->'plan' as plan from settings where tenant_id = '${club.id}'`);

  console.log('\nH4 · live (3 calls; puts Bishop\'s plan settings back afterward)');
  try {
    const saved = await fn('payment_plans', 'config_save', ownerTok, { config: {
      enabled: true, milestones: [{ date: '12-01', min_pct: 50, label: '' }, { date: '05-01', min_pct: 100, label: 'Paid in full' }],
    } });
    check('H4: the server saves "50% by Dec 1, the rest by May 1"', saved.ok, short(saved));
    const pub = await fn('tenant_public', undefined, null, { slug: 'bishopestates' });
    const [{ opens, pinned }] = await sql(`select value->'membership'->>'renewal_opens_month' as opens, value->'membership'->>'year' as pinned from settings where tenant_id = '${club.id}'`);
    const now = new Date(), month = now.getUTCMonth() + 1, opensM = Number(opens) || 12;
    const year = Number(pinned) > 2000 ? Number(pinned) : (month >= opensM ? now.getUTCFullYear() + 1 : now.getUTCFullYear());
    const pp = pub.public_settings?.payment_plan;
    check(`H4: the signup form gets 50% now, the rest on May 1, ${year}`,
      pp && pp.enabled && pp.first_installment_pct === 50 && pp.final_due_date === `${year}-05-01`, short(pp));
  } finally {
    await sql(savedPlan == null
      ? `update settings set value = value #- '{payments,plan}' where tenant_id = '${club.id}'`
      : `update settings set value = jsonb_set(value, '{payments,plan}', '${JSON.stringify(savedPlan).replace(/'/g, "''")}'::jsonb) where tenant_id = '${club.id}'`);
    const [{ plan }] = await sql(`select value->'payments'->'plan' as plan from settings where tenant_id = '${club.id}'`);
    check('H4: Bishop\'s plan settings are back as they were', JSON.stringify(plan) === JSON.stringify(savedPlan), short(plan));
  }
}

// ── H5 live ──────────────────────────────────────────────────────────────
if (live('H5')) {
  const STAMP = String(Date.now()).slice(-6);
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const q = v => `'${String(v).replace(/'/g, "''")}'`;
  const [{ v: sv }] = await sql(`select value as v from settings where tenant_id = ${q(club.id)}`);
  const family = (sv.membership_tiers || []).find(t => t.slug === 'family');
  const base = Number(family?.price_cents) || 0;
  const pay = sv.payments || {};
  const gross = c => pay.pass_stripe_fee ? Math.ceil((c + Number(pay.stripe_fixed_cents ?? 30)) / (1 - Number(pay.stripe_pct ?? 2.9) / 100)) : c;
  const OFF = `SIMOFF${STAMP}`, FREE = `SIMFREE${STAMP}`;
  console.log(`\nH5 · live on Bishop in test mode (about 15 calls; run ${STAMP}, removed afterward)`);
  const app = (n, extra) => ({
    slug: 'bishopestates',
    family_name: `SimMoney ${n} ${STAMP}`, primary_name: `Sim Money ${n}`,
    primary_email: `doug.frevele+simtest-money${n}-${STAMP}@gmail.com`, primary_phone: `555${STAMP}${n}`,
    adults: [{ name: `Sim Money ${n}`, email: `doug.frevele+simtest-money${n}-${STAMP}@gmail.com`, phone: `555${STAMP}${n}` }],
    children: [], waivers_accepted: { rules: true, guest: true, party: true, sitter: true, waiver: true },
    tier_slug: 'family', ...extra,
  });
  const decodeSim = url => {
    const t = /#t=([^&\s]+)/.exec(url || '')?.[1];
    try { return t ? { token: t, ...JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()) } : null; } catch { return null; }
  };
  try {
    await sql(`insert into discount_codes (tenant_id, code, label, amount_cents) values (${q(club.id)}, ${q(OFF)}, 'Sim test $50', 5000)`);
    await sql(`insert into discount_codes (tenant_id, code, label, percent_off, max_uses) values (${q(club.id)}, ${q(FREE)}, 'Sim test free', 100, 1)`);

    const quote = await fn('applications', 'quote', null, { slug: 'bishopestates', tier_slug: 'family', code: OFF.toLowerCase() });
    check('H5: the signup form\'s price takes the code off', quote.ok && quote.price?.amount_due_cents === base - 5000 && quote.price?.code === OFF, short(quote));
    const bad = await fn('applications', 'quote', null, { slug: 'bishopestates', tier_slug: 'family', code: 'NOSUCHCODE' });
    check('H5: a code that doesn\'t exist says so, and the price stays', bad.ok && /isn't valid/.test(bad.price?.code_problem || '') && bad.price?.amount_due_cents === base, short(bad));

    // Card with a code: checkout charges the reduced price (plus the card fee
    // the club passes on), and the use is recorded once it clears.
    const card = await fn('applications', 'submit', null, app(1, { payment_method: 'stripe', discount_code: OFF }));
    check('H5: submit stores the reduced price', card.ok && card.price?.amount_due_cents === base - 5000, short(card));
    const co = await fn('stripe_checkout', 'application', null, { application_id: card.application_id });
    const sim = decodeSim(co.url);
    check(`H5: card checkout charges ${gross(base - 5000)} cents, not ${gross(base)}`, sim && sim.amt === gross(base - 5000), short({ co: co.error, amt: sim?.amt }));
    const [before] = await sql(`select discount_recorded_at from applications where id = ${q(card.application_id)}`);
    check('H5: nothing is recorded before the payment clears', before && !before.discount_recorded_at, short(before));
    if (sim) await fn('stripe_checkout', 'simulate_complete', null, { token: sim.token });
    const [after] = await sql(`select payment_status, discount_recorded_at, discount_cents, amount_due_cents from applications where id = ${q(card.application_id)}`);
    check('H5: once paid, the code use is recorded', after?.payment_status === 'paid' && !!after?.discount_recorded_at && after?.discount_cents === 5000, short(after));

    // $0: a 100% code. "Confirm, nothing to pay" makes them a member.
    const free = await fn('applications', 'submit', null, app(2, { payment_method: null, discount_code: FREE }));
    check('H5: a 100% code makes it $0', free.ok && free.price?.amount_due_cents === 0, short(free.price ?? free));
    const conf = await fn('stripe_checkout', 'confirm_free', null, { application_id: free.application_id });
    check('H5: "Confirm, nothing to pay" goes to the you\'re-in page', conf.ok && /apply\.html\?paid=1/.test(conf.redirect || ''), short(conf));
    let fs = null;
    for (let i = 0; i < 20 && !(fs && fs.status === 'approved' && fs.household_id); i++) {
      [fs] = await sql(`select status, payment_status, payment_method, household_id, discount_recorded_at from applications where id = ${q(free.application_id)}`);
      if (!(fs && fs.status === 'approved' && fs.household_id)) await new Promise(r => setTimeout(r, 1000));
    }
    check('H5: they\'re approved, marked paid as "free", with a household', fs?.status === 'approved' && fs?.payment_status === 'paid'
      && fs?.payment_method === 'free' && !!fs?.household_id && !!fs?.discount_recorded_at, short(fs));
    const [welcome] = await sql(`select body from application_actions where application_id = ${q(free.application_id)} and kind = 'welcome_sent'`);
    check('H5: they get a welcome email', !!welcome, short(welcome));
    const again = await fn('stripe_checkout', 'confirm_free', null, { application_id: free.application_id });
    check('H5: confirming twice does nothing twice', !again.ok && /Already paid/.test(again.error || ''), short(again));
    const usedUp = await fn('applications', 'quote', null, { slug: 'bishopestates', tier_slug: 'family', code: FREE });
    check('H5: a one-family code is used up after one family pays', /used up/.test(usedUp.price?.code_problem || ''), short(usedUp.price));

    // Renewal with referral credit: comes off, and is spent once paid.
    const m = await makeTempMember(sql, club.id, `SimMoney Renew ${STAMP}`);
    await sql(`update households set referral_credits_cents = 10000, paid_until_year = extract(year from now())::int - 1 where id = ${q(m.household_id)}`);
    const memTok = jwt({ sub: m.id, kind: 'member', tid: club.id, slug: 'bishopestates', hid: m.household_id });
    const ro = await fn('member_auth', 'renewal_options', memTok);
    check('H5: the renewal page takes their $100 credit off', ro.ok && ro.price?.credit_cents === 10000 && ro.price?.amount_due_cents === base - 10000
      && ro.dues_cents === gross(base - 10000), short({ price: ro.price, dues: ro.dues_cents, err: ro.error }));
    const [ren] = await sql(`insert into applications (tenant_id, household_id, is_renewal, is_new_member, membership_year, status, payment_status,
        family_name, primary_name, tier_slug) values (${q(club.id)}, ${q(m.household_id)}, true, false, extract(year from now())::int + 1,
        'pending', 'unpaid', ${q(`SimMoney Renew ${STAMP}`)}, 'Sim Renew', 'family') returning id`);
    const rco = await fn('stripe_checkout', 'application', null, { application_id: ren.id });
    const rsim = decodeSim(rco.url);
    check('H5: renewal checkout charges after the credit', rsim && rsim.amt === gross(base - 10000), short({ err: rco.error, amt: rsim?.amt }));
    if (rsim) await fn('stripe_checkout', 'simulate_complete', null, { token: rsim.token });
    const [hh] = await sql(`select referral_credits_cents from households where id = ${q(m.household_id)}`);
    check('H5: once paid, the credit is spent', hh?.referral_credits_cents === 0, short(hh));
  } finally {
    await purgeTestFamilies(sql, club.id, `SimMoney % ${STAMP}`);
    await sql(`delete from discount_codes where tenant_id = ${q(club.id)} and code in (${q(OFF)}, ${q(FREE)})`);
  }
}

// ── H7 live ──────────────────────────────────────────────────────────────
if (live('H7')) {
  const STAMP = String(Date.now()).slice(-6);
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`);
  const ownerTok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
  const CODE = `SIMEARLY${STAMP}`;
  console.log(`\nH7 · live (about 8 calls; code ${CODE}, removed afterward)`);
  try {
    const both = await fn('payments_admin', 'code_save', ownerTok, { code: { code: CODE, amount_cents: 5000, percent_off: 10 } });
    check('H7: a code needs either $ or %, not both', !both.ok && /either a dollar amount or a percent/.test(both.error || ''), short(both));
    const made = await fn('payments_admin', 'code_save', ownerTok, { code: {
      code: CODE.toLowerCase(), label: 'Early bird', amount_cents: 5000, expires_on: '2099-03-01', max_uses: 40, show_on_home: true,
    } });
    check('H7: the board makes an early-bird code', made.ok && made.code?.code === CODE && made.code?.show_on_home === true, short(made));
    const dup = await fn('payments_admin', 'code_save', ownerTok, { code: { code: CODE, percent_off: 5 } });
    check('H7: two codes can\'t share a name', !dup.ok && /already a code/.test(dup.error || ''), short(dup));
    const list = await fn('payments_admin', 'codes_list', ownerTok);
    const row = (list.codes || []).find(c => c.code === CODE);
    check('H7: the list shows it with 0 families so far', list.ok && row && row.uses === 0 && row.max_uses === 40, short(row));
    const pub = await fn('tenant_public', undefined, null, { slug: 'bishopestates' });
    const home = (pub.public_settings?.home_codes || []).find(c => c.code === CODE);
    check('H7: it shows on the member home', !!home && home.amount_cents === 5000 && home.expires_on === '2099-03-01', short(pub.public_settings?.home_codes));
    const off = await fn('payments_admin', 'code_off', ownerTok, { id: made.code?.id });
    const pub2 = await fn('tenant_public', undefined, null, { slug: 'bishopestates' });
    const q2 = await fn('applications', 'quote', null, { slug: 'bishopestates', tier_slug: 'family', code: CODE });
    check('H7: switched off, it leaves the home and stops working', off.ok && !(pub2.public_settings?.home_codes || []).some(c => c.code === CODE)
      && /isn't active/.test(q2.price?.code_problem || ''), short({ off, q: q2.price?.code_problem }));
    const [audit] = await sql(`select count(*)::int n from audit_log where tenant_id = '${club.id}' and entity_id = '${made.code?.id}'`);
    check('H7: making and switching off a code are in the audit log', audit.n >= 2, short(audit));
  } finally {
    await sql(`delete from audit_log where tenant_id = '${club.id}' and entity_id in (select id from discount_codes where tenant_id = '${club.id}' and code = '${CODE}')`);
    await sql(`delete from discount_codes where tenant_id = '${club.id}' and code = '${CODE}'`);
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
