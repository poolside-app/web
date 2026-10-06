// =============================================================================
// agenda — board meeting agendas built from one-liners (PLAN.md L)
// =============================================================================
// Doug, 2026-10-06: anyone on the board adds a one-line item for the next
// meeting at any time ("Bathrooms have been complained about"). Right before
// the meeting someone presses "Create agenda", which lays the items out in the
// standard format with each person's items under their name. It's sent only
// when someone presses "Send to the board".
//
// Pure, so it can be tested without a database (scripts/test_agenda.mjs).
// =============================================================================

export const ITEM_MAX = 100;

/** One line: line breaks and runs of spaces become single spaces. */
export function cleanItem(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

/** Why an item can't be saved, or null. */
export function itemProblem(raw: unknown): string | null {
  const t = cleanItem(raw);
  if (!t) return 'Write one line for the agenda.';
  if (t.length > ITEM_MAX) return `Keep it to one line, ${ITEM_MAX} characters at most. This one is ${t.length}.`;
  return null;
}

export type AgendaItem = {
  id: string; body: string; added_by: string | null; added_by_name: string | null;
  covered?: boolean | null; carried_from_date?: string | null; created_at?: string | null;
};
type Position = { id: string; title: string; sort?: number | null };
type Holder = { position_id: string; admin_user_id: string };
type Login = { id: string; active?: boolean | null; display_name?: string | null };
export type FollowUp = { description: string; assigned_to?: string | null; due_date?: string | null; meeting_date?: string | null };

export type AgendaPerson = { name: string; titles: string[]; items: AgendaItem[] };
export type Agenda = {
  title: string; date: string; time: string | null; location: string | null;
  sections: Array<
    | { key: 'open' | 'actions' | 'close'; title: string }
    | { key: 'minutes'; title: string }
    | { key: 'reports'; title: string; people: AgendaPerson[] }
    | { key: 'old'; title: string; followUps: FollowUp[] }
  >;
};

/**
 * The agenda: call to order, last minutes, each board member's report with
 * the items they added, open action items from past meetings, the action
 * list, next meeting.
 */
export function buildAgenda(args: {
  meeting: { title?: string | null; meeting_date: string; planned_time?: string | null; location?: string | null };
  positions: Position[]; holders: Holder[]; logins: Login[];
  items: AgendaItem[];
  lastMinutesDate?: string | null;
  openFollowUps?: FollowUp[];
}): Agenda {
  const active = new Map(args.logins.filter(l => l.active !== false).map(l => [l.id, l]));
  const positions = [...args.positions].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.title.localeCompare(b.title));
  const byTime = (a: AgendaItem, b: AgendaItem) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
  const items = [...args.items].sort(byTime);

  // Each position holder once, in board order, with every title they hold.
  const people: (AgendaPerson & { id: string })[] = [];
  for (const p of positions) {
    for (const h of args.holders.filter(x => x.position_id === p.id && active.has(x.admin_user_id))) {
      let person = people.find(x => x.id === h.admin_user_id);
      if (!person) {
        person = { id: h.admin_user_id, name: active.get(h.admin_user_id)!.display_name || 'Board member', titles: [], items: [] };
        people.push(person);
      }
      person.titles.push(p.title);
    }
  }
  // Items go under whoever added them. Someone with no position, or who has
  // left the board, still gets their items heard, after the directors.
  for (const it of items) {
    let person = it.added_by ? people.find(x => x.id === it.added_by) : undefined;
    if (!person) {
      const key = it.added_by && active.has(it.added_by) ? it.added_by : `name:${it.added_by_name || 'A board member'}`;
      person = people.find(x => x.id === key);
      if (!person) {
        const name = (it.added_by && active.get(it.added_by)?.display_name) || it.added_by_name || 'A board member';
        person = { id: key, name, titles: [], items: [] };
        people.push(person);
      }
    }
    person.items.push(it);
  }

  // Directors first (in board order), then current board members with no
  // position, then anyone who has left the board.
  const directors = people.filter(p => p.titles.length);
  const others = people.filter(p => !p.titles.length);
  const ordered = [...directors, ...others.filter(p => active.has(p.id)), ...others.filter(p => !active.has(p.id))];

  const sections: Agenda['sections'] = [
    { key: 'open', title: 'Call to order and roll call' },
  ];
  if (args.lastMinutesDate) sections.push({ key: 'minutes', title: `Approve the minutes of the ${longDate(args.lastMinutesDate, false)} meeting` });
  sections.push({ key: 'reports', title: 'Reports and items', people: ordered.map(({ name, titles, items }) => ({ name, titles, items })) });
  if ((args.openFollowUps ?? []).length) {
    sections.push({ key: 'old', title: 'Open action items from past meetings', followUps: args.openFollowUps! });
  }
  sections.push({ key: 'actions', title: 'Action list: who, what, by when' });
  sections.push({ key: 'close', title: 'Set the next meeting, adjourn' });

  return {
    title: args.meeting.title || 'Board Meeting',
    date: args.meeting.meeting_date,
    time: args.meeting.planned_time ?? null,
    location: args.meeting.location ?? null,
    sections,
  };
}

/** The agenda as plain text, for the email and for copying. */
export function agendaText(a: Agenda): string {
  const out: string[] = [];
  out.push(`${a.title} — ${[longDate(a.date, true), a.time ? clock(a.time) : null, a.location].filter(Boolean).join(' · ')}`, '');
  a.sections.forEach((s, i) => {
    out.push(`${i + 1}. ${s.title}`);
    if (s.key === 'reports') {
      for (const p of s.people) {
        out.push(`   ${p.name}${p.titles.length ? ', ' + p.titles.join(' · ') : ''}`);
        for (const it of p.items) out.push(`     - ${it.body}${it.carried_from_date ? ` (from ${longDate(it.carried_from_date, false)})` : ''}`);
      }
    }
    if (s.key === 'old') {
      for (const f of s.followUps) {
        out.push(`   - ${f.description}${f.assigned_to ? ` (${f.assigned_to}` + (f.due_date ? `, due ${longDate(f.due_date, false)})` : ')') : f.due_date ? ` (due ${longDate(f.due_date, false)})` : ''}`);
      }
    }
  });
  return out.join('\n');
}

/** The text that goes out with "Send to the board". Plain ASCII, so it stays
 *  one cheap message. */
export function agendaSms(club: string, date: string, time: string | null, link: string): string {
  return `${club}: the agenda for the board meeting ${longDate(date, true)}${time ? ', ' + clock(time) : ''} is up. ${link}`
    .replace(/[^\x20-\x7e]/g, '');
}

/** How a board member gets the agenda: email if they chose email, else a
 *  text, else email; null if we have neither. */
export function sendChannel(a: { notify_pref?: string | null; email?: string | null; phone_e164?: string | null }): 'text' | 'email' | null {
  if (a.notify_pref === 'email' && a.email) return 'email';
  if (a.phone_e164) return 'text';
  if (a.email) return 'email';
  return null;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Saturday, October 10" (or "October 10") from 'YYYY-MM-DD'. A date, not a moment. */
export function longDate(ymd: string, withDay: boolean): string {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(ymd);
  const day = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${withDay ? day + ', ' : ''}${MONTHS[m - 1]} ${d}`;
}

/** "10:00" → "10:00 AM". */
export function clock(hhmm: string): string {
  const m = String(hhmm).match(/^(\d{2}):(\d{2})$/);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}
