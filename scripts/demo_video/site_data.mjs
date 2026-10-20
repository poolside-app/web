// =============================================================================
// site_data.mjs — the rest of the demo club, for demo.poolsideapp.com (BG9)
// =============================================================================
// data.mjs answers the calls the demo video makes. The demo site lets anyone
// open every screen, so this answers the rest: families, signups, parties,
// events, emails, the board, settings. All of it is made up (the repo is
// public). siteRespond() tries data.mjs first, then these.
//
// `pre` holds what build_demo_site.mjs works out from the app's own code
// (the 19 emails and their previews, the board positions), so the demo shows
// the real lists without copying them by hand.
//
// Nothing here is ever sent anywhere. WOULD (below) says, for the actions that
// would text, email, charge or open a door in a real club, what would have
// happened; the demo shows it as a note instead.
// =============================================================================

import { respond, CLUB, TIERS, PUBLIC_SETTINGS, POSTS, EVENTS, FAMILIES, RIVERA, day, ago, DEMO_NOW } from './data.mjs';

const ADDRESSES = ['3 Elm Court', '21 Birch Way', '9 Cedar Lane', '40 Maple Drive', '17 Oak Street', '6 Aspen Court', '28 Willow Lane', '12 Pine Road', '14 Willow Lane', '33 Spruce Way'];
const FIRST = { Brooks: ['Sam', 'Riley'], Chen: ['Mei', 'David'], Larsen: ['Erik', 'Anna'], Nguyen: ['Linh', 'Tuan'], Novak: ['Petra', 'Jan'],
  Okafor: ['Ngozi', 'Chidi'], Ortiz: ['Lucia', 'Mateo'], Patel: ['Priya', 'Raj'], Rivera: ['Jamie', 'Alex'], Walsh: ['Kate', 'Liam'] };
const KIDS = { Brooks: ['Ava'], Chen: ['Lily', 'Max'], Larsen: ['Freya'], Nguyen: ['Minh'], Novak: ['Tomas', 'Ela'], Okafor: ['Ada'], Ortiz: ['Sofia', 'Diego'], Patel: ['Arjun'], Rivera: ['Sofia', 'Leo'], Walsh: [] };

function phone(i, k) { return `+1555555${String(200 + i * 3 + k).padStart(4, '0')}`; }

/** Every family, the way households_admin `list` returns them. */
function households(state) {
  return FAMILIES.map((f, i) => {
    const id = 'hh-' + f.toLowerCase();
    const [a1, a2] = FIRST[f];
    const members = [
      { id: `m-${f}-1`, household_id: id, name: `${a1} ${f}`, phone_e164: phone(i, 0), email: `${a1.toLowerCase()}@example.com`, role: 'primary', can_unlock_gate: true, can_book_parties: true, active: true, confirmed_at: ago(60 * 24 * 40), last_seen_at: ago(60 * (i + 2)), created_at: ago(60 * 24 * 400) },
      { id: `m-${f}-2`, household_id: id, name: `${a2} ${f}`, phone_e164: phone(i, 1), email: null, role: 'adult', can_unlock_gate: true, can_book_parties: true, active: true, confirmed_at: null, last_seen_at: null, created_at: ago(60 * 24 * 400) },
      ...KIDS[f].map((k, j) => ({ id: `m-${f}-k${j}`, household_id: id, name: `${k} ${f}`, phone_e164: null, email: null, role: 'child', can_unlock_gate: false, can_book_parties: false, active: true, confirmed_at: null, last_seen_at: null, created_at: ago(60 * 24 * 400) })),
    ];
    const unpaid = f === 'Ortiz' || (f === 'Patel' && !state.confirmed?.has('app-patel'));
    const onPlan = f === 'Okafor' || f === 'Nguyen' || f === 'Walsh';
    return { id, family_name: f + ' Family', tier: f === 'Walsh' ? 'couple' : 'family', fob_number: null, dues_paid_for_year: !unpaid && !onPlan, paid_until_year: unpaid ? 2026 : 2027,
      address: ADDRESSES[i], city: 'Maple Grove', zip: '94000', emergency_contact: null, notes: null, active: true, created_at: ago(60 * 24 * (400 - i)),
      members, test_paid: false, on_plan: onPlan };
  });
}

