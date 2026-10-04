// =============================================================================
// positions — board positions, and who gets told about what (PLAN.md K)
// =============================================================================
// Doug, 2026-10-04: a club's board positions, each with a job description,
// editable at setup and any time after. A position decides two things:
//   - what the person can use in the app (it replaced the old fixed roles), and
//   - which alerts they get: the dashboard task and the phone pop-up go to
//     whoever holds the position now.
// One person can hold several positions (the Vice-President is a second
// title), and a position can have more than one holder.
//
// An alert nobody holds goes to the President, then the Vice-President, then
// any full-access login, so nothing is ever dropped. The President still sees
// every task on the dashboard; pop-ups follow the positions.
//
// Pure, so it can be tested without a database. Tested offline by
// scripts/test_positions.mjs.
// =============================================================================

/** Alerts a position can be told about. `needs` are the screens the holder
 *  must have to act on it; giving a position the alert gives it those. */
export const NOTICES: Record<string, { label: string; needs: string[] }> = {
  signups:         { label: 'New signups and family changes', needs: ['applications', 'households'] },
  payments:        { label: 'Payments to check: Venmo, refunds, disputes, failed cards, lapsed plans', needs: ['payments'] },
  referrals:       { label: 'Referral rewards to approve', needs: ['payments'] },
  rentals:         { label: 'Party and rental requests and their payments', needs: ['parties'] },
  photos:          { label: 'Member photos to approve', needs: ['photos'] },
  gate:            { label: 'Gate and keyfob alerts', needs: [] },
  help_keyfob:     { label: 'Member help: keyfob & gate', needs: [] },
  help_membership: { label: 'Member help: membership & dues', needs: [] },
  help_parties:    { label: 'Member help: parties & events', needs: [] },
  help_facility:   { label: 'Member help: pool problem', needs: [] },
  help_grounds:    { label: 'Member help: grounds, bathrooms & cleaning', needs: [] },
  help_other:      { label: 'Member help: something else', needs: [] },
};
export type Notice = keyof typeof NOTICES;

/** Screens a position can use (admin_users.scopes). */
export const SCREENS: Record<string, string> = {
  applications: 'Signups (the pipeline)',
  households: 'Member list and renewals',
  payments: 'Money: payments, plans, refunds, codes',
  tiers: 'Membership prices',
  renewals: 'Renewal reminders',
  events: 'Calendar and events',
  parties: 'Parties and rentals',
  programs: 'Programs and swim lessons',
  volunteer: 'Volunteer sign-ups',
  announcements: 'Announcements and member emails',
  photos: 'Photos',
  policies: 'Policies, waivers and the bylaws',
  directory: 'Member directory',
  audit: 'Activity log',
  meetings: 'Board minutes',
  check_in: 'Gate check-in',
  shifts: 'Lifeguard shifts',
};

/** Which alert each kind of dashboard task belongs to. Tasks not listed here
 *  keep their old routing (an assigned person, or permissions). */
export const TASK_NOTICE: Record<string, Notice> = {
  'application.submitted': 'signups',
  'household_member.member_added': 'signups',
  'household.transfer_primary': 'signups',
  'venmo.claim': 'payments',
  'application.refund': 'payments',
  'application.dispute': 'payments',
  'plan.lapsed': 'payments',
  'renewal.auto_renew_failed': 'payments',
  'referral.reward_request': 'referrals',
  'party.requested': 'rentals',
  'party.venmo_claim': 'rentals',
  'party.refund_needed': 'rentals',
  'photo.pending_approval': 'photos',
  'gate.bridge_offline': 'gate',
};

/** Member help topic → its alert. */
export const HELP_NOTICE: Record<string, Notice> = {
  keyfob: 'help_keyfob', membership: 'help_membership', parties: 'help_parties',
  facility: 'help_facility', grounds: 'help_grounds', other: 'help_other',
};

