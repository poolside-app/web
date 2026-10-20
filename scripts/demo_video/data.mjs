// =============================================================================
// data.mjs — the made-up club in the demo video (PLAN.md BD)
// =============================================================================
// Maple Grove Swim Club and every family in it are invented. The repo is
// public: nothing here may come from a real club. respond() answers each
// Supabase call the demo's screens make; undefined means "not handled", and
// the harness lists those so a new call on a screen gets noticed.
// =============================================================================

// A June Saturday, mid-morning, at the pool.
export const DEMO_NOW = Date.parse('2027-06-19T10:40:00-07:00');
const day = (d, hm) => new Date(`2027-06-${String(d).padStart(2, '0')}T${hm}:00-07:00`).toISOString();
const ago = mins => new Date(DEMO_NOW - mins * 60000).toISOString();

export const CLUB = {
  id: 'demo-club', slug: 'maplegrove', display_name: 'Maple Grove Swim Club', app_name: 'Maple Grove',
  venmo: 'maplegroveswim', timezone: 'America/Los_Angeles',
};

const TIERS = [
  { slug: 'family', label: 'Family', name: 'Family', description: 'Everyone in your household', price_cents: 55000 },
  { slug: 'couple', label: 'Couple', name: 'Couple', description: 'Two adults', price_cents: 42000 },
  { slug: 'single', label: 'Single', name: 'Single', description: 'One adult', price_cents: 30000 },
];

const PUBLIC_SETTINGS = {
  hero: { eyebrow: 'Since 1972', headline: 'Summer at Maple Grove', tagline: 'Our neighborhood pool, open Memorial Day to Labor Day.' },
  branding: { background_photo_url: null, logo_url: null, primary_color: null, icon_192_url: null, icon_512_url: null, app_name: CLUB.app_name },
  club: { location: 'Maple Grove' },
  pool: { opens_at: '10:00', closes_at: '20:00', hours_by_day: null },
  payments: { venmo_handle: CLUB.venmo, paypal_link: null, pass_stripe_fee: true, stripe_pct: 2.9, stripe_fixed_cents: 30, offline_verify_window_days: 3, test_mode: false },
  payment_plan: { enabled: false, first_installment_pct: 50, final_due_date: null, plan_signup_cutoff_date: null, tiers: [] },
  party_length_hours: 3,
  parties: { fee_cents: 15000, auto_approve: true, hold_days: 2 },
  keyfobs: { included_free: 1, fee_cents: 1500, max_per_family: 5 },
  features: { swim_lessons: false, parties: true, keyfobs: true, gate: true, lifeguard_scheduling: false },
  access: { methods: ['keyfob'], show_member_pool_pass: false },
  fundraiser: { enabled: true, title: 'New shade sails', raised_cents: 612000, goal_cents: 900000, donate_message: 'Help us shade the baby pool!' },
  season: { open: true, memberships_frozen: false, closed_message: null, start_date: '2027-05-29', end_date: '2027-09-06' },
  apply: { heading_override: null },
  public: { show_member_count: true },
  sponsors_config: { popup_enabled: false, popup_frequency: 'once_per_session' },
  home_codes: [],
  referrals: { reward_cents: 5000, new_family_cents: 2500, wait_days: 30 },
};

const POSTS = [
  { id: 'post1', title: 'Swim team time trials Tuesday', body: 'Lanes 1–3 are closed 5–7 PM for time trials. The rest of the pool stays open.', pinned: true, published_at: ago(60 * 20) },
  { id: 'post2', title: 'Shade sails are going up', body: 'Thanks to 74 families, the new shade sails over the baby pool go up next week.', pinned: false, published_at: ago(60 * 48) },
];
const EVENTS = [
  { id: 'ev1', title: 'Family movie night', body: 'Bring a towel. Popcorn from the snack shack.', kind: 'social', location: 'Main lawn', starts_at: day(19, '19:30'), ends_at: day(19, '21:30'), all_day: false },
  { id: 'ev2', title: 'Swim team time trials', body: null, kind: 'swim_meet', location: 'Lanes 1–3', starts_at: day(22, '17:00'), ends_at: day(22, '19:00'), all_day: false },
  { id: 'ev3', title: 'Adult swim', body: null, kind: 'event', location: null, starts_at: day(20, '18:00'), ends_at: day(20, '20:00'), all_day: false },
  { id: 'ev4', title: 'Fourth of July BBQ', body: null, kind: 'holiday', location: 'Snack shack', starts_at: '2027-07-04T17:00:00-07:00', ends_at: '2027-07-04T20:00:00-07:00', all_day: false },
];

