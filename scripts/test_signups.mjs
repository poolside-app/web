#!/usr/bin/env node
// Targeted check for sign-ups: shifts and jobs, with a thank-you (PLAN.md BM,
// Doug 10/23: "some type of sign up genius feature").
//   BM1  The rules (_shared/signups.ts) and the server (the volunteer
//        function): any board member posts a shift or a job, with photos and
//        a thank-you; a family signs up; the poster gets a to-do; the
//        volunteer taps Done with a photo; the poster (or the President)
//        approves; the thank-you is given (a one-family discount code, shown
//        and emailed) and a thank-you goes on the news, never pushing a real
//        announcement off.
// Offline by default. `--live` runs the whole thing on a throwaway club that
// is deleted afterwards, never on Bishop's families (PLAN.md BL3).
//
// Usage: node scripts/test_signups.mjs [--live]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const has = rel => existsSync(new URL(rel, root));
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = v => JSON.stringify(v ?? null).slice(0, 220);
const shared = rel => new URL(`supabase/functions/_shared/${rel}`, root);

// ── BM1 · the rules ──────────────────────────────────────────────────────
console.log('BM1 · the rules (offline)');
check('the rules are in _shared/signups.ts', has('supabase/functions/_shared/signups.ts'));
if (has('supabase/functions/_shared/signups.ts')) {
  const S = await importTs(shared('signups.ts'));
  const now = '2027-06-19T17:00:00.000Z';
  const shift = { id: 'o1', kind: 'shift', title: 'Snack Shack at the meet', starts_at: '2027-06-20T17:00:00.000Z', ends_at: '2027-06-20T21:00:00.000Z', slots_needed: 2, active: true, reward_kind: 'note', reward_note: 'Free lunch at the meet', created_by: 'a1' };
  const job = { id: 'o2', kind: 'job', title: 'Fix the sprinkler by the kiddie pool', starts_at: null, due_on: '2027-06-30', slots_needed: 1, active: true, reward_kind: 'discount', reward_amount_cents: 2500, created_by: 'a1' };

  // The thank-you.
  const r1 = S.cleanReward({ reward_kind: 'discount', reward_amount_cents: 2500 });
  const r2 = S.cleanReward({ reward_kind: 'discount', reward_percent: 20 });
  check('a thank-you: nothing, a line, or money off ($ or %)', S.cleanReward({ reward_kind: 'none' }).ok && S.cleanReward({ reward_kind: 'note', reward_note: 'Free lunch' }).ok && r1.ok && r2.ok
    && r1.reward.reward_amount_cents === 2500 && r1.reward.reward_percent === null && r2.reward.reward_percent === 20, short({ r1, r2 }));
  check('  money off needs $ or %, not both, and sensible', !S.cleanReward({ reward_kind: 'discount' }).ok && !S.cleanReward({ reward_kind: 'discount', reward_amount_cents: 100, reward_percent: 10 }).ok
    && !S.cleanReward({ reward_kind: 'discount', reward_percent: 150 }).ok && !S.cleanReward({ reward_kind: 'note', reward_note: ' ' }).ok && !S.cleanReward({ reward_kind: 'cash' }).ok);
  check('  said plainly', S.rewardText(job) === '$25 off next season' && S.rewardText({ reward_kind: 'discount', reward_percent: 20 }) === '20% off next season'
    && S.rewardText(shift) === 'Free lunch at the meet' && S.rewardText({ reward_kind: 'none' }) === null, short([S.rewardText(job), S.rewardText(shift)]));

  // Spots and who can sign up.
  const signups = [
    { id: 's1', opportunity_id: 'o1', household_id: 'h1', member_id: 'm1', status: 'confirmed' },
    { id: 's2', opportunity_id: 'o1', household_id: 'h2', member_id: 'm2', status: 'cancelled' },
    { id: 's3', opportunity_id: 'o2', household_id: 'h3', member_id: 'm3', status: 'done' },
  ];
  check('spots: a cancelled sign-up frees its spot; done and approved keep it', S.spotsTaken('o1', signups) === 1 && S.spotsTaken('o2', signups) === 1);
  check('signing up: open with a spot left', S.signUpProblem(shift, signups, { householdId: 'h2', memberId: 'm2', nowIso: now }) === null);
  check('  not twice for the same person', /already/i.test(S.signUpProblem(shift, signups, { householdId: 'h1', memberId: 'm1', nowIso: now }) || ''));
  check('  not when it\'s full', /taken|full/i.test(S.signUpProblem(job, signups, { householdId: 'h1', memberId: 'm1', nowIso: now }) || ''));
  check('  not once a shift has started', /started|over/i.test(S.signUpProblem({ ...shift, starts_at: '2027-06-19T16:00:00.000Z' }, [], { householdId: 'h9', memberId: 'm9', nowIso: now }) || ''));
  check('  not when it\'s closed or archived', !!S.signUpProblem({ ...shift, active: false }, [], { householdId: 'h9', nowIso: now }) && !!S.signUpProblem({ ...job, closed_at: now }, [], { householdId: 'h9', nowIso: now }));
  check('the number on the tab: open sign-ups the family could still take', S.openCount([shift, job, { ...shift, id: 'o3', active: false }], signups, 'h2', now) === 1
    && S.openCount([shift, job], signups, 'h1', now) === 0 && S.openCount([shift, job], [], 'h4', now) === 2);
  check('cancel: until a shift starts, or until a job is marked done', S.cancelProblem(signups[0], shift, now) === null
    && !!S.cancelProblem(signups[0], { ...shift, starts_at: '2027-06-19T16:00:00.000Z' }, now) && !!S.cancelProblem(signups[2], job, now));
  check('a shift is over at its end (or its start, with no end)', S.shiftEnded(shift, '2027-06-20T21:30:00.000Z') && !S.shiftEnded(shift, '2027-06-20T20:00:00.000Z')
    && S.shiftEnded({ ...shift, ends_at: null }, '2027-06-20T17:30:00.000Z') && !S.shiftEnded(job, '2099-01-01T00:00:00.000Z'));

  // Approving and the thank-you.
  check('the poster or the President approves; no one else', S.canApprove(job, { id: 'a1', isOwner: false }) && S.canApprove(job, { id: 'p', isOwner: true }) && !S.canApprove(job, { id: 'a2', isOwner: false }));
  check('the news names the family: one, two, several', S.familyLabel(['Rivera Family']) === 'Rivera family' && S.familyLabel(['Rivera', 'Chen Family']) === 'Rivera and Chen families'
    && S.familyLabel(['Rivera', 'Chen', 'Patel']) === 'Rivera, Chen and Patel families' && S.familyLabel(['Rivera', 'Rivera Family']) === 'Rivera family', short([S.familyLabel(['Rivera', 'Chen Family'])]));
  const post = S.thanksPost(job, ['Rivera Family']);
  check('  "Thank you, Rivera family!" and what they helped with', post.title === 'Thank you, Rivera family! 🙌' && /Fix the sprinkler by the kiddie pool/.test(post.body), short(post));
  const code = S.newThanksCode();
  check('a thank-you code: THANKS and 5 letters or digits, easy to read', /^THANKS[A-HJ-NP-Z2-9]{5}$/.test(code), code);

  // Thank-you news posts never push a real announcement off.
  const K = await importTs(shared('keep_newest.ts'));
  const day = n => `2027-06-${String(n).padStart(2, '0')}T12:00:00Z`;
  const real = Array.from({ length: 15 }, (_, i) => ({ id: `p${i}`, kind: 'post', published_at: day(i + 1) }));
  const thanks = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, kind: 'thanks', published_at: day(i + 16) }));
  const drop = K.postsToDrop([...real, ...thanks]);
  check('the 15 announcements are kept however many thank-yous follow', !drop.some(id => id.startsWith('p')), short(drop));
  check('  and only the newest 10 thank-yous', drop.filter(id => id.startsWith('t')).sort().join() === ['t0', 't1'].join(), short(drop));
}

