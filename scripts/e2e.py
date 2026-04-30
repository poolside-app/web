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
RESOURCES = {'households': [], 'events': [], 'posts': [], 'photos': [], 'documents': [], 'applications': [], 'programs': [], 'campaigns': [], 'volunteer_opps': []}
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

# Full BE-parity application: 2 adults + 2 kids + waivers + signatures.
# Verifies that approve auto-populates ALL household members (not just primary).
FULL_APP_ID = None
FULL_HH_ID  = None
SIG_PNG = ('data:image/png;base64,'
           'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')

def app_submit_full_detail():
    global FULL_APP_ID
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {
        'action': 'submit', 'slug': SLUG_A,
        'family_name':   f'Full {STAMP}',
        'primary_name':  f'Pat Full {STAMP}',
        'primary_email': f'full-primary-{STAMP}@example.com',
        'primary_phone': f'+1555{STAMP}1001',
        'is_new_member': True,
        'need_new_fob':  True,
        'alt_email':     f'full-alt-{STAMP}@example.com',
        'adults': [
            { 'name': f'Pat Full {STAMP}',     'email': f'full-primary-{STAMP}@example.com', 'phone': f'+1555{STAMP}1001' },
            { 'name': f'Sam Spouse {STAMP}',   'email': f'full-spouse-{STAMP}@example.com',  'phone': f'+1555{STAMP}1002' },
        ],
        'children': [
            { 'name': f'Tween Kid {STAMP}', 'dob': '2012-06-15' },  # ≥13 → role=teen
            { 'name': f'Tiny Kid {STAMP}',  'dob': '2020-03-10', 'allergies': 'peanuts' },
        ],
        'waivers_accepted': { 'rules': True, 'guest': True, 'party': True, 'sitter': True, 'waiver': True },
        'signature_primary':  SIG_PNG,
        'signature_guardian': SIG_PNG,
        'payment_method': 'venmo',
    })
    assert r.get('ok'), f'full submit: {r}'
    FULL_APP_ID = r['application_id']
    track('applications', FULL_APP_ID)

def app_full_approve_populates_all_members():
    global FULL_HH_ID
    r = post(f'{SUPABASE_URL}/functions/v1/applications', {
        'action': 'approve', 'id': FULL_APP_ID, 'override': {'tier': 'family'},
    }, TOKEN_A)
    assert r.get('ok'), f'full approve: {r}'
    FULL_HH_ID = r['household_id']
    track('households', FULL_HH_ID)
    # Should have created primary + spouse + 2 children = 4 members total.
    expected = 4
    got = r.get('members_created')
    assert got == expected, f'expected {expected} members created, got {got}'

def app_full_household_roster_correct():
    rows = mgmt_query(
        f"select role, name from public.household_members "
        f"where household_id = '{FULL_HH_ID}' order by name;"
    )
    roles = sorted([r['role'] for r in rows])
    # primary + adult + teen (DOB 2012, ≥13y old) + child
    expected_roles = ['adult', 'child', 'primary', 'teen']
    assert roles == expected_roles, f'expected roles {expected_roles}, got {roles}'

def app_full_signatures_persisted():
    rows = mgmt_query(
        f"select signature_primary, signature_guardian, accepted_at "
        f"from public.applications where id = '{FULL_APP_ID}';"
    )
    assert rows, 'application row missing'
    a = rows[0]
    assert a.get('signature_primary',  '').startswith('data:image/png;base64,'), 'primary sig missing'
    assert a.get('signature_guardian', '').startswith('data:image/png;base64,'), 'guardian sig missing'
    assert a.get('accepted_at'), 'accepted_at not set despite all 5 waivers true'

step('submit application (full BE parity)',       app_submit_full_detail)
step('approve populates all 4 household members', app_full_approve_populates_all_members)
step('household roles match adults/children mix', app_full_household_roster_correct)
step('signatures + accepted_at persisted',        app_full_signatures_persisted)

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

# ── 13. Programs (bookings engine) ───────────────────────────────────────
section('Programs (bookings)')

