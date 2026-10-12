// =============================================================================
// party_booked.ts — the party person hears about every paid party (PLAN.md AE)
// =============================================================================
// Doug, 10/11: "When a pool party is paid for, Venmo or credit card, the party
// person on the board needs to be notified… and be in contact." Before, a
// card payment booked the party and told only the family.
//
// Whenever a party is paid (card in stripe_webhook, a Venmo the board
// approves in parties_admin, or free at an open time in member_auth), the
// "rentals" alert (the Events & Rentals Director, else the President) gets:
//   - a to-do on their board home until they mark it done (with its phone
//     pop-up, from enqueueAdminTask), and
//   - an email with the party and the family's phone and email, tap to call,
//     text or email.
// The family is pointed at Ask the board → Parties & events (the
// party_confirmed email); no board phone numbers are shared.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { fmtPoolDate, fmtPoolTime, zoneOrDefault } from './pool_time.ts';

type Party = { title?: string | null; starts_at: string; ends_at?: string | null; expected_guests?: number | null; price_cents?: number | null; body?: string | null };
type Contact = { name?: string | null; phone_e164?: string | null; email?: string | null };
export type PaidBy = 'card' | 'venmo' | 'free';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** (555) 123-4567 for a US number, else as stored. */
function phone(p: string | null | undefined): string {
  const d = String(p ?? '').replace(/\D/g, '');
  const n = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return n.length === 10 ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : String(p ?? '');
}
function when(p: Party, tz: string): string {
  const day = fmtPoolDate(p.starts_at, tz, { weekday: 'short', month: 'short', day: 'numeric' });
  const t = (i: string) => fmtPoolTime(i, tz, { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  return p.ends_at ? `${day}, ${t(p.starts_at)}–${t(p.ends_at)}` : `${day}, ${t(p.starts_at)}`;
}
function paidLine(p: Party, how: PaidBy): string {
  if (how === 'free') return 'no fee';
  const amt = p.price_cents ? `$${(Number(p.price_cents) / 100).toFixed(0)} ` : '';
  return `${amt}paid by ${how === 'card' ? 'card' : 'Venmo'}`;
}

/** The to-do's one line. */
export function bookedSummary(p: Party, family: string | null, who: Contact, how: PaidBy, tz: string): string {
  const guests = p.expected_guests ? `, about ${p.expected_guests} guests` : '';
  const name = who.name || (family ? `the ${family}` : 'the family');
  const reach = who.phone_e164 ? ` at ${phone(who.phone_e164)}` : who.email ? ` at ${who.email}` : '';
  return `${p.title || 'A party'} is booked (${paidLine(p, how)}): ${when(p, tz)}${guests}. Get in touch with ${name}${reach}.`;
}

/** The email to the party person: the party, and the family, tap to reach. */
export function bookedEmailHtml(p: Party, family: string | null, who: Contact, how: PaidBy, tz: string, clubUrl: string): string {
  const tel = who.phone_e164 ? String(who.phone_e164).replace(/[^\d+]/g, '') : '';
  const btn = (href: string, label: string) => `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:9px 14px;border-radius:9px;background:#e6eef5;color:#0a3b5c;font-weight:600;text-decoration:none">${label}</a>`;
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;padding:24px;color:#0f172a">
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 12px">🎉 ${esc(p.title || 'A party')} is booked</h2>
      <p style="margin:0 0 6px;line-height:1.55"><b>${esc(when(p, tz))}</b>${p.expected_guests ? ` · about ${esc(p.expected_guests)} guests` : ''} · ${esc(paidLine(p, how))}</p>
      ${p.body ? `<p style="margin:0 0 12px;color:#475569;line-height:1.55">${esc(p.body)}</p>` : ''}
      <p style="margin:16px 0 8px;line-height:1.55">Please get in touch with <b>${esc(who.name || (family ? `the ${family}` : 'the family'))}</b>${family && who.name ? ` (${esc(family)})` : ''}:</p>
      <div>
        ${tel ? btn(`tel:${tel}`, `📞 Call ${esc(phone(who.phone_e164))}`) + btn(`sms:${tel}`, '💬 Text') : ''}
        ${who.email ? btn(`mailto:${who.email}`, `✉️ ${esc(who.email)}`) : ''}
      </div>
      <p style="margin:18px 0"><a href="${esc(clubUrl)}/club/admin/parties.html" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">Open Parties</a></p>
      <p style="margin:14px 0 0;color:#94a3b8;font-size:12px">It's also on your board home until you mark it done. Families with questions can Ask the board → Parties &amp; events, which comes to you.</p>
    </div>`;
}

/**
 * Tell the party person. Best-effort: never fails the booking. Call once,
 * when the party turns paid (each caller only gets there once).
 */
export async function partyBookedAlert(sb: SupabaseClient, args: { tenantId: string; partyId: string; how: PaidBy }): Promise<void> {
  try {
    const { data: p } = await sb.from('party_bookings')
      .select('id, title, body, starts_at, ends_at, expected_guests, price_cents, household_id, requested_by')
      .eq('id', args.partyId).eq('tenant_id', args.tenantId).maybeSingle();
    if (!p) return;
    const [{ data: hh }, { data: who }, { data: tenant }] = await Promise.all([
      sb.from('households').select('family_name').eq('id', p.household_id as string).maybeSingle(),
      p.requested_by ? sb.from('household_members').select('name, phone_e164, email').eq('id', p.requested_by as string).maybeSingle() : Promise.resolve({ data: null }),
      sb.from('tenants').select('slug, timezone').eq('id', args.tenantId).maybeSingle(),
    ]);
    const tz = zoneOrDefault(tenant?.timezone as string | null | undefined);
    const family = (hh?.family_name as string | undefined) ?? null;
    const contact = (who ?? {}) as Contact;
    const party = p as unknown as Party;
    const summary = bookedSummary(party, family, contact, args.how, tz);

    const { enqueueAdminTask } = await import('./enqueue_task.ts');
    await enqueueAdminTask(sb, {
      tenant_id: args.tenantId, target_scopes: ['parties'], kind: 'party.booked', summary,
      link_url: `/club/admin/parties.html#p=${p.id}`, source_kind: 'party_booking', source_id: p.id as string,
      push_title: `🎉 Party booked: ${p.title || 'a party'}`, push_body: `${when(party, tz)}. Get in touch with ${contact.name || 'the family'}.`,
    });

    // The email, to whoever gets the rentals alert right now.
    const { recipientsFor } = await import('./positions_db.ts');
    const ids = await recipientsFor(sb, args.tenantId, 'rentals');
    if (!ids.length) return;
    const { data: admins } = await sb.from('admin_users').select('email').in('id', ids).eq('active', true);
    const { sendEmail } = await import('./send_email.ts');
    const clubUrl = tenant?.slug ? `https://${tenant.slug}.poolsideapp.com` : 'https://poolsideapp.com';
    const html = bookedEmailHtml(party, family, contact, args.how, tz, clubUrl);
    for (const a of admins ?? []) {
      if (!a.email) continue;
      await sendEmail({ to: a.email as string, subject: `🎉 Party booked: ${p.title || 'a party'}, ${when(party, tz)}`, html,
        ...(contact.email ? { replyTo: contact.email } : {}) });
    }
  } catch (e) {
    console.error('partyBookedAlert (non-fatal):', (e as Error).message);
  }
}
