// =============================================================================
// promo.mjs — the 90-second video (PLAN.md BH)
// =============================================================================
//   node scripts/demo_video/promo.mjs [out.mp4]          (about 4 minutes to make)
// Writes handouts/poolside-promo.mp4 (1920×1080), poolside-promo-small.mp4
// (1280×720, for texts and email) and the subtitles, poolside-promo.srt.
// Env: DEMO_VOICE (default "Ava (Premium)", Doug's pick 10/20; download it in
// System Settings → Accessibility → Spoken Content), DEMO_RATE (words a
// minute, 168), DEMO_MUSIC (the track, default the Pixabay one in
// handouts/music/, kept out of git), DEMO_WORK (scratch, default
// /tmp/poolside-promo), DEMO_ENCODER (built encode.swift; otherwise built here),
// DEMO_DEBUG=1 (how long each tap, wait and page load takes).
//
// In the style of the app promo Doug liked: a big title beside the phone for
// each part, labeled icons popping in, short lines over music, and subtitles
// because a Mac voice is still a Mac voice. Each sentence is its own voice
// clip, so its subtitle shows the moment she starts it. The music is turned
// down under her (musicCurve). Every Supabase call is answered by data.mjs;
// it stops with an error if anything it taps isn't on the screen.
// =============================================================================

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launch, attach, FAMILY, BOARD, STAGE, WEB } from './harness.mjs';
import { driver } from './drive.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LINK = '<u>maplegrove.poolsideapp.com/m/verify…</u>';
// Where the icons pop in beside one phone (stage px), top to bottom.
const SPOT = [{ x: 1118, y: 150 }, { x: 1150, y: 300 }, { x: 1118, y: 450 }];
const chip = (h, icon, text, spot) => h.stage(c => Stage.chip(c), { icon, text, ...(typeof spot === 'number' ? SPOT[spot] : spot) });

const DETAILS = [['#address', '14 Willow Lane'], ['#city', 'Maple Grove'], ['#zip', '94500'], ['#primary_phone', '(555) 555-0101'],
  ['#primary_email', 'jamie@example.com'], ['#emergency_name', 'Pat Rivera'], ['#emergency_phone', '(555) 555-0188']];
const PEOPLE = [['[data-adult="0"][data-field="dob"]', '1986-05-14'], ['[data-adult="1"][data-field="name"]', 'Alex Rivera'],
  ['[data-adult="1"][data-field="dob"]', '1987-09-02'], ['[data-adult="1"][data-field="phone"]', '(555) 555-0102'],
  ['[data-child="0"][data-field="name"]', 'Sofia Rivera'], ['[data-child="0"][data-field="dob"]', '2012-04-03'],
  ['[data-child="0"][data-field="phone"]', '(555) 555-0103'], ['[data-child="1"][data-field="name"]', 'Leo Rivera'],
  ['[data-child="1"][data-field="dob"]', '2018-07-21']];