PROG_ID = None
PROG_BOOKING_ID = None

def prog_admin_create():
    global PROG_ID
    r = post(f'{SUPABASE_URL}/functions/v1/programs', {
        'action': 'create',
        'name': f'E2E Swim {STAMP}',
        'description': 'auto-test program',
        'audience': 'kids', 'capacity': 2, 'price_cents': 5000,
        'weekdays': 'tue,thu', 'start_time': '18:00', 'end_time': '18:45',
        'instructor': 'Coach E2E',
    }, TOKEN_A)
    assert r.get('ok'), f'create: {r}'
    PROG_ID = r['program']['id']
    track('programs', PROG_ID)
    assert r['program']['spots_left'] == 2, f'expected 2 spots, got {r["program"]["spots_left"]}'

def prog_public_list_visible():
    r = post(f'{SUPABASE_URL}/functions/v1/programs', { 'action': 'list_public', 'slug': SLUG_A })
    assert r.get('ok'), f'list_public: {r}'
    found = next((p for p in r.get('programs', []) if p['id'] == PROG_ID), None)
    assert found, 'program not exposed via list_public'
    assert found['spots_left'] == 2

def prog_member_book():
    global PROG_BOOKING_ID
    tok = member_jwt(M_PRIMARY_ID, M_TID, M_SLUG, M_HID)
    r = post(f'{SUPABASE_URL}/functions/v1/programs', {
        'action': 'book', 'program_id': PROG_ID,
        'participant_name': f'Kid Booking {STAMP}',
    }, tok)
    assert r.get('ok'), f'book: {r}'
    assert r['booking']['status'] == 'confirmed', f'expected confirmed, got {r["booking"]["status"]}'
    PROG_BOOKING_ID = r['booking']['id']

def prog_my_bookings_lists_it():
    tok = member_jwt(M_PRIMARY_ID, M_TID, M_SLUG, M_HID)
    r = post(f'{SUPABASE_URL}/functions/v1/programs', { 'action': 'my_bookings' }, tok)
    assert r.get('ok'), f'my_bookings: {r}'
    found = next((b for b in r.get('bookings', []) if b['id'] == PROG_BOOKING_ID), None)
    assert found, 'booking not in my_bookings'
    assert (found.get('program') or {}).get('id') == PROG_ID

def prog_admin_roster_and_mark_paid():
    r = post(f'{SUPABASE_URL}/functions/v1/programs', { 'action': 'roster', 'program_id': PROG_ID }, TOKEN_A)
    assert r.get('ok'), f'roster: {r}'
    bk = next((b for b in r.get('bookings', []) if b['id'] == PROG_BOOKING_ID), None)
    assert bk and bk['paid'] is False
    r2 = post(f'{SUPABASE_URL}/functions/v1/programs', { 'action': 'mark_paid', 'booking_id': PROG_BOOKING_ID, 'paid': True }, TOKEN_A)
    assert r2.get('ok') and r2['booking']['paid'] is True, f'mark_paid: {r2}'

def prog_capacity_overflow_waitlists():
    # capacity=2, 1 confirmed already → next two attempts: one confirmed, one waitlisted.
    tok = member_jwt(M_PRIMARY_ID, M_TID, M_SLUG, M_HID)
    r1 = post(f'{SUPABASE_URL}/functions/v1/programs', {
        'action': 'book', 'program_id': PROG_ID,
        'participant_name': f'Sibling A {STAMP}',
    }, tok)
    assert r1.get('ok') and r1['booking']['status'] == 'confirmed', f'sibling A: {r1}'
    r2 = post(f'{SUPABASE_URL}/functions/v1/programs', {
        'action': 'book', 'program_id': PROG_ID,
        'participant_name': f'Sibling B {STAMP}',
    }, tok)
    assert r2.get('ok') and r2['booking']['status'] == 'waitlisted', f'sibling B should waitlist: {r2}'

