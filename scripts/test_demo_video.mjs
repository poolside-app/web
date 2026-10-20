// The demo video's screens still work with its made-up club (PLAN.md BD).
// Offline: every Supabase call is answered by scripts/demo_video/data.mjs.
// A screen that makes a call the demo doesn't answer, or throws, fails here
// before it spoils a recording.   node scripts/test_demo_video.mjs
import { readFileSync } from 'node:fs';
import { launch, attach, FAMILY, BOARD } from './demo_video/harness.mjs';

let passed = 0, failed = 0;
const check = (name, ok, why = '') => { console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ' — ' + why}`); ok ? passed++ : failed++; };

const SCREENS = [
  ['family', '/m/', { riveraPaid: false }], ['family', '/m/renew.html', {}], ['family', '/apply.html', {}], ['family', '/m/', { riveraPaid: true, partyToday: true }],
  ['board', '/club/admin/', {}], ['board', '/club/admin/payments.html', {}], ['board', '/club/admin/keyfobs.html', {}], ['board', '/club/admin/time-saved.html', {}],
];
const browser = await launch();
console.log('BD · each screen in the video, with the demo club');
for (const [side, path, state] of SCREENS) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 720 });
  const log = await attach(page, { state });
  await page.goto((side === 'board' ? BOARD : FAMILY) + path, { waitUntil: 'networkidle0', timeout: 45000 });
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

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
