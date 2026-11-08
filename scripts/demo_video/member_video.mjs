// =============================================================================
// member_video.mjs — "What the app does", for families choosing on the join form (PLAN.md CP)
// =============================================================================
//   node scripts/demo_video/member_video.mjs            (about 4 minutes to make)
// Writes handouts/poolside-member-app.mp4 (1920×1080), -small.mp4 (1280×720)
// and the subtitles (.srt), and videos/what-the-app-does.mp4, the copy the
// join form plays next to "Full app experience".
// Env: as promo.mjs (DEMO_VOICE, DEMO_RATE, DEMO_MUSIC, DEMO_WORK, DEMO_ENCODER,
// DEMO_DEBUG). DEMO_DRY=1 runs every step against the made-up club without
// recording or encoding (the check test_demo_video makes).
//
// Doug 11/8: "a video highlighting the benefits of the app… the party booking
// party specifically, unlock by phone, communications features, chat
// feature. See an issue take a photo. Ease of signing up… no wait time if you
// pay by card… unlock is already loaded on phone. Full calendar which will
// have swim meet and practice schedules", "Same type of video like you did
// tutorials. Just don't click through as fast". About 90 seconds, the made-up
// club, and also: pay over time, the whole family on the app, renewing in one
// tap, keyfobs in the app.
//
// Made like the 90-second video and the add-the-app tutorials (promo.mjs,
// homescreen.mjs): the real member pages in a phone beside a big title for
// each part, Ava's voice, subtitles, the music under her. Slower than those:
// she speaks at 150 words a minute, typing is at a reading pace and each
// screen holds a beat after she finishes. The swim team's practices and meets
// come in the way Bishop's will, from the team's own calendar link.
// =============================================================================

import { mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launch, attach, FAMILY, STAGE, WEB } from './harness.mjs';
import { driver } from './drive.mjs';
import { spoken, captionLines, musicCurve, loudness } from './promo.mjs';
import { respond } from './data.mjs';
import { siteRespond } from './site_data.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const both = (...fns) => Promise.all(fns.map(f => f()));
const LINK = '<u>maplegrove.poolsideapp.com/m/verify…</u>';
// Where the labels pop in beside the phone (stage px), top to bottom.
const SPOT = [{ x: 1108, y: 150 }, { x: 1130, y: 300 }, { x: 1108, y: 450 }];
const chip = (h, icon, text, spot) => h.stage(c => Stage.chip(c), { icon, text, ...(typeof spot === 'number' ? SPOT[spot] : spot) });
const chipsOut = h => h.stage(() => Stage.chipsOut());
const hideTap = h => h.stage(() => Stage.hideTap());
// The signup's Next, without the tap dot (the page changing says enough).
const next = async h => { await h.frameOf('left').evaluate(() => document.getElementById('next-btn').click()); await sleep(500); };
// A tab in the bottom bar (fixed, so nothing to scroll to).
const tab = (h, id) => h.tap('left', `#mtabs [data-tab="${id}"]`, null, { scroll: false, after: 700 });

const DETAILS = [['#address', '14 Willow Lane'], ['#city', 'Maple Grove'], ['#zip', '94500'], ['#primary_phone', '(555) 555-0101'],
  ['#primary_email', 'jamie@example.com'], ['#emergency_name', 'Pat Rivera'], ['#emergency_phone', '(555) 555-0188']];
const PEOPLE = [['[data-adult="0"][data-field="dob"]', '1986-05-14'], ['[data-adult="1"][data-field="name"]', 'Alex Rivera'],
  ['[data-adult="1"][data-field="dob"]', '1987-09-02'], ['[data-adult="1"][data-field="phone"]', '(555) 555-0102'],
  ['[data-child="0"][data-field="name"]', 'Sofia Rivera'], ['[data-child="0"][data-field="dob"]', '2012-04-03'],
  ['[data-child="0"][data-field="phone"]', '(555) 555-0103'], ['[data-child="1"][data-field="name"]', 'Leo Rivera'],
  ['[data-child="1"][data-field="dob"]', '2018-07-21']];

