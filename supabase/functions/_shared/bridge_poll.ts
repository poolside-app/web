// =============================================================================
// bridge_poll.ts — how long the cloud holds a bridge's check-in (PLAN.md AA1, AO)
// =============================================================================
// In September the bridge checked in every 1.5 seconds: about 60,000 Edge
// Function calls a day, which used up the free Supabase plan. Now the bridge
// asks with `wait` and the cloud holds the question open for up to
// MAX_WAIT_SEC, answering the moment an unlock is waiting, so a tap never
// waits for a check-in.
//
// 20 seconds from 10/11 (about 4,300 calls a day); 2 minutes from 10/12
// (Doug: "we dont need that quick of response"), about 720 a day. The free
// plan ends any call at 150 s, so 120 leaves room. The answer tells the
// bridge how long to ask for next time (`next_wait`), so changing this
// never needs a trip to the club PC.
// =============================================================================

export const MAX_WAIT_SEC = 120;
/** How often the cloud looks for a waiting unlock while holding a check-in.
 *  Once a second keeps a 2-minute hold well inside the 2 s CPU limit per call. */
export const LOOK_EVERY_MS = 1000;
/** How often a held check-in stamps bridge_last_seen_at, so "Online", the
 *  outage alarms (_shared/gate_alert.ts) and Settings read as before. */
export const STAMP_EVERY_MS = 30000;

/** Seconds to hold this check-in: 0 when not asked for (an old bridge gets
 *  an answer at once, as before), never more than MAX_WAIT_SEC. */
export function pollWait(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_WAIT_SEC, n) : 0;
}
