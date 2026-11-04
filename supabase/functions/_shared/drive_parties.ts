// =============================================================================
// drive_parties.ts — the nightly Drive catch-up and the Parties tab (PLAN.md BP)
// =============================================================================
// Doug, 2026-11-03, asked whether everything backs up nightly. Signups copy the
// moment they're sent, but one that failed waited for someone to press "Retry
// failed syncs". Each night (pg_cron drive_nightly → google_drive_sync
// cron_nightly), for each club with Drive connected:
//   1. retry every waiting backup,
//   2. copy any signup or signed renewal that never got copied,
//   3. rewrite each season's roster tab from Poolside (PLAN.md BR5),
//   4. bring the Parties tab up to date from party_history.
// Connecting Drive runs the same thing right away (PLAN.md BQ1).
// Like the rest of the Drive code, it only adds and updates; a row in Drive is
// never removed.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ensureTab, formatTab, getAccessToken, loadGrant, readValues, SHEET_COLUMNS, updateGrantCache, writeValues } from './google_drive.ts';
import { enqueueDriveSync, ensureRoster, loadFobs, syncApplicationToDrive, tierLabels } from './sync_application.ts';
import { PARTY_COLUMNS, partyRecord, type PartyMoney, type PartyStep } from './party_history.ts';
import { driveSeason, rosterRecord, rowByHeaders, sheetSafe } from './drive_row.ts';
import { SUN, type ColSpec } from './sheet_look.ts';
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

/** Signups and signed renewals not in the sheet in use. An imported family
 *  that hasn't signed, and a renewal not signed yet, have nothing to keep.
 *  One copied into another sheet (a Google account the club left, or a
 *  trashed folder) is copied again into this one (PLAN.md BQ2). */
