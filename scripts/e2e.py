#!/usr/bin/env python3
"""
End-to-end test suite for Poolside.

Mints synthetic tenant_admin + provider JWTs (no browser needed) and
exercises the major code paths against the live Supabase + Vercel
deploys. Real DB writes; each test cleans up after itself.

Run from the repo root:   python scripts/e2e.py
Exits 0 on all-green, 1 on any failure.
"""
import os, sys, time, json, hmac, hashlib, base64, uuid
import urllib.request, urllib.parse, urllib.error

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

ENV = {}
with open('.env.local', 'r') as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k, _, v = line.partition('=')
        ENV[k.strip()] = v.strip()

SUPABASE_URL = ENV.get('SUPABASE_URL', '').rstrip('/')
JWT_SECRET   = ENV.get('ADMIN_JWT_SECRET')
ACCESS_TOKEN = ENV.get('SUPABASE_ACCESS_TOKEN')
PROJECT_REF  = ENV.get('SUPABASE_PROJECT_REF', 'sdewylbddkcvidwosgxo')

if not (SUPABASE_URL and JWT_SECRET and ACCESS_TOKEN):
    print('Missing SUPABASE_URL / ADMIN_JWT_SECRET / SUPABASE_ACCESS_TOKEN in .env.local')
    sys.exit(1)

UA = 'poolside-e2e/1.0'  # default urllib UA gets blocked by some APIs

def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()

def sign_jwt(payload: dict) -> str:
    h = b64url(json.dumps({'alg':'HS256','typ':'JWT'}, separators=(',',':')).encode())
    p = b64url(json.dumps(payload, separators=(',',':')).encode())
    sig = hmac.new(JWT_SECRET.encode(), f'{h}.{p}'.encode(), hashlib.sha256).digest()
    return f'{h}.{p}.{b64url(sig)}'

def tenant_admin_jwt(tid: str, slug: str) -> str:
    return sign_jwt({
        'sub':  '00000000-0000-0000-0000-000000000000',
        'kind': 'tenant_admin',
        'tid': tid, 'slug': slug,
        'synthetic': True,
        'impersonated_by': '00000000-0000-0000-0000-000000000000',
        'exp': int(time.time()) + 3600,
    })

def member_jwt(member_id: str, tid: str, slug: str, hid: str) -> str:
    return sign_jwt({
        'sub': member_id, 'kind': 'member',
        'tid': tid, 'slug': slug, 'hid': hid,
        'exp': int(time.time()) + 3600,
    })

def provider_jwt(provider_id: str) -> str:
    return sign_jwt({
        'sub': provider_id, 'kind': 'provider',
        'exp': int(time.time()) + 3600,
    })

def post(url: str, body: dict, token: str | None = None) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('User-Agent', UA)
    if token: req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:    return json.loads(e.read().decode())
        except: return {'ok': False, 'error': f'HTTP {e.code}'}

def get(url: str) -> str:
    """GET → returns body as string. Use get_bytes for binary content."""
    return get_bytes(url).decode('utf-8', errors='replace')