export type Position = {
  id: string; slug: string; title: string; sort?: number | null;
  notices?: string[] | null; scopes?: string[] | null; full_access?: boolean | null;
};
export type Holder = { position_id: string; admin_user_id: string };
export type Login = { id: string; active?: boolean | null; role_template?: string | null; roles?: string[] | null };

const isFullAccessLogin = (a: Login) =>
  (a.role_template ?? 'owner') === 'owner' || (a.roles ?? []).includes('owner');
const bySort = (a: Position, b: Position) => (a.sort ?? 0) - (b.sort ?? 0) || a.title.localeCompare(b.title);

function activeHolders(positionIds: string[], holders: Holder[], logins: Login[]): string[] {
  const active = new Set(logins.filter(l => l.active !== false).map(l => l.id));
  const out: string[] = [];
  for (const pid of positionIds) {
    for (const h of holders) {
      if (h.position_id === pid && active.has(h.admin_user_id) && !out.includes(h.admin_user_id)) out.push(h.admin_user_id);
    }
  }
  return out;
}

/**
 * Who gets an alert: the active holders of every position told about it, in
 * position order. If nobody holds one, the President, then the
 * Vice-President, then any full-access login.
 */
export function noticeRecipients(notice: string, positions: Position[], holders: Holder[], logins: Login[]): string[] {
  const sorted = [...positions].sort(bySort);
  const direct = activeHolders(sorted.filter(p => (p.notices ?? []).includes(notice)).map(p => p.id), holders, logins);
  if (direct.length) return direct;
  for (const slug of ['president', 'vice_president']) {
    const ids = activeHolders(sorted.filter(p => p.slug === slug).map(p => p.id), holders, logins);
    if (ids.length) return ids;
  }
  return logins.filter(l => l.active !== false && isFullAccessLogin(l)).map(l => l.id);
}

/** Is this board member one of the people an alert goes to? */
export function receivesNotice(adminId: string, notice: string, positions: Position[], holders: Holder[], logins: Login[]): boolean {
  return noticeRecipients(notice, positions, holders, logins).includes(adminId);
}

/**
 * A person's login, from the positions they hold: their title ("Treasurer ·
 * Vice-President"), full access if any position has it, else the screens of
 * all their positions plus whatever their alerts need.
 */
export function loginFromPositions(held: Position[]): {
  board_title: string | null; role_template: string; roles: string[]; scopes: string[];
} {
  const sorted = [...held].sort(bySort);
  const title = sorted.map(p => p.title).join(' · ') || null;
  if (sorted.some(p => p.full_access)) return { board_title: title, role_template: 'owner', roles: ['owner'], scopes: [] };
  const scopes = new Set<string>();
  for (const p of sorted) {
    for (const s of p.scopes ?? []) if (SCREENS[s]) scopes.add(s);
    for (const n of p.notices ?? []) for (const s of NOTICES[n]?.needs ?? []) scopes.add(s);
  }
  return { board_title: title, role_template: 'custom', roles: ['custom'], scopes: [...scopes] };
}

/** "Doug Frevele, President" for the public page: holders and their titles. */
export function boardRoster(positions: Position[], holders: Holder[], logins: (Login & { display_name?: string | null })[]): { name: string; titles: string[] }[] {
  const sorted = [...positions].sort(bySort);
  const out: { id: string; name: string; titles: string[]; first: number }[] = [];
  sorted.forEach((p, i) => {
    for (const id of activeHolders([p.id], holders, logins)) {
      const l = logins.find(x => x.id === id);
      let row = out.find(r => r.id === id);
      if (!row) { row = { id, name: (l?.display_name || 'Board member').trim(), titles: [], first: i }; out.push(row); }
      row.titles.push(p.title);
    }
  });
  return out.sort((a, b) => a.first - b.first).map(({ name, titles }) => ({ name, titles }));
}

/** "Treasurer" → "treasurer", for a club's own new positions. */
export function slugify(title: string): string {
  return String(title).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'position';
}