export function tenantPublic() {
  return {
    ok: true,
    tenant: { slug: CLUB.slug, display_name: CLUB.display_name, status: 'active', plan: 'club', stripe_charges_enabled: true, timezone: CLUB.timezone },
    public_settings: PUBLIC_SETTINGS,
    posts: POSTS, events: EVENTS, photos: [], programs: [], tiers: TIERS, sponsors: [],
    member_count: 186, today_checkins: { people: 41, guests: 6 },
  };
}

// ── The Rivera family: they sign up in the video, then use the app ────────
const RIVERA = {
  id: 'hh-rivera', family_name: 'Rivera Family', dues_paid_for_year: true, paid_until_year: 2026, tier_slug: 'family', address: '14 Willow Lane',
  members: [
    { id: 'm-jamie', name: 'Jamie Rivera', role: 'primary', phone_e164: '+15555550101', email: 'jamie@example.com', uses_app: true, active: true },
    { id: 'm-alex', name: 'Alex Rivera', role: 'adult', phone_e164: '+15555550102', uses_app: true, active: true },
    { id: 'm-sofia', name: 'Sofia Rivera', role: 'teen', birth_year: 2012, uses_app: false, active: true },
    { id: 'm-leo', name: 'Leo Rivera', role: 'child', birth_year: 2018, uses_app: false, active: true },
  ],
};
const RIVERA_PARTY = { id: 'p-rivera', title: "Leo's 9th birthday", body: null, starts_at: day(19, '16:00'), ends_at: day(19, '19:00'), expected_guests: 18,
  location: 'Main pool', status: 'approved', payment_method: 'stripe', payment_status: 'paid', price_cents: 15000, admin_notes: null,
  decided_at: ago(60 * 24 * 9), event_id: 'ev-rivera', created_at: ago(60 * 24 * 9), venmo_code: 'D4LP' };
function memberMe(state) {
  const paid = !!state.riveraPaid;
  return {
    ok: true,
    user: { id: 'm-jamie', name: 'Jamie Rivera', role: 'primary', email: 'jamie@example.com', phone_e164: '+15555550101', can_book_parties: true, can_unlock: true },
    tenant: { id: CLUB.id, slug: CLUB.slug, display_name: CLUB.display_name, timezone: CLUB.timezone },
    household: { ...RIVERA, paid_until_year: paid ? 2027 : 2026 },
    renewal: null, plan: null,
    keyfobs: {
      fobs: [
        { id: 'fob1', member_id: 'm-jamie', status: 'active', reason: 'new_member', included: true, price_cents: 0, payment_status: 'none', tail: '4417', requested_at: ago(60 * 24 * 20) },
      ],
      fee_cents: 1500, max_per_family: 5, room: 4, card_total_cents: 1575, card_pct: 2.9, card_fixed_cents: 30, venmo_handle: CLUB.venmo,
    },
    access: { member: true, season: 2027, reason: paid ? 'paid' : 'grace', can_use: null, pool_location: { lat: 38.0, lng: -122.0 } },
    is_board_member: false,
    refreshed_token: null,
  };
}

// ── The board: Sam Brooks, Treasurer ──────────────────────────────────────
const ALL_SCOPES = ['applications', 'households', 'payments', 'events', 'posts', 'parties', 'keyfobs', 'gate', 'sms', 'settings', 'audit'];
function boardMe() {
  return {
    ok: true,
    tenant: { slug: CLUB.slug, display_name: CLUB.display_name, status: 'active', plan: 'club', platform_fees_waived: true, timezone: CLUB.timezone,
      features: PUBLIC_SETTINGS.features, branding: PUBLIC_SETTINGS.branding },
    usage: {
      count: 186, cap: 400, remaining: 214, unlimited: false, at_cap: false, percent: 46, plan: 'club', plan_label: 'Club plan',
      dues: { season: 2027, paid: 171, collected_cents: 9405000, test_paid: 0 },
      sms: { used: 214, cap: 1000, remaining: 786, credits: 0, total_left: 786, days_until_reset: 12 },
    },
    renewed_token: null,
    user: {
      id: 'demo-board', email: 'treasurer@example.com', display_name: 'Sam Brooks', is_super: false, is_default_pw: false, active: true,
      scopes: ALL_SCOPES, role_template: 'owner', roles: ['owner'], linked_member_id: null, member_apply_dismissed: true,
      phone_e164: '+15555550199', board_title: 'Treasurer', impersonated: false,
    },
  };
}

