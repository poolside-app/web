#!/usr/bin/env node
// "What the app does", the video next to "Full app experience" on the join
// form (PLAN.md CP). Doug 11/8: "create a video highlighting the benefits of
// the app… put that video next to the selection of full app experience".
//
// Offline: the video file on the site (its length matching the button), the
// script's subtitles, every step of the script run against the made-up club
// in Chrome (DEMO_DRY, no recording), and the join form's button playing it.
//
// Usage: node scripts/test_member_video.mjs
import { readFileSync, existsSync } from 'node:fs';
import { launch, attach, FAMILY } from './demo_video/harness.mjs';

const root = new URL('../', import.meta.url);
const read = rel => { try { return readFileSync(new URL(rel, root), 'utf8'); } catch { return ''; } };
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('CP1 · the video');
const mp4Secs = b => { const i = b.indexOf('mvhd'); if (i < 0) return 0; const v1 = b[i + 4] === 1, o = i + (v1 ? 24 : 16); return (v1 ? Number(b.readBigUInt64BE(o + 4)) : b.readUInt32BE(o + 4)) / b.readUInt32BE(o); };
const vurl = new URL('videos/what-the-app-does.mp4', root);
const vid = existsSync(vurl) ? readFileSync(vurl) : null;
check('on the site, under 11 MB, ready to stream (its index first)', !!vid && vid.length > 1e6 && vid.length < 11e6 && vid.indexOf('moov') < vid.indexOf('mdat'),
  vid ? `${(vid.length / 1e6).toFixed(1)} MB` : 'missing videos/what-the-app-does.mp4');
const pwa = read('js/pwa.js');
const secs = Number((pwa.match(/APP_VIDEO = \{ src: '\/videos\/what-the-app-does\.mp4', secs: (\d+) \}/) || [])[1]);
check('the button says its real length', !!vid && Math.abs(mp4Secs(vid) - secs) <= 2, `file ${vid ? mp4Secs(vid).toFixed(1) : '?'} s, button ${secs} s`);
const src = read('scripts/demo_video/member_video.mjs');
check('member_video.mjs writes it there', /videos\/what-the-app-does\.mp4/.test(src));
const mv = await import('./demo_video/member_video.mjs');
const promo = await import('./demo_video/promo.mjs');
const lines = mv.SCRIPT.filter(s => s.say).map(s => s.say);
check('what Doug asked for is in it: signing up, card, the gate, a party, a photo for the board, news, the calendar, swim, a plan, the family, keyfobs, renewing',
  ['Sign up', 'card', 'gate', 'party', 'photo', 'news', 'calendar', 'swim meets', 'payment plan', 'teen', 'keyfob', 'renewing'].every(w => lines.some(l => l.toLowerCase().includes(w.toLowerCase()))),
  lines.join(' | ').slice(0, 300));
check('every subtitle fits on two lines', lines.every(t => { const c = promo.captionLines(t); return c.length <= 2 && c.every(l => l.length <= 64); }));
check('the made-up club only, never a real one on screen', !/Bishop/.test(src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')));

console.log('CP1 · every step, against the made-up club');
{
  const r = await mv.film({ record: false });
  check('the script runs from signup to the end without a missing button', !r.error, r.error || '');
  check('no page errors along the way', !r.errors?.length, (r.errors || []).join(' | '));
}

console.log('CP3 · on the join form');
{
  const page = read('apply.html');
  check('under "Full app experience", the button and the video', /id="app-video"/.test(page) && /Pwa\.appVideoHtml\(\)/.test(page) && page.indexOf('id="app-video"') < page.indexOf('value="no_app"'));
  const b = await launch(), p = await b.newPage();
  await p.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1');
  await p.setViewport({ width: 390, height: 844 });
  const log = await attach(p, { state: {} });
  await p.goto(FAMILY + '/apply.html', { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise(r => setTimeout(r, 600));
  const before = await p.evaluate(() => { const w = document.querySelector('#app-video .pwa-watch'); return w ? { text: w.textContent, src: w.dataset.src } : null; });
  check('it shows "Watch what the app does (1:55)" with its length', !!before && /Watch what the app does \(\d:\d\d\)/.test(before.text) && before.src === '/videos/what-the-app-does.mp4', JSON.stringify(before));
  await p.evaluate(() => document.querySelector('#app-video .pwa-watch').click());
  await new Promise(r => setTimeout(r, 400));
  const after = await p.evaluate(() => { const v = document.querySelector('#app-video video'); return v ? v.getAttribute('src') : null; });
  check('tapping it plays the video right there', after === '/videos/what-the-app-does.mp4', String(after));
  const still = await p.evaluate(() => document.querySelector('input[name="signup_mode"][value="full_app"]').checked);
  check('Full app experience stays chosen', still);
  check('no page errors', !log.errors.length, log.errors.join(' | '));
  await b.close();
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
