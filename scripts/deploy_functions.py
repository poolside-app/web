#!/usr/bin/env python3
"""Deploy Edge Functions from disk through the Management API, then call each
once to prove it boots (a BOOT_ERROR shows here, not at a family's tap).

The recipe in .claude/skills/deploy/SKILL.md, as a script: every
_shared/*.ts goes with each function (covers transitive imports), paths stay
repo-relative, verify_jwt stays false (Poolside checks its own tokens).

Usage: python3 scripts/deploy_functions.py <slug> [<slug> ...]
"""
import json, os, sys, glob, uuid, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = 'sdewylbddkcvidwosgxo'


def env():
    out = {}
    with open(os.path.join(ROOT, '.env.local'), encoding='utf-8') as f:
        for line in f.read().splitlines():
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                out[k.strip()] = v.strip()
    return out


def multipart(fields, files):
    boundary = uuid.uuid4().hex
    body = b''
    for name, value, ctype in fields:
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n'
                 f'Content-Type: {ctype}\r\n\r\n').encode() + value.encode() + b'\r\n'
    for rel in files:
        with open(os.path.join(ROOT, rel), 'rb') as f:
            data = f.read()
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{rel}"\r\n'
                 f'Content-Type: application/typescript\r\n\r\n').encode() + data + b'\r\n'
    body += f'--{boundary}--\r\n'.encode()
    return body, f'multipart/form-data; boundary={boundary}'


def deploy(slug, token, supabase_url):
    entry = f'supabase/functions/{slug}/index.ts'
    if not os.path.exists(os.path.join(ROOT, entry)):
        return f'{slug}: no {entry}'
    shared = sorted(os.path.relpath(p, ROOT) for p in glob.glob(os.path.join(ROOT, 'supabase/functions/_shared/*.ts')))
    meta = json.dumps({'name': slug, 'entrypoint_path': entry, 'verify_jwt': False})
    body, ctype = multipart([('metadata', meta, 'application/json')], [entry] + shared)
    req = urllib.request.Request(f'https://api.supabase.com/v1/projects/{PROJECT}/functions/deploy?slug={slug}',
                                 data=body, method='POST', headers={'Authorization': f'Bearer {token}', 'Content-Type': ctype,
                                                                     'User-Agent': 'poolside-deploy/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            status = r.status
    except urllib.error.HTTPError as e:
        return f'{slug} deploy failed {e.code}: {e.read()[:300].decode(errors="replace")}'
    # One call with no sign-in: the function's own answer means it booted.
    boot = urllib.request.Request(f'{supabase_url}/functions/v1/{slug}', data=b'{}', method='POST',
                                  headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(boot, timeout=60) as r:
            said = r.read()[:90].decode(errors='replace')
    except urllib.error.HTTPError as e:
        said = e.read()[:90].decode(errors='replace')
    except Exception as e:  # noqa: BLE001
        said = f'no answer ({e})'
    return f'{slug} {status} | boot: {said}'


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    e = env()
    for slug in sys.argv[1:]:
        print(deploy(slug, e['SUPABASE_ACCESS_TOKEN'], e['SUPABASE_URL']), flush=True)
