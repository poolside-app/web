// =============================================================================
// tour.mjs — the step-by-step tour video (PLAN.md BD2)
// =============================================================================
//   node scripts/demo_video/tour.mjs [out.mp4]          (about 8 minutes to make)
// Writes handouts/poolside-tour.mp4 and its captions, handouts/poolside-tour.srt.
// Env: DEMO_VOICE (default "system": the Mac's system voice, Doug's Siri Voice
// 5; or a voice name), DEMO_RATE (words a minute for `say`, default 150),
// DEMO_SIZE=720 (the small copy), ONLY=<chapter number, or intro/recap>,
// DEMO_WORK (scratch, default /tmp/poolside-tour), DEMO_ENCODER (built
// encode.swift; otherwise built here).
//
// How it's made, from the tutorial research in PLAN.md BD2: short chapters,
// each opened by a card; one short line per step, spoken while the step
// happens, with a pause between sentences; a camera that zooms into what's
// in use, a ring on what matters; short step titles on screen (the narration
// goes in the captions file). Every Supabase call is answered by data.mjs.
// It stops with an error if anything it taps isn't on the screen.
// =============================================================================

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launch, attach, FAMILY, BOARD, ALEX, SOFIA, STAGE, WEB } from './harness.mjs';
import { driver } from './drive.mjs';
import { timeSaved } from './data.mjs';

const OUT = process.argv[2] || WEB + 'handouts/poolside-tour.mp4';
const WORK = process.env.DEMO_WORK || '/tmp/poolside-tour';
const VOICE = process.env.DEMO_VOICE || 'system';
const RATE = String(process.env.DEMO_RATE || 150);
const ONLY = process.env.ONLY ?? null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hours = Math.round(timeSaved().minutes / 60);

const CHAPTERS = ['Signing up', 'Paying by card', 'Paying by Venmo', 'A payment plan', 'The rest of the family', 'What the board gets'];
const LINK = '<u>maplegrove.poolsideapp.com/m/verify…</u>';