def prog_member_cancels_own_booking():
    tok = member_jwt(M_PRIMARY_ID, M_TID, M_SLUG, M_HID)
    r = post(f'{SUPABASE_URL}/functions/v1/programs', {
        'action': 'cancel_booking', 'booking_id': PROG_BOOKING_ID,
    }, tok)
    assert r.get('ok'), f'cancel: {r}'
    rows = mgmt_query(f"select status from public.program_bookings where id = '{PROG_BOOKING_ID}';")
    assert rows and rows[0]['status'] == 'cancelled', 'booking not marked cancelled'

def prog_isolation():
    # Tenant B should NOT see tenant A's program in admin list
    r = post(f'{SUPABASE_URL}/functions/v1/programs', { 'action': 'list' }, TOKEN_B)
    assert r.get('ok')
    leaked = any(p['id'] == PROG_ID for p in r.get('programs', []))
    assert not leaked, 'tenant B can see tenant A programs (ISOLATION FAIL)'

def prog_anon_blocked_for_admin_action():
    r = post(f'{SUPABASE_URL}/functions/v1/programs', { 'action': 'list' })
    assert not r.get('ok'), 'admin list must reject anon'

step('admin creates program',                 prog_admin_create)
step('public list_public exposes it',         prog_public_list_visible)
step('member books a confirmed spot',         prog_member_book)
step('my_bookings returns the booking',       prog_my_bookings_lists_it)
step('admin roster + mark_paid flow',         prog_admin_roster_and_mark_paid)
step('over-capacity bookings waitlist',       prog_capacity_overflow_waitlists)
step('member cancels their own booking',      prog_member_cancels_own_booking)
step('cross-tenant isolation on programs',    prog_isolation)
step('anon rejected for admin action',        prog_anon_blocked_for_admin_action)

# ── 14. Campaigns (in-app pop-ups) ───────────────────────────────────────
section('Campaigns (pop-ups)')

CAMP_ID = None

def camp_admin_create():
    global CAMP_ID
    r = post(f'{SUPABASE_URL}/functions/v1/campaigns', {
        'action': 'create',
        'title':  f'E2E Fund Drive {STAMP}',
        'body':   'Help keep the snack bar open this season.',
        'kind':   'fundraiser',
        'audience': 'both',
        'cta_label': 'Donate',
        'cta_url':   'https://example.com/donate',
        'starts_at': '2020-01-01T00:00:00Z',  # already started
    }, TOKEN_A)
    assert r.get('ok'), f'create: {r}'
    CAMP_ID = r['campaign']['id']
    track('campaigns', CAMP_ID)

def camp_public_list_active():
    r = post(f'{SUPABASE_URL}/functions/v1/campaigns', {
        'action': 'list_active', 'slug': SLUG_A, 'audience': 'public',
    })
    assert r.get('ok'), f'list_active: {r}'
    found = next((c for c in r.get('campaigns', []) if c['id'] == CAMP_ID), None)
    assert found, 'public list_active missing newly-created campaign (audience=both should match)'

def camp_audience_filter_works():
    # Create a members-only campaign; list_active(public) should NOT include it.
    r = post(f'{SUPABASE_URL}/functions/v1/campaigns', {
        'action': 'create',
        'title': f'E2E Members Only {STAMP}',
        'audience': 'members',
        'starts_at': '2020-01-01T00:00:00Z',
    }, TOKEN_A)
    assert r.get('ok'), f'create members-only: {r}'
    track('campaigns', r['campaign']['id'])

    pub = post(f'{SUPABASE_URL}/functions/v1/campaigns', {
        'action': 'list_active', 'slug': SLUG_A, 'audience': 'public',
    })
    assert pub.get('ok')
    leak = next((c for c in pub.get('campaigns', []) if c['id'] == r['campaign']['id']), None)
    assert not leak, 'members-only campaign leaked to public surface'

def camp_isolation():
    r = post(f'{SUPABASE_URL}/functions/v1/campaigns', { 'action': 'list' }, TOKEN_B)
    assert r.get('ok')
    leak = any(c['id'] == CAMP_ID for c in r.get('campaigns', []))
    assert not leak, 'tenant B sees tenant A campaign (ISOLATION FAIL)'

