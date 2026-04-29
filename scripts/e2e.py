#!/usr/bin/env python3
"""
End-to-end test of the applications pipeline.

Mints a synthetic tenant_admin JWT (no provider login needed) and walks the
full apply → review → verify → reminder → cleanup flow against bishopestates.

Run from the repo root:   python scripts/e2e.py
Exits 0 on all-green, 1 on any failure.
"""
import os, sys, time, json, hmac, hashlib, base64, uuid, urllib.request, urllib.parse, urllib.error

ENV = {}
with open('.env.local', 'r') as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k, _, v = line.partition('=')
        ENV[k.strip()] = v.strip()

SUPABASE_URL = ENV.get('SUPABASE_URL', '').rstrip('/')
SECRET_KEY   = ENV.get('SUPABASE_SECRET_KEY')
JWT_SECRET   = ENV.get('ADMIN_JWT_SECRET')
ACCESS_TOKEN = ENV.get('SUPABASE_ACCESS_TOKEN')
PROJECT_REF  = ENV.get('SUPABASE_PROJECT_REF', 'sdewylbddkcvidwosgxo')

if not (SUPABASE_URL and JWT_SECRET):
    print('Missing SUPABASE_URL or ADMIN_JWT_SECRET in .env.local')
    sys.exit(1)

# ── Tiny HTTP + JWT helpers ──────────────────────────────────────────────
def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()

def mint_tenant_admin_jwt(tid: str, slug: str) -> str:
    payload = {
        'sub':  '00000000-0000-0000-0000-000000000000',
        'kind': 'tenant_admin',
        'tid':  tid,
        'slug': slug,
        'synthetic':       True,
        'impersonated_by': '00000000-0000-0000-0000-000000000000',
        'exp': int(time.time()) + 3600,
    }
    h = b64url(json.dumps({'alg':'HS256','typ':'JWT'}, separators=(',',':')).encode())
    p = b64url(json.dumps(payload, separators=(',',':')).encode())
    sig = hmac.new(JWT_SECRET.encode(), f'{h}.{p}'.encode(), hashlib.sha256).digest()
    return f'{h}.{p}.{b64url(sig)}'

def post(url: str, body: dict, token: str | None = None) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method='POST')
    req.add_header('Content-Type', 'application/json')
    if token: req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:    return json.loads(e.read().decode())
        except: return {'ok': False, 'error': f'HTTP {e.code}'}

def mgmt_query(sql: str) -> list:
    """Run SQL via Supabase Management API for setup/teardown bypass-of-RLS."""
    if not ACCESS_TOKEN:
        raise RuntimeError('SUPABASE_ACCESS_TOKEN not set — needed for cleanup')
    url = f'https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query'
    req = urllib.request.Request(url, data=json.dumps({'query': sql}).encode(), method='POST')
    req.add_header('Authorization', f'Bearer {ACCESS_TOKEN}')
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

# ── Test runner ──────────────────────────────────────────────────────────
ok_count = 0; fail_count = 0
def step(name, fn):
    global ok_count, fail_count
    t0 = time.time()
    try:
        fn()
        dt = int((time.time() - t0) * 1000)
        print(f'  \033[32m✓\033[0m {name} ({dt}ms)')
        ok_count += 1
        return True
    except Exception as e:
        dt = int((time.time() - t0) * 1000)
        print(f'  \033[31m✗\033[0m {name} ({dt}ms) — {e}')
        fail_count += 1
        return False

# ── Discover tenant id ───────────────────────────────────────────────────
TENANT_SLUG = 'bishopestates'
res = post(f'{SUPABASE_URL}/functions/v1/tenant_public', {'slug': TENANT_SLUG})
if not res.get('ok'):
    print(f'Could not look up {TENANT_SLUG}: {res}'); sys.exit(1)

# Use Management API to grab the tenant_id (tenant_public strips it)
rows = mgmt_query(f"select id from public.tenants where slug = '{TENANT_SLUG}' limit 1;")
if not rows: print('Tenant not found in DB'); sys.exit(1)
TENANT_ID = rows[0]['id']
TOKEN = mint_tenant_admin_jwt(TENANT_ID, TENANT_SLUG)

print(f'\nE2E against tenant: {TENANT_SLUG} ({TENANT_ID})\n')
print('── Applications pipeline ──')