export async function copyMissing(sb: SupabaseClient, tenantId: string, keys: Keys, skip: string[] = [], currentSheet: string | null = null) {
  const { data: apps } = await sb.from('applications')
    .select('id, family_name, status, is_renewal, signature_primary, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });
  const { data: synced } = await sb.from('drive_sync_log').select('application_id, spreadsheet_id').eq('tenant_id', tenantId);
  const here = (synced ?? []).filter(s => !currentSheet || s.spreadsheet_id === currentSheet);
  const elsewhere = new Set((synced ?? []).filter(s => currentSheet && s.spreadsheet_id !== currentSheet).map(s => s.application_id as string));
  const done = new Set([...here.map(s => s.application_id as string), ...skip]);
  const missing = (apps ?? []).filter(a => !done.has(a.id as string)
    && a.status !== 'prefilled'
    && !(a.is_renewal === true && !a.signature_primary));
  let copied = 0, failed = 0;
  const errors: Array<{ family: string; error: string }> = [];
  for (const app of missing) {
    try {
      if (elsewhere.has(app.id as string)) {
        // The old record says "already copied" and would stop the copy.
        await sb.from('drive_sync_log').delete().eq('tenant_id', tenantId).eq('application_id', app.id as string);
      }
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

// The sort key of a row: its =DATE(y,m,d) (and +TIME(h,m,s)) date.
function dateKey(v: unknown): number {
  const m = String(v ?? '').match(/DATE\((\d+),(\d+),(\d+)\)(?:\+TIME\((\d+),(\d+),(\d+)\))?/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : Number.MAX_SAFE_INTEGER;
}

/**
 * Rewrite one tab from Poolside's records, keyed by an ID column:
 * - Poolside's columns in Poolside's order, then any column the board added
 *   (kept, with its values on the same rows).
 * - A row Poolside no longer has keeps what it said, plus `gone` (e.g. a
 *   Status of "Deleted from Poolside"). No row is ever removed.
 * - The look is set first, then the values: a date formula written into a
 *   column still formatted as text would stay text.
 */
export async function writeTab(accessToken: string, spreadsheetId: string, title: string, args: {
  columns: ColSpec[]; records: Map<string, Record<string, unknown>>; idLabel: string; sortLabel: string;
  gone?: Record<string, unknown>; tabColor?: { red: number; green: number; blue: number }; beforeTitle?: string;
}): Promise<number> {
  const sheetId = await ensureTab(accessToken, spreadsheetId, title, args.columns, { beforeTitle: args.beforeTitle, tabColor: args.tabColor });
  const existing = await readValues(accessToken, spreadsheetId, title, 'FORMULA');
  const oldHeaders = (existing[0] ?? []).map(h => String(h ?? ''));
  const ours = args.columns.map(c => c.label);
  const formulas = new Set(args.columns.filter(c => c.formula).map(c => c.label));
  const headers = [...ours, ...oldHeaders.filter(h => h && !ours.includes(h))];

  // What the sheet has now, by ID and column name. Typed text can't turn
  // into a formula when it's written back.
  const idAt = oldHeaders.indexOf(args.idLabel);
  const kept = new Map<string, Record<string, unknown>>();
  const loose: Record<string, unknown>[] = [];
  for (const r of existing.slice(1)) {
    if (!r.some(v => v !== '' && v != null)) continue;
    const obj: Record<string, unknown> = {};
    oldHeaders.forEach((h, i) => { if (h) obj[h] = ours.includes(h) && !formulas.has(h) ? sheetSafe(r[i] ?? '') : (r[i] ?? ''); });
    const id = idAt >= 0 ? String(r[idAt] ?? '') : '';
    if (id) kept.set(id, obj); else loose.push(obj);
  }
  const out = new Map<string, Record<string, unknown>>();
  for (const [id, before] of kept) out.set(id, args.records.has(id) ? { ...before, ...args.records.get(id) } : { ...before, ...(args.gone ?? {}) });
  for (const [id, rec] of args.records) if (!out.has(id)) out.set(id, rec);

  const rows = [...out.values(), ...loose].map((o, i) => ({ o, i }))
    .sort((a, b) => (dateKey(a.o[args.sortLabel]) - dateKey(b.o[args.sortLabel])) || (a.i - b.i))
    .map(x => rowByHeaders(headers, x.o));
  await formatTab(accessToken, spreadsheetId, sheetId, headers, args.columns, rows, { tabColor: args.tabColor });
  // Pad to the old size, so nothing from before is left showing past the end.
  const width = Math.max(headers.length, oldHeaders.length);
  const pad = (r: unknown[]) => [...r, ...Array(Math.max(0, width - r.length)).fill('')];
  const blank = Array(Math.max(0, existing.length - 1 - rows.length)).fill([]);
  await writeValues(accessToken, spreadsheetId, `${title}!A1`, [headers, ...rows, ...blank].map(pad));
  return out.size;
}

/** Each season's roster tab, from Poolside: every signup, renewal and imported
 *  family, with where it stands and its fob numbers (PLAN.md BR4, BR5). */
export async function syncRosterToDrive(
  sb: SupabaseClient, tenantId: string, accessToken: string, spreadsheetId: string, tz: string,
): Promise<number> {
  const { data: apps } = await sb.from('applications').select('*').eq('tenant_id', tenantId);
  const { data: logs } = await sb.from('drive_sync_log').select('application_id, drive_file_id, spreadsheet_id, tab_name').eq('tenant_id', tenantId);
  const filed = new Map(((logs ?? []) as Array<Record<string, string>>)
    .filter(l => l.spreadsheet_id === spreadsheetId).map(l => [l.application_id, l]));
  const tiers = await tierLabels(sb, tenantId);
  const fobs = await loadFobs(sb, tenantId);
  const seasons = new Map<string, Map<string, Record<string, unknown>>>();
  for (const app of (apps ?? []) as Array<Record<string, unknown>>) {
    const log = filed.get(app.id as string);
    // A row stays in the tab its PDF was filed under.
    const season = log?.tab_name || driveSeason(app, tz);
    if (!seasons.has(season)) seasons.set(season, new Map());
    seasons.get(season)!.set(app.id as string, rosterRecord(app, {
      tz, tierLabel: tiers[app.tier_slug as string] ?? null, pdfId: log?.drive_file_id ?? null,
      fobs: fobs.get(app.household_id as string) ?? { active: [], waiting: 0 },
    }));
  }
  let n = 0;
  for (const season of [...seasons.keys()].sort()) {
    n += await writeTab(accessToken, spreadsheetId, season, {
      columns: SHEET_COLUMNS, records: seasons.get(season)!, idLabel: 'App ID', sortLabel: 'Submitted',
      gone: { 'Status': 'Deleted from Poolside' }, beforeTitle: 'Parties',
    });
  }
  return n;
}

/** The Parties tab: every party's row brought up to date, by party date.
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
  const records = new Map<string, Record<string, unknown>>();
  for (const [id, steps] of byParty) {
    records.set(id, partyRecord(steps, ((money ?? []) as PartyMoney[]).filter(m => m.entity_id === id), tz));
  }
  await writeTab(accessToken, spreadsheetId, 'Parties', {
    columns: PARTY_COLUMNS, records, idLabel: 'Party ID', sortLabel: 'Party Date', tabColor: SUN,
  });
  return byParty.size;
}

/** The whole run for one club: nightly, and right after Drive is connected (PLAN.md BQ1). */
export async function nightlyDrive(sb: SupabaseClient, tenantId: string, keys: Keys): Promise<NightlyResult> {
  const empty: NightlyResult = { ok: true, retried: 0, copied: 0, failed: 0, dropped: 0, parties: 0, errors: [] };
  const grant = await loadGrant(sb, tenantId);
  if (!grant) return { ...empty, skipped: true };
  const { data: tenant } = await sb.from('tenants').select('slug, display_name, timezone').eq('id', tenantId).maybeSingle();
  if (!tenant) return { ...empty, skipped: true };

  // The folder and sheet first, so a club just connected has them even with
  // nothing to copy, and so a copy in some other sheet can be told apart.
  const accessToken = await getAccessToken(grant.refresh_token, keys.googleClientId, keys.googleClientSecret);
  const roster = await ensureRoster(accessToken, tenant as { slug: string; display_name: string }, grant);
  if (roster.spreadsheetId !== grant.spreadsheet_id || roster.rootId !== grant.root_folder_id || roster.clubId !== grant.club_folder_id) {
    await updateGrantCache(sb, tenantId, {
      root_folder_id: roster.rootId, club_folder_id: roster.clubId, spreadsheet_id: roster.spreadsheetId,
      ...(roster.spreadsheetId !== grant.spreadsheet_id ? { year_tab_ids: {} } : {}),
    });
  }

  const q = await retryDriveQueue(sb, tenantId, keys);
  const c = await copyMissing(sb, tenantId, keys, q.tried, roster.spreadsheetId);
  const tz = zoneOrDefault(tenant.timezone);
  await syncRosterToDrive(sb, tenantId, accessToken, roster.spreadsheetId, tz);
  const parties = await syncPartiesToDrive(sb, tenantId, accessToken, roster.spreadsheetId, tz);
  await sb.from('google_drive_grants').update({
    last_sync_at: new Date().toISOString(),
    last_error: q.failed + c.failed ? (c.errors[0]?.error ?? 'A backup failed; it is tried again tonight.').slice(0, 500) : null,
  }).eq('tenant_id', tenantId);
  return { ok: true, retried: q.succeeded, copied: c.copied, failed: q.failed + c.failed, dropped: q.dropped, parties, errors: c.errors };
}
