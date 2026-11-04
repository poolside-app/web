// =============================================================================
// drive_parties.ts — the nightly Drive catch-up and the Parties tab (PLAN.md BP)
// =============================================================================
// Doug, 2026-11-03, asked whether everything backs up nightly. Signups copy the
// moment they're sent, but one that failed waited for someone to press "Retry
// failed syncs". Each night (pg_cron drive_nightly → google_drive_sync
// cron_nightly), for each club with Drive connected:
//   1. retry every waiting backup,
//   2. copy any signup or signed renewal that never got copied,
//   3. bring the Parties tab up to date from party_history.
// The board's "Copy anything missing now" button runs the same thing.
// Like the rest of the Drive code, it only adds and updates; a row in Drive is
// never removed.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ensureTab, getAccessToken, loadGrant, readValues, updateGrantCache, writeValues } from './google_drive.ts';
import { enqueueDriveSync, ensureRoster, syncApplicationToDrive } from './sync_application.ts';
import { PARTY_COLUMNS, partyRecord, type PartyMoney, type PartyStep } from './party_history.ts';
import { rowByHeaders, sheetSafe } from './drive_row.ts';
import { zoneOrDefault } from './pool_time.ts';

type Keys = { googleClientId: string; googleClientSecret: string };
export type NightlyResult = {
  ok: true; skipped?: boolean;
  retried: number; copied: number; failed: number; dropped: number; parties: number;
  errors: Array<{ family: string; error: string }>;
};

/** Every backup waiting in the queue, tried now (not only ones past their wait). */
export async function retryDriveQueue(sb: SupabaseClient, tenantId: string, keys: Keys, limit = 25) {
  const { data: rows } = await sb.from('drive_sync_queue')
    .select('id, application_id, attempts')
    .eq('tenant_id', tenantId).eq('status', 'pending')
    .order('created_at')
    .limit(limit);
  let attempted = 0, succeeded = 0, failed = 0, dropped = 0;
  const tried: string[] = [];
  for (const row of rows ?? []) {
    attempted++;
    tried.push(row.application_id as string);
    try {
      const r = await syncApplicationToDrive(sb, { tenantId, applicationId: row.application_id as string, ...keys });
      if (r.ok) {
        await sb.from('drive_sync_queue').update({ status: 'done' }).eq('id', row.id as string);
        succeeded++;
      } else if (r.error === 'application not found') {
        // The signup was deleted (PLAN.md Z1): nothing left to back up, so
        // drop it rather than retrying it forever.
        await sb.from('drive_sync_queue').delete().eq('id', row.id as string);
        dropped++;
      } else {
        failed++;
        const attempts = (row.attempts as number ?? 0) + 1;
        const nextAt = new Date(Date.now() + Math.min(60 * 60 * 1000, 60_000 * 2 ** attempts)).toISOString();
        await sb.from('drive_sync_queue').update({
          attempts,
          last_error: r.error,
          next_retry_at: nextAt,
          status: attempts >= 6 ? 'failed' : 'pending',
        }).eq('id', row.id as string);
      }
    } catch (e) {
      failed++;
      const attempts = (row.attempts as number ?? 0) + 1;
      await sb.from('drive_sync_queue').update({
        attempts,
        last_error: (e as Error).message,
        next_retry_at: new Date(Date.now() + 60_000 * 2 ** attempts).toISOString(),
        status: attempts >= 6 ? 'failed' : 'pending',
      }).eq('id', row.id as string);
    }
  }
  return { attempted, succeeded, failed, dropped, tried };
}

/** Signups and signed renewals not in Drive yet. An imported family that
 *  hasn't signed, and a renewal not signed yet, have nothing to keep. */