def get_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, method='GET')
    req.add_header('User-Agent', UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()

def mgmt_query(sql: str) -> list:
    url = f'https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query'
    req = urllib.request.Request(url, data=json.dumps({'query': sql}).encode(), method='POST')
    req.add_header('Authorization', f'Bearer {ACCESS_TOKEN}')
    req.add_header('Content-Type', 'application/json')
    req.add_header('User-Agent', UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

# A 1×1 transparent PNG, base64-encoded — used for the upload test
TINY_PNG_B64 = (
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8'
    'AAAAASUVORK5CYII='
)

# ── Test runner ──────────────────────────────────────────────────────────
ok_count = 0; fail_count = 0
current_section = ''

def section(name):
    global current_section
    current_section = name
    print(f'\n-- {name} --')

def step(name, fn):
    global ok_count, fail_count
    t0 = time.time()
    try:
        fn()
        dt = int((time.time() - t0) * 1000)
        print(f'  \033[32mOK\033[0m {name} ({dt}ms)')
        ok_count += 1
        return True
    except AssertionError as e:
        dt = int((time.time() - t0) * 1000)
        print(f'  \033[31mFAIL\033[0m {name} ({dt}ms) — {e}')
        fail_count += 1
        return False
    except Exception as e:
        dt = int((time.time() - t0) * 1000)
        print(f'  \033[31mERR\033[0m  {name} ({dt}ms) — {type(e).__name__}: {e}')
        fail_count += 1
        return False

# ── Setup: discover real ids ─────────────────────────────────────────────
SLUG_A = 'bishopestates'
print(f'\nE2E suite for Poolside ({SUPABASE_URL})')

rows = mgmt_query(f"select id from public.tenants where slug = '{SLUG_A}' limit 1;")
if not rows: print('Tenant A not found'); sys.exit(1)
TENANT_A_ID = rows[0]['id']

# Find Doug's provider_admin id (for provider_metrics tests)
prov_rows = mgmt_query("select id from public.provider_admins where active = true order by created_at limit 1;")
PROVIDER_ID = prov_rows[0]['id'] if prov_rows else None

# Spin up an isolated test tenant ('e2etest-{stamp}') for isolation testing.
STAMP = str(int(time.time()))[-6:]
SLUG_B = f'e2etest{STAMP}'
mgmt_query(f"""
  insert into public.tenants (slug, display_name, status, plan)
  values ('{SLUG_B}', 'E2E Test Tenant {STAMP}', 'trial', 'free');
""")
b_rows = mgmt_query(f"select id from public.tenants where slug = '{SLUG_B}' limit 1;")
TENANT_B_ID = b_rows[0]['id']

TOKEN_A = tenant_admin_jwt(TENANT_A_ID, SLUG_A)
TOKEN_B = tenant_admin_jwt(TENANT_B_ID, SLUG_B)

print(f'  tenant A: {SLUG_A} ({TENANT_A_ID[:8]}…)')
print(f'  tenant B: {SLUG_B} ({TENANT_B_ID[:8]}…)  [throwaway]')

# Track resources for cleanup
RESOURCES = {'households': [], 'events': [], 'posts': [], 'photos': [], 'documents': [], 'applications': []}
def track(kind, id):  RESOURCES[kind].append(id)

# ── 1. Cross-tenant isolation (THE most important) ───────────────────────
section('Isolation')

A_HOUSEHOLD_ID = None

def isolation_create_in_a():
    global A_HOUSEHOLD_ID
    r = post(f'{SUPABASE_URL}/functions/v1/households_admin', {
        'action': 'create_household',
        'family_name': f'Isolation Test {STAMP}',
        'primary': {'name': f'Iso {STAMP}', 'phone_e164': f'+1555{STAMP}0001'},
    }, TOKEN_A)
    assert r.get('ok'), f'create in A: {r}'
    A_HOUSEHOLD_ID = r['household_id']
    track('households', A_HOUSEHOLD_ID)

def isolation_b_cannot_see_a():
    r = post(f'{SUPABASE_URL}/functions/v1/households_admin', {'action': 'list'}, TOKEN_B)
    assert r.get('ok'), f'list with B: {r}'
    found = any(h['id'] == A_HOUSEHOLD_ID for h in r.get('households', []))
    assert not found, 'Tenant B sees Tenant A\'s household — ISOLATION BREACH'

def isolation_b_cannot_update_a():
    r = post(f'{SUPABASE_URL}/functions/v1/households_admin', {
        'action': 'update_household', 'id': A_HOUSEHOLD_ID, 'family_name': 'HACKED',
    }, TOKEN_B)
    # Endpoint may return ok:true/noop or error — what matters is the row didn't change
    rows = mgmt_query(f"select family_name from public.households where id = '{A_HOUSEHOLD_ID}';")
    assert rows and rows[0]['family_name'] != 'HACKED', 'Tenant B updated Tenant A\'s household — BREACH'

def isolation_b_cannot_delete_a():
    r = post(f'{SUPABASE_URL}/functions/v1/households_admin', {
        'action': 'delete_household', 'id': A_HOUSEHOLD_ID,
    }, TOKEN_B)
    rows = mgmt_query(f"select active from public.households where id = '{A_HOUSEHOLD_ID}';")
    assert rows and rows[0]['active'] is True, 'Tenant B soft-deleted Tenant A\'s household — BREACH'

def isolation_a_still_owns_data():
    r = post(f'{SUPABASE_URL}/functions/v1/households_admin', {'action': 'list'}, TOKEN_A)
    assert r.get('ok')
    assert any(h['id'] == A_HOUSEHOLD_ID for h in r.get('households', [])), 'Tenant A lost their own data'

step('create household in tenant A',          isolation_create_in_a)
step('tenant B list does NOT see A\'s data',  isolation_b_cannot_see_a)
step('tenant B update on A\'s id is no-op',   isolation_b_cannot_update_a)
step('tenant B delete on A\'s id is no-op',   isolation_b_cannot_delete_a)
step('tenant A still owns their data',         isolation_a_still_owns_data)

# ── 2. Upload pipeline ───────────────────────────────────────────────────
section('Upload pipeline')

UPLOADED_URL = None

def upload_image():
    global UPLOADED_URL
    r = post(f'{SUPABASE_URL}/functions/v1/tenant_upload', {
        'filename': 'e2e-test.png',
        'content_type': 'image/png',
        'base64': TINY_PNG_B64,
    }, TOKEN_A)
    assert r.get('ok'), f'upload: {r}'
    assert r.get('url', '').startswith('https://'), 'no URL returned'
    UPLOADED_URL = r['url']

def upload_url_serves():
    body = get_bytes(UPLOADED_URL)
    assert len(body) > 0, 'uploaded URL empty'
    assert body[:8] == b'\x89PNG\r\n\x1a\n', 'uploaded file not a PNG'  # PNG magic header

def upload_rejects_anon():
    r = post(f'{SUPABASE_URL}/functions/v1/tenant_upload', {
        'filename': 'x.png', 'content_type': 'image/png', 'base64': TINY_PNG_B64,
    })
    assert not r.get('ok'), 'upload should reject anon'

step('tenant_upload accepts a 1×1 PNG',  upload_image)
step('uploaded URL serves the file',      upload_url_serves)
step('tenant_upload rejects anon',        upload_rejects_anon)

# ── 3. Photos CRUD + public surface ──────────────────────────────────────
section('Photos')

PHOTO_ID = None

def photo_create():
    global PHOTO_ID
    r = post(f'{SUPABASE_URL}/functions/v1/photos_admin', {
        'action': 'create',
        'url': UPLOADED_URL,
        'caption': f'E2E test photo {STAMP}',
    }, TOKEN_A)
    assert r.get('ok'), f'create photo: {r}'
    PHOTO_ID = r['photo']['id']
    track('photos', PHOTO_ID)

def photo_in_public():
    r = post(f'{SUPABASE_URL}/functions/v1/tenant_public', {'slug': SLUG_A})
    assert r.get('ok')
    assert any(p['id'] == PHOTO_ID for p in r.get('photos', [])), 'photo not on public surface'

def photo_delete():
    r = post(f'{SUPABASE_URL}/functions/v1/photos_admin', {'action': 'delete', 'id': PHOTO_ID}, TOKEN_A)
    assert r.get('ok'), f'delete: {r}'

def photo_gone_from_public():
    r = post(f'{SUPABASE_URL}/functions/v1/tenant_public', {'slug': SLUG_A})
    assert not any(p['id'] == PHOTO_ID for p in r.get('photos', [])), 'soft-deleted photo still public'

step('create photo from uploaded URL',  photo_create)
step('photo appears on public surface',  photo_in_public)
step('soft-delete photo',                 photo_delete)
step('photo gone from public surface',    photo_gone_from_public)

# ── 4. Documents CRUD + visibility filter ────────────────────────────────
section('Documents')

DOC_ID = None

def doc_create_admin_only():
    global DOC_ID
    r = post(f'{SUPABASE_URL}/functions/v1/documents_admin', {
        'action': 'create', 'url': UPLOADED_URL,
        'title': f'Admin-only doc {STAMP}', 'visibility': 'admins',
    }, TOKEN_A)
    assert r.get('ok'), f'create: {r}'
    DOC_ID = r['document']['id']
    track('documents', DOC_ID)

def admin_only_doc_NOT_in_public():
    r = post(f'{SUPABASE_URL}/functions/v1/tenant_public', {'slug': SLUG_A})
    assert not any(d['id'] == DOC_ID for d in r.get('documents', [])), 'admins-only doc leaked to public'

def update_to_public():
    r = post(f'{SUPABASE_URL}/functions/v1/documents_admin', {
        'action': 'update', 'id': DOC_ID, 'visibility': 'public',
    }, TOKEN_A)
    assert r.get('ok')

def now_in_public():
    r = post(f'{SUPABASE_URL}/functions/v1/tenant_public', {'slug': SLUG_A})
    assert any(d['id'] == DOC_ID for d in r.get('documents', [])), 'visibility=public didn\'t surface'

def doc_cleanup():
    post(f'{SUPABASE_URL}/functions/v1/documents_admin', {'action': 'delete', 'id': DOC_ID}, TOKEN_A)

step('create admin-only document',         doc_create_admin_only)
step('admin doc NOT on public surface',    admin_only_doc_NOT_in_public)
step('flip visibility to public',          update_to_public)
step('public doc appears on public surface', now_in_public)
step('soft-delete document',               doc_cleanup)

# ── 5. Events with recurrence ────────────────────────────────────────────
section('Events (recurring)')

EVENT_ID = None

def event_create_weekly():
    global EVENT_ID
    starts = (time.gmtime(time.time() + 7 * 86400))
    starts_iso = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', starts)
    r = post(f'{SUPABASE_URL}/functions/v1/events_admin', {
        'action': 'create',
        'title': f'Weekly Yoga {STAMP}',
        'kind': 'lesson',
        'starts_at': starts_iso,
        'recurrence': 'weekly',
    }, TOKEN_A)
    assert r.get('ok'), f'create: {r}'
    EVENT_ID = r['event']['id']
    track('events', EVENT_ID)
    assert r['event'].get('recurrence') == 'weekly', f'recurrence not stored: {r["event"]}'

def event_in_public_with_recurrence():
    r = post(f'{SUPABASE_URL}/functions/v1/tenant_public', {'slug': SLUG_A})
    ours = next((e for e in r.get('events', []) if e['id'] == EVENT_ID), None)
    assert ours, 'recurring event not on public surface'
    assert ours.get('recurrence') == 'weekly', 'recurrence field not exposed publicly'

def event_in_ical():
    body = get(f'{SUPABASE_URL}/functions/v1/tenant_calendar_ics?slug={SLUG_A}')
    assert 'BEGIN:VCALENDAR' in body, 'ical missing VCALENDAR'
    assert f'Weekly Yoga {STAMP}' in body, 'event title not in ical feed'

def event_cleanup():
    post(f'{SUPABASE_URL}/functions/v1/events_admin', {'action': 'delete', 'id': EVENT_ID}, TOKEN_A)

step('create weekly recurring event',       event_create_weekly)
step('recurring event on public surface',   event_in_public_with_recurrence)
step('event also appears in iCal feed',     event_in_ical)
step('soft-delete event',                    event_cleanup)

# ── 6. Settings round-trip preservation ─────────────────────────────────
section('Settings round-trip')

def settings_round_trip():
    # Read current
    r = post(f'{SUPABASE_URL}/functions/v1/tenant_settings', {'action': 'get'}, TOKEN_A)
    assert r.get('ok'), f'get: {r}'
    before = r.get('settings') or {}

    # Add a marker key alongside, then save
    marker_key = f'_e2e_marker_{STAMP}'
    new_value = dict(before); new_value[marker_key] = 'temp'
    r2 = post(f'{SUPABASE_URL}/functions/v1/tenant_settings', {
        'action': 'save', 'value': new_value,
    }, TOKEN_A)
    assert r2.get('ok'), f'save: {r2}'

    # Re-read; marker should be present AND all old keys
    r3 = post(f'{SUPABASE_URL}/functions/v1/tenant_settings', {'action': 'get'}, TOKEN_A)
    assert r3.get('ok')
    after = r3.get('settings') or {}
    assert after.get(marker_key) == 'temp', 'marker key missing after save'
    for k in before:
        if k == marker_key: continue
        assert k in after, f'lost key on round-trip: {k}'

    # Cleanup marker
    cleaned = {k: v for k, v in after.items() if k != marker_key}
    post(f'{SUPABASE_URL}/functions/v1/tenant_settings', {
        'action': 'save', 'value': cleaned,
    }, TOKEN_A)

step('settings save preserves unrelated keys', settings_round_trip)

# ── 7. tenant_metrics shape ─────────────────────────────────────────────
section('Metrics endpoints')

def tenant_metrics_shape():
    r = post(f'{SUPABASE_URL}/functions/v1/tenant_metrics', {'action': 'get'}, TOKEN_A)
    assert r.get('ok'), f'tenant_metrics: {r}'
    assert 'totals' in r and 'categories' in r, f'missing keys: {r.keys()}'
    assert isinstance(r['totals'].get('hours'), (int, float)), 'totals.hours not numeric'

step('tenant_metrics returns expected shape', tenant_metrics_shape)

if PROVIDER_ID:
    PROVIDER_TOKEN = provider_jwt(PROVIDER_ID)
    def provider_metrics_shape():
        r = post(f'{SUPABASE_URL}/functions/v1/provider_metrics', {}, PROVIDER_TOKEN)
        assert r.get('ok'), f'provider_metrics: {r}'
        for k in ('tenants', 'network', 'pipeline', 'recent_tenants'):
            assert k in r, f'missing top-level key: {k}'
        assert isinstance(r['tenants'].get('total'), int), 'tenants.total not int'
    step('provider_metrics returns expected shape', provider_metrics_shape)

    def provider_metrics_rejects_tenant_token():
        r = post(f'{SUPABASE_URL}/functions/v1/provider_metrics', {}, TOKEN_A)
        assert not r.get('ok'), 'provider_metrics should reject tenant_admin tokens'
    step('provider_metrics rejects a tenant token',  provider_metrics_rejects_tenant_token)

# ── 8. Applications full pipeline (welcome email, verify, reminder) ──────
section('Applications pipeline')

APP_ID = None
APP_HH_ID = None

def app_submit():
    global APP_ID
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {
        'action': 'submit', 'slug': SLUG_A,
        'family_name': f'Apps E2E {STAMP}', 'primary_name': f'Apps Tester {STAMP}',
        'primary_email': f'apps-e2e-{STAMP}@example.com',
        'primary_phone': f'+1555{STAMP}0009',
        'payment_method': 'venmo',
    })
    assert r.get('ok'), f'submit: {r}'
    APP_ID = r['application_id']
    track('applications', APP_ID)

def app_approve_creates_household_and_email():
    global APP_HH_ID
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {
        'action': 'approve', 'id': APP_ID, 'override': {'tier': 'family'},
    }, TOKEN_A)
    assert r.get('ok'), f'approve: {r}'
    APP_HH_ID = r['household_id']
    track('households', APP_HH_ID)
    # Either Resend sent it OR a dev_link came back. Both fine — just shouldn't be silently dropped.
    assert r.get('welcome_sent') or r.get('welcome_dev_link'), 'welcome email path skipped entirely'

