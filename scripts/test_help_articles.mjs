#!/usr/bin/env node
// Targeted check for the board's help articles (PLAN.md AY1, Doug 10/19:
// "the FAQ area would be really helpful to QC this and make sure that
// everything is on there we need"). Offline: reads the articles, the Help
// page and the board pages. Costs nothing.
//
// What it catches:
//   - an article on disk the Help page doesn't list, or the other way round
//   - an article with no title, or a category the page doesn't order
//   - a menu path in bold ("**Money → Upcoming**") that isn't a real path:
//     the first step is a section or a page, and each next step is a page
//     in that section, or a heading, button or label on that page
//   - any other bold UI name ("**Save changes**") that appears nowhere in
//     the app's screens
//
// Usage: node scripts/test_help_articles.mjs
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

// Words only: emoji, arrows, punctuation and case don't matter.
const norm = s => String(s).toLowerCase()
  .replace(/&amp;/g, '&').replace(/&#39;|’/g, "'")
  .replace(/[^\p{L}\p{N}&'$%.]+/gu, ' ').replace(/\s+/g, ' ').trim();
const textOf = html => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ');
// Every heading, summary, button, label, option and tab on a page.
function uiStrings(html) {
  const out = new Set();
  const body = textOf(html);
  // One pass per tag, so a heading inside a card is still found on its own.
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'summary', 'button', 'label', 'option', 'a', 'th', 'span', 'b', 'div']) {
    for (const m of body.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g'))) {
      const t = norm(m[1].replace(/<[^>]+>/g, ' '));
      if (t && t.length <= 160) out.add(t);
    }
  }
  return out;
}
const ADMIN = 'club/admin/';
const pages = Object.fromEntries(readdirSync(new URL(ADMIN, root)).filter(f => f.endsWith('.html')).map(f => [f, read(ADMIN + f)]));
const pageUi = Object.fromEntries(Object.entries(pages).map(([f, h]) => [f, uiStrings(h)]));
// Screens and strings drawn by scripts (the passes panel, the bottom bar,
// pop-up prompts) and the member side the articles describe.
const extra = ['js/passes.js', 'js/admin-subtabs.js', 'js/admin-push.js', 'js/plan-picker.js', 'js/renew-sign.js', 'js/handoff.js',
  'm/index.html', 'm/login.html', 'm/family.html', 'm/renew.html', 'apply.html', 'renew.html', 'pass.html', 'club/index.html']
  .map(read).join('\n');
// Tags removed, so a label split across tags ("What it's for <span>(optional)</span>") reads whole.
const corpus = norm((Object.values(pages).join('\n') + '\n' + extra).replace(/<[^>]+>/g, ' '));

// The board's menu: sections and the pages under each (js/admin-subtabs.js).
const nav = read('js/admin-subtabs.js');
const sections = {};
for (const m of nav.matchAll(/(\w+):\s*\[\s*'([^']+)',\s*'([^']+)',\s*'\/club\/admin\/([\w-]+\.html)'\s*\]/g)) sections[norm(m[3])] = { key: m[1], page: m[4], subs: {} };
const secKeyToName = Object.fromEntries(Object.entries(sections).map(([n, s]) => [s.key, n]));
const secBody = nav.match(/const SECTIONS = \{([\s\S]*?)\n  \};/)[1];
for (const block of secBody.matchAll(/\n\s{4}(\w+):\s*\[([\s\S]*?)\n\s{4}\],/g)) {
  const name = secKeyToName[block[1]];
  if (!name) continue;
  for (const it of block[2].matchAll(/label:\s*'([^']+)',\s*href:\s*'\/club\/admin\/([\w-]+\.html)/g)) sections[name].subs[norm(it[1])] = it[2];
}
const allSubs = Object.assign({}, ...Object.values(sections).map(s => s.subs));
const HOME = 'index.html';
// A step names a thing on a page if a heading, button or label there starts
// with it (headings often run on: "Season — dates, signups open or closed").
const pageWords = Object.fromEntries(Object.entries(pages).map(([f, h]) => [f, ` ${norm(h)} `]));
const onPage = (page, step) => [...(pageUi[page] || [])].some(t => t === step || t.startsWith(step + ' ') || t.endsWith(' ' + step))
  || (pageWords[page] || '').includes(` ${step} `);   // drawn by the page's script

function pathProblem(parts) {
  const steps = parts.map(norm);
  let page = null, section = null;
  const [first] = steps;
  if (first === 'home') page = HOME;
  else if (sections[first]) { section = sections[first]; page = section.page; }
  else if (allSubs[first]) page = allSubs[first];
  else return `"${parts[0]}" isn't a section or page in the board menu`;
  for (let i = 1; i < steps.length; i++) {
    const s = steps[i];
    if (section && section.subs[s]) { page = section.subs[s]; section = null; continue; }
    if (onPage(page, s)) { section = null; continue; }
    return `"${parts[i]}" isn't on ${page}`;
  }
  return null;
}

// ── The articles ──────────────────────────────────────────────────────────
const help = read('club/admin/help.html');
const listed = [...help.match(/const ARTICLE_FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([\w-]+\.md)'/g)].map(m => m[1]);
const order = [...help.match(/const CATEGORY_ORDER = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
const onDisk = readdirSync(new URL(`${ADMIN}help/articles/`, root)).filter(f => f.endsWith('.md'));

console.log('AY1 · the help articles match the app');
check('every article on disk is listed on the Help page', onDisk.every(f => listed.includes(f)), onDisk.filter(f => !listed.includes(f)).join(', '));
check('every listed article exists', listed.every(f => onDisk.includes(f)), listed.filter(f => !onDisk.includes(f)).join(', '));
check('no article is listed twice', new Set(listed).size === listed.length);
const synonyms = Object.keys(Object.fromEntries([...help.match(/const SYNONYMS = \{([\s\S]*?)\n\};/)[1].matchAll(/'([\w-]+)':\s*\[/g)].map(m => [m[1], 1])));
check('search words exist only for real articles', synonyms.every(s => onDisk.includes(`${s}.md`)), synonyms.filter(s => !onDisk.includes(`${s}.md`)).join(', '));

const problems = [];
for (const f of onDisk) {
  const raw = read(`${ADMIN}help/articles/${f}`);
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fm) { problems.push(`${f}: no title and category at the top`); continue; }
  const title = fm[1].match(/^title:\s*"([^"]+)"/m)?.[1];
  const cat = fm[1].match(/^category:\s*"([^"]+)"/m)?.[1];
  if (!title) problems.push(`${f}: no title`);
  if (!cat || !order.includes(cat)) problems.push(`${f}: category "${cat}" isn't in CATEGORY_ORDER`);
  for (const m of fm[2].matchAll(/\*\*([^*]+)\*\*/g)) {
    const b = m[1].trim();
    const parts = b.split('→').map(x => x.trim()).filter(Boolean);
    if (parts.length > 1) {          // a menu path; a lone trailing arrow is part of a button's name
      const p = pathProblem(parts);
      if (p) problems.push(`${f}: **${b}**: ${p}`);
    } else if (!/^[\d$%.,:\s]+$/.test(b) && !corpus.includes(norm(b))) {
      problems.push(`${f}: **${b}** isn't anywhere in the app`);
    }
  }
}
check('every bold path and button in the articles is real', problems.length === 0, '\n      ' + problems.join('\n      '));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