// ── The swim team's calendar link, synced in (Doug: "Swim team's calendar link") ──
const PT = (d, hm) => `2027-06-${String(d).padStart(2, '0')}T${hm}:00-07:00`;
function swimFeed() {
  const events = [];
  for (const d of [21, 22, 23, 24, 28, 29, 30]) {
    events.push({ uid: `practice-${d}`, summary: 'Swim team practice', location: 'Lanes 1–4', starts_at: new Date(PT(d, '08:00')).toISOString(), ends_at: new Date(PT(d, '09:30')).toISOString(), all_day: false });
  }
  events.push({ uid: 'meet-20', summary: 'Swim meet vs. Oak Hills', location: 'Home pool', starts_at: new Date(PT(20, '09:00')).toISOString(), ends_at: new Date(PT(20, '12:00')).toISOString(), all_day: false });
  return [{ id: 'swim', label: 'Swim team', color: '#0891b2', events }];
}

// ── The board's answer to the photo of the cracked tile ──
const helpRequest = state => ({ id: 'hr-video', topic: 'facility', topic_label: 'Pool problem', status: state.helpReplied ? 'answered' : 'open',
  assigned_name: 'Erik Larsen', created_at: new Date(Date.parse('2027-06-19T10:44:00-07:00')).toISOString(),
  updated_at: new Date(Date.parse('2027-06-19T10:51:00-07:00')).toISOString(), last_message: state.helpReplied ? 'Thanks, Jamie! It’s coned off now, and fixed tomorrow morning.' : 'The deck tile by the steps is cracked.',
  message_count: state.helpReplied ? 2 : 1, unread: !!state.helpReplied });

function answer(fn, body, ctx) {
  const { state } = ctx;
  const a = body.action;
  if (fn === 'external_calendar' && a === 'list_public') return { ok: true, feeds: swimFeed() };
  if (fn === 'help_requests') {
    if (a === 'submit') { state.helpPhoto = body.photo_base64 ? `data:${body.photo_content_type || 'image/jpeg'};base64,${body.photo_base64}` : null; state.helpSent = true; return { ok: true, request: helpRequest(state) }; }
    if (a === 'mine') return { ok: true, requests: state.helpSent ? [helpRequest(state)] : [] };
    if (a === 'get') return { ok: true, request: helpRequest(state), messages: [
      { author_kind: 'member', body: 'The deck tile by the steps is cracked.', photo_url: state.helpPhoto, created_at: new Date(Date.parse('2027-06-19T10:44:00-07:00')).toISOString() },
      ...(state.helpReplied ? [{ author_kind: 'board', author_name: 'Erik Larsen (Facilities Director)', body: 'Thanks, Jamie! It’s coned off now, and fixed tomorrow morning.', created_at: new Date(Date.parse('2027-06-19T10:51:00-07:00')).toISOString() }] : []),
    ] };
  }
  const out = siteRespond(fn, body, ctx) ?? respond(fn, body, ctx);
  // Coming up shows five: keep the other families' parties out of it, so the
  // swim meet and practice show beside the club's events.
  if (fn === 'tenant_public' && out?.events) return { ...out, events: out.events.filter(e => !(e.title === 'Private event' && !String(e.starts_at).startsWith('2027-06-19'))) };
  return out;
}

