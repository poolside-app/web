// Load a Supabase Edge Function helper (.ts, Deno-style relative imports)
// into Node for offline tests. Types are stripped and each relative .ts
// import is built the same way, into a temp folder. Only for helpers whose
// imports are other local .ts files (type-only remote imports are fine).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const OUT = join(tmpdir(), `poolside-ts-${process.pid}`);
const built = new Map();

function build(abs) {
  if (built.has(abs)) return built.get(abs);
  const target = join(OUT, abs.replace(/[\\/:]/g, '_') + '.mjs');
  built.set(abs, target);
  let js = stripTypeScriptTypes(readFileSync(abs, 'utf8'), { mode: 'strip' });
  js = js.replace(/(from\s+|import\s*\(\s*)(['"])(\.{1,2}\/[^'"]+\.ts)\2/g,
    (_m, pre, q, rel) => `${pre}${q}${pathToFileURL(build(resolve(dirname(abs), rel))).href}${q}`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(target, js);
  return target;
}

/** importTs(new URL('../supabase/functions/_shared/x.ts', import.meta.url)) */
export function importTs(url) {
  return import(pathToFileURL(build(fileURLToPath(url))).href);
}
