#!/usr/bin/env node
// =============================================================================
// share_test.mjs — the preview card a neighbor sees, and what must never be in it
// =============================================================================
// club/index.html is rendered in the browser: its static HTML says
// "Loading…" and carries no Open Graph tags, and unfurlers do not run
// JavaScript. So a member pasting their club's link into a neighborhood group
// produced a card that said "Loading…" — on the one channel that actually
// brings a pool club members.
//
// /join is server-rendered to fix that. These tests pin the tags, and pin the
// escaping, because club names go straight into meta attributes.
//
//   node scripts/share_test.mjs
// =============================================================================

import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'poolside-share-'));
copyFileSync(join(here, '..', 'supabase', 'functions', '_shared', 'share_page.ts'), join(work, 'share_page.ts'));
execFileSync('npx', ['--yes', '-p', 'typescript@5.6.3', 'tsc', join(work, 'share_page.ts'),
  '--target', 'es2022', '--module', 'esnext', '--outDir', join(work, 'out'), '--skipLibCheck'], { stdio: 'pipe' });
renameSync(join(work, 'out', 'share_page.js'), join(work, 'out', 'share_page.mjs'));
const { renderSharePage, shareDescription, esc } = await import(pathToFileURL(join(work, 'out', 'share_page.mjs')).href);

let pass = 0, fail = 0;
const t = (name, got, want) => { const ok = got === want; ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n        got  ${got}\n        want ${want}`}`); };
const has = (name, hay, needle) => { const ok = String(hay).includes(needle); ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  missing: ${needle}`}`); };
const lacks = (name, hay, needle) => { const ok = !String(hay).includes(needle); ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  LEAKED: ${needle}`}`); };

const base = {
  slug: 'bishopestates',
  displayName: 'Bishop Estates Cabana Club',
  heroTagline: 'A neighborhood pool, run by neighbors.',
  primaryColor: '#0a3b5c',
  shareImage: 'https://cdn.example.com/pool.jpg',
  fromCents: 60000,
  ref: 'SMITH42',
};

console.log('— the card itself —');
{
  const h = renderSharePage(base);
  has('title', h, '<title>Join Bishop Estates Cabana Club</title>');
  has('og:title', h, '<meta property="og:title" content="Join Bishop Estates Cabana Club">');
  has('og:image', h, '<meta property="og:image" content="https://cdn.example.com/pool.jpg">');
  has('large image card', h, '<meta name="twitter:card" content="summary_large_image">');
  has('canonical', h, 'https://bishopestates.poolsideapp.com/join');
  has('price is on the card', h, 'from $600 a year');
  has('tagline is on the card', h, 'A neighborhood pool, run by neighbors.');
  lacks('never says Loading', h, 'Loading');
}

console.log('— the referral survives the click —');
{
  const h = renderSharePage(base);
  has('apply link carries the code', h, 'apply.html?ref=SMITH42');
  has('and the neighbor is told', h, 'they will be credited');
  const noRef = renderSharePage({ ...base, ref: null });
  has('no code, clean apply link', noRef, 'href="https://bishopestates.poolsideapp.com/apply.html"');
  lacks('and no credit line', noRef, 'will be credited');
}

console.log('— escaping, because club names go into meta attributes —');
{
  const nasty = renderSharePage({ ...base, displayName: 'Bob\'s "Pool" Club', heroTagline: '<script>alert(1)</script>' });
  lacks('no raw double quote breaking the attribute', nasty, 'content="Join Bob\'s "Pool" Club"');
  lacks('no raw script tag', nasty, '<script>alert(1)</script>');
  has('quotes entity-encoded', nasty, '&quot;Pool&quot;');
  has('apostrophe encoded', nasty, 'Bob&#39;s');
  has('script escaped', nasty, '&lt;script&gt;');
  t('esc handles all five', esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
}

console.log('— a club that has set nothing up —');
{
  const bare = renderSharePage({ slug: 'newclub', displayName: 'New Club' });
  has('still has a title', bare, '<title>Join New Club</title>');
  has('falls back to a sentence', bare, 'apply online in a few minutes');
  lacks('no empty og:image tag', bare, 'og:image');
  has('plain summary card instead', bare, '<meta name="twitter:card" content="summary">');
  has('brand color falls back', bare, '#0a3b5c');
}

console.log('— the price line —');
t('rounds to whole dollars', shareDescription({ displayName: 'X', fromCents: 59999 }), 'Family memberships from $600 a year.');
t('thousands separated',     shareDescription({ displayName: 'X', fromCents: 120000 }), 'Family memberships from $1,200 a year.');
t('no price, no claim',      shareDescription({ displayName: 'X', fromCents: 0 }), 'Join X — apply online in a few minutes.');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