// ── The story. `say` is one sentence: spoken, and the subtitle. Its `run`
// happens while it's said (`lead`: starting that many ms before her), with
// `at(p)` waiting until p of the way through the sentence. `title` is a part's
// big title (`accent` is the amber line, `show` how many lines at first;
// `with` happens while it slides in). `do` happens between sentences. ──────
const both = (...fns) => Promise.all(fns.map(f => f()));
// The signup's Next, pressed without the tap dot (the page changing says enough).
const next = async h => { await h.frameOf('left').evaluate(() => document.getElementById('next-btn').click()); await sleep(350); };
export const SCRIPT = [
  // 1. What running a club looks like now, then Poolside.
  { do: async h => { for (let i = 0; i < 5; i++) { await h.stage(i => Stage.messIn(i), i); await sleep(280); } await sleep(300); } },
  { say: "Running a pool club shouldn't feel like a second job." },
  { say: 'No more chasing Venmo screenshots.',
    async run(h, at) { await at(0.4); await h.stage(() => Stage.strike(['venmo', 'shot'])); await sleep(420); await h.stage(() => Stage.drop(['venmo', 'shot'])); } },
  { say: 'No more spreadsheets.',
    async run(h, at) { await at(0.3); await h.stage(() => Stage.strike(['sheet', 'text', 'note'])); await sleep(420); await h.stage(() => Stage.drop(['sheet', 'text', 'note'])); } },
  { say: 'Meet Poolside.', async run(h) { await h.stage(() => Stage.logo('on')); } },
  { wait: 500 },

  // 2. Signing up: the phone works through the form while the icons follow her words.
  { do: async h => { await h.stage(() => { Stage.logo('off'); Stage.brand(true); Stage.label('The family'); }); await h.layout('left'); } },
  { title: ['SIGN UP', 'IN 5 MINUTES'], accent: 1, icon: '📝', async with(h) { await h.show('left', '#your_name', null, 'center', 300); } },
  { say: "A family signs up from their phone in about five minutes: their details, their kids, the club's policies, signed.", lead: 600,
    run: (h, at) => both(
      async () => {
        await h.type('left', '#your_name', 'Jamie Rivera', { fast: true });
        for (const [sel, v] of DETAILS) await h.set('left', sel, v);
        await next(h);
        await h.set('left', '#ccount', '2');
        for (const [sel, v] of PEOPLE) await h.set('left', sel, v);
        await h.show('left', '[data-child="1"][data-field="name"]', null, 'center', 450);
        await next(h);
        // The policy is accepted as the page opens; the signatures are what shows.
        await h.frameOf('left').evaluate(() => { openPolicy('pool-rules'); acceptPolicy(); });
        await h.sign('left', '#sig-adult-0', { points: 16 });
        await h.sign('left', '#sig-adult-1', { points: 10 });
        await h.sign('left', '#sig-guardian', { points: 10 });
      },
      async () => {
        await at(0.55); await chip(h, '📋', 'Their details', 0);
        await at(0.68); await chip(h, '👨‍👩‍👧‍👦', 'Their kids', 1);
        await at(0.82); await chip(h, '✍️', 'Policies signed', 2);
      }) },

  // 3. Paying: by card, nothing for the board. The treasurer's home, counting
  // the Riveras as paid, loads out of sight first.
  { do: async h => {
      await h.stage(() => Stage.chipsOut());
      h.state.riveraPaid = true;
      await both(async () => { await next(h); await h.show('left', 'input[name="tier_slug"][value="family"]', null, 'center', 300); }, () => h.go('board', '/club/admin/'));
      await h.stage(() => Stage.label('The treasurer', 'board'));
    } },
  { title: ['PAID.', 'APPROVED.', 'DONE.'], accent: 2, icon: '✅', show: 1 },
  { say: 'They pay by card, Venmo or a payment plan.',
    run: (h, at) => both(
      async () => {
        await h.tap('left', 'input[name="tier_slug"][value="family"]', null, { after: 100 });
        await h.show('left', '#pay-opt-stripe', null, 'center', 350);
        await at(0.6); await h.tap('left', '#pay-opt-stripe', null, { after: 100 });
        await h.show('left', '#next-btn', null, 'center', 300);
      },
      async () => {
        await at(0.3); await chip(h, '💳', 'Card', 0);
        await at(0.5); await chip(h, '💸', 'Venmo', 1);
        await at(0.76); await chip(h, '📅', 'Payment plan', 2);
      }) },
  { say: 'Card payments approve themselves, so the board has nothing to do.',
    async run(h, at) {
      await h.stage(() => Stage.chipsOut());
      await h.tap('left', '#next-btn', null, { after: 100 });
      await h.stage(() => { Stage.hideTap(); Stage.standin(true, { icon: '💳', title: 'The card page', text: "Families pay on Stripe's secure page.", ok: '✓ Paid' }); });
      await sleep(500); await h.stage(() => Stage.standin(true, { done: true }));
      await at(0.36); await h.stage(() => Stage.titleLine(1));
      await h.layout('both');
      await h.stage(() => Stage.standin(false));
      await h.ring('board', 'a.hs', 'families paid');
      await at(0.8); await h.stage(() => Stage.titleLine(2));
      await h.bubble('left', { kind: 'text', body: `Hi Jamie, you're all set - your membership at Maple Grove Swim Club is approved and paid. Tap to sign in: ${LINK}` });
    } },
  { wait: 300 },

  // 4. The gate. One tap on the welcome text opens the app.
  { title: ['THE GATE', 'KNOWS'], accent: 1, icon: '🔑',
    async with(h) {
      await h.unring();
      await h.layout('left');
      await h.tapBubble('left');
      await h.go('left', '/m/verify.html#token=demo-link', { origin: FAMILY, waitFor: '#gate-card' });
      await h.stage(() => Stage.clearBubbles('left'));
    } },
  { say: "Paid families open the gate from their phone, and their keyfobs follow who's paid.",
    run: (h, at) => both(
      async () => {
        await h.ring('left', '#gate-unlock-btn');
        await at(0.2); await h.unring();
        await h.tap('left', '#gate-unlock-btn', null, { after: 200 });
        await h.stage(() => Stage.hideTap());
      },
      async () => { await at(0.42); await chip(h, '🚪', 'Gate open', 0); await at(0.72); await chip(h, '🔑', 'Keyfob on', 1); },
      // The treasurer's Payments, ready for the next part, out of sight.
      async () => { await h.go('board', '/club/admin/payments.html'); await h.show('board', '#venmo-check', null, 'start', 200); }) },
  { wait: 400 },

  // 5. Venmo and plan payments. The treasurer first; the Patels' phone,
  // paying by Venmo, is set up out of sight (no tap dot) and rises beside it.
  { title: ['NOTHING', 'TO CHASE'], accent: 1, icon: '💸',
    async with(h) {
      await h.stage(() => { Stage.chipsOut(); Stage.label('The treasurer', 'board'); });
      await h.layout('board');
      h.state.patels = (async () => {
        await h.prefill('left', { name: 'Priya Patel', family: 'Patel', phone: '5555550144', email: 'priya@example.com' });
        await h.frameOf('left').evaluate(() => { document.querySelector('input[name="payment_method"][value="venmo"]').click(); document.getElementById('next-btn').click(); });
        await h.show('left', 'a[href^="https://venmo.com"]', null, 'center', 200);
        await h.stage(() => Stage.label('The Patels'));
      })();
    } },
  { say: 'Every Venmo payment carries a code, so the board confirms a whole batch at once.',
    async run(h, at) {
      await h.state.patels;
      await h.layout('both');
      await h.ring('left', '#form b', '#K7Q2');
      await chip(h, '🏷️', 'Code #K7Q2', { x: 880, y: 70 });
      await at(0.6); await h.unring();
      await h.tap('board', '.venmo-row[data-i="0"]', null, { after: 120 });
      await h.tap('board', '.venmo-row[data-i="1"]', null, { after: 120 });
      await h.tap('board', '#venmo-confirm-btn', null, { after: 300 });
      await h.stage(() => Stage.hideTap());
    } },
  { say: 'Plan payments go out only when the board ticks them.', lead: 900,
    async run(h) {
      await h.stage(() => Stage.chipsOut());
      await both(() => h.layout('board'), () => h.go('board', '/club/admin/upcoming.html'));
      await h.show('board', 'input[onchange*="up-nguyen"]', null, 'center', 350);
      for (const id of ['up-okafor', 'up-nguyen', 'up-walsh']) await h.tap('board', `input[onchange*="${id}"]`, null, { after: 80 });
      await h.tap('board', '#bar-btn', null, { after: 400, scroll: false });
      await h.stage(() => Stage.hideTap());
    } },
  { wait: 400 },

  // 6. Each board member's home.
  { title: ['YOUR BOARD,', 'SORTED'], accent: 1, icon: '📋',
    async with(h) { await h.go('board', '/club/admin/'); await h.stage(() => Stage.label('A board member', 'board')); } },
  { say: 'Each board member opens to their own to-do list: parties, keyfobs and questions, in one place.',
    async run(h, at) {
      await at(0.4); await h.bubble('board', { kind: 'pop', title: "🎉 Party booked: Leo's 9th birthday", body: 'Saturday, June 26, 4:00 PM. Get in touch with Jamie Rivera.' });
      await chip(h, '🎉', 'Parties', 0);
      await at(0.55); await h.bubble('board', { kind: 'pop', title: '🔑 Keyfobs to issue', body: 'The Larsen Family need a keyfob.' });
      await chip(h, '🔑', 'Keyfobs', 1);
      await at(0.7); await h.bubble('board', { kind: 'pop', title: 'Guests question from Mia Nguyen', body: 'Can my nanny bring the kids on weekdays?' });
      await chip(h, '💬', 'Questions', 2);
    } },
  { wait: 800 },

  // 7. The name, the line, and where to try it. The words are on screen, so no subtitles.
  { do: async h => {
      await h.stage(() => { Stage.chipsOut(); Stage.clearBubbles('board'); Stage.brand(false); });
      await both(() => h.stage(() => Stage.titleOut()), () => h.layout('none'));
      await h.stage(() => Stage.logo('up'));
      await sleep(500);
    } },
  { say: 'Poolside.', cap: false },
  { say: 'Run your pool club, not your spreadsheets.', cap: false, async run(h) { await h.stage(() => Stage.end('tag')); } },
  { say: 'Try it yourself at demo.poolsideapp.com.', cap: false, async run(h, at) { await at(0.3); await h.stage(() => { Stage.end('url'); Stage.end('note'); }); } },
  { wait: 3400 },
];

