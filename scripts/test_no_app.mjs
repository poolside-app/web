#!/usr/bin/env node
// A family that picks "Just sign me up" (PLAN.md CM1–CM4). Doug 11/8: "Have
// we checked the flow of someone doesn't have the full app experience and
// just buys a membership", and his answers: announcements by email to families
// no pop-up reached; the no-app welcome text without a link.
//
// Offline: the welcome text, the page after paying, the pop-ups that now
// email when no pop-up reached the family, and announcements by email through
// the queue, against a pretend database. Costs nothing.
//
// Usage: node scripts/test_no_app.mjs
import { readFileSync } from 'node:fs';
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
const short = v => JSON.stringify(v)?.slice(0, 240);

console.log('CM1 · the welcome text');
{
  const sms = await importTs(new URL('supabase/functions/_shared/sms_text.ts', root));
  const link = 'https://x.poolsideapp.com/m/verify.html#token=abc';
  const a = { firstName: 'Jane', clubName: 'Bishop Estates Cabana Club', link };
  const w = typeof sms.welcomeText === 'function' ? sms.welcomeText : null;
  check('welcomeText exists', !!w);
  if (w) {
    const app = w({ ...a, onPlan: false, owes: false, noApp: false });
    const noApp = [w({ ...a, onPlan: false, owes: false, noApp: true }), w({ ...a, onPlan: true, owes: false, noApp: true }), w({ ...a, onPlan: false, owes: true, noApp: true })];
    check('the app family still gets the sign-in link', app.includes(link), app);
    check('a "Just sign me up" family gets no link, for paid, a plan and dues still owed', noApp.every(t => !/https?:/.test(t)), short(noApp));
    check('…paid: you\'re all set, see you at the pool', /all set/.test(noApp[0]) && /See you at the pool/.test(noApp[0]), noApp[0]);
    check('…a plan: the schedule is in their email', /payment plan/.test(noApp[1]) && /email/.test(noApp[1]), noApp[1]);
    check('…dues owed: their email says how to pay', /email/.test(noApp[2]) && /pay/.test(noApp[2]), noApp[2]);
    check('plain characters only, so it stays one cheap text', noApp.concat(app).every(t => /^[\x20-\x7E]*$/.test(t)), short(noApp));
  }
  const ap = read('supabase/functions/applications/index.ts');
  check('approval uses it with the family\'s choice', /welcomeText\(\{[^}]*noApp: !!app\.no_app_member/.test(ap));
}

console.log('CM2 · the page after paying by card');
{
  const ap = read('supabase/functions/applications/index.ts');
  const pps = between(ap, "action === 'post_payment_signin'", "action === 'claim_venmo_paid'");
  check('the sign-in answer says whether they chose no app', /no_app_member/.test(pps) && /no_app:/.test(pps));
  const page = between(read('apply.html'), 'async function renderPostPaymentSuccess', '\n}\n');
  check('a "Just sign me up" family sees "see you at the pool", not a big Sign in button', /data\.no_app/.test(page) && /See you at the pool/.test(page) && /Sign in any time/.test(page));
}

console.log('CM3 · pop-ups that now email when no pop-up reached them');
{
  const et = await importTs(new URL('supabase/functions/_shared/email_template.ts', root));
  check('22 emails: "Message from the club" added', et.EMAIL_REGISTRY.length === 22 && !!et.getRegistryEntry('club_notice'));
  const text = h => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
  const m = et.composeEmail('club_notice', null, null, { tenant_name: 'Bishop Estates Cabana Club', family_name: 'Smith', title: '🔑 Your keyfob is ready', body: 'Fob 1234 is set up. Pick it up from the board.', url: '/m/#keyfobs', button: 'Open my member page', club_url: 'https://x.poolsideapp.com' });
  const t = text(m.html);
  check('it carries the pop-up\'s words and a button', /Your keyfob is ready/.test(m.subject) && /Pick it up from the board/.test(t) && /Open my member page/.test(t) && /x\.poolsideapp\.com\/m\/#keyfobs/.test(m.html), t.slice(0, 300));
  const news = et.composeEmail('club_notice', null, null, { tenant_name: 'Bishop', family_name: 'Smith', title: '📰 Pool opens Saturday', body: 'Gates open at 10.\n\nBring sunscreen.', url: '/m/#news', button: 'See all club news', club_url: 'https://x.poolsideapp.com' });
  check('an announcement keeps its paragraphs', (news.html.match(/Gates open at 10\.|Bring sunscreen\./g) || []).length === 2 && /<p[^>]*>Bring sunscreen\.<\/p>/.test(news.html), news.html.slice(0, 200));
  check('the Emails page previews it both ways', (et.getRegistryEntry('club_notice').variants || []).length >= 2);
  const mn = read('supabase/functions/_shared/member_notify.ts');
  check('member_notify: noticeFamily emails "club_notice" when no pop-up reached them', /export async function noticeFamily/.test(mn) && /club_notice/.test(mn) && /notifyHousehold\(/.test(between(mn, 'export async function noticeFamily', '\n}\n')));
  const kf = read('supabase/functions/keyfobs/index.ts');
  check('keyfobs: ready, new one ready, canceled all go through noticeFamily', /noticeFamily\(/.test(between(kf, 'async function popFamily', '\n}\n')) && !/pushMembers\(/.test(kf));
  const rr = read('supabase/functions/_shared/refund_review.ts');
  check('after a refund: membership ended, party canceled, keyfob canceled too', /noticeFamily\(/.test(between(rr, 'async function pop(', '\n}\n')) && !/pushMembers\(/.test(rr));
}

console.log('CM4 · announcements by email to families no pop-up reached');
{
  let ne = null;
  try { ne = await importTs(new URL('supabase/functions/_shared/news_email.ts', root)); }
  catch (e) { check('_shared/news_email.ts loads', false, String(e.message).slice(0, 160)); }
  if (ne) {
    const sb = fakeDb({
      households: [
        { id: 'h1', tenant_id: 't', family_name: 'Smith', active: true },
        { id: 'h2', tenant_id: 't', family_name: 'Jones', active: true },
        { id: 'h3', tenant_id: 't', family_name: 'Old', active: false },
        { id: 'h4', tenant_id: 'other', family_name: 'Elsewhere', active: true },
        { id: 'h5', tenant_id: 't', family_name: 'Lee', active: true },
      ],
      household_members: [
        { id: 'm1', tenant_id: 't', household_id: 'h1', role: 'primary', active: true, email: 'smith@x.com' },
        { id: 'm1b', tenant_id: 't', household_id: 'h1', role: 'adult', active: true, email: 'smith2@x.com' },
        { id: 'm2', tenant_id: 't', household_id: 'h2', role: 'primary', active: true, email: 'jones@x.com' },
        { id: 'm2b', tenant_id: 't', household_id: 'h2', role: 'adult', active: true, email: null },
        { id: 'm3', tenant_id: 't', household_id: 'h3', role: 'primary', active: true, email: 'old@x.com' },
        { id: 'm4', tenant_id: 'other', household_id: 'h4', role: 'primary', active: true, email: 'else@x.com' },
        { id: 'm5', tenant_id: 't', household_id: 'h5', role: 'primary', active: true, email: null },
      ],
    });
    const to = await ne.newsRecipients(sb, 't', ['m2b']);   // the Joneses' second adult has pop-ups
    check('one email per current family no pop-up reached, to the primary', JSON.stringify(to.map(r => r.email)) === JSON.stringify(['smith@x.com']), short(to));
    check('…with their family name for the greeting', to[0]?.family_name === 'Smith', short(to));
  }
  const pa = read('supabase/functions/posts_admin/index.ts');
  const create = between(pa, 'notify_members: notify', 'keepNewestPosts');
  check('posting with Notify members emails them through the queue (today\'s limit, then the morning)', /newsRecipients\(/.test(create) && /enqueueEmails\(/.test(create) && /drainEmailQueue\(/.test(create) && /emailed/.test(create) && /queued/.test(create));
  const page = read('club/admin/announcements.html');
  check('the board is told how many got it by email', /data\.emailed/.test(page) && /data\.queued/.test(page) && /by email/.test(page));
  check('the Notify box says email too', /pop-up on their phones, or an email/.test(page));
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
