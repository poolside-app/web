// =============================================================================
// gate_alert.ts — copy + reply tokens for gate bridge outage escalation
// =============================================================================
// The outage story reaches a club three different ways (SMS, email, and the
// reply page they land on). Those three have to agree about how long the
// bridge has been down and what the club should go check, so the wording
// lives here once rather than being retyped in each sender.
//
// Two things every message must carry:
//
//   1. "Key fobs still work." This is the single most important sentence in
//      the whole flow. The bridge only relays phone-initiated unlocks; the
//      panel holds its own credential database and drives the door itself.
//      A board member who reads "gate bridge offline" without that line
//      assumes the club is locked out and starts calling people at 7am.
//
//   2. What to physically check. Board members are volunteers, not IT. Two
//      concrete steps beat any amount of diagnostic detail.
//
// SMS bodies here are deliberately GSM-7 only: no em-dashes, no curly
// quotes, no ellipsis characters, no emoji. A single non-GSM character
// flips the whole message to UCS-2 and halves the characters per segment.
// normalizeForSms() is applied as a backstop, but the copy is written clean
// so the backstop never has to do anything.
// =============================================================================

import { normalizeForSms } from './sms_text.ts';

// ── Escalation thresholds ────────────────────────────────────────────────
// The bridge heartbeats every 30s and the cron runs every 5 min, so real
// detection lands within 5 minutes of whichever threshold is crossed.
export const PROVIDER_ALERT_MIN = 10;   // silence before Doug is told
export const CLUB_ALERT_MIN     = 30;   // silence before the club is texted
export const RECOVERY_MIN       = 2;    // seen-within to count as back up

// ── Flap damping ─────────────────────────────────────────────────────────
// A bridge cycling up and down produces one full alert set per cycle. That
// is both useless and actively harmful: a club (or Doug) buried in identical
// alerts stops reading them, and then misses the one that matters.
//
// Flapping is also a DIFFERENT diagnosis from a clean outage. "Offline for
// 40 minutes" means go look at the power or the router. "Went offline 4
// times in the last hour" means the hardware is failing and needs
// replacing. Collapsing the storm into that one sentence is the whole point.
export const FLAP_WINDOW_MIN   = 60;   // rolling window for counting outages
export const FLAP_THRESHOLD    = 3;    // outages within the window = flapping
export const ALERT_COOLDOWN_MIN = 30;  // min gap between ordinary offline alerts
export const FLAP_REALERT_MIN  = 180;  // min gap between flap alerts

const minutesSince = (iso: string | null | undefined, now: number): number =>
  iso ? (now - new Date(iso).getTime()) / 60000 : Infinity;

/**
 * Fold a new offline transition into the rolling window.
 * A window older than FLAP_WINDOW_MIN is expired, so counting restarts at 1.
 */
export function advanceFlapWindow(
  count: number,
  windowStart: string | null,
  nowIso: string,
): { count: number; windowStart: string } {
  const now = new Date(nowIso).getTime();
  if (!windowStart || minutesSince(windowStart, now) > FLAP_WINDOW_MIN) {
    return { count: 1, windowStart: nowIso };
  }
  return { count: (Number(count) || 0) + 1, windowStart };
}

/** Is this panel flapping *right now*? A stale window means no. */
export function isFlapping(
  count: number,
  windowStart: string | null,
  nowMs: number = Date.now(),
): boolean {
  if (!windowStart) return false;
  if (minutesSince(windowStart, nowMs) > FLAP_WINDOW_MIN) return false;
  return (Number(count) || 0) >= FLAP_THRESHOLD;
}

export type AlertDecision =
  | 'normal'              // send the ordinary "bridge offline" alert
  | 'flap'                // send the one "this bridge is flapping" alert
  | 'suppress_cooldown'   // too soon after the last ordinary alert
  | 'suppress_flapping';  // already told them it's flapping

/**
 * What, if anything, to send for a newly detected outage.
 *
 * Ordering matters: flapping is checked first, because once a bridge is
 * flapping the ordinary alert is the wrong message no matter how long it
 * has been since the last one.
 */