/** What the voice reads: the subtitle, with the words she'd stumble on spelled out. */
export const spoken = text => text.replace(/’/g, "'").replace(/keyfobs/gi, 'key fobs').replace(/demo\.poolsideapp\.com/g, 'demo dot poolside app dot com');

/** A subtitle on one line, or two balanced ones, broken after a comma or colon near the middle. */
export function captionLines(text, max = 58) {
  if (text.length <= max) return [text];
  let best = -1, score = Infinity;
  for (let i = 1; i < text.length - 1; i++) {
    if (text[i] !== ' ') continue;
    const s = Math.abs(i - text.length / 2) - (/[,:;]/.test(text[i - 1]) ? 10 : 0);
    if (s < score) { score = s; best = i; }
  }
  return [text.slice(0, best), text.slice(best + 1)];
}

// ── The music, under the voice ───────────────────────────────────────────
// Ava through `say` is about -18 dB (measured 10/20). The music sits 15 dB
// below her while she speaks, and comes up in the pauses between parts (but
// not between two sentences close together) and before she starts. The track
// is loud in places, so its own level, a second ahead, sets how far down it goes.
export const VOICE_DB = -18;
const UNDER_DB = VOICE_DB - 15, GAP_DB = -24, INTRO_DB = -22;

/** [[seconds, volume 0–1], …] for encode.swift. voice: [{ t, secs }]; loud: the music's dB every half second. */
export function musicCurve(voice, end, loud, { step = 0.25, fade = 3 } = {}) {
  const spans = voice.map(v => [v.t - 0.35, v.t + v.secs + 0.25]).sort((a, b) => a[0] - b[0]);
  for (let i = 0; i + 1 < spans.length; i++) if (spans[i + 1][0] - spans[i][1] < 1.6) spans[i][1] = Math.max(spans[i][1], spans[i + 1][0]);
  const first = spans.length ? spans[0][0] : Infinity;
  const level = t => {
    let m = -Infinity;
    for (let u = t - 0.5; u <= t + 1; u += 0.5) { const i = Math.floor(u / 0.5); if (i >= 0 && i < loud.length) m = Math.max(m, loud[i]); }
    return Number.isFinite(m) ? m : (loud[loud.length - 1] ?? -20);
  };
  const pts = [];
  for (let n = 0; n * step <= end + 1e-9; n++) {
    const t = n * step;
    const target = spans.some(([a, b]) => t >= a && t <= b) ? UNDER_DB : t < first ? INTRO_DB : GAP_DB;
    let v = 10 ** (Math.min(0, Math.max(-40, target - level(t))) / 20);
    if (t > end - fade) v *= Math.max(0, (end - t) / fade);
    pts.push([Math.round(t * 1000) / 1000, Math.round(v * 10000) / 10000]);
  }
  if (pts[pts.length - 1][0] < end) pts.push([end, 0]);
  return pts;
}

