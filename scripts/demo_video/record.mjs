// =============================================================================
// record.mjs — makes the board demo video (PLAN.md BD)
// =============================================================================
//   node scripts/demo_video/record.mjs [out.mp4]     (about 3 minutes)
// Writes handouts/poolside-board-demo.mp4 by default (handouts/ isn't in git).
// DEMO_SIZE=720 makes the small copy (1280×720, about 21 MB) instead.
// Env: DEMO_WORK (scratch folder, default /tmp/poolside-demo), DEMO_VOICE (a
// Mac voice, default Karen; a Premium voice from System Settings sounds
// better), ONLY=<scene id> (record one scene to check it), DEMO_ENCODER (an
// already-built encode.swift; otherwise it's built here, about a minute).
//
// Each scene's narration is read by the Mac voice and shown as its caption.
// The taps happen while it's read; the scene lasts as long as the longer of
// the two. It stops with an error if anything it taps isn't on the screen.
// Every Supabase call is answered by data.mjs: no real data, no calls.
// =============================================================================

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launch, attach, FAMILY, BOARD, STAGE, WEB } from './harness.mjs';
import { timeSaved } from './data.mjs';

const OUT = process.argv[2] || WEB + 'handouts/poolside-board-demo.mp4';
const WORK = process.env.DEMO_WORK || '/tmp/poolside-demo';
const VOICE = process.env.DEMO_VOICE || 'Karen';   // Doug's pick, 10/19
const ONLY = process.env.ONLY || null;
const ENCODER = process.env.DEMO_ENCODER || buildEncoder();