def app_verify_flips_dues():
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {
        'action': 'verify_payment', 'id': APP_ID,
    }, TOKEN_A)
    assert r.get('ok'), f'verify: {r}'
    rows = mgmt_query(f"select dues_paid_for_year from public.households where id = '{APP_HH_ID}';")
    assert rows and rows[0].get('dues_paid_for_year') is True, 'dues didn\'t flip'

def app_reminder_blocked_when_paid():
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {
        'action': 'send_reminder', 'id': APP_ID,
    }, TOKEN_A)
    assert not r.get('ok'), 'reminder should refuse on already-paid'

def app_audit_log():
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {'action': 'log', 'id': APP_ID}, TOKEN_A)
    assert r.get('ok')
    kinds = {x['kind'] for x in r.get('log', [])}
    expected = {'welcome_sent', 'venmo_verified'}
    missing = expected - kinds
    assert not missing, f'missing audit kinds: {missing}'

step('submit application',                       app_submit)
step('approve creates household + welcome',     app_approve_creates_household_and_email)
step('verify_payment flips dues_paid',           app_verify_flips_dues)
step('reminder refuses when already paid',       app_reminder_blocked_when_paid)
step('audit log has welcome + venmo_verified',  app_audit_log)

# ── 9. Member auth start (no auth required path) ─────────────────────────
section('Member auth')

