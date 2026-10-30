// =============================================================================
// signups.ts — shifts and jobs the board posts, and the thank-you (PLAN.md BM)
// =============================================================================
// Doug, 10/23: "some type of sign up genius feature... we need a person for
// the snack shack… or we have a broken sprinkler, here is a photo come fix
// it… bathrooms need painting." Each post can carry a thank-you: nothing, a
// line ("Free lunch at the meet"), or money off next season, given as a
// one-family discount code once the board approves the work.
//
// A *shift* has a start (and usually an end) and some spots; a *job* has a
// do-by date or none, and usually one spot. A sign-up is 'confirmed' when
// taken, 'done' when the volunteer taps Done (jobs), 'approved' once the
// poster (or the President) OKs it, 'no_show' when a shift's poster ticks
// that they didn't come, and 'cancelled' if they drop it. Cancelled and
// no-show sign-ups free their spot; the rest keep it.
// =============================================================================

export type Kind = 'shift' | 'job';
export type RewardKind = 'none' | 'note' | 'discount';
export type Opp = {
  id: string; kind?: string | null; title?: string | null;
  starts_at?: string | null; ends_at?: string | null; due_on?: string | null;
  slots_needed?: number | null; active?: boolean | null; closed_at?: string | null;
  reward_kind?: string | null; reward_note?: string | null;
  reward_amount_cents?: number | null; reward_percent?: number | null;
  created_by?: string | null;
};
export type Signup = { id: string; opportunity_id: string; household_id: string; member_id?: string | null; status: string };
export type Reward = { reward_kind: RewardKind; reward_note: string | null; reward_amount_cents: number | null; reward_percent: number | null };

export const KINDS: Kind[] = ['shift', 'job'];
const HOLDS_A_SPOT = new Set(['confirmed', 'done', 'approved']);

/** The thank-you a board member set, checked. */
export function cleanReward(v: Record<string, unknown>): { ok: true; reward: Reward } | { ok: false; error: string } {
  const kind = String(v.reward_kind ?? 'none');
  if (kind === 'none') return { ok: true, reward: { reward_kind: 'none', reward_note: null, reward_amount_cents: null, reward_percent: null } };
  if (kind === 'note') {
    const note = String(v.reward_note ?? '').trim().slice(0, 140);
    if (!note) return { ok: false, error: 'Say what the thank-you is, e.g. "Free lunch at the meet".' };
    return { ok: true, reward: { reward_kind: 'note', reward_note: note, reward_amount_cents: null, reward_percent: null } };
  }
  if (kind === 'discount') {
    const cents = v.reward_amount_cents == null || v.reward_amount_cents === '' ? null : Math.trunc(Number(v.reward_amount_cents));
    const pct = v.reward_percent == null || v.reward_percent === '' ? null : Number(v.reward_percent);
    if ((cents == null) === (pct == null)) return { ok: false, error: 'Money off is a dollar amount or a percent.' };
    if (cents != null && !(cents > 0 && cents <= 100000)) return { ok: false, error: 'Money off is between $1 and $1,000.' };
    if (pct != null && !(pct > 0 && pct <= 100)) return { ok: false, error: 'A percent off is between 1 and 100.' };
    return { ok: true, reward: { reward_kind: 'discount', reward_note: null, reward_amount_cents: cents, reward_percent: pct } };
  }
  return { ok: false, error: 'The thank-you is nothing, a line, or money off.' };
}

/** "$25 off next season", "20% off next season", the board's line, or null. */
export function rewardText(o: Opp): string | null {
  if (o.reward_kind === 'note') return o.reward_note || null;
  if (o.reward_kind === 'discount') {
    if (o.reward_amount_cents) {
      const d = o.reward_amount_cents / 100;
      return `$${Number.isInteger(d) ? d : d.toFixed(2)} off next season`;
    }
    if (o.reward_percent) return `${Number(o.reward_percent)}% off next season`;
  }
  return null;
}