// Apple's Command Line Tools ship /usr/include/swift twice over (module.modulemap
// and bridging.modulemap), which stops any Swift build. An overlay hides one,
// so nothing on the Mac is changed.
function buildEncoder() {
  const dir = WORK + '-encoder';
  mkdirSync(dir, { recursive: true });
  const bin = dir + '/encode';
  writeFileSync(dir + '/empty.modulemap', '');
  writeFileSync(dir + '/overlay.yaml', JSON.stringify({ version: 0, 'case-sensitive': 'false', roots: [{ type: 'directory',
    name: '/Library/Developer/CommandLineTools/usr/include/swift',
    contents: [{ type: 'file', name: 'module.modulemap', 'external-contents': dir + '/empty.modulemap' }] }] }));
  console.log('Building the encoder…');
  execFileSync('swiftc', ['-O', '-swift-version', '5', '-vfsoverlay', dir + '/overlay.yaml', '-Xcc', '-ivfsoverlay', '-Xcc', dir + '/overlay.yaml',
    new URL('./encode.swift', import.meta.url).pathname, '-o', bin], { stdio: ['ignore', 'ignore', 'inherit'] });
  return bin;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = timeSaved();
const hours = Math.round(ts.minutes / 60);
const dollars = ts.dollars.toLocaleString('en-US');

// ── The story ───────────────────────────────────────────────────────────
// `cap` is on screen; `say` is spoken when it needs different words.
const SCENES = [
  { id: 'title', overlay: 'title',
    cap: "This is Poolside, from the board's side. A family's phone is on the left and a board member's is on the right. Here's what the app does on its own, and what's left for you." },
  { id: 'old', overlay: 'old', step: 0,
    cap: 'Every season, someone built the signup form, typed each family into a spreadsheet, checked Venmo and PayPal line by line, and signed in to the gate computer to turn keyfobs on. Poolside does most of that for you, and makes the rest a tap.',
    say: 'Every season, someone built the signup form, typed each family into a spreadsheet, checked Venmo and PayPal line by line, and signed in to the gate computer to turn key fobs on. Poolside does most of that for you, and makes the rest a tap.' },
  { id: 'card', step: 1, focus: 'family', kicker: 'Paid by card', title: 'Nothing for the board to do',
    cap: "The best case: a returning family renews on their phone. They accept the club's policies, sign, and pay by card. Poolside records the payment, renews them for the season, and clears it off the board's list. Their keyfob is already in Poolside, so there's nothing to turn on. On the board's phone, the numbers just go up. A brand-new family who pays by card is approved the same way, with a welcome email and a text with a link to the app.",
    say: "The best case: a returning family renews on their phone. They accept the club's policies, sign, and pay by card. Poolside records the payment, renews them for the season, and clears it off the board's list. Their key fob is already in Poolside, so there's nothing to turn on. On the board's phone, the numbers just go up. A brand-new family who pays by card is approved the same way, with a welcome email and a text with a link to the app." },
  { id: 'venmo', step: 2, focus: 'both', kicker: 'Paid by Venmo', title: 'Confirm a whole batch at once',
    cap: "Venmo can't tell anyone a payment arrived, so a person still checks. Poolside fills in each family's Venmo with the amount and a short code. The treasurer opens Venmo, ticks the codes they see, and confirms them all at once. New families are approved and welcomed, the same as paying by card." },
  { id: 'fobs', step: 3, focus: 'board', kicker: 'Keyfobs', title: 'One to-do, then one tap',
    cap: "A new family's keyfob is one to-do: hand it over and type the number printed on it. Then Sync keyfobs reads the doors, shows exactly what will change, and sends it. Lost fobs are turned off the same way. No more signing in to the gate computer, and once it's switched on, the sync runs by itself every night.",
    say: "A new family's key fob is one to-do: hand it over and type the number printed on it. Then Sync key fobs reads the doors, shows exactly what will change, and sends it. Lost fobs are turned off the same way. No more signing in to the gate computer, and once it's switched on, the sync runs by itself every night." },
  { id: 'home', step: 4, focus: 'board', kicker: 'Every board member', title: 'A home built from your job',
    cap: "Each board member's home is built from their job. The treasurer sees the money, whoever runs the gate sees keyfobs, and everyone sees what needs them today. Every door is a button, so nobody has to drive over to let someone in.",
    say: "Each board member's home is built from their job. The treasurer sees the money, whoever runs the gate sees key fobs, and everyone sees what needs them today. Every door is a button, so nobody has to drive over to let someone in." },
  { id: 'family', step: 5, focus: 'family', kicker: 'For families', title: 'Parties book themselves',
    cap: "Families open the front gate from the app during member hours. Parties book themselves: an open time is theirs on the spot, paying by card puts it on the calendar, and on the day, their app opens the party door too." },
  { id: 'saved', step: 6, focus: 'board', kicker: 'Insights', title: 'See the time it saves',
    cap: `And Insights keeps count: every signup, payment, keyfob and party Poolside handled, times the minutes it used to take. Here, that's about ${hours} hours, or about $${dollars} if the club had paid someone $20 an hour.`,
    say: `And Insights keeps count: every signup, payment, key fob and party Poolside handled, times the minutes it used to take. Here, that's about ${hours} hours, or about ${dollars} dollars if the club had paid someone 20 dollars an hour.` },
  { id: 'end', overlay: 'end', cap: 'Poolside. Less paperwork for the board, and more time at the pool.' },
];
const STEPS = 7;

// ── The voice ───────────────────────────────────────────────────────────
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK + '/frames', { recursive: true });
mkdirSync(WORK + '/voice', { recursive: true });
for (const s of SCENES) {
  s.audio = `${WORK}/voice/${s.id}.aiff`;
  // 44.1 kHz: some phone players stumble on the voice's own 22 kHz.
  execFileSync('say', ['-v', VOICE, '-r', '168', '--data-format=BEI16@44100', '-o', s.audio, s.say || s.cap]);
  s.secs = Number(String(execFileSync('afinfo', [s.audio])).match(/estimated duration: ([\d.]+)/)[1]);
}