// The Venmo payments the treasurer still has to find (PLAN.md BC1).
const VENMO_WAITING = [
  { kind: 'signup', id: 'app-patel', step: 'approve', family_name: 'Patel Family', label: 'New signup, 2027 dues', amount_cents: 55000, code: 'K7Q2', claimed: true, age_days: 0 },
  { kind: 'keyfob', id: 'fob-chen1', ids: ['fob-chen1', 'fob-chen2'], family_name: 'Chen Family', label: '2 keyfobs', amount_cents: 3000, code: 'M3PX #W9HC', claimed: true, age_days: 1 },
  { kind: 'party', id: 'party-okafor', family_name: 'Okafor Family', label: "Party: Ada's 10th birthday", amount_cents: 15000, code: 'R8TD', claimed: false, age_days: 1 },
  { kind: 'signup', id: 'app-ortiz', step: 'verify', family_name: 'Ortiz Family', label: '2027 dues', amount_cents: 42000, code: 'ZB4N', claimed: false, age_days: 3 },
];

// The board's to-dos. A card signup adds none (PLAN.md BD story, step 2).
function boardTasks(state) {
  const t = [
    { id: 'task-fob', kind: 'keyfob.issue', summary: 'Issue a keyfob to the Larsen Family (paid by card)', link_url: '/club/admin/keyfobs.html', created_at: ago(60 * 3), target_scopes: ['keyfobs'] },
    { id: 'task-q', kind: 'help.request', summary: 'Nguyen Family: "Can my nanny bring the kids on weekdays?"', link_url: '/club/admin/member-help.html', created_at: ago(60 * 26), target_scopes: [] },
  ];
  return t.filter(x => !(state.done ?? new Set()).has(x.id));
}
function boardHome(state) {
  // Families paid: the Riveras' card renewal, and the Patels once their Venmo is confirmed.
  const patel = !!state.confirmed?.has('app-patel');
  const paid = 171 + (state.riveraPaid ? 1 : 0) + (patel ? 1 : 0);
  const stat = (key, label, href, value, money = false) => ({ key, label, href, value, money });
  return {
    ok: true, tasks: boardTasks(state), me: 'demo-board', help_topics_mine: [], push_devices: 1,
    my_positions: [{ title: 'Treasurer', purpose: 'Keeps the club’s money straight.', description: null }],
    spending_rule: 'Spending over $500 needs a board vote.',
    home: {
      season: 2027, today: '2027-06-19',
      stats: [
        stat('collected', 'collected', '/club/admin/payments.html', 9405000 + (state.riveraPaid ? 55000 : 0) + (patel ? 55000 : 0)),
        stat('paid', 'families paid', '/club/admin/members.html', paid),
        stat('fobs_to_make', 'keyfobs to make', '/club/admin/keyfobs.html', 1),
        stat('parties_week', 'parties this week', '/club/admin/parties.html', 3),
      ].map(x => ({ ...x, money: x.key === 'collected' })),
      quick: [
        { key: 'payments', icon: '💵', label: 'Payments', href: '/club/admin/payments.html' },
        { key: 'signups', icon: '📝', label: 'Signups', href: '/club/admin/members.html#applications' },
        { key: 'keyfobs', icon: '🔑', label: 'Keyfobs', href: '/club/admin/keyfobs.html' },
        { key: 'text_all', icon: '📱', label: 'Text all members', href: '/club/admin/announcements.html#text' },
      ],
      signup_link: true,
      gate: { show: true, online: true, doors: [{ key: 'main_gate', name: 'Main Gate' }, { key: 'snack', name: 'Snack Shack' }, { key: 'pump', name: 'Pump Room' }] },
      pool: { opens_at: '10:00', closes_at: '20:00', hours_by_day: null, location: { lat: 38.0, lng: -122.0 } },
      season_open: true, closed_message: null,
      events: EVENTS, programs: [], shifts: [],
      parties: [
        { id: 'p-okafor', starts_at: day(19, '13:00'), ends_at: day(19, '16:00'), status: 'approved', pool_date: '2027-06-19', title: "Ada's 10th birthday", family: 'Okafor Family', paid: true },
        { id: 'p-rivera', starts_at: day(19, '16:00'), ends_at: day(19, '19:00'), status: 'approved', pool_date: '2027-06-19', title: "Leo's 9th birthday", family: 'Rivera Family', paid: true },
        { id: 'p-novak', starts_at: day(20, '12:00'), ends_at: day(20, '15:00'), status: 'approved', pool_date: '2027-06-20', title: 'Graduation party', family: 'Novak Family', paid: true },
      ],
      next_meeting: { id: 'mtg', title: 'June board meeting', date: '2027-06-24', time: '19:00', agenda: true },
      charge_day: null,
    },
  };
}