// ── The story. `say` is one sentence: spoken, and the subtitle. Its `run`
// happens while it's said (`lead`: starting that many ms before her), with
// `at(p)` waiting until p of the way through the sentence. `title` is a
// part's big title; `do` happens between sentences. Slower than promo.mjs:
// taps wait longer, typing isn't `fast`, and `hold` keeps the screen a beat. ──
export const SCRIPT = [
  { do: async h => { await h.stage(() => Stage.label('The Rivera family')); await h.layout('left'); } },
  { title: ['YOUR CLUB,', 'ON YOUR PHONE'], accent: 1, icon: '📱', async with(h) { await h.show('left', '#your_name', null, 'center', 300); } },
  { say: "Here's what your club's app does for your family." },

  // 1. Signing up, and the whole family on the app.
  { title: ['SIGN UP', 'IN MINUTES'], accent: 1, icon: '📝' },
  { say: 'Sign up from your phone in a few minutes, with everyone in your family.', hold: 300,
    run: (h, at) => both(
      async () => {
        await h.type('left', '#your_name', 'Jamie Rivera');
        for (const [sel, v] of DETAILS) await h.set('left', sel, v);
        await next(h);
        await h.set('left', '#ccount', '2');
        for (const [sel, v] of PEOPLE) await h.set('left', sel, v);
        await h.show('left', '[data-child="1"][data-field="name"]', null, 'center', 600);
      },
      async () => { await at(0.5); await chip(h, '👨‍👩‍👧‍👦', 'Whole family', 0); }) },
  { say: 'Each adult and teen gets their own link to the app.', hold: 500,
    async run(h, at) {
      await h.zoomOn('left', '[data-invite-row="adult-1"]', null, 1.45);
      await h.ring('left', '[data-invite-row="adult-1"]');
      await chip(h, '📲', 'Own app link', 1);
      await at(0.85); await h.unring(); await h.unzoom();
    } },

  { say: "Accept the club's policies, and sign with your finger.", hold: 300,
    async run(h, at) {
      await chipsOut(h);
      await next(h);
      // The policy is accepted as the page opens; the signatures are what shows.
      await h.frameOf('left').evaluate(() => { openPolicy('pool-rules'); acceptPolicy(); });
      await chip(h, '✍️', 'Signed', 0);
      await h.sign('left', '#sig-adult-0', { points: 12 });
      await h.sign('left', '#sig-adult-1', { points: 7 });
      await h.sign('left', '#sig-guardian', { points: 7 });
    } },

  // 2. Paying: by card, straight in; or over time.
  { do: async h => {
      await chipsOut(h);
      await next(h);
      await h.show('left', 'input[name="tier_slug"][value="family"]', null, 'center', 400);
    } },
  { title: ['PAY BY CARD,', 'YOU’RE IN'], accent: 1, icon: '💳' },
  { say: "Pay by card and you're in right away, or spread it out with a payment plan.", hold: 700,
    async run(h, at) {
      await h.tap('left', 'input[name="tier_slug"][value="family"]', null, { after: 500 });
      await h.tap('left', '#pay-opt-stripe', null, { after: 600 });
      await chip(h, '⚡', 'In right away', 0);
      await at(0.45); await h.tap('left', '#next-btn', null, { after: 200 });
      await h.stage(() => { Stage.hideTap(); Stage.standin(true, { icon: '💳', title: 'The card page', text: "You pay on Stripe's secure card page.", ok: '✓ Paid' }); });
      await chip(h, '📅', 'Pay over time', 1);
      await sleep(1100); await h.stage(() => Stage.standin(true, { done: true }));
      await at(0.95);
    } },

  // 3. The welcome text signs them in; the app opens signed in.
  { do: async h => { await chipsOut(h); await h.stage(() => Stage.standin(false)); } },
  { title: ['NO PASSWORD', 'TO REMEMBER'], accent: 1, icon: '🔐',
    async with(h) { await h.bubble('left', { kind: 'text', body: `Hi Jamie, you're all set - your membership at Maple Grove Swim Club is approved and paid. Tap to sign in: ${LINK}` }); } },
  { say: 'Your welcome text signs you in, and the app on your Home Screen stays signed in.', hold: 500,
    async run(h, at) {
      await at(0.35); await h.tapBubble('left');
      await h.go('left', '/m/verify.html#token=demo-link', { origin: FAMILY, waitFor: '#gate-card' });
      await h.stage(() => Stage.clearBubbles('left'));
      await h.frameOf('left').evaluate(() => { const p = document.getElementById('push-prompt'); if (p) p.style.display = 'none'; const i = document.getElementById('install-card-host'); if (i) i.innerHTML = ''; window.scrollTo(0, 0); });
    } },

  // 4. The gate.
  { title: ['OPEN THE GATE', 'FROM YOUR PHONE'], accent: 1, icon: '🔑' },
  { say: 'During pool hours, the gate button is right there when you open the app.', hold: 700,
    async run(h, at) {
      await h.ring('left', '#gate-unlock-btn');
      await at(0.55); await h.unring();
      await h.tap('left', '#gate-unlock-btn', null, { after: 900 });
      await hideTap(h);
      await chip(h, '🚪', 'Gate open', 0);
    } },

  // 5. A party: a day, a time, pay, booked.
  { do: async h => { await chipsOut(h); await h.show('left', '#calendar-card', null, 'start', 600); } },
  { title: ['BOOK A', 'PARTY'], accent: 1, icon: '🎉', async with(h) { await h.tap('left', '#calendar-card button', 'Book a party', { after: 600 }); } },
  { say: 'Booking a party takes a few taps. Pick a day and a start time.', hold: 400,
    async run(h, at) {
      await h.type('left', '#p-title', "Sofia's 15th birthday", { fast: true });
      const day = await h.frameOf('left').evaluate(() => {
        const b = [...document.querySelectorAll('#p-cal button[data-day]')].find(x => !x.classList.contains('off') && x.dataset.day >= '2027-06-26');
        return b ? b.dataset.day : null;
      });
      if (!day) throw new Error('No open party day on or after June 26');
      await h.tap('left', `#p-cal button[data-day="${day}"]`, null, { after: 500 });
      await h.select('left', '#p-time', '14:00');
      await h.ring('left', '#p-time');
      await at(0.95); await h.unring();
    } },
  { say: "Accept the party rules, pay by card, and it's booked.", hold: 500,
    async run(h, at) {
      await h.tap('left', '#p-policy-open', null, { after: 700 });
      await h.tap('left', '#p-policy-accept', null, { after: 500 });
      await h.tap('left', '#p-submit', null, { after: 800 });
      await h.tap('left', '#ask-yes', null, { click: false });
      await h.stage(() => { Stage.hideTap(); Stage.standin(true, { icon: '💳', title: 'The card page', text: "You pay on Stripe's secure card page.", ok: '✓ Paid' }); });
      await Promise.all([h.frameOf('left').waitForNavigation({ waitUntil: 'networkidle0', timeout: 45000 }), h.frameOf('left').evaluate(() => document.getElementById('ask-yes').click())]);
      await h.stage(() => Stage.standin(true, { done: true }));
      await at(0.75);
      await h.stage(() => Stage.standin(false));
      await h.bubble('left', { kind: 'pop', title: "🎉 Sofia's 15th birthday is booked", body: 'Saturday, June 26, 2:00 PM. It’s on the club calendar.' });
      await chip(h, '🎉', 'Booked', 0);
    } },

  // 6. Ask the board, with a photo; the answer pops up.
  { do: async h => {
      await chipsOut(h); await h.stage(() => Stage.clearBubbles('left'));
      await h.frameOf('left').evaluate(() => { window.scrollTo(0, 0); });
    } },
  { title: ['SEE AN ISSUE?', 'SNAP A PHOTO'], accent: 1, icon: '📸', async with(h) { await tab(h, 'help'); await hideTap(h); } },
  { say: 'Questions go straight to the board member who handles them.', hold: 300,
    async run(h, at) {
      await h.tap('left', '#help-card button', 'Ask the board', { after: 800 });
      await h.tap('left', '.help-topic[data-topic="facility"]', null, { after: 500 });
      await chip(h, '💬', 'Right person', 0);
    } },
  { say: 'See something broken? Take a photo and send it.', hold: 500,
    async run(h, at) {
      await h.type('left', '#help-body', 'The deck tile by the steps is cracked.', { fast: true });
      const input = await h.el('left', '#help-photo');
      await h.tap('left', '#help-photo', null, { click: false });
      await input.asElement().uploadFile(h.state.photoPath);
      await chip(h, '📷', 'A photo', 1);
      await at(0.85);
      await h.tap('left', '#help-send', null, { after: 600 });
      await hideTap(h);
    } },
  { say: 'Their answer pops up on your phone.', hold: 1500,
    async run(h, at) {
      h.state.helpReplied = true;
      await h.frameOf('left').evaluate(() => closeHelp());
      await h.bubble('left', { kind: 'pop', title: 'Erik Larsen replied', body: 'Thanks, Jamie! It’s coned off now, and fixed tomorrow morning.' });
      await at(0.6); await h.tapBubble('left');
      await h.stage(() => Stage.clearBubbles('left'));
      await h.frameOf('left').evaluate(() => openHelpThread('hr-video'));
      await sleep(900);
    } },

  // 7. Club news.
  { do: async h => { await chipsOut(h); await h.frameOf('left').evaluate(() => closeHelpThread()); await tab(h, 'home'); await hideTap(h); } },
  { title: ['CLUB NEWS,', 'AS IT HAPPENS'], accent: 1, icon: '📰' },
  { say: 'Club news pops up too, like a storm closure.', hold: 700,
    async run(h, at) {
      await h.bubble('left', { kind: 'pop', title: '📰 Pool closed until 2 PM', body: 'Thunderstorm this morning. Lanes reopen at 2.' });
      await at(0.5); await h.ring('left', 'h2', 'Latest news');
      await at(0.95); await h.unring();
    } },

  // 8. The calendar: swim meets, practices, club events.
  { do: async h => { await h.stage(() => Stage.clearBubbles('left')); } },
  { title: ['THE WHOLE', 'SEASON'], accent: 1, icon: '📅', async with(h) { await h.show('left', '#calendar-card', null, 'start', 900); } },
  { say: "The calendar has the whole season: swim meets, practices, and the club's events.", hold: 900,
    async run(h, at) {
      await h.ring('left', '#coming-up');
      await chip(h, '🏊', 'Swim schedule', 0);
      await at(0.6); await chip(h, '🎬', 'Club events', 1);
      await at(0.95); await h.unring();
    } },

  // 9. And more: keyfobs, renewing.
  { do: async h => { await chipsOut(h); await tab(h, 'family'); await hideTap(h); } },
  { title: ['AND THE', 'REST'], accent: 1, icon: '✨' },
  { say: 'Order a keyfob in the app.', hold: 500,
    async run(h, at) { await h.ring('left', '#keyfobs'); await chip(h, '🔑', 'Keyfobs', 0); await at(0.95); await h.unring(); } },
  { say: "And next year, renewing is one tap. Everything's filled in.", hold: 900,
    async run(h, at) {
      await at(0.3); await h.bubble('left', { kind: 'text', body: "Maple Grove Swim Club: it's time to renew for 2028. Your details are filled in, no password needed: <u>maplegrove.poolsideapp.com/renew…</u>" });
      await chip(h, '🔁', 'Renew in a tap', 1);
    } },

  // 10. The choice.
  { do: async h => {
      await h.stage(() => { Stage.chipsOut(); Stage.clearBubbles('left'); });
      await both(() => h.stage(() => Stage.titleOut()), () => h.layout('none'));
      await h.stage(() => {
        const l = document.getElementById('logo');
        l.innerHTML = '<i></i>Full app experience'; l.style.fontSize = '92px'; l.style.whiteSpace = 'nowrap';
        document.getElementById('tag').textContent = "Choose it when you sign up. It's free with your membership.";
        document.getElementById('note').textContent = 'Maple Grove Swim Club and its families are made up for this video.';
      });
      await sleep(400);
    } },
  { say: "Choose the Full app experience. It's free with your membership.", cap: false,
    async run(h, at) { await h.stage(() => Stage.logo('up')); await at(0.45); await h.stage(() => { Stage.end('tag'); Stage.end('note'); }); } },
  { wait: 3000 },
];