export async function copyMissing(sb: SupabaseClient, tenantId: string, keys: Keys, skip: string[] = []) {
  const { data: apps } = await sb.from('applications')
    .select('id, family_name, status, is_renewal, signature_primary, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });
  const { data: synced } = await sb.from('drive_sync_log').select('application_id').eq('tenant_id', tenantId);
  const done = new Set([...(synced ?? []).map(s => s.application_id as string), ...skip]);
  const missing = (apps ?? []).filter(a => !done.has(a.id as string)
    && a.status !== 'prefilled'
    && !(a.is_renewal === true && !a.signature_primary));
  let copied = 0, failed = 0;
  const errors: Array<{ family: string; error: string }> = [];
  for (const app of missing) {
    try {
      const r = await syncApplicationToDrive(sb, { tenantId, applicationId: app.id as string, ...keys });
      if (r.ok && !r.skipped) copied++;
      else if (!r.ok) {
        failed++; errors.push({ family: app.family_name as string, error: r.error });
        await enqueueDriveSync(sb, tenantId, app.id as string, r.error);
      }
    } catch (e) {
      failed++; errors.push({ family: app.family_name as string, error: (e as Error).message });
      await enqueueDriveSync(sb, tenantId, app.id as string, (e as Error).message);
    }
  }
  return { total: missing.length, copied, failed, errors };
}

// The sort key of a row: its =DATE(y,m,d) party date.
function dateKey(v: unknown): number {
  const m = String(v ?? '').match(/DATE\((\d+),(\d+),(\d+)\)/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : Number.MAX_SAFE_INTEGER;
}

/** Rewrite the Parties tab: every party's row brought up to date, by party date.
 *  A row whose party is gone from Poolside is kept as it was. */
export async function syncPartiesToDrive(
  sb: SupabaseClient, tenantId: string, accessToken: string, spreadsheetId: string, tz: string,
): Promise<number> {
  const { data: hist } = await sb.from('party_history')
    .select('*').eq('tenant_id', tenantId).order('at', { ascending: true });
  const { data: money } = await sb.from('audit_log')
    .select('entity_id, kind, created_at, summary')
    .eq('tenant_id', tenantId).eq('entity_type', 'party_booking')
    .in('kind', ['payment.refund', 'payment.dispute']);
  const byParty = new Map<string, PartyStep[]>();
  for (const h of (hist ?? []) as PartyStep[]) {
    if (!byParty.has(h.booking_id)) byParty.set(h.booking_id, []);
    byParty.get(h.booking_id)!.push(h);
  }

  await ensureTab(accessToken, spreadsheetId, 'Parties', PARTY_COLUMNS);
  const existing = await readValues(accessToken, spreadsheetId, 'Parties', 'FORMULA');
  const headers = existing[0]?.length ? existing[0].map(String) : PARTY_COLUMNS.map(c => c.label);
  const idAt = headers.indexOf('Party ID'), dateAt = headers.indexOf('Party Date');
  const formulaCols = new Set(['Party Date', 'Requested'].map(h => headers.indexOf(h)));
  // Kept rows are written back as they read, but typed text can't turn into a formula.
  const kept = new Map<string, unknown[]>();
  for (const row of existing.slice(1)) {
    const id = String(row[idAt] ?? '');
    if (!id) continue;
    kept.set(id, headers.map((_, i) => (formulaCols.has(i) ? row[i] ?? '' : sheetSafe(row[i] ?? ''))));
  }
  for (const [id, steps] of byParty) {
    const refunds = ((money ?? []) as PartyMoney[]).filter(m => m.entity_id === id);
    kept.set(id, rowByHeaders(headers, partyRecord(steps, refunds, tz)));
  }
  const rows = [...kept.values()].map((r, i) => ({ r, i }))
    .sort((a, b) => (dateKey(a.r[dateAt]) - dateKey(b.r[dateAt])) || (a.i - b.i))
    .map(x => x.r);
  await writeValues(accessToken, spreadsheetId, 'Parties!A1', [headers, ...rows]);
  return byParty.size;
}

/** The whole nightly run for one club. */
export async function nightlyDrive(sb: SupabaseClient, tenantId: string, keys: Keys): Promise<NightlyResult> {
  const empty: NightlyResult = { ok: true, retried: 0, copied: 0, failed: 0, dropped: 0, parties: 0, errors: [] };
  if (!(await loadGrant(sb, tenantId))) return { ...empty, skipped: true };

  const q = await retryDriveQueue(sb, tenantId, keys);
  const c = await copyMissing(sb, tenantId, keys, q.tried);

  // Read again: a backup above may have just made the folder and sheet.
  const grant = await loadGrant(sb, tenantId);
  const { data: tenant } = await sb.from('tenants').select('slug, display_name, timezone').eq('id', tenantId).maybeSingle();
  if (!grant || !tenant) return { ...empty, retried: q.succeeded, copied: c.copied, failed: q.failed + c.failed, dropped: q.dropped, errors: c.errors };
  const accessToken = await getAccessToken(grant.refresh_token, keys.googleClientId, keys.googleClientSecret);
  const roster = await ensureRoster(accessToken, tenant as { slug: string; display_name: string }, grant);
  if (roster.spreadsheetId !== grant.spreadsheet_id || roster.rootId !== grant.root_folder_id || roster.clubId !== grant.club_folder_id) {
    await updateGrantCache(sb, tenantId, {
      root_folder_id: roster.rootId, club_folder_id: roster.clubId, spreadsheet_id: roster.spreadsheetId,
      ...(roster.spreadsheetId !== grant.spreadsheet_id ? { year_tab_ids: {} } : {}),
    });
  }
  const parties = await syncPartiesToDrive(sb, tenantId, accessToken, roster.spreadsheetId, zoneOrDefault(tenant.timezone));
  return { ok: true, retried: q.succeeded, copied: c.copied, failed: q.failed + c.failed, dropped: q.dropped, parties, errors: c.errors };
}
