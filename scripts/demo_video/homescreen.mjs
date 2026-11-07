// =============================================================================
// homescreen.mjs — the "add the app" videos for families (PLAN.md CA)
// =============================================================================
//   node scripts/demo_video/homescreen.mjs [iphone|android|both]   (about 2 minutes each)
// Writes handouts/poolside-home-screen-iphone.mp4 and -android.mp4 (1920×1080),
// a -small.mp4 of each (1280×720, for texts and email) and their subtitles, and
// videos/add-app-iphone.mp4 / -android.mp4, the ~6 MB copies the app plays (PLAN.md CA4).
// Env: as promo.mjs (DEMO_VOICE, DEMO_RATE, DEMO_MUSIC, DEMO_WORK, DEMO_ENCODER).
//
// Doug 11/6: "a video describing and walking through how to add the app to
// your home screen on a iphone/android", made like the 90-second video, for
// families, one per phone, with Ava's voice and subtitles. The real member
// app (the made-up Maple Grove club) is in the phone; Safari's and Chrome's
// own screens, the Home Screen and the notifications question are drawn on
// the stage (homescreen.html), since they aren't web pages. The steps are
// today's: since iOS 26 Safari's Share is behind ••• next to the address bar.
// The narration says "your club", so it fits any club.
// =============================================================================

import { mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launch, attach, FAMILY, STAGE, WEB } from './harness.mjs';
import { driver } from './drive.mjs';
import { spoken, captionLines, musicCurve, loudness } from './promo.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const both = (...fns) => Promise.all(fns.map(f => f()));
// Something drawn on the stage: tap it, show it, ring it.
const ui = (h, sel, press = true) => h.stage((id, p) => Stage.ui(id, p), sel.slice(1), press);
const show = (h, id, on = true) => h.stage((id, on) => Stage.show(id, on), id, on);
const ringUi = (h, id) => h.stage(id => Stage.ringUi(id), id);
const unring = h => h.stage(() => { Stage.unring(); Stage.hideTap(); });

// The member app in the phone: signed in, the steps card showing, the
// notifications card out of the way until its turn.
async function openApp(h, phone) {
  await h.go('app', '/m/verify.html#token=demo-link', { origin: FAMILY, waitFor: '#gate-card' });
  await h.frameOf('app').evaluate(phone => {
    try { localStorage.removeItem('poolside_install_later'); } catch (_) {}
    const p = document.getElementById('push-prompt'); if (p) p.style.display = 'none';
    // Chrome offers its install (what the app's Android button uses), and the steps redraw with it.
    if (phone === 'android') {
      const e = new Event('beforeinstallprompt');
      e.prompt = () => {}; e.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(e);
    }
    if (typeof renderInstallCard === 'function') renderInstallCard();
    const tab = document.querySelector(`#install-card-host .pwa-btab[data-b="${phone === 'android' ? 'android' : 'ios-safari'}"]`);
    if (tab) tab.click();
    window.scrollTo(0, 0);
  }, phone);
  await sleep(400);
}
// Opened from the Home Screen: no steps card any more, and the notifications card.
async function asInstalled(h) {
  await h.frameOf('app').evaluate(async () => {
    try { localStorage.setItem('poolside_install_later', String(Date.now())); } catch (_) {}
    const host = document.getElementById('install-card-host'); if (host) host.innerHTML = '';
    const p = document.getElementById('push-prompt');
    if (p) {
      p.style.display = '';
      if (window.MemberPush) { try { await MemberPush.mountPrompt(p); } catch (_) {} }
      // As member-push.js draws it, should this browser not offer pop-ups.
      if (!p.querySelector('button[data-act="on"]')) {
        p.innerHTML = '<div style="background:linear-gradient(135deg,#fff7ed,#fef3c7);border:1px solid #fde68a;border-radius:14px;padding:14px 16px;color:#78350f;margin-bottom:14px">🔔 <div style="font-size:13.5px;line-height:1.45;margin-bottom:10px">Get a pop-up when the board answers you, your party is approved, a payment goes through, or the club posts news.</div><button type="button" data-act="on" style="padding:9px 15px;border-radius:10px;font:600 13px Inter,sans-serif;cursor:pointer;background:var(--blue,#0a3b5c);color:#fff;border:0">Turn on notifications</button></div>';
        p.style.display = '';
      }
      p.onclick = null;
    }
    window.scrollTo(0, 0);
  });
  await sleep(300);
}
const notificationsOn = h => h.frameOf('app').evaluate(() => {
  const p = document.getElementById('push-prompt');
  if (p) p.innerHTML = '<div style="background:#dcfce7;border-radius:14px;padding:12px 16px;color:#14532d;font-size:13.5px;margin-bottom:14px">✓ Notifications are on.</div>';
});

