// =============================================================================
// bridge_poll.ts — how long the cloud holds a bridge's check-in (PLAN.md AA1)
// =============================================================================
// In September the bridge checked in every 1.5 seconds: about 60,000 Edge
// Function calls a day, which used up the free Supabase plan. Now the bridge
// asks with `wait` and the cloud holds the question open for up to
// MAX_WAIT_SEC, answering the moment an unlock is waiting. One call every
// 20 seconds (about 4,300 a day) and the gate opens within a second.
// =============================================================================

export const MAX_WAIT_SEC = 20;
/** How often the cloud looks for a waiting unlock while holding a check-in. */
export const LOOK_EVERY_MS = 500;

/** Seconds to hold this check-in: 0 when not asked for (an old bridge gets
 *  an answer at once, as before), never more than MAX_WAIT_SEC. */
export function pollWait(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_WAIT_SEC, n) : 0;
}