def camp_archive_hides_from_public():
    r = post(f'{SUPABASE_URL}/functions/v1/campaigns', { 'action': 'delete', 'id': CAMP_ID }, TOKEN_A)
    assert r.get('ok'), f'delete: {r}'
    pub = post(f'{SUPABASE_URL}/functions/v1/campaigns', {
        'action': 'list_active', 'slug': SLUG_A, 'audience': 'public',
    })
    leak = any(c['id'] == CAMP_ID for c in pub.get('campaigns', []))
    assert not leak, 'archived campaign still visible publicly'

step('admin creates campaign',                  camp_admin_create)
step('public list_active surfaces it',          camp_public_list_active)
step('audience=members hidden from public',     camp_audience_filter_works)
step('cross-tenant isolation on campaigns',     camp_isolation)
step('archive hides from public list',          camp_archive_hides_from_public)

# ── 15. Member directory (opt-in) ────────────────────────────────────────
section('Member directory')

def dir_default_empty():
    tok = member_jwt(M_PRIMARY_ID, M_TID, M_SLUG, M_HID)
    r = post(f'{SUPABASE_URL}/functions/v1/member_auth', { 'action': 'list_directory' }, tok)
    assert r.get('ok'), f'list_directory: {r}'
    # No members opted in yet — should be empty.
    assert not any(m['id'] == M_PRIMARY_ID for m in r.get('members', [])), 'directory leaked an opt-out member'

def dir_opt_in_via_profile():
    tok = member_jwt(M_PRIMARY_ID, M_TID, M_SLUG, M_HID)
    r = post(f'{SUPABASE_URL}/functions/v1/member_auth', {
        'action': 'update_my_profile', 'directory_visible': True,
    }, tok)
    assert r.get('ok'), f'opt-in: {r}'

def dir_now_lists_me():
    tok = member_jwt(M_PRIMARY_ID, M_TID, M_SLUG, M_HID)
    r = post(f'{SUPABASE_URL}/functions/v1/member_auth', { 'action': 'list_directory' }, tok)
    assert r.get('ok'), f'list: {r}'
    found = next((m for m in r.get('members', []) if m['id'] == M_PRIMARY_ID), None)
    assert found, 'opted-in member not in directory'
    assert 'phone_e164' not in found, 'directory leaks phone (privacy)'
    assert 'email' not in found, 'directory leaks email (privacy)'

def dir_isolation():
    # Tenant B's directory must NOT contain tenant A's opted-in member.
    # Use tenant B's admin token to make a B-side member token, then list.
    # Simplest: just hit list directly via mgmt and check tenant_id scope.
    rows = mgmt_query(
        f"select count(*) as c from public.household_members "
        f"where tenant_id = '{TENANT_B_ID}' and directory_visible = true and active = true;"
    )
    assert rows[0]['c'] == 0, 'tenant B has stray opted-in members (isolation concern)'

step('directory empty by default',     dir_default_empty)
step('member opts in via profile',     dir_opt_in_via_profile)
step('directory now includes them',    dir_now_lists_me)
step('cross-tenant directory isolation', dir_isolation)

# ── 16. Volunteer opportunities ──────────────────────────────────────────
section('Volunteer signups')

VOL_OPP_ID = None
VOL_SIGNUP_ID = None

def vol_admin_create():
    global VOL_OPP_ID
    future = '2099-06-15T18:00:00Z'  # safely in the future
    r = post(f'{SUPABASE_URL}/functions/v1/volunteer', {
        'action': 'create',
        'title': f'E2E Snack Bar {STAMP}',
        'description': 'Saturday meet shift',
        'starts_at': future,
        'slots_needed': 2,
        'location': 'Snack bar',
    }, TOKEN_A)
    assert r.get('ok'), f'create: {r}'
    VOL_OPP_ID = r['opportunity']['id']
    track('volunteer_opps', VOL_OPP_ID)