def member_start_generic_response():
    # Submit an email that doesn't exist — should still return ok+sent (privacy)
    r = post(f'{SUPABASE_URL}/functions/v1/member_auth', {
        'action': 'start', 'slug': SLUG_A, 'email': f'never-exists-{STAMP}@example.com',
    })
    assert r.get('ok'), f'start: {r}'

step('member_auth.start returns generic ok',  member_start_generic_response)

# ── 10. Audit log captures writes ────────────────────────────────────────
section('Audit log')

AUDIT_HH_ID = None

def audit_create_household():
    global AUDIT_HH_ID
    r = post(f'{SUPABASE_URL}/functions/v1/households_admin', {
        'action': 'create_household',
        'family_name': f'Audit Test {STAMP}',
        'primary': {'name': f'Audit {STAMP}', 'phone_e164': f'+1555{STAMP}1234'},
    }, TOKEN_A)
    assert r.get('ok'), f'create: {r}'
    AUDIT_HH_ID = r['household_id']
    track('households', AUDIT_HH_ID)

def audit_log_has_create():
    r = post(f'{SUPABASE_URL}/functions/v1/audit_admin', {'action': 'list', 'entity_type': 'household'}, TOKEN_A)
    assert r.get('ok'), f'audit list: {r}'
    found = any(e['entity_id'] == AUDIT_HH_ID and e['kind'] == 'household.create' for e in r.get('entries', []))
    assert found, 'household.create not in audit log'