// ── The two stories. `say` is one sentence (spoken, and the subtitle); its
// `run` happens while it's said, `at(p)` waiting until p of the way through.
// `title` is the step's big title; `do` happens between sentences. ─────────
const THANKS = { do: async h => { await h.stage(() => { Stage.titleOut(); Stage.end('That’s it.', 'Use the icon from now on.'); }); await sleep(400); } };
export const SCRIPTS = {
  iphone: [
    { do: async h => { await h.stage(() => Stage.device('ios')); await sleep(700); } },
    { title: ['ADD THE APP', 'ON IPHONE'], accent: 1, icon: '📲' },
    { say: "Here's how to add your club's app to your iPhone's Home Screen." },
    { title: ['OPEN IT', 'IN SAFARI'], accent: 1, icon: '1' },
    { say: "Open your club's link in Safari, not inside Gmail or another app.",
      async run(h, at) { await at(0.25); await ringUi(h, 'ios-bar'); await h.stage(() => Stage.chip('✉️', 'In another app? Look for Open in Safari')); await at(0.95); await unring(h); } },
    { say: "Your club's Home page shows these steps too.",
      async run(h, at) { await h.stage(() => Stage.chip()); await h.ring('app', '#install-card-host .pwa-steps'); await at(0.95); await unring(h); } },
    { title: ['TAP •••', 'THEN SHARE'], accent: 1, icon: '2' },
    { say: 'Tap the three dots next to the address bar, then tap Share.',
      async run(h, at) {
        await h.stage(() => Stage.zoom(330, 640, 1.3));
        await at(0.3); await ui(h, '#ios-dots'); await show(h, 'ios-menu');
        await at(0.72); await ui(h, '#ios-share');
        await show(h, 'ios-menu', false); await h.stage(() => { Stage.hideTap(); Stage.unzoom(); });
        await sleep(350); await show(h, 'dim'); await show(h, 'ios-sheet');
        await h.stage(() => Stage.chip('⬆︎', 'Older iPhone? Share is at the bottom of Safari'));
      } },
    { title: ['ADD TO', 'HOME SCREEN'], accent: 1, icon: '3' },
    { say: 'Scroll down and tap Add to Home Screen.',
      async run(h, at) {
        await h.stage(() => { Stage.chip(); Stage.scrollSheet(190); });
        await at(0.35); await ringUi(h, 'ios-a2hs');
        await at(0.85); await unring(h); await ui(h, '#ios-a2hs');
        await sleep(250); await show(h, 'ios-addsheet'); await h.stage(() => Stage.hideTap());
      } },
    { wait: 500 },
    { say: 'Leave Open as Web App on, and tap Add.',
      async run(h, at) {
        await h.stage(() => Stage.zoom(195, 160, 1.3));
        await at(0.15); await ringUi(h, 'ios-webapp');
        await at(0.6); await unring(h); await ui(h, '#ios-add');
        await h.stage(() => { Stage.hideTap(); Stage.unzoom(); });
        await show(h, 'ios-addsheet', false); await show(h, 'ios-sheet', false); await show(h, 'dim', false);
        await h.stage(() => Stage.home(true));
      } },
    { title: ['OPEN IT', 'FROM HOME'], accent: 1, icon: '4' },
    { say: "Your club's icon is now on your Home Screen. Tap it to open the app.",
      async run(h, at) {
        await at(0.1); await h.stage(() => Stage.homeNew());
        await at(0.75); await ui(h, '#home-new');
        await h.stage(() => { Stage.hideTap(); Stage.mode('app'); });
        await asInstalled(h);
        await h.stage(() => Stage.homeAway());
      } },
    { say: "You're already signed in.",
      async run(h, at) { await h.ring('app', '.hero-card h1'); await at(1); await sleep(200); await unring(h); } },
    { title: ['TURN ON', 'NOTIFICATIONS'], accent: 1, icon: '5' },
    { say: 'Tap Turn on notifications, then Allow, so you hear when the board answers you.',
      async run(h, at) {
        await at(0.05); await h.tap('app', 'button[data-act="on"]', null, { click: false });
        await show(h, 'ios-alert');
        await at(0.7); await ui(h, '#ios-allow');
        await show(h, 'ios-alert', false); await notificationsOn(h); await h.stage(() => Stage.hideTap());
      } },
    THANKS,
    { say: "That's it. Use the icon from now on.", cap: false },
    { wait: 2600 },
  ],

  android: [
    { do: async h => { await h.stage(() => Stage.device('android')); await sleep(700); } },
    { title: ['ADD THE APP', 'ON ANDROID'], accent: 1, icon: '📲' },
    { say: "Here's how to add your club's app to your Android phone's home screen." },
    { title: ['OPEN IT', 'IN CHROME'], accent: 1, icon: '1' },
    { say: "Open your club's link in Chrome.",
      async run(h, at) { await at(0.2); await ringUi(h, 'cr-bar'); await at(0.95); await unring(h); } },
    { title: ['TAP ADD TO', 'HOME SCREEN'], accent: 1, icon: '2' },
    { say: "On your club's Home page, tap Add to home screen.",
      async run(h, at) {
        await at(0.45); await h.tap('app', '.pwa-install-btn', null, { click: false });
        await show(h, 'dim'); await show(h, 'cr-install'); await h.stage(() => Stage.hideTap());
      } },
    { say: 'Then tap Install.',
      async run(h, at) {
        await at(0.2); await ui(h, '#cr-install-btn');
        await show(h, 'cr-install', false); await show(h, 'dim', false); await h.stage(() => Stage.hideTap());
      } },
    { title: ['NO BUTTON?', 'USE THE MENU'], accent: 1, icon: '⋮' },
    { say: "No button? Open Chrome's menu, the three dots at the top, then Add to home screen.",
      async run(h, at) {
        await at(0.3); await ui(h, '#cr-dots'); await show(h, 'cr-menu'); await h.stage(() => Stage.hideTap());
        await at(0.7); await ringUi(h, 'cr-a2hs');
        await at(1); await unring(h); await show(h, 'cr-menu', false);
      } },
    { title: ['OPEN IT', 'FROM HOME'], accent: 1, icon: '3', async with(h) { await h.stage(() => Stage.home(true)); } },
    { say: "Your club's icon is now on your home screen. Tap it to open the app.",
      async run(h, at) {
        await at(0.1); await h.stage(() => Stage.homeNew());
        await at(0.75); await ui(h, '#home-new');
        await h.stage(() => { Stage.hideTap(); Stage.mode('app'); });
        await asInstalled(h);
        await h.stage(() => Stage.homeAway());
      } },
    { say: "You're already signed in.",
      async run(h, at) { await h.ring('app', '.hero-card h1'); await at(1); await sleep(200); await unring(h); } },
    { title: ['TURN ON', 'NOTIFICATIONS'], accent: 1, icon: '4' },
    { say: 'Tap Turn on notifications, then Allow, so you hear when the board answers you.',
      async run(h, at) {
        await at(0.05); await h.tap('app', 'button[data-act="on"]', null, { click: false });
        await show(h, 'an-alert');
        await at(0.7); await ui(h, '#an-allow');
        await show(h, 'an-alert', false); await notificationsOn(h); await h.stage(() => Stage.hideTap());
      } },
    THANKS,
    { say: "That's it. Use the icon from now on.", cap: false },
    { wait: 2600 },
  ],
};

