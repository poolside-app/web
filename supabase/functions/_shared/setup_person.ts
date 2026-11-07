// =============================================================================
// setup_person.ts — who handles the club setup list, and what each person sees
// =============================================================================
// PLAN.md CD (Doug 11/6): "That list of setup should only be president... We
// can select who deals with the setup… might not always be the president".
// The "Club setup" alert (NOTICES.setup) says who: whoever holds a position
// given it, else the President, like every alert. They get the whole list
// (on their home, and the Setup tab); anyone with full access gets it on the
// Setup tab too; everyone else only "Sign up your own family", which is theirs.
// Seven steps save only with full access (tenant_settings `save` and the
// board's positions are the President's), so someone handling setup without it
// sees those marked instead of a button that would fail.
// =============================================================================
import { noticeRecipients, type Holder, type Login, type Position } from './positions.ts';

export const SETUP_NOTICE = 'setup';
export const OWN_STEP = 'self_signup';
export const FULL_ACCESS_STEPS: readonly string[] = Object.freeze(['logo', 'hero', 'address', 'location', 'prices', 'payment', 'invite_board']);

type Board = { positions: Position[]; holders: Holder[]; logins: Login[] };

/** Does this board login handle setup right now? */
export function handlesSetup(adminId: string, b: Board): boolean {
  return noticeRecipients(SETUP_NOTICE, b.positions, b.holders, b.logins).includes(adminId);
}

/** The position that handles setup, for "The Secretary handles the club's setup". */
export function setupWho(b: Board): string {
  const p = b.positions.find(x => (x.notices ?? []).includes(SETUP_NOTICE as never));
  return p ? p.title : 'President';
}

type Step = { id: string; done: boolean; [k: string]: unknown };

/** The list as this person sees it. */
export function setupFor<T extends Step>(items: T[], o: { mine: boolean; fullAccess: boolean }) {
  const all = o.mine || o.fullAccess;
  const shown = (all ? items : items.filter(i => i.id === OWN_STEP))
    .map(i => (!o.fullAccess && !i.done && FULL_ACCESS_STEPS.includes(i.id)) ? { ...i, needs_full: true } : i);
  const done = shown.filter(i => i.done).length;
  return {
    mine: o.mine, full_access: o.fullAccess, items: shown,
    done, total: shown.length,
    percent: shown.length ? Math.round((done / shown.length) * 100) : 100,
    complete: done === shown.length,
  };
}
