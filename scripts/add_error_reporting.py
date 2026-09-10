#!/usr/bin/env python3
"""Put /js/errors.js on every page, idempotently.

Runs early and with `defer` so it is parsed before the page's own inline
scripts execute but does not block rendering. Skips the retired redirect
stubs, which have no content to break.

    python3 scripts/add_error_reporting.py [--dry-run]
"""
import pathlib, re, sys

TAG = '<script src="/js/errors.js" defer></script>'
ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIP_DIRS = {'node_modules', '.git', 'Poolside design', 'club-demo'}

dry = '--dry-run' in sys.argv
added = skipped = already = 0

for f in sorted(ROOT.rglob('*.html')):
    rel = f.relative_to(ROOT)
    if any(part in SKIP_DIRS for part in rel.parts):
        continue
    s = f.read_text()
    if TAG in s:
        already += 1
        continue
    # Retired stubs are ~20 lines of redirect and have no scripts worth watching.
    if 'name="robots" content="noindex"' in s and len(s) < 2000:
        skipped += 1
        continue
    m = re.search(r'</title>', s, re.I)
    if not m:
        skipped += 1
        print(f'  skip (no <title>): {rel}')
        continue
    i = m.end()
    s = s[:i] + '\n' + TAG + s[i:]
    if not dry:
        f.write_text(s)
    added += 1
    print(f'  {"would add" if dry else "added"}: {rel}')

print(f'\n{added} page(s) {"would be " if dry else ""}updated, {already} already had it, {skipped} skipped')