// ── BM1 · the wiring ─────────────────────────────────────────────────────
console.log('BM1 · the wiring (offline)');
const migs = readdirSync(new URL('supabase/migrations/', root)).filter(f => /signups/.test(f)).map(f => read(`supabase/migrations/${f}`)).join('\n');
check('the migration: shifts and jobs, photos, the thank-you, Done and approval', /kind text/.test(migs) && /due_on/.test(migs) && /photos jsonb/.test(migs)
  && /reward_kind/.test(migs) && /done_photo_url/.test(migs) && /approved_at/.test(migs) && /discount_code_id/.test(migs) && /'no_show'/.test(migs));
check('  news posts get a photo and a kind (post or thanks)', /alter table public\.posts/.test(migs) && /image_url/.test(migs) && /'thanks'/.test(migs));
check('  a family can sign up again after cancelling', /where status <> 'cancelled'|where \(status <> 'cancelled'\)/.test(migs));
const vol = read('supabase/functions/volunteer/index.ts');
for (const a of ['upload_photo', 'done', 'approve', 'attendance', 'send_back']) check(`the server has "${a}"`, new RegExp(`action === '${a}'`).test(vol));
check('any board member posts (not only the Volunteer screen)', /boardCaller\(/.test(vol) && !/requireScope\(sb, payload as never, 'volunteer'\)/.test(vol));
check('members of the current season only', /householdStatus\(/.test(vol));
check('the poster\'s to-dos are to-dos, not pop-ups', /enqueueAdminTask\(/.test(vol) && /skip_push: true/.test(vol) && !/skip_push: false/.test(vol));
check('the code is emailed with its own email', /renderAndSend\([\s\S]{0,200}signup_thanks/.test(vol));
check('the thank-you goes on the news, and the keep-newest rule runs', /kind: 'thanks'/.test(vol) && /keepNewestPosts\(/.test(vol));
// email_template.ts reads Deno.env through send_email.ts; nothing is sent offline.
globalThis.Deno = globalThis.Deno || { env: { get: () => undefined } };
const et = await importTs(shared('email_template.ts'));
check('the email "Thank you for helping" is on Settings → Emails, under Sign-ups', et.EMAIL_REGISTRY.some(d => d.key === 'signup_thanks' && d.section === 'signups')
  && et.EMAIL_SECTIONS.some(s => s.id === 'signups' && s.label === 'Sign-ups'));
check('the club\'s news carries the photo and kind', /select\('id, title, body, pinned, published_at, image_url, kind'\)/.test(read('supabase/functions/tenant_public/index.ts')));
check('the daily run asks the poster to tick who came after a shift', /askAttendance\(/.test(read('supabase/functions/payment_plans/index.ts')));

// ── BM2 · the board's Sign-ups page, drawn with sample answers ──────────
console.log('BM2 · the board\'s Sign-ups page (offline, in Chrome)');
{
  const { launch, attach, BOARD } = await import('./demo_video/harness.mjs');
  const { respond } = await import('./demo_video/data.mjs');
  const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
  const opps = [
    { id: '11111111-1111-1111-1111-111111111111', kind: 'job', title: 'Fix the sprinkler', due_on: '2099-07-01', slots_needed: 1, slots_filled: 1, waiting: 1, approved: 0, can_approve: true,
      photos: ['data:image/png;base64,iVBORw0KGgo='], reward_kind: 'discount', reward_amount_cents: 2500, reward_text: '$25 off next season', created_by_name: 'Erik Larsen', active: true },
    { id: '22222222-2222-2222-2222-222222222222', kind: 'shift', title: 'Snack Shack at the meet', starts_at: ago(5), ends_at: ago(1), slots_needed: 3, slots_filled: 2, waiting: 0, can_approve: true,
      photos: [], reward_kind: 'note', reward_note: 'Free lunch', reward_text: 'Free lunch', created_by_name: 'Sam Brooks', active: true },
    { id: '33333333-3333-3333-3333-333333333333', kind: 'shift', title: 'Timers for the swim meet', starts_at: '2099-06-20T16:00:00Z', ends_at: '2099-06-20T19:00:00Z', slots_needed: 4, slots_filled: 1, waiting: 0, can_approve: false,
      photos: [], reward_kind: 'none', reward_text: null, created_by_name: 'Mei Chen', active: true },
  ];
  const sent = [];
  const roster = id => id === opps[0].id
    ? [{ id: 's-job', status: 'done', volunteer_name: 'Jamie Rivera', family_name: 'Rivera Family', done_note: 'New head on.', done_photo_url: 'data:image/png;base64,iVBORw0KGgo=' }]
    : [{ id: 's-a', status: 'confirmed', volunteer_name: 'Jamie Rivera', family_name: 'Rivera Family' }, { id: 's-b', status: 'confirmed', volunteer_name: 'Lin Chen', family_name: 'Chen Family' }];
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const log = await attach(page, { answer: (f, body, ctx) => {
    if (f === 'volunteer') {
      sent.push(body);
      if (body.action === 'list') return { ok: true, opportunities: opps };
      if (body.action === 'roster') return { ok: true, opportunity: opps.find(o => o.id === body.opportunity_id), signups: roster(body.opportunity_id) };
      return { ok: true, opportunity: opps[0] };
    }
    return respond(f, body, ctx);
  } });
  await page.goto(BOARD + '/club/admin/volunteer.html', { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise(r => setTimeout(r, 600));
  const view = await page.evaluate(() => ({
    title: document.querySelector('h1')?.textContent, buttons: [...document.querySelectorAll('.toolbar .btn')].map(b => b.textContent.trim()),
    sections: [...document.querySelectorAll('.section-h')].map(h => h.textContent), text: document.getElementById('list').innerText.replace(/\s+/g, ' '),
    wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  check('the page is "Sign-ups", with + Shift and + Job', view.title === 'Sign-ups' && view.buttons.join('|') === '+ Shift|+ Job', JSON.stringify(view).slice(0, 160));
  check('what\'s waiting for you first: the job to approve and the shift that\'s over', /^waiting for you$/i.test(view.sections[0]) && /Fix the sprinkler.*1 to approve/i.test(view.text) && /Snack Shack at the meet.*who came\?/i.test(view.text), view.text.slice(0, 220));
  check('  then the open ones, with the thank-you and who posted it', view.sections.some(h => /^open$/i.test(h)) && /Timers for the swim meet/.test(view.text) && /🎁 \$25 off next season/.test(view.text) && /posted by Erik Larsen/.test(view.text));
  check('  fits a phone', view.wide <= 1, String(view.wide));
  const form = await page.evaluate(() => {
    openCreate('job');
    const job = { title: document.getElementById('m-title').textContent, jobWhen: getComputedStyle(document.getElementById('m-job-when')).display, shiftWhen: getComputedStyle(document.getElementById('m-shift-when')).display };
    setReward('discount');
    document.getElementById('m-name').value = 'Paint the bathrooms';
    document.getElementById('m-reward-amount').value = '25';
    return { ...job, money: getComputedStyle(document.getElementById('m-reward-money')).display };
  });
  await page.evaluate(() => save());
  await new Promise(r => setTimeout(r, 400));
  const made = sent.find(b => b.action === 'create');
  check('+ Job: a do-by date instead of a time, and money off', form.title === 'New job' && form.jobWhen !== 'none' && form.shiftWhen === 'none' && form.money !== 'none', JSON.stringify(form));
  check('  saved as a job with $25 off', made?.kind === 'job' && made?.title === 'Paint the bathrooms' && made?.reward_kind === 'discount' && made?.reward_amount_cents === 2500 && made?.starts_at === null, JSON.stringify(made).slice(0, 200));
  await page.evaluate(id => openRoster(id), opps[0].id);
  await new Promise(r => setTimeout(r, 400));
  const jr = await page.evaluate(() => ({ text: document.getElementById('r-list').innerText.replace(/\s+/g, ' '), photo: !!document.querySelector('#r-list img.done-ph'),
    btns: [...document.querySelectorAll('#r-list button')].map(b => b.textContent.trim()) }));
  check('a job marked done: their note and photo, Approve and Send back', /Marked done/i.test(jr.text) && /New head on/.test(jr.text) && jr.photo && jr.btns.includes('Approve') && jr.btns.includes('Send back'), JSON.stringify(jr));
  page.on('dialog', d => d.accept());
  await page.evaluate(() => approve('s-job'));
  await new Promise(r => setTimeout(r, 400));
  check('  Approve sends that sign-up', sent.some(b => b.action === 'approve' && b.signup_ids?.[0] === 's-job'));
  await page.evaluate(id => openRoster(id), opps[1].id);
  await new Promise(r => setTimeout(r, 400));
  const sr = await page.evaluate(() => { const boxes = [...document.querySelectorAll('#r-list input.came')]; if (boxes[1]) boxes[1].checked = false;
    return { boxes: boxes.length, save: !!document.querySelector('#r-list button[onclick="saveCame()"]') }; });
  await page.evaluate(() => saveCame());
  await new Promise(r => setTimeout(r, 400));
  const att = sent.find(b => b.action === 'attendance');
  check('a shift that\'s over: tick who came, then Save who came', sr.boxes === 2 && sr.save && att?.came?.join() === 's-a', JSON.stringify({ sr, att }));
  check('no script errors', !log.errors.length, log.errors.join(' | '));
  await browser.close();
}

// ── BM1 · live, on a throwaway club ─────────────────────────────────────
if (process.argv.includes('--live')) {
  console.log('BM1 · live (a throwaway club, deleted afterwards; about 25 calls)');
  const env = Object.fromEntries(read('.env.local').split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const { SUPABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, ADMIN_JWT_SECRET, CRON_SECRET } = env;
  const sql = async query => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
    if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  const b64u = b => Buffer.from(b).toString('base64url');
  const jwt = p => { const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const b = b64u(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + 900 }));
    return `${h}.${b}.${createHmac('sha256', ADMIN_JWT_SECRET).update(`${h}.${b}`).digest('base64url')}`; };
  const fn = async (name, body, token, headers = {}) => {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const { makeTempClub, dropTempClub } = await import('./lib/testdata.mjs');
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  let club = null;
  try {
    club = await makeTempClub(sql, 'signups', { features: { volunteer: true } });
    const T = club.id, slug = club.slug;
    const admin = async (name, role = 'custom') => (await sql(`insert into admin_users (tenant_id, username, email, password_hash, display_name, role_template, scopes, is_default_pw, active)
      values (${q(T)}, ${q(`simtest-${name.toLowerCase()}-${club.stamp}`)}, 'delivered@resend.dev', 'x', ${q(name)}, ${q(role)}, array[]::text[], false, true) returning id`))[0].id;
    const pres = await admin('Pat President', 'owner'), poster = await admin('Erik Poster'), other = await admin('Mia Other');
    const tok = id => jwt({ sub: id, kind: 'tenant_admin', tid: T, slug });
    const family = async (name, paid = true) => {
      const [hh] = await sql(`insert into households (tenant_id, family_name, tier, active, dues_paid_for_year, paid_until_year)
        values (${q(T)}, ${q(name)}, 'family', true, ${paid}, ${paid ? 'extract(year from now())::int + 1' : 'null'}) returning id`);
      const [m] = await sql(`insert into household_members (tenant_id, household_id, name, email, role, active, can_unlock_gate, can_book_parties, confirmed_at)
        values (${q(T)}, ${q(hh.id)}, ${q(name.replace(' Family', '') + ' Tester')}, 'delivered@resend.dev', 'primary', true, true, true, now()) returning id`);
      return { hid: hh.id, mid: m.id, tok: jwt({ sub: m.id, kind: 'member', tid: T, slug, hid: hh.id }) };
    };
    const rivera = await family('Rivera Family'), chen = await family('Chen Family'), lapsed = await family('Gone Family', false);
    await sql(`update settings set value = jsonb_set(value, '{membership}', jsonb_build_object('year', extract(year from now())::int + 1)) where tenant_id = ${q(T)}`);

    // A job with a photo and $25 off, posted by any board member.
    const up = await fn('volunteer', { action: 'upload_photo', content_type: 'image/png', base64: PNG }, tok(poster));
    check('a board member adds a photo', up.ok && /\/storage\/v1\/object\/public\/club-assets\//.test(up.url || ''), short(up));
    const mk = await fn('volunteer', { action: 'create', kind: 'job', title: 'Fix the sprinkler by the kiddie pool', description: 'The head by the gate sprays the path.',
      due_on: '2099-07-01', slots_needed: 1, photos: [up.url], reward_kind: 'discount', reward_amount_cents: 2500 }, tok(poster));
    const job = mk.opportunity;
    check('any board member posts a job: photo, do-by date, $25 off', mk.ok && job?.kind === 'job' && job?.photos?.length === 1 && job?.reward_amount_cents === 2500 && job?.created_by === poster, short(mk));

    // Families see it, with a number on the tab.
    const l1 = await fn('volunteer', { action: 'list' }, rivera.tok);
    check('a family sees it, and the tab says 1', l1.ok && l1.open_count === 1 && l1.opportunities?.some(o => o.id === job.id && o.reward_text === '$25 off next season'), short({ n: l1.open_count, err: l1.error }));
    const no = await fn('volunteer', { action: 'signup', opportunity_id: job.id, volunteer_name: 'Gone Tester', member_id: lapsed.mid }, lapsed.tok);
    check('a family that isn\'t a member this season can\'t sign up', !no.ok && no.status === 403, short(no));
    const s1 = await fn('volunteer', { action: 'signup', opportunity_id: job.id, volunteer_name: 'Rivera Tester', member_id: rivera.mid }, rivera.tok);
    const [t1] = await sql(`select assigned_admin_id from admin_tasks where tenant_id = ${q(T)} and kind = 'signup.taken' and source_id = ${q(job.id)}`);
    check('the Riveras take it; the poster gets a to-do', s1.ok && t1?.assigned_admin_id === poster, short({ s1: s1.error, t1 }));
    const full = await fn('volunteer', { action: 'signup', opportunity_id: job.id, volunteer_name: 'Chen Tester', member_id: chen.mid }, chen.tok);
    const l2 = await fn('volunteer', { action: 'list' }, chen.tok);
    check('one spot: the Chens can\'t, and their tab says 0', !full.ok && l2.open_count === 0, short({ full: full.error, n: l2.open_count }));

    // Done, with a photo; approved by the poster.
    const dup = await fn('volunteer', { action: 'upload_photo', content_type: 'image/png', base64: PNG }, rivera.tok);
    const dn = await fn('volunteer', { action: 'done', signup_id: s1.signup?.id, photo_url: dup.url, note: 'New head on.' }, rivera.tok);
    const [t2] = await sql(`select assigned_admin_id from admin_tasks where tenant_id = ${q(T)} and kind = 'signup.done' and source_id = ${q(job.id)} and completed_at is null`);
    check('the Riveras tap Done with a photo; the poster gets "approve"', dn.ok && dn.signup?.status === 'done' && t2?.assigned_admin_id === poster, short({ dn: dn.error || dn.signup?.status, t2 }));
    const nope = await fn('volunteer', { action: 'approve', signup_ids: [s1.signup?.id] }, tok(other));
    check('another board member can\'t approve it', !nope.ok && nope.status === 403, short(nope));
    const ap = await fn('volunteer', { action: 'approve', signup_ids: [s1.signup?.id] }, tok(poster));
    const [sg] = await sql(`select s.status, s.discount_code_id, c.code, c.amount_cents, c.max_uses, s.thanks_post_id from volunteer_signups s left join discount_codes c on c.id = s.discount_code_id where s.id = ${q(s1.signup?.id)}`);
    check('the poster approves: done, and a one-family code for $25 off', ap.ok && sg?.status === 'approved' && /^THANKS/.test(sg?.code || '') && sg?.amount_cents === 2500 && sg?.max_uses === 1, short({ ap: ap.error, sg }));
    const [post] = sg?.thanks_post_id ? await sql(`select title, body, image_url, kind, notify_members from posts where id = ${q(sg.thanks_post_id)}`) : [];
    check('  a thank-you on the news with the Done photo, no pop-up', post?.kind === 'thanks' && post?.title === 'Thank you, Rivera family! 🙌' && post?.image_url === dup.url && post?.notify_members === false, short(post));
    const mine = await fn('volunteer', { action: 'list' }, rivera.tok);
    const m1 = (mine.mine || []).find(x => x.id === s1.signup?.id);
    check('  the Riveras see it approved, with their code', m1?.status === 'approved' && m1?.code === sg?.code, short(m1));
    const [{ n: done2 }] = await sql(`select count(*)::int as n from admin_tasks where tenant_id = ${q(T)} and source_id = ${q(job.id)} and completed_at is null`);
    check('  the poster\'s to-dos are closed', done2 === 0, String(done2));

    // A shift: two families; the poster ticks who came.
    const sh = (await fn('volunteer', { action: 'create', kind: 'shift', title: 'Snack Shack at the meet', starts_at: new Date(Date.now() - 4 * 3600e3).toISOString(),
      ends_at: new Date(Date.now() - 3600e3).toISOString(), slots_needed: 3, reward_kind: 'note', reward_note: 'Free lunch' }, tok(poster))).opportunity;
    await sql(`insert into volunteer_signups (tenant_id, opportunity_id, household_id, member_id, volunteer_name) values
      (${q(T)}, ${q(sh?.id)}, ${q(rivera.hid)}, ${q(rivera.mid)}, 'Rivera Tester'), (${q(T)}, ${q(sh?.id)}, ${q(chen.hid)}, ${q(chen.mid)}, 'Chen Tester')`);
    // The daily run's step, for this club only (payment_plans runs it for every club).
    const cron = await fn('volunteer', { action: 'cron_attendance', tenant_id: T }, null, { 'x-cron-secret': CRON_SECRET });
    const [t3] = await sql(`select assigned_admin_id from admin_tasks where tenant_id = ${q(T)} and kind = 'signup.attendance' and source_id = ${q(sh?.id)}`);
    check('after the shift, the daily run asks the poster who came', cron.ok && cron.asked >= 1 && t3?.assigned_admin_id === poster, short({ cron, t3 }));
    const ro = await fn('volunteer', { action: 'roster', opportunity_id: sh?.id }, tok(pres));
    const riv = (ro.signups || []).find(x => x.household_id === rivera.hid);
    const at = await fn('volunteer', { action: 'attendance', opportunity_id: sh?.id, came: [riv?.id] }, tok(pres));
    const st = await sql(`select household_id, status from volunteer_signups where opportunity_id = ${q(sh?.id)}`);
    check('the President ticks the Riveras: approved; the Chens didn\'t come', at.ok && st.find(x => x.household_id === rivera.hid)?.status === 'approved' && st.find(x => x.household_id === chen.hid)?.status === 'no_show', short({ at: at.error, st }));
    const [p2] = await sql(`select title from posts where tenant_id = ${q(T)} and kind = 'thanks' order by created_at desc limit 1`);
    check('  one thank-you on the news for the shift', p2?.title === 'Thank you, Rivera family! 🙌', short(p2));
  } catch (e) {
    check('live run', false, e.stack || e.message);
  } finally {
    if (club) {
      const left = await dropTempClub(sql, club, { accessToken: SUPABASE_ACCESS_TOKEN, projectRef: SUPABASE_PROJECT_REF, supabaseUrl: SUPABASE_URL });
      check('the throwaway club and everything in it are gone', left === 0, String(left));
    }
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
