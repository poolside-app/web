// =============================================================================
// minutes_approval.ts — who approves board minutes, and when (PLAN.md BJ3)
// =============================================================================
// Doug, 10/21: minutes are approved by the board members who attended before
// members see them. The note-taker closes the meeting, fixes the draft, and
// submits it; each board member ticked in "Who's here?" gets a pop-up and a
// to-do, and approves or asks for changes. The moment the last one approves,
// a copy is kept (posted_json) and members see that copy. After 7 days the
// President can approve for someone who hasn't. Approved minutes are locked;
// a change is an amendment that goes through the same approval.
//
// The rules here are plain functions; board_meetings and the daily run
// (payment_plans) use them. Tested offline by scripts/test_minutes.mjs.
// =============================================================================

export const ON_BEHALF_DAYS = 7;
export const REMIND_DAYS = [3, 6];

export type Attendee = { admin_user_id?: string | null; name?: string | null };
export type ApprovalRow = { admin_id: string; name: string; status: 'pending' | 'approved' | 'voided' };

/** The board members who attended (active board logins), once each. The
 *  person who submits counts as approving: they wrote the minutes. */
export function approversFor(attendees: Attendee[], boardIds: Set<string>, submitterId: string | null): ApprovalRow[] {
  const seen = new Set<string>();
  const rows: ApprovalRow[] = [];
  for (const a of attendees ?? []) {
    const id = a?.admin_user_id ? String(a.admin_user_id) : '';
    if (!id || seen.has(id) || !boardIds.has(id)) continue;
    seen.add(id);
    rows.push({ admin_id: id, name: String(a.name ?? 'Board member'), status: id === submitterId ? 'approved' : 'pending' });
  }
  return rows;
}

/** "2 of 3 approved · waiting on Erik Larsen". Voided rows don't count. */
export function progress(rows: Array<{ name: string; status: string }>) {
  const live = (rows ?? []).filter(r => r.status !== 'voided');
  const approved = live.filter(r => r.status === 'approved').length;
  return { approved, total: live.length, pending: live.filter(r => r.status === 'pending').map(r => r.name), done: approved === live.length };
}

/** The President may approve for someone once the minutes have waited 7 days. */
export function mayApproveFor(isPresident: boolean, submittedAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!isPresident || !submittedAt) return false;
  return now.getTime() - Date.parse(submittedAt) >= ON_BEHALF_DAYS * 86400000;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** For the daily run, by pool date: 'remind' the people still waiting on
 *  days 3 and 6, tell the 'president' on day 7, otherwise nothing. */
export function remindDay(submittedDay: string, today: string): 'remind' | 'president' | null {
  if (REMIND_DAYS.some(n => addDays(submittedDay, n) === today)) return 'remind';
  if (addDays(submittedDay, ON_BEHALF_DAYS) === today) return 'president';
  return null;
}

/** What a change to the meeting does now:
 *  open   — the meeting is still going: it saves as you type;
 *  draft  — closed, minutes not yet submitted (or sent back): fixes save;
 *  locked — waiting for approval: no changes (ask for changes, or Edit again);
 *  amend  — approved: a change starts an amendment (members keep the approved copy). */
export function editMode(m: { status?: string | null; minutes_status?: string | null }): 'open' | 'draft' | 'locked' | 'amend' {
  if (m.status !== 'completed') return 'open';
  if (m.minutes_status === 'submitted') return 'locked';
  if (m.minutes_status === 'approved') return 'amend';
  return 'draft';
}

/** What members see: a copy of the minutes taken when they're approved. */
export function snapshot(m: Record<string, unknown>) {
  return {
    title: m.title ?? null, meeting_date: m.meeting_date ?? null, location: m.location ?? null,
    started_at: m.started_at ?? null, ended_at: m.ended_at ?? null, notes_md: m.notes_md ?? '',
    attendees_json: m.attendees_json ?? [], votes_json: m.votes_json ?? [], follow_ups_json: m.follow_ups_json ?? [],
    visibility: m.visibility === 'private' ? 'private' : 'members',
  };
}