// The photo of the issue: a cracked deck tile by the steps, drawn (the demo has no real photos).
const ISSUE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
  <defs>
    <linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3fb6e0"/><stop offset="1" stop-color="#1b86b8"/></linearGradient>
    <linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9dcc4"/><stop offset="1" stop-color="#d6c6a8"/></linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="1.2"/></filter>
  </defs>
  <rect width="1200" height="330" fill="url(#w)"/>
  <path d="M0 80 Q150 60 300 85 T600 80 T900 88 T1200 78" stroke="#bfeaf7" stroke-width="6" fill="none" opacity=".55"/>
  <path d="M0 190 Q170 170 340 196 T680 188 T1020 198 T1200 186" stroke="#bfeaf7" stroke-width="5" fill="none" opacity=".45"/>
  <rect x="0" y="300" width="1200" height="60" fill="#f4f1ea"/>
  <rect x="0" y="352" width="1200" height="10" fill="#c9bfae"/>
  <g stroke="#bba98a" stroke-width="5">
    ${[0, 1, 2, 3, 4, 5].map(c => [0, 1, 2].map(r => `<rect x="${c * 200 + 4}" y="${362 + r * 180 + 4}" width="192" height="172" fill="url(#t)"/>`).join('')).join('')}
  </g>
  <path d="M430 400 L470 470 L455 520 L505 585 L490 640 L540 700" stroke="#4a3b2a" stroke-width="9" fill="none" stroke-linejoin="round" filter="url(#soft)"/>
  <path d="M470 470 L520 480 M505 585 L560 572 M455 520 L420 560" stroke="#4a3b2a" stroke-width="5" fill="none" filter="url(#soft)"/>
  <path d="M490 640 L515 655 L500 690 L470 672 Z" fill="#8a7860"/>
  <g transform="translate(830 560)"><path d="M0 170 L60 0 L120 170 Z" fill="#f97316"/><rect x="-25" y="165" width="170" height="22" rx="6" fill="#ea580c"/><path d="M28 90 L92 90 L100 115 L20 115 Z" fill="#fff" opacity=".9"/></g>