def audit_rejects_anon():
    r = post(f'{SUPABASE_URL}/functions/v1/audit_admin', {'action': 'list'})
    assert not r.get('ok'), 'audit_admin should reject anon'

def audit_isolation():
    # Tenant B's audit log should NOT include tenant A's events
    r = post(f'{SUPABASE_URL}/functions/v1/audit_admin', {'action': 'list'}, TOKEN_B)
    assert r.get('ok')
    assert not any(e['entity_id'] == AUDIT_HH_ID for e in r.get('entries', [])), 'audit log leaks across tenants'

step('create household triggers audit',     audit_create_household)
step('audit log has household.create',      audit_log_has_create)
step('audit_admin rejects anon',            audit_rejects_anon)
step('audit log respects tenant isolation', audit_isolation)

# ── 11. Feature flags surfaced through me ────────────────────────────────
section('Feature flags via tenant_admin_auth.me')

def me_returns_features():
    r = post(f'{SUPABASE_URL}/functions/v1/tenant_admin_auth', {'action': 'me'}, TOKEN_A)
    assert r.get('ok'), f'me: {r}'
    assert 'features' in (r.get('tenant') or {}), 'tenant.features missing from me response'

step('me() returns tenant.features',  me_returns_features)

# ── 12. Member-side household management ─────────────────────────────────
section('Member-side household management')