// Keyfobs: the families' fobs, one new one to hand out, and the sync.
const FAMILIES = ['Brooks', 'Chen', 'Larsen', 'Nguyen', 'Novak', 'Okafor', 'Ortiz', 'Patel', 'Rivera', 'Walsh'];
function keyfobList(state) {
  const fob = (id, fam, tail, extra = {}) => ({ id, household_id: 'hh-' + fam.toLowerCase(), family_name: fam + ' Family', member_id: null, member_name: null,
    card_number: 10000000 + Number(tail), tail, status: 'active', reason: 'imported', included: true, price_cents: 0, payment_status: 'none',
    payment_method: null, requested_at: ago(60 * 24 * 300), issued_at: ago(60 * 24 * 300), lost_at: null, turned_off_at: null, paid_at: null, level: 'member', ...extra });
  const fobs = [
    state.fobIssued
      ? fob('fob-larsen', 'Larsen', '4521', { reason: 'new_member', requested_at: ago(60 * 3), issued_at: ago(1) })
      : fob('fob-larsen', 'Larsen', null, { card_number: null, status: 'requested', reason: 'new_member', requested_at: ago(60 * 3), issued_at: null }),
    fob('fob-rivera', 'Rivera', '4417'), fob('fob-chen', 'Chen', '3302'), fob('fob-okafor', 'Okafor', '2871'),
    fob('fob-novak', 'Novak', '1956'), fob('fob-ortiz', 'Ortiz', '3610'), fob('fob-walsh', 'Walsh', '2204'),
  ];
  return {
    ok: true,
    settings: { enabled: true, included_free: 1, fee_cents: 1500, max_per_family: 5 },
    fobs,
    households: FAMILIES.map(f => ({ id: 'hh-' + f.toLowerCase(), family_name: f + ' Family', address: null })),
    access: {
      levels: [
        { key: 'member', name: 'Member', doors: ['main_gate'], days: [0, 1, 2, 3, 4, 5, 6], start: '10:00', end: '20:00', from: '2027-05-29', until: '2027-09-06', text: 'Main Gate, every day 10:00 AM–8:00 PM, May 29 – Sep 6' },
        { key: 'board', name: 'Board', doors: ['main_gate', 'snack', 'pump'], days: [0, 1, 2, 3, 4, 5, 6], start: null, end: null, from: null, until: null, text: 'Every door, any time' },
      ],
      party_doors: ['snack'],
      doors: [{ key: 'main_gate', name: 'Main Gate', remote: true }, { key: 'snack', name: 'Snack Shack', remote: true }, { key: 'pump', name: 'Pump Room', remote: true }],
    },
  };
}
// "Sync keyfobs now": read the doors, then send the one change.
function syncStatus(state) {
  const job = (id, kind, status, result, mins = 0) => ({ id, kind, status, auto: false, created_at: ago(mins + 1), completed_at: status === 'done' ? ago(mins) : null, result, error: null });
  const jobs = [];
  const sent = job('send-0', 'send', 'done', { summary: { live: 3 } }, 60 * 24 * 2);
  if (state.sync === 'checking') jobs.push(job('check-1', 'check', 'in_flight', null));
  if (state.sync === 'checked') jobs.push(job('check-1', 'check', 'done', { ops: 1, summary: { add: 1, unchanged: 212 }, lines: ['Larsen Family: fob 4521 on the Main Gate, Member hours'] }));
  if (state.sync === 'sending') jobs.push(job('send-1', 'send', 'in_flight', null));
  if (state.sync === 'sent') jobs.push(job('send-1', 'send', 'done', { summary: { live: 1 } }));
  jobs.push(sent);
  return { ok: true, ready: true, bridge_version: '1.4.0-poolside', auto: false, jobs };
}