/** Signups for 2027 (applications `list`). */
function applications(state) {
  const base = { membership_year: 2027, is_renewal: false, address: null, city: 'Maple Grove', zip: '94000', num_adults: 2, num_kids: 1, body: null,
    admin_notes: null, decided_by: null, verified_by: null, reminder_count: 0, last_reminder_at: null, is_new_member: true, need_new_fob: true,
    prior_fob_number: null, fob_review_note: null, fob_extra_count: 0, fob_cents: 0, alt_email: null, adults_json: [], children_json: [],
    waivers_accepted: { 'pool-rules': true }, signature_primary: null, signature_guardian: null, no_app_member: false, wants_auto_renew: false,
    claim_source: null, invited_at: null, claimed_at: null, emergency_contact: null, discount_cents: 0, discount_kind: null, credit_cents: 0,
    payment_reference: null, plans: [] };
  const app = (id, fam, extra) => ({ ...base, id, family_name: fam + ' Family', primary_name: `${FIRST[fam]?.[0] ?? 'Pat'} ${fam}`,
    primary_email: `${(FIRST[fam]?.[0] ?? 'pat').toLowerCase()}@example.com`, primary_phone: '+15555550142', tier_slug: 'family',
    base_cents: 55000, amount_due_cents: 55000, created_at: ago(60 * 5), updated_at: ago(60 * 5), accepted_at: ago(60 * 5), ...extra });
  const patelDone = state.confirmed?.has('app-patel');
  return [
    app('app-patel', 'Patel', { status: patelDone ? 'approved' : 'pending', payment_method: 'venmo', payment_status: patelDone ? 'paid' : 'unpaid', venmo_code: 'K7Q2', decided_at: patelDone ? ago(1) : null, paid_at: patelDone ? ago(1) : null, verified_at: patelDone ? ago(1) : null, household_id: patelDone ? 'hh-patel' : null, stripe_session_id: null }),
    app('app-ortiz', 'Ortiz', { status: 'approved', payment_method: 'venmo', payment_status: state.confirmed?.has('app-ortiz') ? 'paid' : 'unpaid', venmo_code: 'ZB4N', tier_slug: 'couple', base_cents: 42000, amount_due_cents: 42000, decided_at: ago(60 * 24 * 3), paid_at: null, verified_at: null, household_id: 'hh-ortiz', created_at: ago(60 * 24 * 3) }),
    app('app-larsen', 'Larsen', { status: 'approved', payment_method: 'stripe', payment_status: 'paid', venmo_code: 'H2WQ', decided_at: ago(60 * 3), paid_at: ago(60 * 3), verified_at: ago(60 * 3), household_id: 'hh-larsen', stripe_session_id: 'cs_demo_larsen', created_at: ago(60 * 3) }),
    app('app-okafor', 'Okafor', { status: 'approved', payment_method: 'stripe_plan', payment_status: 'pending', venmo_code: 'T6YK', decided_at: ago(60 * 24 * 30), paid_at: null, verified_at: null, household_id: 'hh-okafor', created_at: ago(60 * 24 * 30), plan_started_at: ago(60 * 24 * 30),
      plans: [{ status: 'active', paid_cents: 35000, total_cents: 55000 }] }),
  ];
}

