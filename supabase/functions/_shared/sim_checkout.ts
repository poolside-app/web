// The pretend card checkout used while a club has Test payments on (moved
// here from stripe_checkout for PLAN.md BG3 so donations use it too).
//
// The token carries everything the fake checkout needs, signed so the amount
// and metadata can't be edited in the browser. It deliberately has no `sub`:
// several functions accept any signed token with sub + tid as a login.
// /pay-test.html shows it; stripe_checkout `simulate_complete` finishes it.

import { create, verify, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

export type SimCheckout = {
  tid: string; sid: string; amt: number; name: string; desc: string;
  ok: string; no: string; md: Record<string, string>;
};

async function key(): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', new TextEncoder().encode(Deno.env.get('ADMIN_JWT_SECRET')!),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function simulatedCheckoutUrl(p: Omit<SimCheckout, 'sid'>): Promise<{ url: string; session_id: string }> {
  const sid = 'sim_cs_' + crypto.randomUUID().replace(/-/g, '');
  const token = await create({ alg: 'HS256', typ: 'JWT' },
    { kind: 'sim_checkout', ...p, sid, exp: getNumericDate(60 * 60) }, await key());
  return { url: `${new URL(p.ok).origin}/pay-test.html#t=${token}`, session_id: sid };
}

export async function verifySimToken(token: string): Promise<SimCheckout | null> {
  if (!Deno.env.get('ADMIN_JWT_SECRET') || !token) return null;
  try {
    const p = await verify(token, await key()) as Record<string, unknown>;
    if (p.kind !== 'sim_checkout' || !p.tid || !p.sid) return null;
    return p as unknown as SimCheckout;
  } catch { return null; }
}
