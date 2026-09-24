// Whether a club's gate bridge is answering. The bridge stamps
// gate_panels.bridge_last_seen_at on every poll, so a stale stamp means taps
// would sit in the queue and time out. Five minutes matches gate_admin's
// "offline" threshold and leaves room for a bridge polling slower than today.
export const BRIDGE_OFFLINE_AFTER_SEC = 300;

export function bridgeOnline(lastSeenIso: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!lastSeenIso) return false;
  const seen = Date.parse(lastSeenIso);
  if (!Number.isFinite(seen)) return false;
  return (nowMs - seen) / 1000 < BRIDGE_OFFLINE_AFTER_SEC;
}
