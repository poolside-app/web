// Sign-in guard rules (PLAN.md BG1, from the 10/20 audit).
//
// Board and provider passwords, and board sign-in codes, lock for 15 minutes
// after 5 wrong tries in a row. Member codes already burn after 5 wrong tries
// (member_auth verify_code); this brings the board and the provider level.
//
// The counts live on the row being guessed at (admin_users, provider_admins:
// failed_logins + locked_until). A right answer clears them.

export const MAX_TRIES = 5;
export const LOCK_MINUTES = 15;

export type GuardState = { failed_logins?: number | null; locked_until?: string | null };

/** True while the row is locked. */
export function isLocked(s: GuardState, now = new Date()): boolean {
  return !!s.locked_until && new Date(s.locked_until).getTime() > now.getTime();
}

/** The row after one more wrong try. On the 5th the count resets and the
 *  lock starts; `just_locked` says this try caused it (to email the person). */
export function afterFailure(s: GuardState, now = new Date()): { failed_logins: number; locked_until: string | null; just_locked: boolean } {
  const n = (isLocked(s, now) ? 0 : Number(s.failed_logins ?? 0)) + 1;
  if (n >= MAX_TRIES) {
    return { failed_logins: 0, locked_until: new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString(), just_locked: true };
  }
  return { failed_logins: n, locked_until: null, just_locked: false };
}

/** What the person sees while locked. */
export function lockedMessage(s: GuardState, now = new Date()): string {
  const left = s.locked_until ? Math.ceil((new Date(s.locked_until).getTime() - now.getTime()) / 60_000) : LOCK_MINUTES;
  const mins = Math.max(1, Math.min(LOCK_MINUTES, left));
  return `Too many wrong tries. Sign-in is paused for ${mins} minute${mins === 1 ? '' : 's'}.`;
}

/** The email a person gets when their sign-in locks. */
export function lockedEmail(args: { name?: string | null; where: string; what: 'password' | 'code' }): { subject: string; html: string } {
  const who = args.name ? args.name.replace(/[<>&"]/g, '') : 'there';
  const what = args.what === 'password' ? 'wrong passwords' : 'wrong sign-in codes';
  return {
    subject: `Sign-in paused for ${args.where}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
      <p>Hi ${who},</p>
      <p>Someone typed ${MAX_TRIES} ${what} for your ${args.where.replace(/[<>&"]/g, '')} sign-in, so it's paused for ${LOCK_MINUTES} minutes.</p>
      <p>If that was you, wait ${LOCK_MINUTES} minutes and try again. If it wasn't, nothing was opened; you may want to change your password.</p>
    </div>`,
  };
}

/** A typed email for an ilike lookup: % and _ (and the escape itself) are
 *  taken literally, so "%" can't match someone else's address. PostgREST
 *  also reads * as %, with no way to escape it, so a * becomes a character
 *  no address holds (an address with a real * just won't match by email). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, c => '\\' + c).replace(/\*/g, '\n');
}
