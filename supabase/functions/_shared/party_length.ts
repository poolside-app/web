// =============================================================================
// party_length.ts — how long a party runs (PLAN.md N3, Doug 2026-10-07)
// =============================================================================
// Members pick a date and a start time; every party runs the club's set
// length, 4 hours unless the board changes it on the Parties page. Stored at
// settings.value.parties.length_hours.
// =============================================================================

export const DEFAULT_PARTY_HOURS = 4;

export function partyHours(settingsValue: unknown): number {
  const raw = Number(((settingsValue as Record<string, unknown> | null)?.parties as Record<string, unknown> | undefined)?.length_hours);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PARTY_HOURS;
  return Math.min(12, Math.max(1, Math.round(raw * 2) / 2));   // half hours, 1 to 12
}

/** The end of a party that starts at `startsIso`. */
export function partyEnd(startsIso: string, hours: number): string {
  return new Date(Date.parse(startsIso) + hours * 3600_000).toISOString();
}