export function decideOfflineAlert(args: {
  newCount: number;
  windowStart: string | null;
  lastOfflineAlertAt: string | null;
  flapAlertedAt: string | null;
  nowMs?: number;
}): AlertDecision {
  const now = args.nowMs ?? Date.now();
  if (isFlapping(args.newCount, args.windowStart, now)) {
    return minutesSince(args.flapAlertedAt, now) < FLAP_REALERT_MIN
      ? 'suppress_flapping'
      : 'flap';
  }
  return minutesSince(args.lastOfflineAlertAt, now) < ALERT_COOLDOWN_MIN
    ? 'suppress_cooldown'
    : 'normal';
}

/**
 * Whether to send a recovery notice.
 *
 * The invariant: never announce the end of something whose start was never
 * announced. A recovery notice for an outage the recipient was never told
 * about is pure noise — it describes a problem they didn't know they had,
 * and invites a "wait, what broke?" reply.
 *
 * Also suppressed outright while flapping: during a storm the "it's back"
 * messages are half the volume, and the flap alert already says the bridge
 * is cycling.
 */
export function shouldSendRecovery(args: {
  count: number;
  windowStart: string | null;
  /** When an offline alert was last actually delivered, ever. */
  lastOfflineAlertAt: string | null;
  /** When the outage now ending began. */
  outageStartedAt: string | null;
  nowMs?: number;
}): boolean {
  const now = args.nowMs ?? Date.now();
  if (isFlapping(args.count, args.windowStart, now)) return false;
  if (!args.lastOfflineAlertAt) return false;
  if (!args.outageStartedAt) return false;
  // The alert has to belong to THIS outage, not a previous one.
  return new Date(args.lastOfflineAlertAt).getTime() >= new Date(args.outageStartedAt).getTime();
}

/** "8 min", "1 hr 5 min", "2 hr" — for humans, not logs. */
export function humanDuration(totalMin: number): string {
  const m = Math.max(0, Math.round(totalMin));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} hr` : `${h} hr ${rem} min`;
}

// ── Reply-link tokens ────────────────────────────────────────────────────
// Stateless: signed over the club slug plus the outage's start time, so a
// token is valid for exactly one outage at one club and cannot be minted by
// anyone without ADMIN_JWT_SECRET. Nothing is stored at mint time.
//
// The club slug comes from the URL host (the link is served from the club's
// own subdomain), which keeps the token short enough not to add an SMS
// segment on its own.

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(slug: string, epoch: number): Promise<string> {
  const secret = Deno.env.get('ADMIN_JWT_SECRET');
  if (!secret) throw new Error('ADMIN_JWT_SECRET not set');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`gate-outage.${slug}.${epoch}`),
  );
  // 16 bytes is 128 bits of forgery resistance, which is far more than a
  // low-stakes diagnostic reply needs, and keeps the link short.
  return b64url(new Uint8Array(mac).slice(0, 16));
}

/** Mint the token for one outage. `firstOfflineAt` is the outage's identity. */
export async function mintReplyToken(slug: string, firstOfflineAt: string): Promise<string> {
  const epoch = Math.floor(new Date(firstOfflineAt).getTime() / 1000);
  return `${epoch}.${await sign(slug, epoch)}`;
}

/**
 * Verify a token against a club + the outage currently on record.
 *
 * Returns the outage epoch on success, null on any failure. Compares against
 * the panel's own bridge_alert_first_offline_at so a token from a previous
 * outage can't be replayed to answer the current one.
 */
export async function verifyReplyToken(
  slug: string,
  token: string,
  firstOfflineAt: string | null,
): Promise<number | null> {
  if (!token || !firstOfflineAt) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const epoch = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(epoch) || !sig) return null;

  const expected = await sign(slug, epoch);
  // Constant-time-ish compare. Deno has no timingSafeEqual in std crypto for
  // strings, and a length-then-XOR loop is enough for a 16-byte tag.
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;

  // The signature proves the token is ours; this proves it belongs to the
  // outage in progress rather than one from last season.
  const onRecord = Math.floor(new Date(firstOfflineAt).getTime() / 1000);
  if (epoch !== onRecord) return null;

  return epoch;
}

export function replyLink(slug: string, token: string): string {
  return `https://${slug}.poolsideapp.com/gate-status.html?t=${encodeURIComponent(token)}`;
}