stamp   = str(int(time.time()))[-6:]
APP_FAM = f'E2E Family {stamp}'
APP_NAME = f'E2E Tester {stamp}'
APP_EMAIL = f'e2e-{stamp}@example.com'
APP_PHONE = f'+1555{stamp}{stamp[-4:]}'[:14]  # +1 555 NNNNNN-NNNN unique-ish
APP_ID    = None
HH_ID     = None

def submit():
    global APP_ID
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {
        'action': 'submit', 'slug': TENANT_SLUG,
        'family_name': APP_FAM, 'primary_name': APP_NAME,
        'primary_email': APP_EMAIL, 'primary_phone': APP_PHONE,
        'num_adults': 2, 'num_kids': 1,
        'payment_method': 'venmo',
        'body': 'E2E test — please ignore',
    })
    if not r.get('ok'): raise RuntimeError(r.get('error', 'submit failed'))
    APP_ID = r['application_id']

def list_pending():
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {'action': 'list', 'status': 'pending'}, TOKEN)
    if not r.get('ok'): raise RuntimeError(r.get('error', 'list failed'))
    if not any(a['id'] == APP_ID for a in r.get('applications', [])):
        raise RuntimeError('our application not in pending list')

def approve():
    global HH_ID
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {
        'action': 'approve', 'id': APP_ID,
        'override': {'tier': 'family'},
    }, TOKEN)
    if not r.get('ok'): raise RuntimeError(r.get('error', 'approve failed'))
    HH_ID = r['household_id']
    if not r.get('welcome_dev_link') and not r.get('welcome_sent'):
        raise RuntimeError('welcome email path skipped — no Resend AND no dev_link')

def list_approved_unpaid():
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {'action': 'list', 'status': 'approved', 'filter': 'unpaid'}, TOKEN)
    if not r.get('ok'): raise RuntimeError(r.get('error', 'list failed'))
    ours = next((a for a in r.get('applications', []) if a['id'] == APP_ID), None)
    if not ours: raise RuntimeError('our approved app not in unpaid list')
    if ours['payment_status'] == 'paid': raise RuntimeError('shouldn\'t be paid yet')

def reminder():
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {'action': 'send_reminder', 'id': APP_ID}, TOKEN)
    if not r.get('ok'): raise RuntimeError(r.get('error', 'reminder failed'))

def verify_payment():
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {'action': 'verify_payment', 'id': APP_ID, 'method': 'venmo', 'note': 'E2E verify'}, TOKEN)
    if not r.get('ok'): raise RuntimeError(r.get('error', 'verify failed'))

def confirm_paid():
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {'action': 'list', 'status': 'approved'}, TOKEN)
    if not r.get('ok'): raise RuntimeError(r.get('error'))
    ours = next((a for a in r.get('applications', []) if a['id'] == APP_ID), None)
    if not ours: raise RuntimeError('lost track of our application')
    if ours['payment_status'] != 'paid': raise RuntimeError(f'expected paid, got {ours["payment_status"]}')

def household_dues_flipped():
    rows = mgmt_query(f"select dues_paid_for_year from public.households where id = '{HH_ID}' limit 1;")
    if not rows or not rows[0].get('dues_paid_for_year'):
        raise RuntimeError('household.dues_paid_for_year did NOT flip true')

def audit_log():
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {'action': 'log', 'id': APP_ID}, TOKEN)
    if not r.get('ok'): raise RuntimeError(r.get('error'))
    kinds = {x['kind'] for x in r.get('log', [])}
    expected = {'reminder_sent', 'venmo_verified', 'welcome_sent'}
    missing = expected - kinds
    if missing: raise RuntimeError(f'missing audit kinds: {missing}')

def cleanup():
    if HH_ID: mgmt_query(f"delete from public.households where id = '{HH_ID}';")
    if APP_ID: mgmt_query(f"delete from public.applications where id = '{APP_ID}';")

step('public submit',                       submit)
step('admin sees in pending list',          list_pending)
step('approve creates household',           approve)
step('approved + unpaid list shows it',     list_approved_unpaid)
step('send_reminder',                       reminder)
step('verify_payment (Venmo manual)',       verify_payment)
step('application now marked paid',         confirm_paid)
step('household.dues_paid_for_year flipped', household_dues_flipped)
step('audit log has welcome+reminder+verify', audit_log)
step('cleanup',                             cleanup)

print()
total = ok_count + fail_count
if fail_count == 0:
    print(f'\033[32m{ok_count}/{total} green\033[0m')
    sys.exit(0)
else:
    print(f'\033[31m{fail_count}/{total} failed\033[0m')
    sys.exit(1)