export function spotsTaken(oppId: string, signups: Signup[]): number {
  return signups.filter(s => s.opportunity_id === oppId && HOLDS_A_SPOT.has(s.status)).length;
}

/** Shown to families: active, not closed, and (a shift) not started yet. */
export function isOpen(o: Opp, nowIso: string): boolean {
  if (o.active === false || o.closed_at) return false;
  if ((o.kind ?? 'shift') === 'shift' && o.starts_at && o.starts_at <= nowIso) return false;
  return true;
}

/** Why this person can't take it, or null. */
export function signUpProblem(o: Opp, signups: Signup[], a: { householdId: string; memberId?: string | null; nowIso: string }): string | null {
  if (o.active === false || o.closed_at) return 'This sign-up is closed.';
  if ((o.kind ?? 'shift') === 'shift' && o.starts_at && o.starts_at <= a.nowIso) return 'This shift has already started.';
  // The same person can't take two spots; two people from one family can.
  const mine = signups.filter(s => s.opportunity_id === o.id && HOLDS_A_SPOT.has(s.status) && s.household_id === a.householdId);
  if (a.memberId && mine.some(s => s.member_id === a.memberId)) return 'They\'re already signed up for this.';
  if (spotsTaken(o.id, signups) >= Math.max(1, Number(o.slots_needed ?? 1))) return 'All the spots are taken.';
  return null;
}

/** The number on the family's Sign-ups tab: open ones they could still take. */
export function openCount(opps: Opp[], signups: Signup[], householdId: string, nowIso: string): number {
  return opps.filter(o => isOpen(o, nowIso)
    && !signups.some(s => s.opportunity_id === o.id && s.household_id === householdId && HOLDS_A_SPOT.has(s.status))
    && spotsTaken(o.id, signups) < Math.max(1, Number(o.slots_needed ?? 1))).length;
}

/** Why a family can't drop it now, or null: until a shift starts, or until a job is marked done. */
export function cancelProblem(s: Signup, o: Opp, nowIso: string): string | null {
  if (s.status !== 'confirmed') return s.status === 'cancelled' ? null : 'It\'s already done. Ask the board if something changed.';
  if ((o.kind ?? 'shift') === 'shift' && o.starts_at && o.starts_at <= nowIso) return 'The shift has started. Ask the board if something came up.';
  return null;
}

/** A shift is over at its end, or its start when it has no end. Jobs never are. */
export function shiftEnded(o: Opp, nowIso: string): boolean {
  if ((o.kind ?? 'shift') !== 'shift') return false;
  const end = o.ends_at || o.starts_at;
  return !!end && end <= nowIso;
}

/** The board member who posted it, or the President. */
export function canApprove(o: Opp, caller: { id: string | null; isOwner: boolean }): boolean {
  return caller.isOwner || (!!o.created_by && o.created_by === caller.id);
}

const bare = (n: string) => String(n ?? '').trim().replace(/\s+family$/i, '').trim();
/** "Rivera family", "Rivera and Chen families", "Rivera, Chen and Patel families". */
export function familyLabel(names: string[]): string {
  const list = [...new Set(names.map(bare).filter(Boolean))];
  if (!list.length) return 'volunteers';
  if (list.length === 1) return `${list[0]} family`;
  if (list.length > 4) return `${list.slice(0, 3).join(', ')} and ${list.length - 3} more families`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]} families`;
}

/** The news post: the family by name (news is public), and what they did. */
export function thanksPost(o: Opp, familyNames: string[]): { title: string; body: string } {
  return {
    title: `Thank you, ${familyLabel(familyNames)}! 🙌`,
    body: `Thanks for helping with: ${String(o.title ?? 'a club job').trim()}.`,
  };
}

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I
/** A one-family thank-you code, e.g. THANKSK7Q2M. */
export function newThanksCode(rand: () => number = Math.random): string {
  let s = 'THANKS';
  for (let i = 0; i < 5; i++) s += CODE_LETTERS[Math.floor(rand() * CODE_LETTERS.length)];
  return s;
}
