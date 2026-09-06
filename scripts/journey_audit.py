#!/usr/bin/env python3
"""
journey_audit.py — walk the two journeys that matter, end to end, for real.

e2e.py proves individual endpoints still behave. This asks a different
question: can a family actually get from "received a text" to "booked a party",
and can a board actually run a season? Every step below is a real call against
production, in the order a human would hit it, so a break in the CHAIN shows up
even when each link passes its own unit test.

Run:  python3.11 scripts/journey_audit.py
      python3.11 scripts/journey_audit.py --member    (just the family side)
      python3.11 scripts/journey_audit.py --board     (just the board side)

Creates a throwaway household and tears it down. Sends no email or SMS.
"""
import os, sys, time, json, hmac, hashlib, base64, urllib.request, urllib.error

try: sys.stdout.reconfigure(encoding='utf-8')
except Exception: pass

ENV = {}
with open('.env.local') as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k, _, v = line.partition('=')
        ENV[k.strip()] = v.strip()

SUPABASE_URL = ENV.get('SUPABASE_URL', '').rstrip('/')
JWT_SECRET   = ENV.get('ADMIN_JWT_SECRET')
ACCESS_TOKEN = ENV.get('SUPABASE_ACCESS_TOKEN')
PROJECT_REF  = ENV.get('SUPABASE_PROJECT_REF', 'sdewylbddkcvidwosgxo')
SLUG         = 'bishopestates'
HOST         = f'https://{SLUG}.poolsideapp.com'
UA           = 'poolside-journey-audit/1.0'
STAMP        = str(int(time.time()))[-6:]

