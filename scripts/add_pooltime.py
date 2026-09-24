#!/usr/bin/env python3
"""Put /js/pooltime.js on every club-facing page, idempotently.

It must run before any other script on the page (it sets the pool's time zone
as the default for every date shown), so it goes right after <title>, loaded
synchronously. Provider pages (/admin) and marketing pages are left alone —
they aren't about one pool.

    python3 scripts/add_pooltime.py [--dry-run]
"""
import pathlib, re, sys

TAG = '<script src="/js/pooltime.js"></script>'
ROOT = pathlib.Path(__file__).resolve().parent.parent
CLUB_DIRS = ('club', 'm')
CLUB_ROOT_PAGES = {'apply.html', 'renew.html', 'governance.html'}

dry = '--dry-run' in sys.argv
added = already = skipped = 0

pages = sorted(p for d in CLUB_DIRS for p in (ROOT / d).rglob('*.html'))
pages += sorted(ROOT / n for n in CLUB_ROOT_PAGES)
for f in pages:
    rel = f.relative_to(ROOT)
    s = f.read_text()
    if TAG in s:
        already += 1
        continue
    if 'name="robots" content="noindex"' in s and len(s) < 2000:
        skipped += 1   # retired redirect stubs
        continue
    m = re.search(r'</title>', s, re.I)
    if not m:
        skipped += 1
        print(f'  skip (no <title>): {rel}')
        continue
    s = s[:m.end()] + '\n' + TAG + s[m.end():]
    if not dry:
        f.write_text(s)
    added += 1
    print(f'  {"would add" if dry else "added"}: {rel}')

print(f'\n{added} page(s) {"would be " if dry else ""}updated, {already} already had it, {skipped} skipped')