</svg>`;

async function makePhoto(browser, dir) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1200, height: 900 });
  await p.setContent(`<!doctype html><body style="margin:0">${ISSUE_SVG}</body>`);
  const f = dir + '/cracked-tile.jpg';
  await p.screenshot({ path: f, type: 'jpeg', quality: 88 });
  await p.close();
  return f;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ts = t => { const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };

function encoder(work) {
  if (process.env.DEMO_ENCODER) return process.env.DEMO_ENCODER;
  // Apple's Command Line Tools ship /usr/include/swift twice over; an overlay hides one (as promo.mjs).
  const dir = work + '-encoder', bin = dir + '/encode', src = new URL('./encode.swift', import.meta.url).pathname;
  if (existsSync(bin) && statSync(bin).mtimeMs > statSync(src).mtimeMs) return bin;
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + '/empty.modulemap', '');
  writeFileSync(dir + '/overlay.yaml', JSON.stringify({ version: 0, 'case-sensitive': 'false', roots: [{ type: 'directory', name: '/Library/Developer/CommandLineTools/usr/include/swift',
    contents: [{ type: 'file', name: 'module.modulemap', 'external-contents': dir + '/empty.modulemap' }] }] }));
  execFileSync('swiftc', ['-O', '-swift-version', '5', '-vfsoverlay', dir + '/overlay.yaml', '-Xcc', '-ivfsoverlay', '-Xcc', dir + '/overlay.yaml',
    src, '-o', bin], { stdio: ['ignore', 'ignore', 'pipe'] });
  return bin;
}

/** Every step against the made-up club; with record, the video too. Returns what went wrong. */
export async function film({ record = true } = {}) {
  const OUT = WEB + 'handouts/poolside-member-app.mp4';
  const WORK = process.env.DEMO_WORK || '/tmp/poolside-member-app';
  const VOICE = process.env.DEMO_VOICE || 'Ava (Premium)';
  const RATE = String(process.env.DEMO_RATE || 150);
  const MUSIC = process.env.DEMO_MUSIC || WEB + 'handouts/music/upbeat-summer-travel-music-ikoliks_aj.mp3';
  if (record && !existsSync(MUSIC)) throw new Error(`No music at ${MUSIC} (set DEMO_MUSIC)`);

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK + '/frames', { recursive: true });
  mkdirSync(WORK + '/voice', { recursive: true });
  const steps = SCRIPT.map(s => ({ ...s }));
  steps.filter(s => s.say).forEach((s, i) => {
    if (!record) { s.secs = 0.5; return; }   // a dry run doesn't speak, and doesn't wait for her
    s.audio = `${WORK}/voice/${String(i).padStart(2, '0')}.aiff`;
    execFileSync('say', ['-v', VOICE, '-r', RATE, '--data-format=BEI16@44100', '-o', s.audio, spoken(s.say)]);
    s.secs = Number(String(execFileSync('afinfo', [s.audio])).match(/estimated duration: ([\d.]+)/)[1]);
  });

  const browser = await launch({ protocolTimeout: 30000 });
  const state = { riveraPaid: false };
  state.photoPath = await makePhoto(browser, WORK);
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1');
  await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 4 / 3 });
  const log = await attach(page, { state, answer, extraFiles: { '/__promo.html': new URL('./promo.html', import.meta.url).pathname } });
  page.on('dialog', d => d.accept());
  await page.goto(STAGE + '/__promo.html', { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  let H = driver(page, { state, origins: { left: FAMILY } });
  if (process.env.DEMO_DEBUG) H = new Proxy(H, { get(t, k, proxy) {
    const v = t[k];
    if (typeof v !== 'function' || k === 'stage') return v;
    return (...a) => { const t0 = Date.now(), r = v.apply(proxy, a);
      Promise.resolve(r).then(() => console.log(`    ${String(k)}(${a.slice(0, 2).map(x => typeof x === 'string' ? x : '…').join(', ').slice(0, 70)}) ${Date.now() - t0} ms`), e => console.log(`    ${String(k)} failed: ${e.message.slice(0, 80)}`));
      return r; };
  } });
  await H.go('left', '/apply.html');
  await sleep(800);

  const cdp = await page.createCDPSession();
  const frames = [], voice = [], cues = [];
  const T0 = Date.now() / 1000;
  if (record) {
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      const f = `${WORK}/frames/${String(frames.length).padStart(5, '0')}.jpg`;
      writeFileSync(f, Buffer.from(data, 'base64'));
      frames.push({ f, t: Math.max(0, Date.now() / 1000 - T0) });   // stamped on arrival: Chrome's frame clock drifts
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  }
  await sleep(600);

  try {
    for (const s of steps) {
      if (s.do) await s.do(H);
      else if (s.wait) await sleep(record ? s.wait : 100);
      else if (s.title) await Promise.all([page.evaluate((l, o) => Stage.title(l, o), s.title, { icon: s.icon, accent: s.accent }), s.with ? s.with(H) : null, sleep(600)]);
      else {
        let start = Date.now() + (s.lead ?? 0);
        const at = async p => { const due = start + p * s.secs * 1000; if (Date.now() < due) await sleep(due - Date.now()); };
        const work = s.run ? s.run(H, at) : null;
        if (s.lead) { await sleep(s.lead); start = Date.now(); }
        if (record) voice.push({ f: s.audio, t: start / 1000 - T0, secs: s.secs });
        cues.push({ start: start / 1000 - T0, end: start / 1000 - T0 + s.secs, text: s.say });
        if (s.cap !== false) await page.evaluate(h => Stage.caption(h), captionLines(s.say).map(esc).join('<br>'));
        await Promise.all([work, sleep(s.secs * 1000).then(() => page.evaluate(() => Stage.caption(null)))]);
        // Slower than the 90-second video: the screen holds a beat after she finishes.
        await sleep(500 + (s.hold ?? 0));
        const over = (Date.now() - start) / 1000 - s.secs - 0.5 - (s.hold ?? 0) / 1000;
        console.log(`${s.say.slice(0, 52).padEnd(52)} ${s.secs.toFixed(1)} s${over > 0.3 ? `, then ${over.toFixed(1)} s more for the screen` : ''}`);
      }
    }
  } catch (e) {
    await browser.close();
    return { error: e.message, unknown: [...new Set(log.unknown)], errors: [...new Set(log.errors)] };
  }
  if (record) await cdp.send('Page.stopScreencast');
  const end = Date.now() / 1000 - T0;
  await browser.close();
  const out = { error: null, unknown: [...new Set(log.unknown)], errors: [...new Set(log.errors)], seconds: end };
  if (!record) return out;
  if (out.unknown.length) console.log('Calls the demo did not answer:', out.unknown.join(', '));
  if (out.errors.length) console.log('Page errors:', out.errors.join(' | '));

  const srtPath = OUT.replace(/\.mp4$/, '.srt');
  writeFileSync(srtPath, cues.filter((_, i) => steps.filter(s => s.say)[i].cap !== false)
    .map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${captionLines(c.text).join('\n')}\n`).join('\n'));
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@44100', MUSIC, `${WORK}/music.wav`]);
  writeFileSync(`${WORK}/music.json`, JSON.stringify({ f: MUSIC, points: musicCurve(voice, end, loudness(`${WORK}/music.wav`)) }));
  writeFileSync(`${WORK}/frames.json`, JSON.stringify({ end, frames }));
  writeFileSync(`${WORK}/voice.json`, JSON.stringify(voice.map(({ f, t }) => ({ f, t }))));
  console.log(`${frames.length} frames over ${end.toFixed(1)} s; subtitles ${srtPath}`);
  const ENC = encoder(WORK), args = [`${WORK}/frames.json`, `${WORK}/voice.json`];
  console.log(String(execFileSync(ENC, [...args, OUT, `${WORK}/music.json`], { env: { ...process.env, DEMO_BITRATE: '6000000' } })).trim());
  console.log(String(execFileSync(ENC, [...args, OUT.replace(/\.mp4$/, '-small.mp4'), `${WORK}/music.json`],
    { env: { ...process.env, DEMO_SIZE: '720', DEMO_BITRATE: '1800000' } })).trim());
  // The copy the join form plays (PLAN.md CP3): on the site, small enough for cell data.
  // If its length changes, change the seconds in APP_VIDEO in js/pwa.js (test_demo_video checks).
  console.log(String(execFileSync(ENC, [...args, new URL('../../videos/what-the-app-does.mp4', import.meta.url).pathname, `${WORK}/music.json`],
    { env: { ...process.env, DEMO_SIZE: '720', DEMO_BITRATE: '550000' } })).trim());
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await film({ record: !process.env.DEMO_DRY });
  if (r.error) { console.error('Stopped:', r.error); if (r.unknown.length) console.error('Unanswered:', r.unknown.join(', ')); if (r.errors.length) console.error('Page errors:', r.errors.join(' | ')); process.exit(1); }
  console.log(`Done in ${r.seconds?.toFixed(1)} s${r.unknown.length ? '; unanswered: ' + r.unknown.join(', ') : ''}`);
}