export const SPENDING_RULE = 'Under $50, go ahead. $50 or more needs board approval.';

/**
 * The positions a new club starts with: Bishop Estates' board (Doug,
 * 2026-10-04), without the Bishop-only details, ready to edit.
 */
export const STARTER_POSITIONS: Array<{
  slug: string; title: string; purpose: string; description: string;
  notices: Notice[]; scopes: string[]; full_access?: boolean;
}> = [
  {
    slug: 'president', title: 'President', full_access: true, scopes: [],
    notices: ['help_other'],
    purpose: "Lead the board, keep every director on their list, and be the club's public face.",
    description: [
      'Bylaw duties: Preside at meetings, supervise club business, sign contracts the Board has approved, sit on all committees, give members an annual report.',
      "Every month: Set the agenda and run the board meeting. Go around the table for each director's report. Send out the action list (who, what, by when) within two days.",
      'Through the year: Build the budget with the Treasurer. Serve as main contact for the county, the insurer and any swim team. Lead the renovation and funding plan. Give the annual report at the annual member meeting.',
      'Can do without asking: Speak for the club, sign what the Board approved, close the pool for a safety problem, spend under $50.',
      'Needs board approval: New contracts, dues or policy changes, anything $50 or more.',
      "Not this job: Doing the other directors' tasks. Hand them off.",
    ].join('\n'),
  },
  {
    slug: 'vice_president', title: 'Vice-President', scopes: [], notices: [],
    purpose: 'A second title held by one of the directors.',
    description: "Bylaw duties: Act as President when the President can't.",
  },
  {
    slug: 'treasurer', title: 'Treasurer',
    scopes: ['payments', 'applications', 'households', 'renewals', 'tiers', 'audit'],
    notices: ['signups', 'payments', 'referrals', 'help_membership'],
    purpose: 'Know where every dollar is, tell the board how long the cash will last, and run membership accounts.',
    description: [
      'Bylaw duties: Keep the accounting records, hold and deposit all funds, give receipts.',
      'Every month: Pay bills, reconcile the bank account, and report the balance, income, spending against budget, and months of cash left. Have a second board member look over the bank statement.',
      "Membership: Process applications and renewals, keep the member list and paid status, answer member account questions. Give the Membership & Marketing Director the list of who hasn't renewed.",
      'Through the year: Draft the budget. Send renewal invoices. File taxes and state paperwork on time. Present the finances at the annual member meeting.',
      'Can do without asking: Pay recurring bills the Board has already approved, spend under $50.',
      "Needs board approval: New vendors, moving money between accounts, anything $50 or more that isn't already approved.",
    ].join('\n'),
  },
  {
    slug: 'secretary', title: 'Secretary',
    scopes: ['meetings', 'policies', 'announcements', 'directory'], notices: [],
    purpose: "Keep the club's records and make sure meetings and notices are done properly.",
    description: [
      'Bylaw duties: Minutes of all member and board meetings, all required notices, custody of records, the member register.',
      'Every month: Send the agenda three days before the meeting and the minutes within a week after. Keep a current copy of the member list from the Treasurer.',
      'Through the year: Send notice of the annual meeting as the bylaws require and track quorum and proxies. Keep bylaws, insurance, permits and contracts in one shared folder.',
      'Can do without asking: Send official notices and member emails, spend under $50.',
      'Needs board approval: Anything that changes the bylaws or club rules, anything $50 or more.',
    ].join('\n'),
  },
  {
    slug: 'facilities', title: 'Facilities Director',
    scopes: ['check_in', 'shifts'], notices: ['gate', 'help_keyfob', 'help_facility'],
    purpose: 'Keep the pool, equipment and buildings safe, working and passing inspection.',
    description: [
      'Every week in season: Walk the property with a checklist: gates and latches, safety equipment, lights, leaks, pool equipment. Confirm the pool tech showed up.',
      "Every month: Report what broke, what was fixed, what's coming and what it costs. Keep one repair list ranked by safety, then compliance, then comfort.",
      'Through the year: Run the opening and closing checklists. Track every county inspection item to completion. Organize a spring and a fall volunteer work day. Get two or three quotes on anything over $1,000. Keep a list of members with trade skills.',
      'Can do without asking: Call vendors for quotes, close off anything unsafe, spend under $50.',
      'Needs board approval: New service contracts, anything $50 or more.',
      'Not this job: Doing all the work personally. The job is making sure it gets done.',
    ].join('\n'),
  },
  {
    slug: 'grounds', title: 'Grounds Director', scopes: [], notices: ['help_grounds'],
    purpose: 'Make sure the property looks cared for by managing the people who are paid to maintain it.',
    description: [
      'Every week in season: Walk the grounds and bathrooms after the cleaners and landscapers have been there. Check their work against the standard below. Text or call the vendor the same day if something was missed.',
      'Every month: Report to the board: did each vendor show up, was the work acceptable, any problems or supply needs.',
      "Through the year: Be the single contact for the cleaning and landscaping vendors. Schedule extra service before opening day and events. Once a year, review each vendor's price and quality and get a competing quote if either is slipping.",
      "The standard: Lawn mowed and edged, no weeds in the deck or beds, trash emptied, bathrooms clean and stocked. Would a family touring the club today think it's well kept?",
      'Can do without asking: Tell a vendor to redo or fix missed work, spend under $50.',
      'Needs board approval: Changing vendors, changing the service schedule or price, anything $50 or more.',
    ].join('\n'),
  },
  {
    slug: 'membership_marketing', title: 'Membership & Marketing Director',
    scopes: ['households', 'renewals', 'announcements', 'photos', 'directory'], notices: ['photos'],
    purpose: 'Bring in new member families, win back past ones, and keep the club visible in the neighborhood.',
    description: [
      'Goal: A number of new or returning families signed up by opening day, set with the board.',
      'Time: About 1 to 2 hours a week.',
      'Every week: One post on Nextdoor and the neighborhood Facebook group, rotating through four types, each ending with the join link:',
      '   1. A real photo or story from the club (a swim meet, a family, a summer evening).',
      '   2. A progress update: what got fixed and where the money went.',
      '   3. A specific invitation with a date (open house, bring-a-neighbor day, renewal deadline).',
      "   4. A myth-buster: we're not an HOA, anyone nearby can join, here's what it costs.",
      "Every month: Check that the website's prices, dates and join button are current. Send a welcome note and a free guest pass to any home in the neighborhood that sold that month. Report new sign-ups, inquiries and what was posted.",
      "Through the year: Win-back email to past members in January. Contact every family that hasn't renewed by March 1, using the Treasurer's list. Flyer or door hanger to the non-member homes nearby in March and May.",
      'Can do without asking: Post, email, update the website, contact any current or past member, spend under $50.',
      'Needs board approval: Discounts, new pricing, anything $50 or more.',
    ].join('\n'),
  },
  {
    slug: 'events_rentals', title: 'Events & Rentals Director',
    scopes: ['events', 'parties', 'programs', 'volunteer'], notices: ['rentals', 'help_parties'],
    purpose: 'Make the club worth belonging to and bring in rental income.',
    description: [
      'Goal: One event a month in season, plus a rental income target set with the Treasurer.',
      'Before the season: Publish the event calendar by April 1, including an open house where non-members can visit.',
      'For each event: Set the date, line up volunteers, and hand the Membership & Marketing Director the details two weeks ahead.',
      'For rentals: Answer inquiries within two days, keep the booking calendar, and collect the fee and signed rules before the date.',
      'Every month: Report events held, turnout, rentals booked and income.',
      'Can do without asking: Schedule events and rentals on open dates, spend under $50.',
      'Needs board approval: Rental prices, non-member rental rules, alcohol or outside vendors, anything $50 or more.',
    ].join('\n'),
  },
];