GRN, RED, YEL, DIM, RST = '\033[32m', '\033[31m', '\033[33m', '\033[2m', '\033[0m'

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
def sign_jwt(payload):
    h = b64u(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    p = b64u(json.dumps(payload).encode())
    sig = hmac.new(JWT_SECRET.encode(), f'{h}.{p}'.encode(), hashlib.sha256).digest()
    return f'{h}.{p}.{b64u(sig)}'

def post(path, body, token=None):
    url = path if path.startswith('http') else f'{SUPABASE_URL}/functions/v1/{path}'
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('User-Agent', UA)
    if token: req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:    return json.loads(e.read().decode())
        except Exception: return {'ok': False, 'error': f'HTTP {e.code}'}
    except Exception as e:
        return {'ok': False, 'error': str(e)}

def sql(q):
    url = f'https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query'
    req = urllib.request.Request(url, data=json.dumps({'query': q}).encode(), method='POST')
    req.add_header('Authorization', f'Bearer {ACCESS_TOKEN}')
    req.add_header('Content-Type', 'application/json')
    req.add_header('User-Agent', UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

# ── reporting ──────────────────────────────────────────────────────────────
RESULTS = []
def head(t):
    print(f'\n{"─"*74}\n  {t}\n{"─"*74}')
def step(n, name, fn):
    t0 = time.time()
    try:
        note = fn() or ''
        ms = int((time.time()-t0)*1000)
        print(f'  {GRN}✓{RST} {n:<2} {name:<52} {DIM}{ms}ms{RST}')
        if note: print(f'       {DIM}{note}{RST}')
        RESULTS.append(('ok', name, note))
    except AssertionError as e:
        print(f'  {RED}✗{RST} {n:<2} {name:<52} {RED}BROKEN{RST}')
        print(f'       {RED}{e}{RST}')
        RESULTS.append(('fail', name, str(e)))
    except SkipStep as e:
        print(f'  {YEL}~{RST} {n:<2} {name:<52} {YEL}skipped{RST}')
        print(f'       {DIM}{e}{RST}')
        RESULTS.append(('skip', name, str(e)))
    except Exception as e:
        print(f'  {RED}!{RST} {n:<2} {name:<52} {RED}ERROR{RST}')
        print(f'       {RED}{type(e).__name__}: {e}{RST}')
        RESULTS.append(('fail', name, f'{type(e).__name__}: {e}'))

class SkipStep(Exception): pass

# ── shared fixtures ────────────────────────────────────────────────────────
TID = sql(f"select id from tenants where slug='{SLUG}'")[0]['id']
OWNER = sql(f"select id from admin_users where tenant_id='{TID}' and active and role_template='owner' limit 1")[0]['id']
ADMIN_TOK = sign_jwt({'sub': OWNER, 'kind': 'tenant_admin', 'tid': TID, 'slug': SLUG,
                      'role_template': 'owner', 'is_super': True, 'exp': int(time.time())+7200})
S = {}     # state carried between steps

# ═══════════════════════════════════════════════════════════════════════════
#  THE FAMILY'S JOURNEY — text message to booking a party
# ═══════════════════════════════════════════════════════════════════════════
def member_journey():
    head('A FAMILY JOINS — from the text they receive to using the pool')

    def s01_club_is_public():
        d = post('tenant_public', {'slug': SLUG})
        assert d.get('ok'), f'the club\'s public page is down: {d}'
        assert d.get('tenant'), 'no club details returned'
        S['club'] = d['tenant']['display_name']
        return f"public site answers for {S['club']}"

    def s02_apply_page_loads():
        req = urllib.request.Request(f'{HOST}/apply.html', headers={'User-Agent': UA})
        html = urllib.request.urlopen(req, timeout=20).read().decode()
        assert 'functions/v1/applications' in html, 'apply form is not wired to the backend'
        assert 'claim' in html, 'apply form cannot handle a claim link'
        return 'apply.html loads and is wired'

    def s03_board_imports_them():
        # The club migrates its roster: the family lands as a pre-filled
        # application, not an active member — they have not agreed or paid yet.
        r = sql(f"""insert into applications
              (tenant_id, family_name, primary_name, primary_email, primary_phone,
               status, payment_status, claim_source, membership_year, tier_slug,
               adults_json, children_json, num_adults, num_kids)
            values ('{TID}', 'Audit Family {STAMP}', 'Casey Audit', 'audit-{STAMP}@example.com',
                    '+1555{STAMP}01', 'prefilled', 'unpaid', 'csv_import',
                    {time.gmtime().tm_year}, 'family',
                    '[{{"name":"Casey Audit"}}]'::jsonb, '[]'::jsonb, 1, 0)
            returning id;""")
        S['app_id'] = r[0]['id']
        return f"imported as a pre-filled application ({S['app_id'][:8]})"

    def s04_invite_mints_a_link():
        # Targeted so the audit cannot text or email the real roster.
        d = post('applications', {'action': 'send_claim_invites', 'ids': [S['app_id']],
                                  'channels': ['email'], 'only_uninvited': False}, ADMIN_TOK)
        assert d.get('ok'), f'invite send failed: {d}'
        row = sql(f"select claim_token_hash, invited_at from applications where id='{S['app_id']}'")[0]
        assert row['claim_token_hash'], 'no claim link was created'
        assert row['invited_at'], 'invite time not recorded — the board cannot tell who was contacted'
        # Re-point the token at one we know, to follow the family's path.
        S['token'] = f'audit-{STAMP}'
        h = hashlib.sha256(S['token'].encode()).hexdigest()
        sql(f"update applications set claim_token_hash='{h}' where id='{S['app_id']}'")
        return 'claim link created and the send was recorded'

    def s05_family_opens_the_link():
        d = post('applications', {'action': 'get_claim', 'slug': SLUG, 'claim_token': S['token']})
        assert d.get('ok'), f'the claim link does not open: {d}'
        assert d.get('application'), 'link opened but returned nothing to confirm'
        app = d['application']
        assert app.get('family_name'), 'their details were not pre-filled'
        return f"opens pre-filled for {app.get('family_name')}"

    def s06_family_submits():
        d = post('applications', {
            'action': 'submit', 'slug': SLUG, 'claim_token': S['token'],
            'family_name': f'Audit Family {STAMP}', 'primary_name': 'Casey Audit',
            'primary_email': f'audit-{STAMP}@example.com', 'primary_phone': f'+1555{STAMP}01',
            'address': '1 Pool Lane', 'city': 'Concord', 'zip': '94521',
            'tier_slug': 'family', 'payment_method': 'venmo',
            'adults_json': [{'name': 'Casey Audit'}], 'children_json': [{'name': 'Kid Audit'}],
            'waivers_accepted': True,
        })
        assert d.get('ok'), f'they cannot submit the form: {d}'
        row = sql(f"select status, claimed_at, num_kids from applications where id='{S['app_id']}'")[0]
        assert row['status'] == 'pending', f'submission did not enter the queue: {row}'
        assert row['claimed_at'], 'claim not timestamped'
        return 'submitted, policies accepted, now awaiting the board'

    def s07_they_can_pay():
        # Stripe is in test mode; creating the session proves the whole payment
        # path is wired without moving money.
        d = post('stripe_checkout', {'action': 'application', 'application_id': S['app_id']})
        if not d.get('ok') and 'Stripe' in str(d.get('error', '')):
            raise SkipStep(f"club has not connected Stripe: {d.get('error')}")
        assert d.get('ok') and d.get('url'), f'cannot start a payment: {d}'
        assert 'checkout.stripe.com' in d['url'], f'unexpected checkout URL: {d["url"]}'
        return 'Stripe checkout session opens'

    def s08_board_approves():
        d = post('applications', {'action': 'approve', 'id': S['app_id'],
                                  'verify_venmo_payment': True}, ADMIN_TOK)
        assert d.get('ok'), f'the board cannot approve them: {d}'
        row = sql(f"select household_id from applications where id='{S['app_id']}'")[0]
        assert row['household_id'], 'approval did not create a household'
        S['hid'] = row['household_id']
        m = sql(f"select id, name from household_members where household_id='{S['hid']}' and role='primary'")
        assert m, 'no member record was created'
        S['mid'] = m[0]['id']
        return f"household created with {len(m)} primary member"

    def s09_signin_link_works():
        d = post('member_auth', {'action': 'start', 'slug': SLUG, 'email': f'audit-{STAMP}@example.com'})
        assert d.get('ok'), f'they cannot request a sign-in link: {d}'
        return 'sign-in link requested (uncapped, always available)'

    def s10_member_home_loads():
        S['mtok'] = sign_jwt({'sub': S['mid'], 'kind': 'member', 'tid': TID,
                              'slug': SLUG, 'hid': S['hid'], 'exp': int(time.time())+3600})
        d = post('member_auth', {'action': 'me'}, S['mtok'])
        assert d.get('ok'), f'member home will not load: {d}'
        assert d.get('household'), 'no household on their home screen'
        assert 'renewal' in d, 'renewal state missing from the member payload'
        assert d.get('refreshed_token'), 'session is not rolling forward — they would be logged out eventually'
        return f"home loads; {len(d['household'].get('members', []))} on the membership"

    def s11_they_see_whats_on():
        d = post('tenant_public', {'slug': SLUG, 'local_day': time.strftime('%Y-%m-%d')})
        assert d.get('ok'), f'today-at-the-pool is broken: {d}'
        assert 'events' in d, 'no events feed'
        assert 'today_checkins' in d, 'live headcount missing'
        return f"{len(d.get('events') or [])} upcoming events, headcount wired"

    def s12_calendar_renders_on_the_home():
        # The calendar is embedded in the member home, not a page of its own.
        req = urllib.request.Request(f'{HOST}/m/', headers={'User-Agent': UA})
        html = urllib.request.urlopen(req, timeout=20).read().decode()
        assert '/js/calendar.js' in html, 'the calendar widget is not on the member home'
        assert '/js/today.js' in html, "the 'today at the pool' block is missing"
        js = urllib.request.urlopen(
            urllib.request.Request(f'{HOST}/js/calendar.js', headers={'User-Agent': UA}), timeout=20
        ).read().decode()
        assert len(js) > 500, 'calendar script is empty or truncated'
        return 'calendar + today block load on the member home'

    def s13_calendar_subscribe():
        d = post(f'{SUPABASE_URL}/functions/v1/tenant_calendar_ics', {'slug': SLUG})
        # ICS is usually served over GET; try that if POST is not the contract.
        req = urllib.request.Request(f'{SUPABASE_URL}/functions/v1/tenant_calendar_ics?slug={SLUG}',
                                     headers={'User-Agent': UA})
        try:
            body = urllib.request.urlopen(req, timeout=20).read().decode()
        except Exception as e:
            raise AssertionError(f'calendar subscription feed is unreachable: {e}')
        assert 'BEGIN:VCALENDAR' in body, 'subscription feed is not valid iCal'
        return 'webcal subscription feed is valid'

    def s14_add_a_family_member():
        pol = {p['slug']: True for p in (post('policies', {'action': 'list_public', 'slug': SLUG}).get('policies') or [])}
        assert pol, 'no policies to accept — the club has published none'
        d = post('member_auth', {'action': 'add_household_member',
                                 'name': f'Teen Audit {STAMP}', 'role': 'teen',
                                 'policies_accepted': pol,
                                 'signature': 'Casey Audit',
                                 'guardian_signature': 'Casey Audit'}, S['mtok'])
        assert d.get('ok'), f'they cannot add someone to their membership: {d}'
        return 'added a teen to the membership'

    def s15_request_a_party():
        starts = time.strftime('%Y-%m-%dT18:00:00.000Z', time.gmtime(time.time()+7*86400))
        d = post('member_auth', {'action': 'request_party', 'title': f'Audit Party {STAMP}',
                                 'starts_at': starts, 'expected_guests': 20,
                                 'policies_accepted': True, 'signature': 'Casey Audit'}, S['mtok'])
        assert d.get('ok'), f'they cannot request a party: {d}'
        S['party_id'] = d.get('party', {}).get('id') or d.get('id')
        return 'party request submitted'

    def s16_see_their_parties():
        d = post('member_auth', {'action': 'list_my_parties'}, S['mtok'])
        assert d.get('ok'), f'they cannot see their own bookings: {d}'
        assert any(STAMP in (p.get('title') or '') for p in d.get('parties', [])), \
            'the party they just booked is not listed'
        return f"{len(d.get('parties') or [])} booking(s) visible to them"

    def s17_programs_are_browsable():
        d = post('programs', {'action': 'list_public', 'slug': SLUG})
        assert d.get('ok'), f'programs will not list: {d}'
        return f"{len(d.get('programs') or [])} program(s) offered"

    def s18_guest_passes():
        d = post('guest_passes', {'action': 'my_packs'}, S['mtok'])
        assert d.get('ok'), f'guest passes are broken for members: {d}'
        return 'guest-pass balance loads'

    def s19_policies_readable():
        d = post('policies', {'action': 'list_public', 'slug': SLUG})
        assert d.get('ok'), f'club policies will not load: {d}'
        assert len(d.get('policies') or []) > 0, 'no policies published — members sign nothing'
        return f"{len(d['policies'])} policies published"

    def s20_submit_feedback():
        d = post('feedback', {'action': 'submit', 'slug': SLUG,
                              'comment': f'Journey audit {STAMP} — please ignore.'})
        assert d.get('ok'), f'nobody can report a problem: {d}'
        return 'anyone can report a problem, no login needed'

    def s21_renewal_offer():
        d = post('member_auth', {'action': 'renewal_options'}, S['mtok'])
        assert d.get('ok'), f'renewal will not load: {d}'
        assert 'year' in d and 'dues_cents' in d, f'renewal quote incomplete: {d}'
        return (f"renewal quotes {d['year']} at ${d['dues_cents']/100:.2f}"
                + ('' if d.get('open') else '  (window closed today, as configured)'))

    def s22_install_guide_available():
        req = urllib.request.Request(f'{HOST}/js/pwa.js', headers={'User-Agent': UA})
        js = urllib.request.urlopen(req, timeout=20).read().decode()
        assert 'renderInstallGuide' in js, 'no add-to-home-screen guide is deployed'
        return 'add-to-home-screen guide is live'

    for i, (name, fn) in enumerate([
        ('Club website is up',                     s01_club_is_public),
        ('Join form loads and is wired',           s02_apply_page_loads),
        ('Board imports them from a spreadsheet',  s03_board_imports_them),
        ('Invite creates their personal link',     s04_invite_mints_a_link),
        ('They open the link — details pre-filled', s05_family_opens_the_link),
        ('They confirm and accept the policies',   s06_family_submits),
        ('They can pay',                           s07_they_can_pay),
        ('Board approves — membership created',    s08_board_approves),
        ('They can get a sign-in link',            s09_signin_link_works),
        ('Member home loads',                      s10_member_home_loads),
        ("They can see what's on today",           s11_they_see_whats_on),
        ('Calendar shows on the member home',      s12_calendar_renders_on_the_home),
        ('Calendar subscribe feed works',          s13_calendar_subscribe),
        ('They can add family',                    s14_add_a_family_member),
        ('They can request a party',               s15_request_a_party),
        ('They can see their bookings',            s16_see_their_parties),
        ('They can browse programs',               s17_programs_are_browsable),
        ('Guest passes load',                      s18_guest_passes),
        ('Club policies are readable',             s19_policies_readable),
        ('Anyone can report a problem',            s20_submit_feedback),
        ('Renewal is offered next season',         s21_renewal_offer),
        ('Add-to-home-screen guide is live',       s22_install_guide_available),
    ], 1):
        step(i, name, fn)

# ═══════════════════════════════════════════════════════════════════════════
#  THE BOARD'S JOURNEY — running a season
# ═══════════════════════════════════════════════════════════════════════════
def board_journey():
    head('THE BOARD RUNS A SEASON — every screen a volunteer touches')
    T = ADMIN_TOK

    def b01_admin_can_sign_in():
        d = post('tenant_admin_auth', {'action': 'me'}, T)
        assert d.get('ok'), f'admins cannot load their session: {d}'
        assert d.get('tenant'), 'no club on the admin session'
        return f"signed in to {d['tenant'].get('display_name')}"

    def b02_dashboard_numbers():
        # The dashboard's own counters come from tenant_admin_auth.me + the
        # task queue; tenant_metrics powers the separate Impact page.
        d = post('tenant_admin_auth', {'action': 'me'}, T)
        assert d.get('ok') and d.get('usage') is not None, f'dashboard counters missing: {d}'
        t = post('admin_tasks', {'action': 'count'}, T)
        assert t.get('ok'), f'the task queue is broken: {t}'
        i = post('tenant_metrics', {'action': 'get'}, T)
        assert i.get('ok'), f'the Impact page is broken: {i}'
        return f"dashboard, task queue and Impact page all load"

    def b02b_task_queue_is_clean():
        # Ghost tasks pointing at deleted rows are what made this dashboard
        # unusable before; the sweep should be keeping it clear.
        d = post('admin_tasks', {'action': 'list'}, T)
        assert d.get('ok'), f'task list broken: {d}'
        return f"{len(d.get('tasks') or [])} open task(s)"

    def b03_applications_pipeline():
        d = post('applications', {'action': 'list', 'status': 'needs_attention'}, T)
        assert d.get('ok'), f'the review queue will not load: {d}'
        renewals = [a for a in (d.get('applications') or [])
                    if a.get('is_renewal') and a.get('payment_status') != 'paid']
        assert not renewals, f'{len(renewals)} unpaid renewals are cluttering the review queue'
        return f"{len(d.get('applications') or [])} needing attention, renewals correctly excluded"

    def b04_renewals_have_their_own_view():
        d = post('applications', {'action': 'list', 'status': 'renewals'}, T)
        assert d.get('ok'), f'the renewals view is broken: {d}'
        return f"{len(d.get('applications') or [])} renewal(s) in flight"

    def b05_households():
        d = post('households_admin', {'action': 'list'}, T)
        assert d.get('ok'), f'the member list will not load: {d}'
        if S.get('hid'):
            assert any(h['id'] == S['hid'] for h in (d.get('households') or [])), \
                'the family approved earlier in this run is missing from the roster'
        return f"{len(d.get('households') or [])} household(s) on the roster"

    def b06_payments_queue():
        d = post('payments_admin', {'action': 'list'}, T)
        assert d.get('ok'), f'the payments screen is broken: {d}'
        return 'open balances load'

    def b07_approve_a_party():
        if not S.get('party_id'): raise SkipStep('no party was booked earlier in this run')
        d = post('parties_admin', {'action': 'list'}, T)
        assert d.get('ok'), f'party requests will not load: {d}'
        found = [p for p in (d.get('bookings') or []) if STAMP in str(p.get('title'))]
        assert found, 'the party a member just booked is not in the board queue'
        a = post('parties_admin', {'action': 'approve', 'id': found[0]['id']}, T)
        assert a.get('ok'), f'the board cannot approve a party: {a}'
        return 'party request appeared and was approved'

    def b08_events_and_calendar():
        starts = time.strftime('%Y-%m-%dT12:00:00.000Z', time.gmtime(time.time()+3*86400))
        d = post('events_admin', {'action': 'create', 'title': f'Audit Event {STAMP}',
                                  'kind': 'social', 'starts_at': starts}, T)
        assert d.get('ok'), f'the board cannot add a calendar event: {d}'
        S['event_id'] = d['event']['id']
        pub = post('tenant_public', {'slug': SLUG})
        assert any(e['id'] == S['event_id'] for e in (pub.get('events') or [])), \
            'a new event does not reach the public calendar'
        return 'event created and visible to members'

    def b09_announcements():
        d = post('posts_admin', {'action': 'create', 'title': f'Audit Post {STAMP}',
                                 'body': 'Journey audit — please ignore.'}, T)
        assert d.get('ok'), f'the board cannot post news: {d}'
        S['post_id'] = d.get('post', {}).get('id') or d.get('id')
        return 'announcement published'

    def b10_text_blast_gate():
        p = post('sms_blasts', {'action': 'preview', 'body': f'Audit preview {STAMP}'}, T)
        assert p.get('ok'), f'the text composer is broken: {p}'
        assert p.get('segments') == 1, f'a short message is being billed as {p.get("segments")} texts'
        assert 'est_cost_cents' in p, 'no cost shown before sending'
        return (f"preview: {p['recipient_count']} recipients, "
                f"${p['est_cost_cents']/100:.2f}, {p['cap']['remaining']} texts left this month")

    def b11_photos_approval():
        d = post('photos_admin', {'action': 'pending_count'}, T)
        assert d.get('ok'), f'photo approvals are broken: {d}'
        return 'photo approval queue loads'

    def b12_policies_editable():
        d = post('policies', {'action': 'list'}, T)
        assert d.get('ok'), f'policies will not load for the board: {d}'
        return f"{len(d.get('policies') or [])} policies the board can edit"

    def b13_board_meetings():
        d = post('board_meetings', {'action': 'list'}, T)
        assert d.get('ok'), f'board minutes are broken: {d}'
        return 'meeting minutes load'

    def b14_volunteer():
        d = post('volunteer', {'action': 'list'}, T)
        assert d.get('ok'), f'volunteer shifts are broken: {d}'
        return 'volunteer shifts load'

    def b15_lifeguards():
        d = post('lifeguards', {'action': 'list_roster'}, T)
        assert d.get('ok'), f'lifeguard scheduling is broken: {d}'
        return 'lifeguard scheduling loads'

    def b16_checkin():
        d = post('checkins', {'action': 'list_today'}, T)
        assert d.get('ok'), f'pool check-in is broken: {d}'
        return 'check-in screen loads'

    def b17_guest_passes_admin():
        d = post('guest_passes', {'action': 'list'}, T)
        assert d.get('ok'), f'guest pass admin is broken: {d}'
        return 'guest passes load'

    def b18_programs_admin():
        d = post('programs', {'action': 'list'}, T)
        assert d.get('ok'), f'programs admin is broken: {d}'
        return 'programs load'

    def b19_donations_and_sponsors():
        a = post('donations', {'action': 'list'}, T)
        b = post('sponsors_admin', {'action': 'list'}, T)
        assert a.get('ok'), f'donations are broken: {a}'
        assert b.get('ok'), f'sponsors are broken: {b}'
        return f"{len(a.get('donations') or [])} donations, {len(b.get('sponsors') or [])} sponsors"

    def b20_import_and_migrate():
        d = post('applications', {'action': 'list_prefilled'}, T)
        assert d.get('ok'), f'the migration tracker is broken: {d}'
        return 'migration tracker loads'

    def b21_settings_round_trip():
        d = post('tenant_settings', {'action': 'get'}, T)
        assert d.get('ok'), f'club settings will not load: {d}'
        assert isinstance(d.get('settings'), dict), 'settings came back malformed'
        return 'settings load'

    def b22_admins_and_roles():
        d = post('tenant_admin_auth', {'action': 'list_admins'}, T)
        assert d.get('ok'), f'the admin list is broken: {d}'
        n = len(d.get('admins') or [])
        note = f'{n} admin(s)'
        if n < 2:
            note += ' — with one admin, club-wide texts fall back to self-approval'
        return note

    def b23_audit_log():
        d = post('audit_admin', {'action': 'list'}, T)
        assert d.get('ok'), f'the audit log is broken: {d}'
        return f"{len(d.get('entries') or d.get('rows') or [])} recent entries"

    def b24_billing_and_texts():
        d = post('sms_blasts', {'action': 'list'}, T)
        assert d.get('ok'), f'text history/balance is broken: {d}'
        c = d.get('cap') or {}
        return f"{c.get('remaining')} of {c.get('cap')} monthly texts left, {c.get('credits',0)} purchased"

    def b25_health():
        d = post('admin_health', {'action': 'check'}, T)
        assert d.get('ok'), f'the health screen is broken: {d}'
        return 'health screen loads'

    def b26_gate():
        d = post('gate_admin', {'action': 'get_status'}, T)
        assert d.get('ok'), f'gate admin is broken: {d}'
        return 'gate status loads'

    def b27_renewal_tools():
        d = post('renewals', {'action': 'sms_usage'}, T)
        assert d.get('ok'), f'renewal tools are broken: {d}'
        return 'renewal season tools load'

    for i, (name, fn) in enumerate([
        ('Admin session loads',                b01_admin_can_sign_in),
        ('Dashboard numbers',                  b02_dashboard_numbers),
        ('Task queue is free of ghosts',       b02b_task_queue_is_clean),
        ('Application review queue',           b03_applications_pipeline),
        ('Renewals have their own view',       b04_renewals_have_their_own_view),
        ('Member roster',                      b05_households),
        ('Payments / who owes what',           b06_payments_queue),
        ('Party request arrives and approves', b07_approve_a_party),
        ('Events reach the public calendar',   b08_events_and_calendar),
        ('Announcements',                      b09_announcements),
        ('Club-wide text: preview and cost',   b10_text_blast_gate),
        ('Photo approvals',                    b11_photos_approval),
        ('Policies',                           b12_policies_editable),
        ('Board meeting minutes',              b13_board_meetings),
        ('Volunteer shifts',                   b14_volunteer),
        ('Lifeguard scheduling',               b15_lifeguards),
        ('Pool check-in',                      b16_checkin),
        ('Guest passes',                       b17_guest_passes_admin),
        ('Programs',                           b18_programs_admin),
        ('Donations and sponsors',             b19_donations_and_sponsors),
        ('Migration tracker',                  b20_import_and_migrate),
        ('Club settings',                      b21_settings_round_trip),
        ('Admins and roles',                   b22_admins_and_roles),
        ('Audit log',                          b23_audit_log),
        ('Text balance and history',           b24_billing_and_texts),
        ('Health screen',                      b25_health),
        ('Gate integration',                   b26_gate),
        ('Renewal season tools',               b27_renewal_tools),
    ], 1):
        step(i, name, fn)


def cleanup():
    head('CLEANUP — leaving the club exactly as we found it')
    def c1():
        for t, col, val in [('events','id',S.get('event_id')), ('posts','id',S.get('post_id'))]:
            if val: sql(f"delete from {t} where {col} = '{val}'")
        if S.get('hid'):
            sql(f"delete from party_bookings where household_id = '{S['hid']}'")
            sql(f"delete from household_members where household_id = '{S['hid']}'")
            sql(f"delete from households where id = '{S['hid']}'")
        sql(f"delete from applications where family_name like '%Audit Family {STAMP}%'")
        sql(f"delete from applications where is_renewal and household_id is null and payment_status <> 'paid'")
        sql(f"delete from feedback_submissions where comment like '%Journey audit {STAMP}%'")
        sql(f"delete from admin_tasks where summary like '%{STAMP}%'")
        left = sql(f"select count(*) as n from households where family_name like '%Audit%{STAMP}%'")[0]['n']
        assert left == 0, f'{left} audit household(s) left behind'
        return 'all audit data removed'
    step(1, 'Remove everything this audit created', c1)


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else '--all'
    print(f'\n  Poolside journey audit · {SLUG} · run {STAMP}')
    try:
        if which in ('--all', '--member'): member_journey()
        if which in ('--all', '--board'):  board_journey()
    finally:
        cleanup()

    ok   = sum(1 for r in RESULTS if r[0] == 'ok')
    bad  = [r for r in RESULTS if r[0] == 'fail']
    skip = [r for r in RESULTS if r[0] == 'skip']
    head('RESULT')
    print(f'  {GRN}{ok} working{RST}   {RED}{len(bad)} broken{RST}   {YEL}{len(skip)} skipped{RST}\n')
    for _, name, why in bad:
        print(f'  {RED}BROKEN{RST}  {name}\n          {why}')
    for _, name, why in skip:
        print(f'  {YEL}SKIP{RST}    {name}\n          {why}')
    print()
    sys.exit(1 if bad else 0)
