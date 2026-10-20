// =============================================================================
// drive.mjs — taps, typing and the camera for the demo videos (PLAN.md BD2, BH)
// =============================================================================
// The tour (tour.mjs) and the 90-second video (promo.mjs) both show the real
// pages in phone frames named 'left' and 'board' on a stage page, which draws
// the tap dot, the ring, the zoom and the bubbles (window.Stage). This is the
// part they share: find what's on a phone's screen, bring it into view, and
// tap, type, sign or zoom on it. It stops with an error if anything it's asked
// to use isn't on the screen.
// =============================================================================

import { FAMILY } from './harness.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function driver(page, { state, origins }) {
  const frameOf = side => page.frames().find(f => f.name() === side);
  const ORIGIN = { ...origins };
  return {
    state,
    frameOf,
    async go(side, path, { origin, waitFor } = {}) {
      if (origin) ORIGIN[side] = origin;
      await frameOf(side).goto(ORIGIN[side] + path, { waitUntil: 'networkidle0', timeout: 45000 });
      if (waitFor) await this.el(side, waitFor);
      await sleep(450);
    },
    async el(side, sel, text) {
      const deadline = Date.now() + 9000;
      for (;;) {
        const f = frameOf(side);
        const h = await f.evaluateHandle((sel, text) => [...document.querySelectorAll(sel)]
          .find(e => (!text || e.textContent.includes(text)) && e.getClientRects().length) || null, sel, text ?? null).catch(() => null);
        if (h && await h.evaluate(e => !!e).catch(() => false)) return h;
        if (Date.now() > deadline) throw new Error(`Not on the ${side} screen: ${sel}${text ? ` "${text}"` : ''}`);
        await sleep(200);
      }
    },
    async box(h) { return h.evaluate(e => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }); },
    // Into view, in the middle of the screen, unless it's already well inside.
    async view(h) {
      let b = await this.settle(h);
      if (b.y > 80 && b.y + b.h < 640) return b;
      await h.evaluate(e => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await sleep(500);
      return this.settle(h);
    },
    // Where it is once the page has stopped moving (smooth scrolls, re-renders).
    async settle(h) {
      let a = await this.box(h);
      for (let i = 0; i < 20; i++) {
        await sleep(90);
        const b = await this.box(h);
        if (Math.abs(b.y - a.y) < 1 && Math.abs(b.x - a.x) < 1) return b;
        a = b;
      }
      return a;
    },
    async show(side, sel, text, block = 'center', ms = 850) {
      const h = await this.el(side, sel, text);
      await h.evaluate((e, block) => block === 'start'
        ? window.scrollTo({ top: e.getBoundingClientRect().top + window.scrollY - 72, behavior: 'smooth' })
        : e.scrollIntoView({ behavior: 'smooth', block }), block);
      await sleep(ms);
      return h;
    },
    async scroll(side, dy, ms = 1200) { await frameOf(side).evaluate(dy => window.scrollBy({ top: dy, behavior: 'smooth' }), dy); await sleep(ms); },
    async zoomOn(side, sel, text, s = 1.45) {
      const b = await this.view(await this.el(side, sel, text));
      await page.evaluate((side, x, y, s) => Stage.zoom(side, x, y, s), side, b.x + b.w / 2, b.y + b.h / 2, s);
      await sleep(900);
    },
    async unzoom() { await page.evaluate(() => Stage.unzoom()); await sleep(700); },
    async ring(side, sel, text) {
      const b = await this.view(await this.el(side, sel, text));
      await page.evaluate((side, r) => Stage.ring(side, r), side, b);
      await sleep(500);
    },
    async unring() { await page.evaluate(() => Stage.unring()); },
    // The dot to it, a beat, then the tap. `click: false` only points;
    // `after` is the pause once it's tapped; `scroll: false` for something
    // fixed on the screen (a bar at the bottom).
    async tap(side, sel, text, { click = true, nav = false, after = 500, scroll = true } = {}) {
      const h = await this.el(side, sel, text);
      const b = scroll ? await this.view(h) : await this.box(h);
      await page.evaluate((side, x, y) => Stage.tapAt(side, x, y, true), side, b.x + Math.min(b.w / 2, 40), b.y + b.h / 2);
      if (!click) return;
      if (nav) await Promise.all([frameOf(side).waitForNavigation({ waitUntil: 'networkidle0', timeout: 45000 }), h.evaluate(e => e.click())]);
      else await h.evaluate(e => e.click());
      await sleep(after);
    },
    async type(side, sel, text, { zoom = 0, fast = false, clear = false } = {}) {
      if (zoom) await this.zoomOn(side, sel, null, zoom);
      await this.tap(side, sel);
      const h = await this.el(side, sel);
      if (clear) await h.evaluate(e => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
      await h.focus();
      for (const ch of text) { await h.type(ch); await sleep(fast ? 45 : 95); }
      await sleep(250);
    },
    // Filled in without typing (fields the narration doesn't dwell on).
    async set(side, sel, value) {
      const h = await this.el(side, sel);
      await h.evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, value);
    },
    async select(side, sel, value) { await this.tap(side, sel, null, { click: false }); await this.set(side, sel, value); await sleep(500); },
    // A signature, drawn with the mouse, wherever the camera has zoomed
    // (`points`: fewer is quicker).
    async sign(side, sel, { points = 32 } = {}) {
      const b = await this.view(await this.el(side, sel));
      const f = await page.evaluate(side => { const r = document.getElementById('f-' + side).getBoundingClientRect(); return { x: r.left, y: r.top, s: r.width / 390 }; }, side);
      const pts = [];
      for (let i = 0; i <= points; i++) { const t = i / points; pts.push([b.x + b.w * (0.15 + 0.68 * t), b.y + b.h * (0.6 - 0.24 * Math.sin(t * Math.PI * 3.1) * (1 - t * 0.5) - 0.07 * Math.sin(t * 17))]); }
      await page.evaluate((side, x, y) => Stage.tapAt(side, x, y, false), side, pts[0][0], pts[0][1]);
      await page.mouse.move(f.x + pts[0][0] * f.s, f.y + pts[0][1] * f.s);
      await page.mouse.down();
      for (const [x, y] of pts) { await page.mouse.move(f.x + x * f.s, f.y + y * f.s, { steps: 2 }); await page.evaluate((side, x, y) => Stage.moveTap(side, x, y), side, x, y); await sleep(8); }
      await page.mouse.up();
      await page.evaluate(() => Stage.hideTap());
      await sleep(300);
    },
    async bubble(side, b) { await page.evaluate((side, b) => Stage.bubble(side, b), side, b); },
    async tapBubble(side) { await page.evaluate(side => Stage.tapAt(side, 195, 80, true), side); await sleep(250); await page.evaluate(() => Stage.hideTap()); },
    async layout(which, dim) { await page.evaluate((w, d) => Stage.layout(w, d), which, dim ?? null); await sleep(750); },
    async label(text) { await page.evaluate(t => Stage.label(t), text); },
    // A filled-in form at its last step, for the Venmo and plan scenes (made
    // out of sight; the signup itself was shown in full earlier).
    async prefill(side, p) {
      await this.go(side, '/apply.html', { origin: FAMILY });
      await frameOf(side).evaluate(p => {
        const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
        set('your_name', p.name); set('family_name', p.family); set('address', '9 Birch Court'); set('primary_phone', p.phone);
        set('primary_email', p.email); set('emergency_name', 'A neighbor'); set('emergency_phone', '5555550177');
        showStep(4);
        const t = document.querySelector('input[name="tier_slug"][value="family"]'); if (t) { t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); }
      }, p);
      await sleep(900);
    },
    stage: (fn, ...a) => page.evaluate(fn, ...a),
  };
}