/** The music's loudness (dB) every half second, from a 16-bit WAV. */
function loudness(wav) {
  const b = readFileSync(wav);
  let o = 12, rate = 44100, ch = 2, data = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(o + 10); rate = b.readUInt32LE(o + 12); }
    if (id === 'data') { data = b.subarray(o + 8, Math.min(b.length, o + 8 + n)); break; }
    o += 8 + n + (n & 1);
  }
  const samples = data.length >> 1, per = Math.round(rate / 2) * ch, out = [];
  for (let s = 0; s < samples; s += per) {
    let sum = 0, k = 0;
    for (let i = s; i < Math.min(s + per, samples); i += 3) { const x = data.readInt16LE(i * 2); sum += x * x; k++; }
    out.push(20 * Math.log10(Math.sqrt(sum / Math.max(1, k)) / 32768 + 1e-9));
  }
  return out;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ts = t => { const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };

async function main() {
  const OUT = process.argv[2] || WEB + 'handouts/poolside-promo.mp4';
  const WORK = process.env.DEMO_WORK || '/tmp/poolside-promo';
  const VOICE = process.env.DEMO_VOICE || 'Ava (Premium)';
  const RATE = String(process.env.DEMO_RATE || 168);
  const MUSIC = process.env.DEMO_MUSIC || WEB + 'handouts/music/upbeat-summer-travel-music-ikoliks_aj.mp3';
  if (!existsSync(MUSIC)) throw new Error(`No music at ${MUSIC} (set DEMO_MUSIC)`);

  // ── The voice: one clip a sentence ──
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK + '/frames', { recursive: true });
  mkdirSync(WORK + '/voice', { recursive: true });
  const steps = SCRIPT.map(s => ({ ...s }));
  steps.filter(s => s.say).forEach((s, i) => {
    s.audio = `${WORK}/voice/${String(i).padStart(2, '0')}.aiff`;
    execFileSync('say', ['-v', VOICE, '-r', RATE, '--data-format=BEI16@44100', '-o', s.audio, spoken(s.say)]);
    s.secs = Number(String(execFileSync('afinfo', [s.audio])).match(/estimated duration: ([\d.]+)/)[1]);
  });

  // ── The browser ──
  const browser = await launch({ protocolTimeout: 30000 });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 4 / 3 });
  const state = { riveraPaid: false };
  const log = await attach(page, { state, extraFiles: { '/__promo.html': new URL('./promo.html', import.meta.url).pathname } });
  page.on('dialog', d => d.accept());
  await page.goto(STAGE + '/__promo.html', { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  let H = driver(page, { state, origins: { left: FAMILY, board: BOARD } });
  // DEMO_DEBUG=1: how long each tap, wait and page load takes.
  if (process.env.DEMO_DEBUG) H = new Proxy(H, { get(t, k, proxy) {
    const v = t[k];
    if (typeof v !== 'function' || k === 'stage') return v;
    return (...a) => { const t0 = Date.now(), r = v.apply(proxy, a);
      Promise.resolve(r).then(() => console.log(`    ${String(k)}(${a.slice(0, 2).map(x => typeof x === 'string' ? x : '…').join(', ').slice(0, 70)}) ${Date.now() - t0} ms`), e => console.log(`    ${String(k)} failed: ${e.message.slice(0, 80)}`));
      return r; };
  } });
  await H.go('left', '/apply.html');
  await H.go('board', '/club/admin/');
  await sleep(800);

  // ── Record ──
  const cdp = await page.createCDPSession();
  const frames = [], voice = [], cues = [];
  const T0 = Date.now() / 1000;
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    const f = `${WORK}/frames/${String(frames.length).padStart(5, '0')}.jpg`;
    writeFileSync(f, Buffer.from(data, 'base64'));
    frames.push({ f, t: Math.max(0, Date.now() / 1000 - T0) });   // stamped on arrival: Chrome's frame clock drifts
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await sleep(600);

  for (const s of steps) {
    const t0 = Date.now();
    if (s.do) await s.do(H);
    else if (s.wait) await sleep(s.wait);
    else if (s.title) await Promise.all([page.evaluate((l, o) => Stage.title(l, o), s.title, { icon: s.icon, accent: s.accent, show: s.show }),
      s.with ? s.with(H) : null, sleep(250)]);
    else {
      // A sentence: its clip, its subtitle, and what happens while it's said.
      let start = Date.now() + (s.lead ?? 0);
      const at = async p => { const due = start + p * s.secs * 1000; if (Date.now() < due) await sleep(due - Date.now()); };
      const work = s.run ? s.run(H, at) : null;
      if (s.lead) { await sleep(s.lead); start = Date.now(); }
      voice.push({ f: s.audio, t: start / 1000 - T0, secs: s.secs });
      cues.push({ start: start / 1000 - T0, end: start / 1000 - T0 + s.secs, text: s.say });
      if (s.cap !== false) await page.evaluate(h => Stage.caption(h), captionLines(s.say).map(esc).join('<br>'));
      await Promise.all([work, sleep(s.secs * 1000).then(() => page.evaluate(() => Stage.caption(null)))]);
      await sleep(420);
      const over = (Date.now() - start) / 1000 - s.secs - 0.42;
      console.log(`${s.say.slice(0, 48).padEnd(48)} ${s.secs.toFixed(1)} s${over > 0.3 ? `, then ${over.toFixed(1)} s more for the screen` : ''}`);
      continue;
    }
    if (s.do && Date.now() - t0 > 2500) console.log(`  (between sentences: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  await cdp.send('Page.stopScreencast');
  const end = Date.now() / 1000 - T0;
  await browser.close();

  if (log.unknown.length) console.log('Calls the demo did not answer:', [...new Set(log.unknown)].join(', '));
  if (log.errors.length) console.log('Page errors:', [...new Set(log.errors)].join(' | '));
  if (log.external.size) console.log('Blocked:', [...log.external].join(', '));

  // ── Subtitles file, the music's levels, then the two MP4s ──
  const srtPath = OUT.replace(/\.mp4$/, '.srt');
  writeFileSync(srtPath, cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${captionLines(c.text).join('\n')}\n`).join('\n'));
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@44100', MUSIC, `${WORK}/music.wav`]);
  writeFileSync(`${WORK}/music.json`, JSON.stringify({ f: MUSIC, points: musicCurve(voice, end, loudness(`${WORK}/music.wav`)) }));
  writeFileSync(`${WORK}/frames.json`, JSON.stringify({ end, frames }));
  writeFileSync(`${WORK}/voice.json`, JSON.stringify(voice.map(({ f, t }) => ({ f, t }))));
  console.log(`${frames.length} frames over ${end.toFixed(1)} s (${(frames.length / end).toFixed(0)} a second); subtitles ${srtPath}`);

  const ENCODER = process.env.DEMO_ENCODER || (() => {
    // Apple's Command Line Tools ship /usr/include/swift twice over; an overlay hides one.
    const dir = WORK + '-encoder', bin = dir + '/encode', src = new URL('./encode.swift', import.meta.url).pathname;
    if (existsSync(bin) && statSync(bin).mtimeMs > statSync(src).mtimeMs) return bin;
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + '/empty.modulemap', '');
    writeFileSync(dir + '/overlay.yaml', JSON.stringify({ version: 0, 'case-sensitive': 'false', roots: [{ type: 'directory', name: '/Library/Developer/CommandLineTools/usr/include/swift',
      contents: [{ type: 'file', name: 'module.modulemap', 'external-contents': dir + '/empty.modulemap' }] }] }));
    execFileSync('swiftc', ['-O', '-swift-version', '5', '-vfsoverlay', dir + '/overlay.yaml', '-Xcc', '-ivfsoverlay', '-Xcc', dir + '/overlay.yaml',
      src, '-o', bin], { stdio: ['ignore', 'ignore', 'pipe'] });
    return bin;
  })();
  const args = [`${WORK}/frames.json`, `${WORK}/voice.json`];
  // The background is always moving, so these need more bits than the tour's still screens.
  console.log(String(execFileSync(ENCODER, [...args, OUT, `${WORK}/music.json`], { env: { ...process.env, DEMO_BITRATE: '6000000' } })).trim());
  console.log(String(execFileSync(ENCODER, [...args, OUT.replace(/\.mp4$/, '-small.mp4'), `${WORK}/music.json`],
    { env: { ...process.env, DEMO_SIZE: '720', DEMO_BITRATE: '1800000' } })).trim());
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