// Insights → Time saved, worked out the way _shared/time_saved.ts does.
const TIME_ITEMS = [
  ['signup_form', 'Signup form, each season', 'Building the signup form in Jotform for the season.', 60, 1],
  ['signup', 'Signups and renewals', 'Typing each family into the spreadsheet and checking it line by line.', 10, 172],
  ['payment', 'Payments confirmed', 'Cross-checking Venmo or PayPal and marking the family paid.', 5, 181],
  ['keyfob', 'Keyfobs turned on or off', 'Signing in to the gate computer and finding the family to turn a fob on or off.', 10, 64],
  ['plan_payment', 'Plan payments collected', 'Reminding the family and recording each payment.', 5, 22],
  ['party', 'Parties booked', 'Calls and emails back and forth to book a date and take the fee.', 20, 19],
  ['door', 'Doors opened remotely and passes', 'A trip to the pool to let someone in.', 15, 38],
];
export function timeSaved() {
  const rows = TIME_ITEMS.map(([key, label, before, minutes_each, count]) => ({ key, label, before, count, minutes_each, total_minutes: count * minutes_each }));
  const minutes = rows.reduce((n, r) => n + r.total_minutes, 0);
  return { ok: true, can_edit: true, rows, minutes, hours: minutes / 60, per_hour: 20, dollars: Math.round(minutes / 60 * 20) };
}

export function weather() {
  return { current: { temperature_2m: 84, weather_code: 0 }, current_units: { temperature_2m: '°F' } };
}