// ── The story: a chapter card, then its steps. `say` is spoken and goes in
// the captions; `title` is the short line on screen. ─────────────────────
const SCRIPT = [
  { id: 'intro', overlay: 'intro', say: "Here's how Poolside works, step by step. You'll see a family sign up, and pay three different ways. Then the rest of their family gets the app, and you'll see what the board gets." },

  { card: 0, sub: 'A family joins from their phone, in about five minutes.', say: 'Chapter one. Signing up.' },
  { ch: 0, title: 'The club’s signup link', say: "This is the club's signup link, open on Jamie's phone.",
    async run(h, at) { await h.zoomOn('left', '#title', null, 1.3); } },
  { ch: 0, title: 'The family’s details', say: "First, the family's details. Name, address, phone, and email.",
    async run(h) {
      await h.type('left', '#your_name', 'Jamie Rivera', { zoom: 1.55 });
      // The rest fills in quickly, field by field, as a phone's autofill would.
      for (const [sel, v] of [['#address', '14 Willow Lane'], ['#city', 'Maple Grove'], ['#zip', '94500'], ['#primary_phone', '(555) 555-0101'],
        ['#primary_email', 'jamie@example.com'], ['#emergency_name', 'Pat Rivera'], ['#emergency_phone', '(555) 555-0188']]) {
        await h.show('left', sel, null, 'center', 260); await h.set('left', sel, v);
      }
      await h.unzoom();
      await h.tap('left', '#next-btn');
    } },
  { ch: 0, title: 'Everyone on the membership', say: 'Next, everyone on the membership. Jamie adds Alex, and their kids, Sofia and Leo, with a birthday for each.',
    async run(h) {
      await h.select('left', '#ccount', '2');
      await h.set('left', '[data-adult="0"][data-field="dob"]', '1986-05-14');
      await h.type('left', '[data-adult="1"][data-field="name"]', 'Alex Rivera', { zoom: 1.45, fast: true });
      await h.set('left', '[data-adult="1"][data-field="dob"]', '1987-09-02');
      await h.set('left', '[data-adult="1"][data-field="phone"]', '(555) 555-0102');
      await h.type('left', '[data-child="0"][data-field="name"]', 'Sofia Rivera', { zoom: 1.45, fast: true });
      await h.set('left', '[data-child="0"][data-field="dob"]', '2012-04-03');
      await h.set('left', '[data-child="0"][data-field="phone"]', '(555) 555-0103');
      await h.type('left', '[data-child="1"][data-field="name"]', 'Leo Rivera', { zoom: 1.45, fast: true });
      await h.set('left', '[data-child="1"][data-field="dob"]', '2018-07-21');
    } },
  { ch: 0, title: 'Text them the app', say: "Alex and Sofia have their own phones, so each one gets a box. Text them a link to get the app. It's already ticked.",
    async run(h, at) {
      await h.zoomOn('left', '[data-invite-row="adult-1"]', null, 1.5);
      await h.ring('left', '[data-invite-row="adult-1"]');
      await at(0.55);
      await h.zoomOn('left', '[data-invite-row="child-0"]', null, 1.5);
      await h.ring('left', '[data-invite-row="child-0"]');
      await at(0.95); await h.unring(); await h.unzoom();
    } },
  { ch: 0, title: 'Policies and signatures', say: 'Then the club’s policies. Jamie opens each one, and taps I accept. Each adult signs with a finger, and a parent signs for the kids.',
    async run(h, at) {
      await h.tap('left', '#next-btn');
      await h.tap('left', '#btn-pool-rules');
      await sleep(900);
      await h.tap('left', '#policy-accept-btn');
      await at(0.45);
      await h.sign('left', '#sig-adult-0'); await h.sign('left', '#sig-adult-1'); await h.sign('left', '#sig-guardian');
    } },
  { ch: 0, title: 'Membership level', say: 'Last, the membership level. New families get their first keyfob free. Then, how to pay.',
    async run(h, at) {
      await h.tap('left', '#next-btn');
      await h.tap('left', 'input[name="tier_slug"][value="family"]');
      await at(0.4);
      await h.zoomOn('left', '#fob-free-opt', null, 1.4); await h.ring('left', '#fob-free-opt');
      await at(0.85); await h.unring(); await h.unzoom();
    } },

  { card: 1, sub: 'The best case: nothing for the board to do.', say: 'Chapter two. Paying by card.' },
  { ch: 1, title: 'Card, then Submit', say: "Jamie picks credit card, and taps Submit. They pay on Stripe's secure card page.",
    async run(h, at) {
      await h.tap('left', '#pay-opt-stripe');
      await h.ring('left', '#pay-opt-stripe');
      await at(0.35); await h.unring();
      await h.tap('left', '#next-btn');
      await h.stage(() => { Stage.hideTap(); Stage.standin(true, { icon: '💳', title: 'The card page', text: "Families pay on Stripe's secure page. It's skipped in this demo.", ok: '✓ Paid' }); });
      await sleep(2000); await h.stage(() => Stage.standin(true, { done: true })); await sleep(1100);
      await h.stage(() => Stage.standin(false));
    } },
  { ch: 1, title: 'Paid, approved, and in', say: "That's it. They're paid and approved, and nobody on the board did a thing. There's no to-do. The family just shows up as paid.",
    async run(h, at) {
      await h.layout('both');
      await h.go('board', '/club/admin/');
      await at(0.5);
      await h.ring('board', 'a.hs', 'families paid');
      await at(0.95); await h.unring();
    } },
  { ch: 1, title: 'A welcome text', say: 'Jamie gets a welcome text, and an email. One tap signs them in. No password to remember.',
    async run(h, at) {
      await h.layout('left');
      await h.bubble('left', { kind: 'text', body: `Hi Jamie, you're all set - your membership at Maple Grove Swim Club is approved and paid. Tap to sign in: ${LINK}` });
      await at(0.55);
      await h.tapBubble('left');
      await h.go('left', '/m/verify.html#token=demo-link', { origin: FAMILY, waitFor: '#gate-card' });
      await h.stage(() => Stage.clearBubbles('left'));
    } },
  { ch: 1, title: 'Their club, in the app', say: 'This is their club in the app. Today at the pool, a button to open the gate, the news, and the calendar.',
    async run(h, at) {
      await h.ring('left', '#gate-unlock-btn');
      await at(0.45); await h.unring();
      await at(0.55); await h.show('left', 'h2', 'Coming up', 'start', 1300);
    } },

  { card: 2, sub: 'A code in every Venmo note, and one batch for the treasurer.', say: 'Chapter three. Paying by Venmo.',
    async run(h) { await h.label("The Patels' phone"); await h.prefill('left', { name: 'Priya Patel', family: 'Patel', phone: '5555550144', email: 'priya@example.com' }); } },
  { ch: 2, title: 'Venmo, then Submit', say: 'Now a family that pays by Venmo. At the last step, the Patels pick Venmo, and tap Submit.',
    async run(h, at) {
      await h.tap('left', 'input[name="payment_method"][value="venmo"]');
      await at(0.6);
      await h.tap('left', '#next-btn');
    } },
  { ch: 2, title: 'Amount and code, filled in', say: 'Poolside gives them a Venmo button, with the amount and a short code already in the note.',
    async run(h, at) {
      await h.zoomOn('left', 'a[href^="https://venmo.com"]', null, 1.5);
      await at(0.5); await h.ring('left', '#form b', '#K7Q2');
      await at(0.9); await h.unring();
      await h.tap('left', 'a[href^="https://venmo.com"]', null, { click: false });
      await h.unzoom();
      await h.stage(() => { Stage.hideTap(); Stage.standin(true, { icon: '💸', title: 'Venmo', text: 'Venmo opens with $550.00 and the note "Maple Grove 2027 dues - Patel - #K7Q2" filled in. It\'s skipped in this demo.', ok: '✓ Sent' }); });
      await sleep(1700); await h.stage(() => Stage.standin(true, { done: true })); await sleep(900); await h.stage(() => Stage.standin(false));
    } },
  { ch: 2, title: 'A pop-up for the treasurer', say: 'The treasurer gets a pop-up on their phone.',
    async run(h) {
      await h.layout('both', 'left');
      await h.bubble('board', { kind: 'pop', title: '💵 New Venmo application — verify + approve', body: 'Priya Patel applied via Venmo. Open Venmo, confirm the payment, then tap "Approve & verify" — one click handles both.' });
    } },
  { ch: 2, title: 'Confirm them all at once', say: 'Under Payments, every Venmo waiting is listed with its code. The treasurer opens Venmo, ticks the codes they see, and confirms them all at once.',
    async run(h, at) {
      await h.stage(() => Stage.clearBubbles('board'));
      await h.go('board', '/club/admin/payments.html');
      await h.show('board', '#venmo-check', null, 'start');
      await h.zoomOn('board', '#venmo-check', null, 1.25);
      await at(0.45);
      await h.tap('board', '.venmo-row[data-i="0"]'); await h.tap('board', '.venmo-row[data-i="1"]');
      await at(0.8);
      await h.tap('board', '#venmo-confirm-btn');
      await sleep(600); await h.stage(() => Stage.hideTap());
      await sleep(600); await h.unzoom();
    } },
  { ch: 2, title: 'Approved and welcomed', say: 'The Patels are approved, and get the same welcome text as a card payment.',
    async run(h) {
      await h.layout('both', 'board');
      await h.bubble('left', { kind: 'text', body: `Hi Priya, you're all set - your membership at Maple Grove Swim Club is approved and paid. Tap to sign in: ${LINK}` });
    } },

  { card: 3, sub: 'Pay part now and the rest later, with no surprise charges.', say: 'Chapter four. A payment plan.',
    async run(h) { await h.stage(() => { Stage.clearBubbles('left'); Stage.clearBubbles('board'); }); await h.layout('left'); await h.label("The Okafors' phone");
      await h.prefill('left', { name: 'Ngozi Okafor', family: 'Okafor', phone: '5555550166', email: 'ngozi@example.com' }); } },
  { ch: 3, title: 'Pay part today', say: 'A family can also spread the dues out. The Okafors pick Payment plan, choose what to pay today, and when to be paid off.',
    async run(h, at) {
      await h.tap('left', '#pay-opt-stripe-plan');
      await sleep(900);
      await h.zoomOn('left', '#plan-picker', null, 1.3);
      await h.type('left', '#pp-today', '150', { clear: true });
      await at(0.75);
      await h.select('left', '#pp-month', '2027-08');
    } },
  { ch: 3, title: 'Every date, up front', say: 'They see every date and amount before they agree. Their gate access starts once half is paid.',
    async run(h, at) {
      await h.ring('left', '#pp-result table');
      await at(0.95); await h.unring(); await h.unzoom();
    } },
  { ch: 3, title: 'Today’s part, by card', say: "They pay today's part on the card page, and they're in.",
    async run(h) {
      await h.tap('left', '#next-btn');
      await h.stage(() => { Stage.hideTap(); Stage.standin(true, { icon: '💳', title: 'The card page', text: "Stripe keeps the card for the plan and takes today's $154.65. It's skipped in this demo.", ok: '✓ Card saved' }); });
      await sleep(1900); await h.stage(() => Stage.standin(true, { done: true })); await sleep(900); await h.stage(() => Stage.standin(false));
    } },
  { ch: 3, title: 'Nothing charged without a tick', say: 'Three days before payments are due, the treasurer gets a pop-up. Nothing is charged until a board member ticks it.',
    async run(h, at) {
      await h.layout('board');
      await h.go('board', '/club/admin/');
      await h.bubble('board', { kind: 'pop', title: '💳 Plan payments to approve', body: 'Approve 3 plan payments due Jul 1: $564.28. Nothing is charged until you do.' });
      await at(0.45);
      await h.stage(() => Stage.clearBubbles('board'));
      await h.go('board', '/club/admin/upcoming.html');
      for (const id of ['up-okafor', 'up-nguyen', 'up-walsh']) await h.tap('board', `input[onchange*="${id}"]`);
      await h.tap('board', '#bar-btn');
      await sleep(1000);
    } },

  { card: 4, sub: 'Everyone in the family on the app, with a text.', say: 'Chapter five. The rest of the family.',
    async run(h) { await h.label("Alex's phone"); await h.layout('left'); await h.go('left', '/m/login.html', { origin: ALEX }); } },
  { ch: 4, title: 'Alex gets a text', say: 'Remember those ticked boxes? When the Riveras were approved, Alex got this text.',
    async run(h) {
      await h.bubble('left', { kind: 'text', body: `Hi Alex, Jamie added you to the Maple Grove Swim Club app. Tap to sign in, then add it to your Home Screen: ${LINK}` });
    } },
  { ch: 4, title: 'One tap, and in', say: "One tap, and Alex is signed in to the family's app.",
    async run(h) {
      await h.tapBubble('left');
      await h.go('left', '/m/verify.html#token=alex-link', { origin: ALEX, waitFor: '#gate-card' });
      await h.stage(() => Stage.clearBubbles('left'));
    } },
  { ch: 4, title: 'Sign in with a code', say: 'Anyone in the family with a phone number on file can sign in on any phone. Sofia types her number.',
    async run(h) {
      await h.label("Sofia's phone");
      await h.go('left', '/m/login.html', { origin: SOFIA });
      await h.type('left', '#email', '5555550103', { zoom: 1.45 });
      await h.unzoom();
      await h.tap('left', '#submit');
    } },
  { ch: 4, title: 'The code comes by text', say: "The code comes by text. She types it, and she's in. Teens thirteen and up can open the gate, too.",
    async run(h, at) {
      await h.bubble('left', { kind: 'text', body: '482913 is your Maple Grove Swim Club MEMBER sign-in code. Enter it in the app.<br><br>Or tap: <u>maplegrove.poolsideapp.com/m/…</u><br>(Expires in 15 minutes.)' });
      await at(0.3);
      await h.type('left', '#code', '482913', { zoom: 1.45 });   // signs in by itself at six digits
      await h.stage(() => { Stage.clearBubbles('left'); Stage.hideTap(); });
      await h.unzoom();
      await h.el('left', '#gate-card');
    } },

  { card: 5, sub: 'Pop-ups for what needs you, and the rest runs itself.', say: 'Chapter six. What the board gets.',
    async run(h) { await h.layout('board'); await h.go('board', '/club/admin/'); } },
  { ch: 5, title: 'Pop-ups for what needs you', say: "The board hears about what needs them, as pop-ups. A Venmo to check, plan payments to approve, a keyfob to hand out, and a member's question.",
    async run(h, at) {
      const pops = [
        { title: '💵 New Venmo application — verify + approve', body: 'Priya Patel applied via Venmo. Open Venmo, confirm the payment, then tap "Approve & verify".' },
        { title: '💳 Plan payments to approve', body: 'Approve 3 plan payments due Jul 1: $564.28. Nothing is charged until you do.' },
        { title: '🔑 Keyfobs to issue', body: 'The Larsen Family need a keyfob.' },
        { title: 'Guests question from Mia Nguyen', body: 'Can my nanny bring the kids on weekdays?' },
      ];
      for (let i = 0; i < pops.length; i++) { await at(0.3 + i * 0.16); await h.bubble('board', { kind: 'pop', ...pops[i] }); }
    } },
  { ch: 5, title: 'A home built from your job', say: "Each board member's home shows their own job. Their to-dos, the numbers, and a button for every gate door.",
    async run(h, at) {
      await h.stage(() => Stage.clearBubbles('board'));
      await sleep(600);
      await h.ring('board', '.hero-stats');
      await at(0.45); await h.unring();
      await h.show('board', '#gate-card', null, 'start'); await h.ring('board', '#gate-card');
      await at(0.95); await h.unring();
    } },
  { ch: 5, title: 'Keyfobs follow payment', say: 'Keyfobs take care of themselves. Every night, a paid family’s fob goes on. When the season closes, member fobs go off, and board fobs stay on.',
    async run(h, at) {
      h.state.nightly = true;
      await h.go('board', '/club/admin/keyfobs.html');
      await h.show('board', '#sync-host', null, 'center');
      await h.zoomOn('board', '#sync-host', null, 1.35); await h.ring('board', '#sync-host .card');
      await at(0.95); await h.unring(); await h.unzoom();
    } },
  { ch: 5, title: 'The time it saves', say: `And Insights adds up the time Poolside saves the board. Here, about ${hours} hours.`,
    async run(h, at) {
      await h.go('board', '/club/admin/time-saved.html');
      await h.show('board', 'h1', 'Time saved', 'start');
      await h.zoomOn('board', '#ts-hero', null, 1.3); await h.ring('board', '#ts-hero');
      await at(0.95); await h.unring(); await h.unzoom();
    } },

  { id: 'recap', overlay: 'recap', say: "So. Families do it themselves. Card payments need nothing from the board. Venmo is one batch. Plan payments are one tick. And keyfobs follow who's paid.",
    async run(h, at) { for (let i = 0; i < 5; i++) { await at([0.12, 0.3, 0.48, 0.62, 0.8][i]); await h.stage(i => Stage.recapShow(i), i); } } },
  { id: 'end', overlay: 'end', say: 'Poolside. Thanks for watching.' },
];
const RECAP = [
  'Families sign up and pay by card, Venmo, or a payment plan',
  'Card payments need nothing from the board',
  'Venmo: the code is in the note, and you confirm a batch at once',
  'Plan payments wait for a board member’s tick',
  'Keyfobs go on when paid, and off when the season closes',
];