function parties(state) {
  const p = (id, fam, title, d, hm, extra) => {
    const starts = day(d, hm); const ends = new Date(Date.parse(starts) + 3 * 3600000).toISOString();
    return { id, tenant_id: CLUB.id, household_id: 'hh-' + fam.toLowerCase(), requested_by: `m-${fam}-1`, title, body: null, starts_at: starts, ends_at: ends,
      expected_guests: 20, location: 'Main pool', status: 'approved', admin_notes: null, decided_at: ago(60 * 24 * 6), decided_by: null, event_id: null,
      price_cents: 15000, payment_method: 'stripe', payment_status: 'paid', paid_at: ago(60 * 24 * 5), verified_at: ago(60 * 24 * 5), verified_by: null,
      created_at: ago(60 * 24 * 7), venmo_code: 'P' + id.slice(-3).toUpperCase(), family_name: fam + ' Family', household: { id: 'hh-' + fam.toLowerCase(), family_name: fam + ' Family', address: null, city: 'Maple Grove' },
      requester: { id: `m-${fam}-1`, name: `${FIRST[fam][0]} ${fam}`, email: `${FIRST[fam][0].toLowerCase()}@example.com`, phone_e164: '+15555550150' }, ...extra };
  };
  return [
    p('party-okafor', 'Okafor', "Ada's 10th birthday", 19, '13:00', { payment_method: 'venmo', payment_status: state.confirmed?.has('party-okafor') ? 'paid' : 'unpaid', paid_at: null, verified_at: null, venmo_code: 'R8TD' }),
    p('party-rivera', 'Rivera', "Leo's 9th birthday", 19, '16:00', {}),
    p('party-novak', 'Novak', 'Graduation party', 20, '12:00', {}),
    p('party-chen', 'Chen', 'Swim team end-of-season', 26, '15:00', { status: 'pending', decided_at: null, payment_status: 'unpaid', paid_at: null, verified_at: null }),
  ];
}