// ── The browser ─────────────────────────────────────────────────────────
const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 4 / 3 });
const state = {};
const log = await attach(page, { state, extraFiles: { '/__stage.html': new URL('./stage.html', import.meta.url).pathname } });
page.on('dialog', d => d.accept());   // the board's "Confirm…?" boxes
await page.goto(STAGE + '/__stage.html', { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);

const frameOf = side => page.frames().find(f => f.name() === side);
const H = {
  state,
  async go(side, path) {
    await frameOf(side).goto((side === 'board' ? BOARD : FAMILY) + path, { waitUntil: 'networkidle0', timeout: 45000 });
    await sleep(500);
  },
  // The first element matching `sel` (and containing `text`), or stop.
  async el(side, sel, text) {
    const f = frameOf(side);
    const deadline = Date.now() + 8000;
    for (;;) {
      const h = await f.evaluateHandle((sel, text) => [...document.querySelectorAll(sel)]
        .find(e => (!text || e.textContent.includes(text)) && e.getClientRects().length) || null, sel, text ?? null);
      if (await h.evaluate(e => !!e)) return h;
      if (Date.now() > deadline) throw new Error(`Not on the ${side} screen: ${sel}${text ? ` "${text}"` : ''}`);
      await sleep(200);
    }
  },
  async show(side, sel, text, block = 'center') {
    const h = await this.el(side, sel, text);
    // 'start' leaves room for the page's sticky header.
    await h.evaluate((e, block) => block === 'start'
      ? window.scrollTo({ top: e.getBoundingClientRect().top + window.scrollY - 72, behavior: 'smooth' })
      : e.scrollIntoView({ behavior: 'smooth', block }), block);
    await sleep(850);
    return h;
  },
  async scroll(side, dy, ms = 1200) {
    await frameOf(side).evaluate(dy => window.scrollBy({ top: dy, behavior: 'smooth' }), dy);
    await sleep(ms);
  },
  async top(side) { await frameOf(side).evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await sleep(800); },
  // Move the dot to it and tap; `click: false` only points.
  async tap(side, sel, text, { click = true, nav = false } = {}) {
    const h = await this.el(side, sel, text);
    const r = await h.evaluate(e => {
      const b = e.getBoundingClientRect();
      if (b.top < 60 || b.bottom > innerHeight - 90) { e.scrollIntoView({ behavior: 'smooth', block: 'center' }); return null; }
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    let at = r;
    if (!at) { await sleep(850); at = await h.evaluate(e => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }); }
    await page.evaluate((side, x, y) => Stage.tapAt(side, x, y, true), side, at.x, at.y);
    if (!click) return;
    if (nav) await Promise.all([frameOf(side).waitForNavigation({ waitUntil: 'networkidle0', timeout: 45000 }), h.evaluate(e => e.click())]);
    else await h.evaluate(e => e.click());
    await sleep(350);
  },
  async type(side, sel, text) {
    await this.tap(side, sel);
    const h = await this.el(side, sel);
    await h.focus();
    // Typed into the phone itself, a letter at a time.
    for (const ch of text) { await h.type(ch); await sleep(90); }
    await sleep(300);
  },
  // A signature, drawn with the mouse across the box.
  async sign(side, sel) {
    const h = await this.show(side, sel);
    const b = await h.evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const o = await page.evaluate(side => { const r = document.getElementById('f-' + side).getBoundingClientRect(); return { x: r.left, y: r.top }; }, side);
    const pts = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      pts.push([b.x + b.w * (0.14 + 0.7 * t), b.y + b.h * (0.58 - 0.22 * Math.sin(t * Math.PI * 3.2) * (1 - t * 0.5) - 0.08 * Math.sin(t * 19))]);
    }
    await page.evaluate((side, x, y) => Stage.tapAt(side, x, y, false), side, pts[0][0], pts[0][1]);
    await page.mouse.move(o.x + pts[0][0], o.y + pts[0][1]);
    await page.mouse.down();
    for (const [x, y] of pts) {
      await page.mouse.move(o.x + x, o.y + y, { steps: 2 });
      await page.evaluate((side, x, y) => { const p = Stage.at(side, x, y), t = document.getElementById('tap'); t.style.transition = 'none'; t.style.left = p.x + 'px'; t.style.top = p.y + 'px'; }, side, x, y);
      await sleep(16);
    }
    await page.mouse.up();
    await page.evaluate(() => { document.getElementById('tap').style.transition = ''; });
    await sleep(400);
  },
  stage: (fn, ...a) => page.evaluate(fn, ...a),
  sleep,
};

// What each scene does on the phones, while its narration plays. `at(p)`
// waits until the voice has read that far (by words) into the scene.
const RUN = {
  async title(h, at) { await at(1); },
  async old(h, at) {
    for (let i = 0; i < 4; i++) { await at([0.22, 0.38, 0.55, 0.78][i]); await h.stage(i => Stage.strike(i), i); }
    await at(0.82); await h.stage(() => Stage.oldNow());
  },
  async card(h, at) {
    await h.tap('family', 'a.hero-renew', null, { nav: true });
    await h.show('family', '[data-policy]');
    await h.tap('family', '[data-policy]');
    await sleep(900);
    await h.tap('family', '#rs-accept');
    await h.sign('family', '#rs-canvas');
    await h.tap('family', 'button', 'Pay $550.00');
    await h.stage(() => { Stage.hideTap(); Stage.cardPage(true); });
    await sleep(1900);
    await h.stage(() => Stage.cardPage(true, true));
    await sleep(1100);
    await h.stage(() => Stage.cardPage(false));
    await sleep(900);
    await at(0.64);
    await h.stage(() => Stage.focus('board'));
    await h.go('board', '/club/admin/');
    await h.tap('board', 'a.hs', 'families paid', { click: false });
    await at(0.8);
    await h.stage(() => { Stage.hideTap(); Stage.focus('both'); });
  },
  async venmo(h, at) {
    await h.go('family', '/apply.html');
    await h.stage(() => Stage.focus('family'));
    await h.type('family', '#family_name', 'Patel');
    await frameOfEval('family', () => {
      const v = document.querySelector('input[name="payment_method"][value="venmo"]'); if (v) v.checked = true;
      const t = document.querySelector('input[name="tier_slug"][value="family"]'); if (t) t.checked = true;
      return submitApplication();
    });
    await sleep(1200);
    await h.tap('family', 'a[href^="https://venmo.com"]', null, { click: false });
    await at(0.42);
    await h.stage(() => { Stage.hideTap(); Stage.focus('board'); });
    await h.go('board', '/club/admin/payments.html');
    await h.show('board', '#venmo-check', null, 'start');
    await h.tap('board', '.venmo-row[data-i="0"]');
    await h.tap('board', '.venmo-row[data-i="1"]');
    await at(0.7);
    await h.tap('board', '#venmo-confirm-btn');
    await sleep(1500);
    await h.stage(() => Stage.hideTap());
  },
  async fobs(h, at) {
    await Promise.all([h.go('family', '/m/'), h.go('board', '/club/admin/keyfobs.html')]);
    await h.show('board', '#issue-list', null, 'start');
    await h.type('board', '#n-fob-larsen', '4521');
    await h.tap('board', 'button', 'Issue');
    await sleep(800);
    await at(0.3);
    await h.show('board', '#sync-host', null, 'center');
    await h.tap('board', 'button', 'Sync keyfobs now');
    await sleep(2000);
    h.state.sync = 'checked';
    await frameOfEval('board', () => loadSync());
    await sleep(1200);
    await at(0.5);
    await h.tap('board', 'button', 'Send to the doors');
    await sleep(1800);
    h.state.sync = 'sent';
    await frameOfEval('board', () => loadSync());
    await sleep(800);
    await h.stage(() => Stage.hideTap());
  },
  async home(h, at) {
    await h.go('board', '/club/admin/');
    await at(0.2);
    await h.scroll('board', 260);
    await at(0.5);
    await h.show('board', '#gate-card', null, 'start');
    await at(0.72);
    await h.tap('board', '[data-door="snack"]');
    await sleep(1200);
    await h.stage(() => Stage.hideTap());
    await h.scroll('board', 360);
  },
  async family(h, at) {
    h.state.partyToday = true;
    await h.go('family', '/m/');
    await h.show('family', '#gate-card', null, 'start');
    await h.tap('family', '#gate-unlock-btn');
    await sleep(1800);
    await h.stage(() => Stage.hideTap());
    await at(0.4);
    await h.show('family', '#parties-card', null, 'center');
    await at(0.85);
    await h.show('family', '#gate-card', null, 'start');
  },
  async saved(h, at) {
    await h.go('board', '/club/admin/time-saved.html');
    await h.show('board', 'h1', 'Time saved', 'start');
    await at(0.55);
    for (let i = 0; i < 5; i++) await h.scroll('board', 170, 900);
  },
  async end(h, at) { await at(1); },
};
async function frameOfEval(side, fn) { return frameOf(side).evaluate(fn); }

// ── Record ──────────────────────────────────────────────────────────────
await H.go('family', '/m/');
await H.go('board', '/club/admin/');
await page.evaluate(n => Stage.steps(n), STEPS);
const scenes = ONLY ? SCENES.filter(s => s.id === ONLY) : SCENES;
if (!scenes[0].overlay) await page.evaluate(() => {});
else await page.evaluate(id => Stage.overlay(id, true), scenes[0].overlay);
await sleep(800);

const cdp = await page.createCDPSession();
const frames = [], voice = [];
const T0 = Date.now() / 1000;
cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
  const f = `${WORK}/frames/${String(frames.length).padStart(5, '0')}.jpg`;
  writeFileSync(f, Buffer.from(data, 'base64'));
  // Stamped on arrival: Chrome's own frame clock drifts from real time,
  // and the voice is placed by real time.
  frames.push({ f, t: Math.max(0, Date.now() / 1000 - T0) });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
await page.evaluate(() => { document.body.style.outline = '0 solid transparent'; });
await sleep(600);

let prevOverlay = scenes[0].overlay || null;
for (const s of scenes) {
  // Overlays fade between each other; scenes swap their captions.
  if (s.overlay && s.overlay !== prevOverlay) {
    await page.evaluate((on, off) => { Stage.overlay(on, true); if (off) setTimeout(() => Stage.overlay(off, false), 700); }, s.overlay, prevOverlay);
    await sleep(900);
  } else if (!s.overlay && prevOverlay) {
    await page.evaluate((sc) => Stage.scene(sc), { kicker: s.kicker, title: s.title, cap: s.cap, focus: s.focus, step: s.step });
    await page.evaluate(off => Stage.overlay(off, false), prevOverlay);
    await sleep(900);
  } else if (!s.overlay) {
    await page.evaluate((sc) => Stage.scene(sc), { kicker: s.kicker, title: s.title, cap: s.cap, focus: s.focus, step: s.step });
    await sleep(500);
  }
  if (s.overlay && s.step !== undefined) await page.evaluate(n => Stage.scene({ step: n, focus: 'both' }), s.step);
  prevOverlay = s.overlay || null;

  const start = Date.now();
  voice.push({ f: s.audio, t: start / 1000 - T0 });
  const at = async p => { const due = start + p * s.secs * 1000; if (Date.now() < due) await sleep(due - Date.now()); };
  await Promise.all([RUN[s.id](H, at), sleep(s.secs * 1000)]);
  await sleep(700);
  console.log(`${s.id}: ${((Date.now() - start) / 1000).toFixed(1)} s (voice ${s.secs.toFixed(1)} s)`);
}
await sleep(1200);
await cdp.send('Page.stopScreencast');
const end = Date.now() / 1000 - T0;
await browser.close();

if (log.unknown.length) console.log('Calls the demo did not answer:', [...new Set(log.unknown)].join(', '));
if (log.errors.length) console.log('Page errors:', [...new Set(log.errors)].join(' | '));
if (log.external.size) console.log('Blocked:', [...log.external].join(', '));
writeFileSync(`${WORK}/frames.json`, JSON.stringify({ end, frames }));
writeFileSync(`${WORK}/voice.json`, JSON.stringify(voice));
console.log(`${frames.length} frames over ${end.toFixed(1)} s`);
console.log(String(execFileSync(ENCODER, [`${WORK}/frames.json`, `${WORK}/voice.json`, OUT])).trim());