// ── The voice: one file per line, a pause after each sentence ────────────
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK + '/frames', { recursive: true });
mkdirSync(WORK + '/voice', { recursive: true });
const pick = SCRIPT.filter(s => ONLY == null || s.id === ONLY || String(s.card ?? s.ch) === String(ONLY));
pick.forEach((s, i) => {
  s.audio = `${WORK}/voice/${String(i).padStart(2, '0')}.aiff`;
  const spoken = s.say.replace(/’/g, "'").replace(/([.?!])\s+/g, '$1 [[slnc 420]] ');
  execFileSync('say', [...(VOICE === 'system' ? [] : ['-v', VOICE]), '-r', RATE, '--data-format=BEI16@44100', '-o', s.audio, spoken]);
  s.secs = Number(String(execFileSync('afinfo', [s.audio])).match(/estimated duration: ([\d.]+)/)[1]);
});

// ── The browser ─────────────────────────────────────────────────────────
const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 4 / 3 });
const state = { riveraPaid: false };
const log = await attach(page, { state, extraFiles: { '/__tour.html': new URL('./stage2.html', import.meta.url).pathname } });
page.on('dialog', d => d.accept());
await page.goto(STAGE + '/__tour.html', { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);

const H = driver(page, { state, origins: { left: FAMILY, board: BOARD } });

// ── Record ──────────────────────────────────────────────────────────────
await page.evaluate((c, r) => { Stage.chapters(c); Stage.recap(r); }, CHAPTERS, RECAP);
await H.go('left', '/apply.html');
await H.go('board', '/club/admin/');
await page.evaluate(() => Stage.layout('left'));
// One chapter on its own (ONLY): set up what the chapters before it left.
if (String(ONLY) === '1') await H.prefill('left', { name: 'Jamie Rivera', family: 'Rivera', phone: '5555550101', email: 'jamie@example.com' });
if (ONLY != null && /^\d+$/.test(String(ONLY)) && Number(ONLY) >= 2) state.riveraPaid = true;
if (pick[0].overlay) await page.evaluate(id => Stage.overlay(id, true), pick[0].overlay);
await sleep(800);

const cdp = await page.createCDPSession();
const frames = [], voice = [], cues = [];
const T0 = Date.now() / 1000;
cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
  const f = `${WORK}/frames/${String(frames.length).padStart(5, '0')}.jpg`;
  writeFileSync(f, Buffer.from(data, 'base64'));
  frames.push({ f, t: Math.max(0, Date.now() / 1000 - T0) });   // stamped on arrival: Chrome's frame clock drifts
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
await page.evaluate(() => { document.body.style.outline = '0 solid transparent'; });
await sleep(500);

let overlayOn = pick[0].overlay || null;
for (const s of pick) {
  // What's on screen for this line.
  if (s.overlay) {
    if (s.overlay !== overlayOn) { await page.evaluate((on, off) => { Stage.overlay(on, true); if (off) setTimeout(() => Stage.overlay(off, false), 700); }, s.overlay, overlayOn); await sleep(900); }
    overlayOn = s.overlay;
  } else if (s.card !== undefined) {
    await page.evaluate((n, t, sub, off) => { Stage.chapterCard(n, t, sub); Stage.overlay('chapter', true); if (off && off !== 'chapter') setTimeout(() => Stage.overlay(off, false), 700); Stage.chapter(n - 1); }, s.card + 1, CHAPTERS[s.card], s.sub, overlayOn);
    overlayOn = 'chapter';
    await sleep(800);
  } else {
    await page.evaluate(n => Stage.chapter(n), s.ch);
    const swap = page.evaluate((k, t) => Stage.step(k, t), `Chapter ${s.ch + 1} · ${CHAPTERS[s.ch]}`, s.title);
    if (overlayOn) { await page.evaluate(off => Stage.overlay(off, false), overlayOn); overlayOn = null; await sleep(800); }
    await swap; await sleep(250);
  }
  const start = Date.now();
  voice.push({ f: s.audio, t: start / 1000 - T0 });
  cues.push({ start: start / 1000 - T0, end: start / 1000 - T0 + s.secs, text: s.say });
  const at = async p => { const due = start + p * s.secs * 1000; if (Date.now() < due) await sleep(due - Date.now()); };
  // A chapter card's own work (setting up the next screens) happens behind it.
  await Promise.all([s.run ? s.run(H, at) : null, sleep(s.secs * 1000)]);
  await sleep(s.card !== undefined ? 400 : 750);
  console.log(`${s.id ?? (s.card !== undefined ? 'card ' + (s.card + 1) : s.title)}: ${((Date.now() - start) / 1000).toFixed(1)} s (voice ${s.secs.toFixed(1)} s)`);
}
await sleep(1200);
await cdp.send('Page.stopScreencast');
const end = Date.now() / 1000 - T0;
await browser.close();

if (log.unknown.length) console.log('Calls the demo did not answer:', [...new Set(log.unknown)].join(', '));
if (log.errors.length) console.log('Page errors:', [...new Set(log.errors)].join(' | '));
if (log.external.size) console.log('Blocked:', [...log.external].join(', '));

// ── Captions (.srt): each line split into readable pieces, timed by words ──
const ts = t => { const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
const pieces = text => { const out = []; for (const sent of text.match(/[^.?!]+[.?!]*/g) ?? [text]) {
  let rest = sent.trim(); while (rest.length > 84) { const cut = rest.lastIndexOf(',', 84) > 30 ? rest.lastIndexOf(',', 84) + 1 : rest.lastIndexOf(' ', 84); out.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim(); }
  if (rest) out.push(rest); } return out; };
let n = 0, srt = '';
for (const c of cues) {
  const parts = pieces(c.text), words = parts.map(p => p.split(/\s+/).length), total = words.reduce((a, b) => a + b, 0);
  let t = c.start;
  parts.forEach((p, i) => { const d = (c.end - c.start) * words[i] / total; srt += `${++n}\n${ts(t)} --> ${ts(t + d)}\n${p}\n\n`; t += d; });
}
const srtPath = OUT.replace(/\.mp4$/, '.srt');
writeFileSync(srtPath, srt);

writeFileSync(`${WORK}/frames.json`, JSON.stringify({ end, frames }));
writeFileSync(`${WORK}/voice.json`, JSON.stringify(voice));
console.log(`${frames.length} frames over ${end.toFixed(1)} s; captions ${srtPath}`);

const ENCODER = process.env.DEMO_ENCODER || (() => {
  // Apple's Command Line Tools ship /usr/include/swift twice over; an overlay hides one.
  const dir = WORK + '-encoder', bin = dir + '/encode';
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + '/empty.modulemap', '');
  writeFileSync(dir + '/overlay.yaml', JSON.stringify({ version: 0, 'case-sensitive': 'false', roots: [{ type: 'directory', name: '/Library/Developer/CommandLineTools/usr/include/swift',
    contents: [{ type: 'file', name: 'module.modulemap', 'external-contents': dir + '/empty.modulemap' }] }] }));
  execFileSync('swiftc', ['-O', '-swift-version', '5', '-vfsoverlay', dir + '/overlay.yaml', '-Xcc', '-ivfsoverlay', '-Xcc', dir + '/overlay.yaml',
    new URL('./encode.swift', import.meta.url).pathname, '-o', bin], { stdio: ['ignore', 'ignore', 'inherit'] });
  return bin;
})();
console.log(String(execFileSync(ENCODER, [`${WORK}/frames.json`, `${WORK}/voice.json`, OUT])).trim());