# We need a real member with role='primary' to test against. Use the
# household we created in section 1 (isolation test) — its primary was
# inserted with role='primary' by households_admin.create_household.
M_TID = TENANT_A_ID
M_SLUG = SLUG_A
M_PRIMARY_ID = None  # will resolve from DB
M_HID = None
M_ADDED_ID = None

def fetch_primary():
    global M_PRIMARY_ID, M_HID
    rows = mgmt_query(
        f"select hm.id, hm.household_id from public.household_members hm "
        f"where hm.tenant_id = '{TENANT_A_ID}' and hm.role = 'primary' and hm.active = true "
        f"and hm.household_id = '{A_HOUSEHOLD_ID}' limit 1;"
    )
    assert rows, 'no primary member to use for member-token tests'
    M_PRIMARY_ID = rows[0]['id']
    M_HID = rows[0]['household_id']

def member_add_housemate():
    global M_ADDED_ID
    tok = member_jwt(M_PRIMARY_ID, M_TID, M_SLUG, M_HID)
    r = post(f'{SUPABASE_URL}/functions/v1/member_auth', {
        'action': 'add_household_member',
        'name': f'Member-Add {STAMP}',
        'role': 'adult',
        'phone_e164': f'+1555{STAMP}5678',
    }, tok)
    assert r.get('ok'), f'add: {r}'
    M_ADDED_ID = r['member_id']

