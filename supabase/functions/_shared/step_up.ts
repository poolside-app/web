// =============================================================================
// step_up.ts — a fresh texted code before a dangerous change (PLAN.md CQ1)
// =============================================================================
// Doug 11/8: "Do the text confirm swapping that", and "If you think password
// protect by text is good enough for things then that's fine". A board
// sign-in can sit open on a phone for weeks, so before the changes that move
// money or hand over the club (switching Stripe accounts, changing the Venmo
// handle, giving someone full access, approving one of those), Poolside texts
// a code to the person's own phone, or emails it when the text can't go.
// A code works once, for that one kind of change, for 10 minutes, and five
// wrong tries end it. Only its sha256 is kept.
// =============================================================================

type Db = { from: (table: string) => any };   // a Supabase client, or the tests' pretend one

export const STEP_UP_PURPOSES = {
  stripe_switch: 'switch the club to a different Stripe account',
  payments_change: "change where the club's Venmo payments go",
  full_access: 'give someone full access',
  approve: 'approve a change',
} as const;
export type StepUpPurpose = keyof typeof STEP_UP_PURPOSES;

const TTL_MS = 10 * 60_000;
const MAX_TRIES = 5;

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** What a function answers when the change needs a code first. */
export function needsCode(purpose: StepUpPurpose) {
  return { ok: false, needs_code: true, purpose, error: `Enter the code we text you to ${STEP_UP_PURPOSES[purpose]}.` };
}

const mask = (phone: string) => `(•••) •••-${phone.replace(/\D/g, '').slice(-4)}`;

/** Text (or email) a new code for one change. `send` is replaceable for tests. */
export async function startStepUp(sb: Db, args: {
  tenantId: string; adminId: string; purpose: StepUpPurpose; clubName: string;
  send?: (to: { phone: string | null; email: string | null }, code: string) => Promise<'text' | 'email' | null>;
}): Promise<{ ok: true; via: 'text' | 'email'; to: string } | { ok: false; error: string }> {
  if (!STEP_UP_PURPOSES[args.purpose]) return { ok: false, error: 'Unknown change' };
  const { data: admin } = await sb.from('admin_users').select('id, phone_e164, email, active')
    .eq('id', args.adminId).eq('tenant_id', args.tenantId).maybeSingle();
  if (!admin || admin.active === false) return { ok: false, error: 'Sign in again.' };
  // At most 5 codes in 15 minutes, so a stolen sign-in can't flood a phone.
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: recent } = await sb.from('admin_step_up_codes').select('id, created_at').eq('admin_user_id', args.adminId);
  if (((recent ?? []) as Array<{ created_at: string }>).filter(r => r.created_at >= since).length >= 5) {
    return { ok: false, error: 'Too many codes just now. Wait 15 minutes and try again.' };
  }
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  const send = args.send ?? defaultSend(sb, args.tenantId, args.clubName, args.purpose);
  const via = await send({ phone: admin.phone_e164 ?? null, email: admin.email ?? null }, code);
  if (!via) return { ok: false, error: "We couldn't text or email you a code. Check your phone number on Settings → Board, or ask Poolside." };
  await sb.from('admin_step_up_codes').insert({
    tenant_id: args.tenantId, admin_user_id: args.adminId, purpose: args.purpose,
    code_hash: await sha256Hex(code), sent_via: via, expires_at: new Date(Date.now() + TTL_MS).toISOString(),
    created_at: new Date().toISOString(),
  });
  return { ok: true, via, to: via === 'text' ? mask(String(admin.phone_e164)) : String(admin.email) };
}

/** The code they typed: right, for this change, not used, not old. Uses it up. */
export async function useStepUp(sb: Db, args: { tenantId: string; adminId: string; purpose: StepUpPurpose; code: unknown }): Promise<boolean> {
  const typed = String(args.code ?? '').replace(/\D/g, '');
  if (typed.length !== 6) return false;
  const now = new Date().toISOString();
  const { data: rows } = await sb.from('admin_step_up_codes').select('id, code_hash, expires_at, used_at, attempts, created_at')
    .eq('admin_user_id', args.adminId).eq('tenant_id', args.tenantId).eq('purpose', args.purpose).is('used_at', null);
  const live = ((rows ?? []) as Array<Record<string, unknown>>)
    .filter(r => String(r.expires_at) > now && Number(r.attempts ?? 0) < MAX_TRIES)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (!live) return false;
  if (await sha256Hex(typed) !== live.code_hash) {
    await sb.from('admin_step_up_codes').update({ attempts: Number(live.attempts ?? 0) + 1 }).eq('id', live.id);
    return false;
  }
  await sb.from('admin_step_up_codes').update({ used_at: now }).eq('id', live.id).is('used_at', null);
  return true;
}

/** In a function: the change goes ahead only with a right code. */
export async function checkStepUp(sb: Db, args: { tenantId: string; adminId: string; purpose: StepUpPurpose; code: unknown }):
  Promise<null | { status: number; body: Record<string, unknown> }> {
  if (args.code == null || String(args.code).trim() === '') return { status: 428, body: needsCode(args.purpose) };
  if (!(await useStepUp(sb, args))) return { status: 428, body: { ...needsCode(args.purpose), error: "That code isn't right, or it's more than 10 minutes old. Send a new one." } };
  return null;
}

function defaultSend(sb: Db, tenantId: string, clubName: string, purpose: StepUpPurpose) {
  return async (to: { phone: string | null; email: string | null }, code: string): Promise<'text' | 'email' | null> => {
    const what = STEP_UP_PURPOSES[purpose];
    if (to.phone) {
      try {
        const { sendSms } = await import('./send_sms.ts');
        const r = await sendSms({ sb: sb as never, tenantId, to: to.phone, kind: 'auth', source: `step_up.${purpose}`,
          body: `${code} is your ${clubName} BOARD code to ${what}. Expires in 10 min. If this wasn't you, call the club's President now.` });
        if (r.sent) return 'text';
      } catch (e) { console.error('step-up text:', (e as Error).message); }
    }
    if (to.email) {
      try {
        const { sendEmail } = await import('./send_email.ts');
        const r = await sendEmail({ to: to.email, subject: `${code} is your ${clubName} board code`,
          html: `<p style="font:15px/1.5 Inter,Arial,sans-serif;color:#0f172a">Your ${clubName} board code to ${what} is</p><p style="font:700 28px Inter,Arial,sans-serif;letter-spacing:.12em;color:#0a3b5c">${code}</p><p style="font:13px/1.5 Inter,Arial,sans-serif;color:#64748b">It expires in 10 minutes. If this wasn't you, call the club's President now.</p>` });
        if (r.sent) return 'email';
      } catch (e) { console.error('step-up email:', (e as Error).message); }
    }
    return null;
  };
}
