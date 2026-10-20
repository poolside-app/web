// The demo video's screens still work with its made-up club (PLAN.md BD).
// Offline: every Supabase call is answered by scripts/demo_video/data.mjs.
// A screen that makes a call the demo doesn't answer, or throws, fails here
// before it spoils a recording.   node scripts/test_demo_video.mjs
import { readFileSync } from 'node:fs';
import { launch, attach, FAMILY, BOARD, ALEX } from './demo_video/harness.mjs';

let passed = 0, failed = 0;
const check = (name, ok, why = '') => { console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ' — ' + why}`); ok ? passed++ : failed++; };

const SCREENS = [
  ['family', '/m/', { riveraPaid: false }], ['family', '/m/renew.html', {}], ['family', '/apply.html', {}], ['family', '/m/', { riveraPaid: true, partyToday: true }],
  ['board', '/club/admin/', {}], ['board', '/club/admin/payments.html', {}], ['board', '/club/admin/keyfobs.html', {}], ['board', '/club/admin/time-saved.html', {}],
  // The tour (BD2): after paying, a plan started, the board's Upcoming, signing in.
  ['family', '/apply.html?paid=1&app_id=app-rivera-new', {}], ['family', '/apply.html?plan_started=1&app_id=app-okafor', {}],
  ['board', '/club/admin/upcoming.html', {}], ['alex', '/m/login.html', {}], ['alex', '/m/verify.html#token=x', {}],
];
const browser = await launch();
console.log('BD · each screen in the video, with the demo club');
for (const [side, path, state] of SCREENS) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 720 });
  const log = await attach(page, { state });
  await page.goto(({ board: BOARD, alex: ALEX }[side] ?? FAMILY) + path, { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise(r => setTimeout(r, 800));
  const problems = [...new Set(log.unknown)].map(u => 'unanswered ' + u).concat(log.errors, [...log.external].map(h => 'blocked ' + h));
  check(`${side} ${path}`, !problems.length, problems.join('; '));
  await page.close();
}
await browser.close();

console.log('BD · the club is made up');
const data = readFileSync(new URL('./demo_video/data.mjs', import.meta.url), 'utf8');
check('no real club or family names', !/bishop|frevele|beaubien|cabana/i.test(data), 'found a real name in data.mjs');
check('phone numbers are 555 numbers, emails example.com', [...data.matchAll(/\+1\d{10}/g)].every(m => m[0].slice(5, 8) === '555')
  && [...data.matchAll(/[\w.]+@[\w.]+/g)].every(m => m[0].endsWith('example.com')), 'a real-looking phone or email');

// The 90-second video (PLAN.md BH): Doug's script, subtitles, the music under the voice.
console.log('BH · the 90-second video');
let promo = null;
try { promo = await import('./demo_video/promo.mjs'); } catch (e) { check('promo.mjs loads without recording', false, String(e.message).slice(0, 120)); }
if (promo) {
  const APPROVED = [
    "Running a pool club shouldn't feel like a second job.", 'No more chasing Venmo screenshots.', 'No more spreadsheets.', 'Meet Poolside.',
    "A family signs up from their phone in about five minutes: their details, their kids, the club's policies, signed.",
    'They pay by card, Venmo or a payment plan.', 'Card payments approve themselves, so the board has nothing to do.',
    "Paid families open the gate from their phone, and their keyfobs follow who's paid.",
    'Every Venmo payment carries a code, so the board confirms a whole batch at once.', 'Plan payments go out only when the board ticks them.',
    'Each board member opens to their own to-do list: parties, keyfobs and questions, in one place.',
    'Poolside.', 'Run your pool club, not your spreadsheets.', 'Try it yourself at demo.poolsideapp.com.',
  ];
  const lines = promo.SCRIPT.filter(s => s.say).map(s => s.say);
  check('it says exactly the script Doug approved, in order', JSON.stringify(lines) === JSON.stringify(APPROVED), lines.join(' | ').slice(0, 200));
  const titles = promo.SCRIPT.filter(s => s.title).map(s => s.title.join(' '));
  check('a big title for each part', JSON.stringify(titles) === JSON.stringify(['SIGN UP IN 5 MINUTES', 'PAID. APPROVED. DONE.', 'THE GATE KNOWS', 'NOTHING TO CHASE', 'YOUR BOARD, SORTED']), titles.join(' | '));
  const stage = readFileSync(new URL('./demo_video/promo.html', import.meta.url), 'utf8');
  check('no "Chapter" anywhere', !/chapter/i.test(stage + JSON.stringify(promo.SCRIPT.map(s => [s.say, s.title]))));
  const long = lines.filter(t => { const c = promo.captionLines(t); return c.length > 2 || c.some(l => l.length > 64); });
  check('every subtitle fits on two lines', !long.length, long.join(' | '));
  const said = lines.map(promo.spoken).join(' ');
  check('the voice reads "key fobs" and the web address as words', /key fobs/.test(said) && !/keyfob/i.test(said) && /demo dot poolside app dot com/.test(said) && !/\w\.\w/.test(said), said.slice(0, 160));

  // Music: voice at 2–5 s, 5.5–8 s and 12–15 s, a steady loud track, 20 s long.
  const loud = Array(40).fill(-9);
  const pts = promo.musicCurve([{ t: 2, secs: 3 }, { t: 5.5, secs: 2.5 }, { t: 12, secs: 3 }], 20, loud);
  const at = t => pts.reduce((best, p) => Math.abs(p[0] - t) < Math.abs(best[0] - t) ? p : best)[1];
  const db = v => 20 * Math.log10(v);
  check('music sits at least 14 dB under the voice while she speaks', db(at(3)) - 9 <= promo.VOICE_DB - 14 && db(at(13)) - 9 <= promo.VOICE_DB - 14, `${(db(at(3)) - 9).toFixed(1)} dB`);
  check('it stays down through a short pause', Math.abs(at(5.2) - at(3)) < 0.01);
  check('it comes up between parts and before she starts', at(10) > at(3) * 2 && at(0.5) > at(3) * 2);
  check('it fades out at the end, never above full volume', at(20) === 0 && pts.every(p => p[1] >= 0 && p[1] <= 1));
}
const enc = readFileSync(new URL('./demo_video/encode.swift', import.meta.url), 'utf8');
check('the encoder mixes in music with its volume curve', /music\.json/.test(enc) && /setVolumeRamp/.test(enc) && /audioMix/.test(enc));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
