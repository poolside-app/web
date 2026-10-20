// Look at one demo screen: node scripts/demo_video/preview.mjs family /m/ out.png
// Lists every call it made, any it doesn't answer, and page errors.
import { launch, attach, FAMILY, BOARD } from './harness.mjs';
const [side, path, out, full] = process.argv.slice(2);
const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 720, deviceScaleFactor: 2 });
const log = await attach(page);
await page.goto((side === 'board' ? BOARD : FAMILY) + path, { waitUntil: 'networkidle0', timeout: 45000 }).catch(e => log.errors.push('goto: ' + e.message));
await new Promise(r => setTimeout(r, 1500));
console.log('url:', page.url());
console.log('calls:', [...new Set(log.calls)].join(', '));
console.log('unknown:', [...new Set(log.unknown)].join(', ') || 'none');
console.log('blocked hosts:', [...log.external].join(', ') || 'none');
console.log('errors:', log.errors.join(' | ') || 'none');
if (out) await page.screenshot({ path: out, fullPage: full === 'full' });
await browser.close();
