// =============================================================================
// stripe_sig.ts — checking that a webhook really came from Stripe (PLAN.md BL1)
// =============================================================================
// Stripe signs each webhook with HMAC-SHA256 using that endpoint's signing
// secret. Poolside has two endpoints at the same address: one for the clubs'
// own Stripe accounts (families paying dues, parties, keyfobs) and one for
// Poolside's own account (clubs buying texts, Premium Setup or a plan). Each
// has its own secret, so an event is genuine if it matches either.
//
// Header format: t=<unix seconds>,v1=<hex>[,v1=<hex>...] — two v1 values while
// Stripe is rolling a secret.
// =============================================================================

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** True when `sigHeader` is a fresh Stripe signature of `rawBody` with `secret`. */
export async function verifyStripeSignature(rawBody: string, sigHeader: string, secret: string, toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  let ts = 0;
  const v1: string[] = [];
  for (const part of String(sigHeader || '').split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') ts = parseInt(v, 10) || 0;
    else if (k === 'v1' && v) v1.push(v);
  }
  if (!ts || !v1.length || !secret) return false;
  if (Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = await hmacHex(secret, `${ts}.${rawBody}`);
  return v1.some(s => sameText(expected, s));
}

/** True when the signature matches any of the secrets that are set. */
export async function verifyAny(rawBody: string, sigHeader: string, secrets: Array<string | null | undefined>, toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  for (const s of secrets) {
    if (s && await verifyStripeSignature(rawBody, sigHeader, s, toleranceSec, nowSec)) return true;
  }
  return false;
}