// What each phone's browser says it is, so the app shows that phone's steps.
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
};

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

async function film(phone) {
  const OUT = WEB + `handouts/poolside-home-screen-${phone}.mp4`;
  const WORK = (process.env.DEMO_WORK || '/tmp/poolside-homescreen') + '-' + phone;
  const VOICE = process.env.DEMO_VOICE || 'Ava (Premium)';
  const RATE = String(process.env.DEMO_RATE || 168);
  const MUSIC = process.env.DEMO_MUSIC || WEB + 'handouts/music/upbeat-summer-travel-music-ikoliks_aj.mp3';
  if (!existsSync(MUSIC)) throw new Error(`No music at ${MUSIC} (set DEMO_MUSIC)`);

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK + '/frames', { recursive: true });
  mkdirSync(WORK + '/voice', { recursive: true });
  const steps = SCRIPTS[phone].map(s => ({ ...s }));
  steps.filter(s => s.say).forEach((s, i) => {
    s.audio = `${WORK}/voice/${String(i).padStart(2, '0')}.aiff`;
    execFileSync('say', ['-v', VOICE, '-r', RATE, '--data-format=BEI16@44100', '-o', s.audio, spoken(s.say)]);
    s.secs = Number(String(execFileSync('afinfo', [s.audio])).match(/estimated duration: ([\d.]+)/)[1]);
  });

  const browser = await launch({ protocolTimeout: 30000 });
  const page = await browser.newPage();
  await page.setUserAgent(UA[phone]);
  await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 4 / 3 });
  const state = {};
  const log = await attach(page, { state, extraFiles: { '/__homescreen.html': new URL('./homescreen.html', import.meta.url).pathname } });
  page.on('dialog', d => d.accept());
  await page.goto(STAGE + '/__homescreen.html', { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  const H = driver(page, { state, origins: { app: FAMILY } });
  await openApp(H, phone);
  await sleep(600);

  const cdp = await page.createCDPSession();
  const frames = [], voice = [], cues = [];
  const T0 = Date.now() / 1000;
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    const f = `${WORK}/frames/${String(frames.length).padStart(5, '0')}.jpg`;
    writeFileSync(f, Buffer.from(data, 'base64'));
    frames.push({ f, t: Math.max(0, Date.now() / 1000 - T0) });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await sleep(600);

  for (const s of steps) {
    if (s.do) await s.do(H);
    else if (s.wait) await sleep(s.wait);
    else if (s.title) await Promise.all([page.evaluate((l, o) => Stage.title(l, o), s.title, { icon: s.icon, accent: s.accent }), s.with ? s.with(H) : null, sleep(600)]);
    else {
      const start = Date.now();
      const at = async p => { const due = start + p * s.secs * 1000; if (Date.now() < due) await sleep(due - Date.now()); };
      const work = s.run ? s.run(H, at) : null;
      voice.push({ f: s.audio, t: start / 1000 - T0, secs: s.secs });
      cues.push({ start: start / 1000 - T0, end: start / 1000 - T0 + s.secs, text: s.say });
      if (s.cap !== false) await page.evaluate(h => Stage.caption(h), captionLines(s.say).map(esc).join('<br>'));
      await Promise.all([work, sleep(s.secs * 1000).then(() => page.evaluate(() => Stage.caption(null)))]);
      await sleep(450);
      const over = (Date.now() - start) / 1000 - s.secs - 0.45;
      console.log(`${s.say.slice(0, 48).padEnd(48)} ${s.secs.toFixed(1)} s${over > 0.3 ? `, then ${over.toFixed(1)} s more for the screen` : ''}`);
    }
  }
  await cdp.send('Page.stopScreencast');
  const end = Date.now() / 1000 - T0;
  await browser.close();
  if (log.unknown.length) console.log('Calls the demo did not answer:', [...new Set(log.unknown)].join(', '));
  if (log.errors.length) console.log('Page errors:', [...new Set(log.errors)].join(' | '));

  const srtPath = OUT.replace(/\.mp4$/, '.srt');
  writeFileSync(srtPath, cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${captionLines(c.text).join('\n')}\n`).join('\n'));
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@44100', MUSIC, `${WORK}/music.wav`]);
  writeFileSync(`${WORK}/music.json`, JSON.stringify({ f: MUSIC, points: musicCurve(voice, end, loudness(`${WORK}/music.wav`)) }));
  writeFileSync(`${WORK}/frames.json`, JSON.stringify({ end, frames }));
  writeFileSync(`${WORK}/voice.json`, JSON.stringify(voice.map(({ f, t }) => ({ f, t }))));
  console.log(`${phone}: ${frames.length} frames over ${end.toFixed(1)} s; subtitles ${srtPath}`);
  const ENC = encoder(WORK), args = [`${WORK}/frames.json`, `${WORK}/voice.json`];
  console.log(String(execFileSync(ENC, [...args, OUT, `${WORK}/music.json`], { env: { ...process.env, DEMO_BITRATE: '6000000' } })).trim());
  console.log(String(execFileSync(ENC, [...args, OUT.replace(/\.mp4$/, '-small.mp4'), `${WORK}/music.json`],
    { env: { ...process.env, DEMO_SIZE: '720', DEMO_BITRATE: '1800000' } })).trim());
  // The copy the app plays under its written steps (PLAN.md CA4): on the site, about 6 MB for cell data.
  // If its length changes, change the seconds in INSTALL_VIDEO in js/pwa.js (test_demo_video checks).
  console.log(String(execFileSync(ENC, [...args, new URL(`../../videos/add-app-${phone}.mp4`, import.meta.url).pathname, `${WORK}/music.json`],
    { env: { ...process.env, DEMO_SIZE: '720', DEMO_BITRATE: '900000' } })).trim());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const which = process.argv[2] || 'both';
  for (const phone of which === 'both' ? ['iphone', 'android'] : [which]) await film(phone);
}