def non_primary_cannot_add():
    # Pretend to be the housemate we just added (role='adult') and try to add
    tok = member_jwt(M_ADDED_ID, M_TID, M_SLUG, M_HID)
    r = post(f'{SUPABASE_URL}/functions/v1/member_auth', {
        'action': 'add_household_member',
        'name': 'Should fail',
        'role': 'adult',
        'phone_e164': f'+1555{STAMP}9876',
    }, tok)
    assert not r.get('ok'), 'non-primary should NOT be able to add members'

def member_remove_housemate():
    tok = member_jwt(M_PRIMARY_ID, M_TID, M_SLUG, M_HID)
    r = post(f'{SUPABASE_URL}/functions/v1/member_auth', {
        'action': 'remove_household_member',
        'id': M_ADDED_ID,
    }, tok)
    assert r.get('ok'), f'remove: {r}'
    rows = mgmt_query(f"select active from public.household_members where id = '{M_ADDED_ID}';")
    assert rows and rows[0]['active'] is False, 'remove did not soft-delete'

def member_cannot_remove_primary():
    tok = member_jwt(M_PRIMARY_ID, M_TID, M_SLUG, M_HID)
    r = post(f'{SUPABASE_URL}/functions/v1/member_auth', {
        'action': 'remove_household_member',
        'id': M_PRIMARY_ID,
    }, tok)
    assert not r.get('ok'), 'primary should not be removable via this action'

step('resolve a primary member',           fetch_primary)
step('primary can add housemate',          member_add_housemate)
step('non-primary CANNOT add housemate',   non_primary_cannot_add)
step('primary can remove housemate',       member_remove_housemate)
step('primary cannot remove themselves',   member_cannot_remove_primary)

# ── Cleanup ──────────────────────────────────────────────────────────────
section('Cleanup')

def cleanup_all():
    # Delete the throwaway test tenant — cascades clean up child rows
    mgmt_query(f"delete from public.tenants where id = '{TENANT_B_ID}';")
    # Hard-delete any tracked rows in tenant A
    for hh_id in RESOURCES['households']:
        mgmt_query(f"delete from public.households where id = '{hh_id}';")
    for app_id in RESOURCES['applications']:
        mgmt_query(f"delete from public.applications where id = '{app_id}';")
    for ev in RESOURCES['events']:
        mgmt_query(f"delete from public.events where id = '{ev}';")
    for p in RESOURCES['photos']:
        mgmt_query(f"delete from public.photos where id = '{p}';")
    for d in RESOURCES['documents']:
        mgmt_query(f"delete from public.documents where id = '{d}';")

step('teardown — drop test tenant + tracked rows', cleanup_all)

# ── Summary ──────────────────────────────────────────────────────────────
print()
total = ok_count + fail_count
if fail_count == 0:
    print(f'\033[32m{ok_count}/{total} green\033[0m')
    sys.exit(0)
else:
    print(f'\033[31m{fail_count}/{total} failed\033[0m  (out of {total})')
    sys.exit(1)
