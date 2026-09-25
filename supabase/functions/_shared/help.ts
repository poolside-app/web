// =============================================================================
// help — rules for member help requests (PLAN.md E2)
// =============================================================================
// A member picks a topic and writes to the board. The request goes to the
// board member who handles that topic (Help page → who handles what), else
// to the president. Only that board member and the president can see it.
// While it's unsolved it keeps one task on the assignee's dashboard; board
// replies are texted to the member with a link back to the conversation.
// These are the pure rules, tested offline by scripts/test_help_requests.mjs.
// Dashboard tasks for requests are in help_tasks.ts.
// =============================================================================

import { normalizeForSms } from './sms_text.ts';

export const TOPIC_LABELS = {
  keyfob: 'Keyfob & gate',
  membership: 'Membership & dues',
  parties: 'Parties & events',
  facility: 'Pool problem',
  other: 'Something else',
} as const;
export type Topic = keyof typeof TOPIC_LABELS;
export const isTopic = (t: unknown): t is Topic => typeof t === 'string' && Object.hasOwn(TOPIC_LABELS, t);

export function helpLink(slug: string, requestId: string): string {
  return `https://${slug}.poolsideapp.com/m/#help=${requestId}`;
}

// Two text segments at most (GSM-7, 153 characters each).
const MAX_TEXT = 306;

/** The text a member gets when the board replies. */
export function replyText(clubName: string, fromName: string, body: string, link: string): string {
  const said = normalizeForSms(body).replace(/\s+/g, ' ').trim();
  const head = normalizeForSms(`${clubName}: ${fromName} replied to your question: "`);
  const tail = `" Read or reply: ${link}`;
  const room = MAX_TEXT - head.length - tail.length;
  const fit = said.length <= room ? said : said.slice(0, Math.max(0, room - 3)).trimEnd() + '...';
  return head + fit + tail;
}

export function canSeeHelpRequest(req: { assigned_admin_id?: string | null }, caller: { id: string; isOwner: boolean }): boolean {
  return caller.isOwner || (!!req.assigned_admin_id && req.assigned_admin_id === caller.id);
}

export const snippet = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + '…';
};