export function respond(fn, body, { side, state }) {
  const a = body.action;
  state.confirmed ??= new Set();
  switch (fn) {
    case 'tenant_public': return tenantPublic();
    case 'policies': if (a === 'list_public') return { ok: true, policies: [
      { slug: 'pool-rules', title: 'Pool rules and waiver', required_for_apply: true,
        body: 'Children under 12 swim with an adult. No glass on the pool deck. Guests sign in at the gate.\n\nBy accepting, your family agrees to the pool rules and the club\'s liability waiver for the 2027 season.' },
    ] }; break;
    // Parts of the member home the demo leaves empty.
    case 'help_requests': if (a === 'mine') return { ok: true, requests: [] }; break;
    case 'external_calendar': if (a === 'list_public') return { ok: true, events: [] }; break;
    case 'programs': if (a === 'list_public') return { ok: true, programs: [] }; if (a === 'my_bookings') return { ok: true, bookings: [] }; break;
    case 'volunteer': if (a === 'list_public') return { ok: true, shifts: [] }; if (a === 'my_signups') return { ok: true, signups: [] }; break;
    case 'donations': if (a === 'list_public') return { ok: true, donations: [] }; break;
    case 'unlock_gate':
      // A family with a paid party today also gets the party door (PLAN.md AR4).
      if (a === 'check') return { ok: true, tenant_active: true, can_unlock: true, gate_closed: null,
        doors: [{ key: 'main_gate', name: 'Front gate', via: 'member' }, ...(state.partyToday ? [{ key: 'snack', name: 'Snack Shack', via: 'pass', until: day(19, '20:00') }] : [])] };
      if (a === 'tap') { state.unlockPolls = 0; return { ok: true, unlock_id: 'unlock-1' }; }
      // The bridge answers on the second look, about a second later.
      if (a === 'status') return (state.unlockPolls = (state.unlockPolls ?? 0) + 1) < 2 ? { ok: true, status: 'pending' } : { ok: true, status: 'done', result_code: 'ok' };
      break;
    case 'member_auth':
      if (a === 'me') return memberMe(state);
      if (a === 'list_my_parties') return { ok: true, parties: state.partyToday ? [RIVERA_PARTY] : [] };
      // Renewing for 2027 (the "pays by card, already has a fob" family).
      if (a === 'renewal_options') return {
        ok: true, year: 2027, open: true, already_paid: !!state.riveraPaid, tier_label: 'Family', dues_cents: 55000, pass_fee: false,
        plans_enabled: false, plan: { available: false }, options: [],
        price: { base_cents: 55000, discount_cents: 0, credit_cents: 0, amount_due_cents: 55000, code: null, code_label: null, code_problem: null, note: null, fob_count: 0, fob_cents: 0, fob_fee_cents: 1500, fob_room: 4 },
        application_id: null, family_name: 'Rivera Family', auto_renew: false, saved_card: false, last_plan: false,
        signer_name: 'Jamie Rivera', i_am_signer: true, signed_at: null,
        keyfobs: { fee_cents: 1500, max_per_family: 5, app_unlock: true },
      };
      if (a === 'renew_start') return { ok: true, application_id: 'app-rivera-2027', amount_due_cents: 55000 };
      if (a === 'renew_sign') return { ok: true, signed_at: new Date(DEMO_NOW).toISOString() };
      break;
    case 'tenant_admin_auth':
      if (a === 'me' || a === 'verify') return boardMe();
      break;
    case 'admin_tasks':
      if (a === 'list') { const h = boardHome(state); delete h.home; return h; }
      if (a === 'home') return boardHome(state);
      if (a === 'complete') { (state.done ??= new Set()).add(body.id); return { ok: true }; }
      if (a === 'time_saved') return timeSaved();
      break;
    case 'tenant_settings':
      if (a === 'setup_status') return { ok: true, complete: true, done: [], items: [], total: 0 };
      break;
    case 'payments_admin':
      if (a === 'venmo_waiting') return { ok: true, items: VENMO_WAITING.filter(i => !state.confirmed.has(i.id)) };
      if (a === 'list') return { ok: true, items: [] };
      break;
    case 'applications':
      if (a === 'submit') return { ok: true, id: 'app-patel', venmo: { code: 'K7Q2', amount_cents: 55000, note: 'Maple Grove 2027 dues - Patel - #K7Q2',
        link: 'https://venmo.com/maplegroveswim?txn=pay&amount=550.00&note=' + encodeURIComponent('Maple Grove 2027 dues - Patel - #K7Q2') } };
      if (a === 'approve' || a === 'verify_payment') { state.confirmed.add(body.id); return { ok: true }; }
      break;
    case 'gate_admin':
      if (a === 'board_unlock') return { ok: true, unlock_id: 'board-unlock-1' };
      break;
    case 'keyfobs':
      if (a === 'list') return keyfobList(state);
      if (a === 'issue') { state.fobIssued = true; (state.done ??= new Set()).add('task-fob'); return { ok: true, fob: { id: body.id, tail: String(body.number).slice(-4) } }; }
      if (a === 'sync_status') return syncStatus(state);
      if (a === 'sync_check') { state.sync = 'checking'; return { ok: true }; }
      if (a === 'sync_send') { state.sync = 'sending'; return { ok: true }; }
      if (a === 'confirm_venmo') { state.confirmed.add(VENMO_WAITING.find(i => i.ids?.includes(body.id))?.id ?? body.id); return { ok: true }; }
      break;
    case 'stripe_checkout':
      // The card page is Stripe's, so the demo skips it: paying lands back in
      // the app, and Poolside's side (the webhook's approval) happens here.
      if (a === 'application') { state.riveraPaid = true; return { ok: true, url: '/m/?renewed=1' }; }
      break;
    case 'parties_admin':
      if (a === 'verify_payment') { state.confirmed.add(body.id); return { ok: true }; }
      break;
  }
  // Parts of the Payments and Keyfobs pages the demo doesn't open.
  if (QUIET.has(`${fn}:${a}`)) return { ok: true };
  return undefined;
}
const QUIET = new Set(['stripe_connect:status', 'tenant_settings:get', 'payment_plans:config_get', 'payment_plans:list_plans', 'referrals:list',
  'payments_admin:late_fee_config', 'payments_admin:list_late_fees', 'payments_admin:codes_list', 'gate_admin:pass_list']);