// ── Phone normalisation ──────────────────────────────────────────────────
// gate_panels.contact_phone is whatever the board typed into the settings
// form, which formats for display as "(925)-771-9074" and stores that string
// verbatim. Twilio needs E.164. Without this the outage text — the one
// message the monitoring fee exists to deliver — fails silently with a
// Twilio 21211 and nobody finds out until the next outage.
//
// Deliberately conservative: anything that isn't recognisably a US 10- or
// 11-digit number, or already E.164, returns null rather than a guess. A
// null is visible in the provider alert ("no number on file"); a wrong
// number is not.
export function toE164(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.startsWith('+')) {
    const kept = '+' + s.slice(1).replace(/\D/g, '');
    return kept.length >= 8 ? kept : null;
  }
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

// ── Message bodies ───────────────────────────────────────────────────────

/** The reassurance line. Every channel repeats it verbatim. */
export const FOBS_STILL_WORK =
  'Key fobs and keypad codes still work normally. Only phone unlock is affected.';

/** What a volunteer should physically go look at, in order. */
export const CHECK_STEPS: string[] = [
  'Is the bridge powered on? Check that its power adapter is plugged in and the light is on.',
  'Is the club internet working? Try loading any website on the club network.',
  'Is the network cable still plugged into both the bridge and the router?',
];

/** Club-facing SMS. GSM-7 clean; ~2 segments including the link. */
export function clubOutageSms(args: {
  clubName: string;
  offlineMin: number;
  link: string;
}): string {
  const body = [
    `Poolside alert: the gate bridge at ${args.clubName} has been offline for ${humanDuration(args.offlineMin)}.`,
    '',
    FOBS_STILL_WORK,
    '',
    'Please check that the bridge has power and that your internet is working.',
    '',
    `Then tap here to tell us what you found: ${args.link}`,
  ].join('\n');
  return normalizeForSms(body);
}

/** Provider-facing SMS, stage 1. Short: Doug is going to open the dashboard. */
export function providerOutageSms(args: {
  clubName: string;
  offlineMin: number;
  clubAlertInMin: number;
}): string {
  const body = [
    `Poolside: ${args.clubName} gate bridge offline ${humanDuration(args.offlineMin)}.`,
    `Club has NOT been told (auto-text in ~${args.clubAlertInMin} min).`,
    'https://poolsideapp.com/admin/gate-integrations.html',
  ].join(' ');
  return normalizeForSms(body);
}

/** Provider-facing SMS when the club has just been auto-texted. */
export function providerEscalatedSms(args: {
  clubName: string;
  offlineMin: number;
  contactPhone: string | null;
}): string {
  const who = args.contactPhone ? ` at ${args.contactPhone}` : '';
  const body = [
    `Poolside: ${args.clubName} still offline ${humanDuration(args.offlineMin)}.`,
    `Gate contact${who} has now been texted.`,
    'https://poolsideapp.com/admin/gate-integrations.html',
  ].join(' ');
  return normalizeForSms(body);
}

/** Provider-facing SMS on recovery. Says whether the club ever found out. */
export function providerRecoverySms(args: {
  clubName: string;
  downMin: number;
  clubWasTold: boolean;
}): string {
  const tail = args.clubWasTold
    ? 'The club was texted during the outage.'
    : 'The club was never notified.';
  return normalizeForSms(
    `Poolside: ${args.clubName} gate bridge is back online after ${humanDuration(args.downMin)}. ${tail}`,
  );
}

/**
 * Provider-facing SMS for a flapping bridge. Says the diagnosis, not the
 * symptom, and says that alerts are now paused — otherwise the silence that
 * follows reads as "it fixed itself".
 */
export function providerFlapSms(args: { clubName: string; count: number }): string {
  return normalizeForSms(
    `Poolside: ${args.clubName} gate bridge has gone offline ${args.count} times in the last hour. ` +
    `That usually means failing power, a bad cable or a dying SD card, not a one-off outage. ` +
    `Further alerts for this bridge are paused for ${Math.round(FLAP_REALERT_MIN / 60)} hours.`,
  );
}

/** What the club sees on the reply page, and what Doug sees in his alert. */
export const REPLY_LABELS: Record<string, string> = {
  power_outage: 'Power is out here',
  please_check: 'Power looks fine, please check it',
};