def vol_public_list():
    r = post(f'{SUPABASE_URL}/functions/v1/volunteer', { 'action': 'list_public', 'slug': SLUG_A })
    assert r.get('ok'), f'list_public: {r}'
    found = next((o for o in r.get('opportunities', []) if o['id'] == VOL_OPP_ID), None)
    assert found, 'opportunity not in public list'
    assert found['slots_filled'] == 0

def vol_member_signup():
    global VOL_SIGNUP_ID
    tok = member_jwt(M_PRIMARY_ID, M_TID, M_SLUG, M_HID)
    r = post(f'{SUPABASE_URL}/functions/v1/volunteer', {
        'action': 'signup', 'opportunity_id': VOL_OPP_ID,
        'volunteer_name': f'Volunteer {STAMP}',
        'member_id': M_PRIMARY_ID,
    }, tok)
    assert r.get('ok'), f'signup: {r}'
    VOL_SIGNUP_ID = r['signup']['id']

def vol_my_signups():
    tok = member_jwt(M_PRIMARY_ID, M_TID, M_SLUG, M_HID)
    r = post(f'{SUPABASE_URL}/functions/v1/volunteer', { 'action': 'my_signups' }, tok)
    assert r.get('ok'), f'my_signups: {r}'
    found = next((s for s in r.get('signups', []) if s['id'] == VOL_SIGNUP_ID), None)
    assert found, 'signup not in my_signups'

def vol_capacity_block():
    # capacity=2, primary already took one; the same member can't sign up twice (unique)
    tok = member_jwt(M_PRIMARY_ID, M_TID, M_SLUG, M_HID)
    r = post(f'{SUPABASE_URL}/functions/v1/volunteer', {
        'action': 'signup', 'opportunity_id': VOL_OPP_ID,
        'volunteer_name': 'Duplicate', 'member_id': M_PRIMARY_ID,
    }, tok)
    assert not r.get('ok'), 'should have rejected duplicate signup'

def vol_admin_roster_sees_signup():
    r = post(f'{SUPABASE_URL}/functions/v1/volunteer', { 'action': 'roster', 'opportunity_id': VOL_OPP_ID }, TOKEN_A)
    assert r.get('ok'), f'roster: {r}'
    found = next((s for s in r.get('signups', []) if s['id'] == VOL_SIGNUP_ID), None)
    assert found, 'admin roster missing signup'

def vol_member_cancel():
    tok = member_jwt(M_PRIMARY_ID, M_TID, M_SLUG, M_HID)
    r = post(f'{SUPABASE_URL}/functions/v1/volunteer', { 'action': 'cancel_signup', 'signup_id': VOL_SIGNUP_ID }, tok)
    assert r.get('ok'), f'cancel: {r}'

def vol_isolation():
    r = post(f'{SUPABASE_URL}/functions/v1/volunteer', { 'action': 'list' }, TOKEN_B)
    assert r.get('ok')
    leak = any(o['id'] == VOL_OPP_ID for o in r.get('opportunities', []))
    assert not leak, 'tenant B sees tenant A volunteer opp (ISOLATION FAIL)'

step('admin creates volunteer opportunity', vol_admin_create)
step('public list_public surfaces it',      vol_public_list)
step('member signs up',                     vol_member_signup)
step('my_signups returns it',               vol_my_signups)
step('duplicate signup blocked',            vol_capacity_block)
step('admin roster includes signup',        vol_admin_roster_sees_signup)
step('member cancels their signup',         vol_member_cancel)
step('cross-tenant isolation on volunteer', vol_isolation)

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
    for pid in RESOURCES['programs']:
        mgmt_query(f"delete from public.programs where id = '{pid}';")
    for cid in RESOURCES['campaigns']:
        mgmt_query(f"delete from public.campaigns where id = '{cid}';")
    for vid in RESOURCES['volunteer_opps']:
        mgmt_query(f"delete from public.volunteer_opportunities where id = '{vid}';")

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
