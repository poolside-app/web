#!/usr/bin/env node
// Targeted check for the sponsor pop-up setting (PLAN.md Y). Offline: reads
// the Sponsors page and the pop-up script. Costs nothing.
//
// Usage: node scripts/test_sponsor_popup.mjs
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const between = (s, a, b) => { const i = s.indexOf(a); return i < 0 ? '' : s.slice(i, s.indexOf(b, i + a.length)); };

console.log('Y1 · the sponsor pop-up switch (offline)');
const page = read('club/admin/sponsors.html');
check('one switch that saves the moment it\'s flipped', /type="checkbox" id="popup_on"[^>]*onchange="savePopupConfig\(\)"/.test(page));
check('the how-often choice saves on change too', /id="popup_frequency"[^>]*onchange="savePopupConfig\(\)"/.test(page));
check('no separate "Save popup settings" button', !/Save popup settings/.test(page));
check('a line says what members see', /id="popup-status"/.test(page) && /function paintPopupStatus/.test(page));
const save = between(page, 'async function savePopupConfig', '\n}\n');
check('it saves only the pop-up setting, never a stale copy of everything', /call\(SETTINGS_URL, 'save', \{ value: \{ sponsors_config \} \}\)/.test(save) && !/value = \{\s*\.\.\.LAST_SETTINGS/.test(save), save.slice(0, 200));
const pop = read('js/sponsor-popup.js');
check('the pop-up still shows only when it\'s on, and only if there are sponsors', /if \(!config\.popup_enabled\) return;/.test(pop) && /if \(!sponsors\.length\) return;/.test(pop));

// PLAN.md BJ8: sponsor-popup.js is deferred, so the club's answer can come
// back before it has run (the demo answers in milliseconds; so can a fast
// phone). Then the pages wait for it instead of skipping the pop-up.
for (const f of ['m/index.html', 'club/index.html']) {
  const src = read(f);
  const at = src.indexOf('SponsorPopup.maybeShow');
  const near = src.slice(Math.max(0, at - 400), at + 600);
  check(`${f} waits for the pop-up script when the club's answer comes first`, at > 0 && /document\.readyState === 'loading'/.test(near) && /DOMContentLoaded/.test(near), near.slice(0, 160));
}

console.log('Y2 · Sponsors under Content (offline)');
const sub = read('js/admin-subtabs.js');
const strip = key => sub.slice(sub.indexOf(`${key}: [`), sub.indexOf('],', sub.indexOf(`${key}: [`)));
check('Sponsors is under Content, not Money (Doug, 10/11)', /sponsors\.html/.test(strip('content')) && !/sponsors\.html/.test(strip('money')) && /'sponsors\.html': 'content'/.test(sub));
check('the nav generator agrees', /"sponsors\.html":\s+"content"/.test(read('scripts/rewrite_admin_nav.py')));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