const PHOTO = (id, caption, hue) => ({ id, tenant_id: CLUB.id, caption, sort_order: 0, active: true, status: 'approved', uploaded_by_kind: 'admin', uploaded_by_member_id: null,
  uploader_name: null, approved_at: ago(60 * 24), approved_by: null, rejected_at: null, rejected_by: null, rejected_reason: null, created_at: ago(60 * 24), updated_at: ago(60 * 24),
  // A plain colored tile: the demo has no real photos.
  url: `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="hsl(${hue},55%,62%)"/><text x="400" y="260" font-family="Georgia" font-size="40" text-anchor="middle" fill="white">${caption}</text></svg>`)}` });

function boardGet(pre) {
  const positions = (pre.positions || []).map((p, i) => ({ ...p, id: 'pos-' + p.slug, sort: i,
    holders: p.slug === 'treasurer' ? [{ id: 'demo-board', name: 'Sam Brooks', pending: false }]
      : p.slug === 'president' ? [{ id: 'adm-chen', name: 'Mei Chen', pending: false }]
      : p.slug === 'facilities' ? [{ id: 'adm-larsen', name: 'Erik Larsen', pending: false }] : [],
    vacant_goes_to: null }));
  const members = [
    { id: 'adm-chen', name: 'Mei Chen', board_title: 'President', pending: false, full_access: true, position_ids: ['pos-president'] },
    { id: 'demo-board', name: 'Sam Brooks', board_title: 'Treasurer', pending: false, full_access: false, position_ids: ['pos-treasurer'] },
    { id: 'adm-larsen', name: 'Erik Larsen', board_title: 'Facilities Director', pending: false, full_access: false, position_ids: ['pos-facilities'] },
  ];
  return { ok: true, me: 'demo-board', is_owner: true, spending_rule: 'Under $50, go ahead. $50 or more needs board approval.',
    positions, members, staff: [{ id: 'adm-gate', name: 'Gate iPad', pending: false }], notices: pre.notices || {}, screens: pre.screens || {} };
}

const SETTINGS_FULL = () => ({
  ...PUBLIC_SETTINGS,
  club: { location: 'Maple Grove', city: 'Maple Grove', state: 'CA', default_city: 'Maple Grove', default_zip: '94000', swim_team_name: 'Maple Grove Marlins', email: 'board@example.com' },
  membership: { year: 2027, renewal_opens_month: 10 },
  membership_tiers: TIERS,
  features: { ...PUBLIC_SETTINGS.features },
  payments: { ...PUBLIC_SETTINGS.payments, venmo_handle: CLUB.venmo, test_mode: false },
});

/**
 * What would have happened in a real club, for actions that reach outside
 * Poolside. Shown as a note on screen instead (Doug, 10/20: "label things
 * like this button WOULD send a text or email").
 */
export const WOULD = {
  'sms_blasts:queue': 'In a real club, this text waits for a second board member to release it.',
  'sms_blasts:approve': 'In a real club, this texts every member with a phone number.',
  'sms_blasts:send': 'In a real club, this texts every member with a phone number.',
  'renewals:send_renewal_links': 'In a real club, this emails and texts last season\'s families their own renewal link.',
  'applications:approve': 'In a real club, this emails and texts the family their welcome, with a link to sign in.',
  'applications:verify_payment': 'In a real club, this emails the family that their payment arrived.',
  'applications:send_reminder': 'In a real club, this emails the family a reminder with the amount and a Venmo button.',
  'applications:reject': 'In a real club, this emails the family that their signup wasn\'t approved.',
  'email_templates:test': 'In a real club, this emails you a test copy.',
  'posts_admin:create': 'In a real club, members who turned on pop-ups get this one on their phone (if you ticked Notify).',
  'parties_admin:approve': 'In a real club, this emails the family that their party is approved.',
  'parties_admin:verify_payment': 'In a real club, this books the party and emails the family.',
  'parties_admin:reject': 'In a real club, this emails the family.',
  'help_requests:reply': 'In a real club, this sends the member your reply as a pop-up.',
  'gate_admin:board_unlock': 'In a real club, this opens that door for a few seconds.',
  'unlock_gate:tap': 'In a real club, this opens the front gate for a few seconds.',
  'gate_admin:pass_give': 'In a real club, this gives the pass and texts the link if you chose to.',
  'keyfobs:issue': 'In a real club, the fob goes on the doors at the next sync.',
  'keyfobs:sync_send': 'In a real club, this writes the changes to the doors.',
  'payment_plans:approve': 'In a real club, this charges the families\' saved cards on billing day.',
  'member_auth:start': 'In a real club, this texts a 6-digit sign-in code. In the demo, type any 6 digits.',
  'tenant_admin_auth:start_link': 'In a real club, this texts a 6-digit sign-in code.',
  'tenant_admin_auth:invite_admin': 'In a real club, this texts or emails them an invite.',
  'board:invite': 'In a real club, this texts or emails them an invite.',
  'stripe_checkout:application': 'In a real club, this opens Stripe\'s secure card page.',
  'stripe_checkout:keyfob': 'In a real club, this opens Stripe\'s secure card page.',
  'stripe_checkout:party': 'In a real club, this opens Stripe\'s secure card page.',
  'member_auth:family_invite': 'In a real club, this texts them a link to get the app.',
  'referrals:issue_refund': 'In a real club, this refunds their card through Stripe.',
};

export function siteRespond(fn, body, ctx) {
  const { state, pre = {} } = ctx;
  const a = body.action;
  const first = respond(fn, body, ctx);
  if (first !== undefined && !(first && Object.keys(first).length === 1 && first.ok === true && QUIET_REPLACED.has(`${fn}:${a}`))) return first;
  switch (fn) {
    case 'households_admin':
      if (a === 'list') return { ok: true, households: households(state) };
      break;
    case 'applications':
      if (a === 'list') return { ok: true, applications: applications(state) };
      if (a === 'list_years') return { ok: true, years: [2027, 2026] };
      if (a === 'list_prefilled') return { ok: true, applications: [], summary: { total: 0, claimed: 0, invited: 0 } };
      if (a === 'log') return { ok: true, actions: [{ kind: 'submitted', body: null, created_at: ago(60 * 5) }] };
      if (['reject', 'send_reminder', 'update'].includes(a)) return { ok: true, sent: true };
      break;
    case 'parties_admin':
      if (a === 'list') return { ok: true, bookings: parties(state).filter(b => !body.status || body.status === 'all' || b.status === body.status) };
      if (a === 'settings_get') return { ok: true, length_hours: 3, fee_cents: 15000, auto_approve: true, hold_days: 2 };
      if (['approve', 'reject', 'cancel', 'settings_save', 'admin_cancel'].includes(a)) return { ok: true };
      break;
    case 'events_admin':
      if (a === 'list') return { ok: true, events: EVENTS.map(e => ({ ...e, tenant_id: CLUB.id, active: true, recurrence: null, recurrence_until: null, created_at: ago(60 * 24 * 10), updated_at: ago(60 * 24 * 10) })) };
      return { ok: true, event: { id: 'ev-new' } };
    case 'external_calendar':
      if (a === 'list_feeds') return { ok: true, feeds: [{ id: 'feed1', name: 'Maple Grove Marlins swim team', url: 'https://example.com/marlins.ics', color: '#0ea5e9', active: true, last_synced_at: ago(14), event_count: 12, last_error: null }] };
      break;
    case 'posts_admin':
      if (a === 'list') return { ok: true, posts: POSTS.map(p => ({ ...p, tenant_id: CLUB.id, active: true, created_at: p.published_at, updated_at: p.published_at })) };
      return { ok: true, post: { id: 'post-new' } };
    case 'sms_blasts':
      if (a === 'list') return { ok: true, blasts: [{ id: 'blast1', body: 'Pool is closed until 2 PM today for a thunderstorm. We\'ll text when it reopens.', status: 'sent', recipients: 214, segments: 1, created_by_name: 'Mei Chen', approved_by_name: 'Sam Brooks', created_at: ago(60 * 24 * 12), sent_at: ago(60 * 24 * 12) }] };
      if (a === 'history') return { ok: true, days: [{ day: '2027-06-07', kinds: { 'Club-wide text': 214, 'Sign-in codes': 9 } }], rows: [] };
      return { ok: true, blast: { id: 'blast-new', status: 'pending' } };
    case 'audit_admin':
      if (a === 'list') return { ok: true, entries: [
        { id: 'au1', kind: 'application.approve', entity_type: 'application', entity_id: 'app-larsen', summary: 'Approved Larsen Family (paid by card)', actor_kind: 'stripe', actor_label: 'Card payment', metadata: null, created_at: ago(60 * 3) },
        { id: 'au2', kind: 'keyfob.sync_done', entity_type: 'keyfob_sync', entity_id: null, summary: 'Nightly keyfob check: nothing to change', actor_kind: 'system', actor_label: 'Nightly', metadata: null, created_at: ago(60 * 9) },
        { id: 'au3', kind: 'payments.approve', entity_type: 'tenant', entity_id: null, summary: 'Approved 3 plan payments for July 1', actor_kind: 'tenant_admin', actor_label: 'Sam Brooks', metadata: null, created_at: ago(60 * 24) },
      ] };
      break;
    case 'board_meetings':
      if (a === 'list') return { ok: true, meetings: [{ id: 'mtg-may', title: 'May board meeting', meeting_date: '2027-05-27', status: 'closed', visibility: 'public', attendees: ['Mei Chen', 'Sam Brooks', 'Erik Larsen'], notes: 'Opening day plan approved. Shade sail quotes reviewed.', motions: [{ text: 'Approve opening day May 29', result: 'passed' }], followups: [], created_at: ago(60 * 24 * 23) }] };
      if (a === 'next') return { ok: true, meeting: { id: 'mtg', title: 'June board meeting', meeting_date: '2027-06-24', status: 'draft' }, items: [{ id: 'ai1', body: 'Shade sail install date', added_by_name: 'Erik Larsen', created_at: ago(60 * 24 * 2) }] };
      if (a === 'bylaws') return { ok: true, text: 'Article I. Name. The club is Maple Grove Swim Club.\n\nArticle II. Purpose. To run a neighborhood pool for its members.', updated_at: ago(60 * 24 * 300), can_change: true };
      if (a === 'list_public') return { ok: true, meetings: [], bylaws: { text: 'Article I. Name. The club is Maple Grove Swim Club.', updated_at: ago(60 * 24 * 300) }, board: [{ name: 'Mei Chen', titles: ['President'] }, { name: 'Sam Brooks', titles: ['Treasurer'] }, { name: 'Erik Larsen', titles: ['Facilities Director'] }] };
      return { ok: true };
    case 'donations':
      if (a === 'list') return { ok: true, donations: [
        { id: 'don1', amount_cents: 25000, donor_name: 'Walsh Family', donor_email: null, message: 'Shade for the little ones!', method: 'stripe', is_public: true, is_anonymous: false, status: 'verified', stripe_session_id: 'cs_demo', created_at: ago(60 * 24 * 4), verified_at: ago(60 * 24 * 4) },
        { id: 'don2', amount_cents: 10000, donor_name: null, donor_email: null, message: null, method: 'venmo', is_public: true, is_anonymous: true, status: 'verified', stripe_session_id: null, created_at: ago(60 * 24 * 6), verified_at: ago(60 * 24 * 6) },
      ] };
      return { ok: true, raised_cents: 612000 };
    case 'email_templates':
      if (a === 'list') return { ok: true, sections: pre.emailSections || [], emails: pre.emails || [], aliases: pre.emailAliases || {} };
      if (a === 'outbox') return { ok: true, quota_limited: false, quota_used: null, queued: [], failed: [] };
      if (a === 'preview') {
        const key = `${body.key}|${body.variant || ''}`;
        const pv = pre.previews?.[key] || pre.previews?.[`${body.key}|`] || { subject: '', html: '' };
        return { ok: true, ...pv };
      }
      if (a === 'test') return { ok: true, to: 'treasurer@example.com' };
      return { ok: true };
    case 'lifeguards':
      if (a === 'list_shifts') return { ok: true, shifts: [] };
      if (a === 'list') return { ok: true, lifeguards: [] };
      return { ok: true };
    case 'help_requests':
      if (a === 'topics') return { ok: true, topics: [
        { topic: 'keyfob', label: 'Keyfob & gate', goes_to: ['Erik Larsen'] }, { topic: 'membership', label: 'Membership & dues', goes_to: ['Sam Brooks'] },
        { topic: 'parties', label: 'Parties & events', goes_to: ['Mei Chen'] }, { topic: 'other', label: 'Something else', goes_to: ['Mei Chen'] }] };
      if (a === 'list') return { ok: true, requests: [{ id: 'hr1', topic: 'membership', status: 'open', created_at: ago(60 * 26), updated_at: ago(60 * 26), solved_at: null,
        member_name: 'Linh Nguyen', family_name: 'Nguyen Family', assigned_admin_id: 'demo-board', last_message: 'Can my nanny bring the kids on weekdays?', message_count: 1, unread: true }] };
      if (a === 'get') return { ok: true, request: { id: 'hr1', topic: 'membership', status: 'open', created_at: ago(60 * 26), member_name: 'Linh Nguyen', family_name: 'Nguyen Family' },
        messages: [{ author_kind: 'member', body: 'Can my nanny bring the kids on weekdays?', created_at: ago(60 * 26) }], member: { name: 'Linh Nguyen', phone_e164: '+15555550210', email: 'linh@example.com' }, board: [], is_owner: true };
      return { ok: true };
    case 'photos_admin':
      if (a === 'list') return { ok: true, photos: [PHOTO('ph1', 'Opening day', 200), PHOTO('ph2', 'Swim team relay', 190), PHOTO('ph3', 'Movie night', 260)] };
      if (a === 'list_pending') return { ok: true, photos: [] };
      if (a === 'pending_count') return { ok: true, count: 0 };
      return { ok: true };
    case 'policies':
      if (a === 'list') return { ok: true, policies: [
        { id: 'pol1', tenant_id: CLUB.id, slug: 'pool-rules', title: 'Pool rules and waiver', body: 'Children under 12 swim with an adult. No glass on the pool deck. Guests sign in at the gate.', required_for_apply: true, sort_order: 1, active: true, updated_at: ago(60 * 24 * 60) },
        { id: 'pol2', tenant_id: CLUB.id, slug: 'guest', title: 'Guest policy', body: 'Up to 4 guests a day, $5 each, paid at the gate.', required_for_apply: true, sort_order: 2, active: true, updated_at: ago(60 * 24 * 60) },
        { id: 'pol3', tenant_id: CLUB.id, slug: 'party', title: 'Party policy', body: 'Parties run 3 hours. The host family stays the whole time.', required_for_apply: false, sort_order: 3, active: true, updated_at: ago(60 * 24 * 60) },
      ] };
      return { ok: true };
    case 'programs':
      if (a === 'list') return { ok: true, programs: [] };
      return { ok: true };
    case 'sponsors_admin':
      if (a === 'list') return { ok: true, sponsors: [{ id: 'sp1', name: 'Grove Hardware', logo_url: null, link_url: 'https://example.com', description: 'Your neighborhood hardware store.', tier: 'gold', paid_through: '2027-12-31', sort_order: 1, active: true, created_at: ago(60 * 24 * 90), updated_at: ago(60 * 24 * 90) }] };
      return { ok: true };
    case 'volunteer':
      if (a === 'list') return { ok: true, opportunities: [{ id: 'vol1', tenant_id: CLUB.id, title: 'Snack shack, movie night', description: 'Pop corn, sell drinks.', starts_at: day(19, '19:00'), ends_at: day(19, '21:30'), slots_needed: 4, location: 'Snack shack', event_id: 'ev1', active: true, created_at: ago(60 * 24 * 5), updated_at: ago(60 * 24 * 5), signups: [], filled: 2 }] };
      return { ok: true };
    case 'board':
      if (a === 'get') return boardGet(pre);
      if (a === 'mine') return { ok: true, positions: [{ id: 'pos-treasurer', title: 'Treasurer', purpose: 'Keeps the club’s money straight.', description: null, sort: 2 }] };
      return { ok: true };
    case 'tenant_settings':
      if (a === 'get') return { ok: true, settings: SETTINGS_FULL(), tenant: { slug: 'demo', display_name: CLUB.display_name, timezone: CLUB.timezone, status: 'active' } };
      if (a === 'season_status') return { ok: true, year: 2027, open: true, closed_message: null, memberships_frozen: false, renewals_open: false, can_close: true, checklist: [] };
      return { ok: true };
    case 'gate_admin':
      if (a === 'get_status') return { ok: true, panel: { status: 'active', panel_type: 'mengqi', bridge_version: '1.4.0-poolside', doors: [{ key: 'main_gate', name: 'Main Gate', remote: true }, { key: 'snack', name: 'Snack Shack', remote: true }, { key: 'pump', name: 'Pump Room', remote: true }] },
        bridge_health: { state: 'ok', last_seen_at: ago(1), minutes_since: 0 } };
      if (a === 'pass_list') return { ok: true, passes: [] };
      if (a === 'recent_unlocks') return { ok: true, unlocks: [] };
      return { ok: true };
    case 'google_drive_sync':
      if (a === 'status') return { ok: true, platform_configured: true, connected: true, email: 'board@example.com', connected_at: ago(60 * 24 * 200), last_sync_at: ago(60 * 3), pending: 0, failed: 0 };
      return { ok: true };
    case 'member_auth':
      if (a === 'auto_renew_status') return { ok: true, auto_renew: false, set_at: null, dues_cents: 55000, club_name: CLUB.display_name, terms: '' };
      if (a === 'family_invite') return { ok: true, sent: true };
      break;
    case 'payment_plans':
      if (a === 'config_get') return { ok: true, config: { enabled: true, max_installments: 6, min_installment_cents: 2500, billing_day: 1, access_when: 'half_paid', tiers: [], reactivation_fee_cents: 5000, auto_deactivate_keyfob: true, reminder_days_before: [],
        milestones: [{ date: '07-01', min_pct: 50, label: 'Half paid' }, { date: '08-01', min_pct: 100, label: 'Paid in full' }] }, tiers_available: TIERS.map(t => ({ slug: t.slug, label: t.label })) };
      if (a === 'list_plans') return { ok: true, plans: [] };
      return { ok: true };
    case 'referrals':
      if (a === 'list') return { ok: true, referrals: [], totals: { pending: 0, approved: 0, paid: 0 } };
      return { ok: true };
    case 'stripe_connect':
      if (a === 'status') return { ok: true, connected: true, account_id: 'acct_demo', charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: [] };
      return { ok: true };
    case 'checkins':
      if (a === 'search') {
        const q = String(body.q ?? body.query ?? '').toLowerCase();
        return { ok: true, households: households(state).filter(h => !q || h.family_name.toLowerCase().includes(q)).map(h => ({ id: h.id, family_name: h.family_name, dues_paid_for_year: h.dues_paid_for_year || h.on_plan, members: h.members })) };
      }
      if (a === 'capacity') return { ok: true, in_pool_now: 41, today_total: 47 };
      return { ok: true, entries: [] };
  }
  if (first !== undefined) return first;
  // Anything else on a screen: "it worked", so a click never errors.
  return { ok: true };
}
// data.mjs answers these with a bare { ok: true } for the video; the site has
// the real shape.
const QUIET_REPLACED = new Set(['tenant_settings:get', 'payment_plans:config_get', 'payment_plans:list_plans', 'referrals:list', 'stripe_connect:status', 'gate_admin:pass_list']);
