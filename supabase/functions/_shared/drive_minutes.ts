// =============================================================================
// drive_minutes.ts — board minutes and bylaws in the club's Drive (PLAN.md BV)
// =============================================================================
// Doug, 11/5: "we should probably backup the meeting minutes as well in the
// google drive". His picks: drafts too, Board-only minutes too, PDF, the
// bylaws too, one draft file kept up to date. Into Poolside Archive → the
// club → "Board minutes":
//   - one draft file per meeting, saved when it closes and rewritten whenever
//     the draft changes (Save changes, an amendment);
//   - an approved file each time the last approval lands, from the copy
//     members see (posted_json); an approved amendment adds its own;
//   - each bylaws version posted, and minutes uploaded for a meeting not
//     taken in Poolside (PLAN.md BW4).
// board_meetings runs this after the page has its answer; the nightly Drive
// run (drive_parties.ts nightlyDrive) catches anything that failed or came
// before Drive was connected. Like the rest of the Drive code it only adds
// and rewrites; deleting a meeting in Poolside leaves its files.
// Tested offline by scripts/test_minutes_drive.mjs.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ensureFolder, getAccessToken, loadGrant, rewritePdf, updateGrantCache, uploadPdf, type DriveGrant } from './google_drive.ts';
import { minutesFileName, renderMinutesPdf } from './minutes_pdf.ts';
import { snapshot } from './minutes_approval.ts';
import { PRIVATE_BUCKET } from './club_docs.ts';
import { poolDate, zoneOrDefault } from './pool_time.ts';

type Keys = { googleClientId: string; googleClientSecret: string };
type Row = Record<string, unknown>;
export const MINUTES_FOLDER = 'Board minutes';
const FIELDS = 'id, tenant_id, title, meeting_date, location, status, started_at, ended_at, visibility, notes_md, attendees_json, votes_json, follow_ups_json, minutes_status, approval_round, posted_json, posted_at, posted_count, drive_draft_file_id, drive_draft_hash, drive_posted_count';

// One club's Drive for one run: the token and the folder, fetched once.
type Session = {
  tenantId: string; grant: DriveGrant; club: string; tz: string; keys: Keys;
  token?: string; folderId?: string;
};

async function openSession(sb: SupabaseClient, tenantId: string, keys: Keys): Promise<Session | null> {
  const grant = await loadGrant(sb, tenantId);
  if (!grant) return null;
  const { data: t } = await sb.from('tenants').select('slug, display_name, timezone').eq('id', tenantId).maybeSingle();
  if (!t) return null;
  return { tenantId, grant, keys, club: String(t.display_name || t.slug), tz: zoneOrDefault(t.timezone) };
}

/** The "Board minutes" folder, found or made again, like the club's others. */
async function minutesFolder(sb: SupabaseClient, s: Session): Promise<{ token: string; folderId: string }> {
  if (s.token && s.folderId) return { token: s.token, folderId: s.folderId };
  const token = await getAccessToken(s.grant.refresh_token, s.keys.googleClientId, s.keys.googleClientSecret);
  const rootId = await ensureFolder(token, 'Poolside Archive', 'root', s.grant.root_folder_id);
  const clubId = await ensureFolder(token, s.club, rootId, s.grant.club_folder_id);
  const folderId = await ensureFolder(token, MINUTES_FOLDER, clubId, s.grant.minutes_folder_id ?? null);
  if (rootId !== s.grant.root_folder_id || clubId !== s.grant.club_folder_id || folderId !== s.grant.minutes_folder_id) {
    await updateGrantCache(sb, s.tenantId, { root_folder_id: rootId, club_folder_id: clubId, minutes_folder_id: folderId });
    Object.assign(s.grant, { root_folder_id: rootId, club_folder_id: clubId, minutes_folder_id: folderId });
  }
  s.token = token; s.folderId = folderId;
  return { token, folderId };
}

/** What the draft says, so an unchanged draft isn't written again. */
export async function draftHash(m: Row): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot(m)));
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(sum, b => b.toString(16).padStart(2, '0')).join('');
}

/** What a closed meeting still needs in Drive. A draft is kept up to date
 *  until it's approved; an approval not copied yet gets its own file. */
export async function minutesNeeds(m: Row): Promise<{ draft: boolean; approved: boolean; hash: string | null }> {
  if (m.status !== 'completed') return { draft: false, approved: false, hash: null };
  const approved = !!m.posted_json && Number(m.posted_count ?? 0) > Number(m.drive_posted_count ?? 0);
  if (m.minutes_status === 'approved') return { draft: false, approved, hash: null };
  const hash = await draftHash(m);
  return { draft: !m.drive_draft_file_id || hash !== m.drive_draft_hash, approved, hash };
}

/** Who approved the copy members see: the newest round everyone approved. */
async function approversOf(sb: SupabaseClient, meetingId: string) {
  const { data } = await sb.from('board_minutes_approvals').select('round, name, status, on_behalf, decided_by_name')
    .eq('meeting_id', meetingId);
  const byRound = new Map<number, Row[]>();
  for (const r of (data ?? []) as Row[]) {
    const n = Number(r.round ?? 0);
    byRound.set(n, [...(byRound.get(n) ?? []), r]);
  }
  const done = [...byRound.entries()].filter(([, rows]) => rows.every(r => r.status === 'approved')).sort((a, b) => b[0] - a[0])[0];
  return (done?.[1] ?? []).map(r => ({ name: String(r.name ?? 'Board member'), on_behalf_by: r.on_behalf ? String(r.decided_by_name ?? 'the President') : null }));
}

async function backupOne(sb: SupabaseClient, s: Session, m: Row): Promise<number> {
  const need = await minutesNeeds(m);
  let wrote = 0;
  if (need.draft) {
    const { token, folderId } = await minutesFolder(sb, s);
    const bytes = await renderMinutesPdf({ ...m, club: s.club, tz: s.tz, state: 'draft' });
    const name = minutesFileName(m, 'draft');
    let fileId = m.drive_draft_file_id ? String(m.drive_draft_file_id) : null;
    if (!fileId || !(await rewritePdf(token, fileId, name, bytes))) fileId = await uploadPdf(token, folderId, name, bytes);
    await sb.from('board_meetings').update({ drive_draft_file_id: fileId, drive_draft_hash: need.hash })
      .eq('id', m.id as string).eq('tenant_id', s.tenantId);
    Object.assign(m, { drive_draft_file_id: fileId, drive_draft_hash: need.hash });
    wrote++;
  }
  if (need.approved) {
    const { token, folderId } = await minutesFolder(sb, s);
    const posted = m.posted_json as Row;
    const amended = Number(m.posted_count ?? 0) > 1;
    const approvedAt = String(m.posted_at ?? new Date().toISOString());
    const bytes = await renderMinutesPdf({
      ...posted, club: s.club, tz: s.tz, state: 'approved', amended, approved_at: approvedAt,
      approvers: await approversOf(sb, m.id as string),
    });
    const name = minutesFileName({ meeting_date: posted.meeting_date ?? m.meeting_date, title: posted.title ?? m.title }, 'approved',
      { approvedDay: poolDate(approvedAt, s.tz), amended });
    await uploadPdf(token, folderId, name, bytes);
    await sb.from('board_meetings').update({ drive_posted_count: Number(m.posted_count) })
      .eq('id', m.id as string).eq('tenant_id', s.tenantId);
    m.drive_posted_count = Number(m.posted_count);
    wrote++;
  }
  return wrote;
}

/** One meeting, now (board_meetings, after Close meeting, a saved draft or the last approval). */
export async function backupMinutes(sb: SupabaseClient, tenantId: string, meetingId: string, keys: Keys) {
  const s = await openSession(sb, tenantId, keys);
  if (!s) return { ok: true, skipped: true, reason: 'drive not connected' };
  const { data: m } = await sb.from('board_meetings').select(FIELDS).eq('id', meetingId).eq('tenant_id', tenantId).maybeSingle();
  if (!m) return { ok: true, skipped: true, reason: 'meeting not found' };
  if (m.status !== 'completed') return { ok: true, skipped: true, reason: 'meeting still open' };
  return { ok: true, wrote: await backupOne(sb, s, m as Row) };
}

/** A bylaws version or uploaded minutes (PLAN.md BW4), as it's named in Drive. */
export function docFileName(d: Row, tz: string): string {
  if (d.kind === 'minutes') {
    const ext = (String(d.storage_path ?? '').match(/\.([a-z0-9]+)$/i) ?? [])[1] ?? 'pdf';
    return `${d.meeting_date} Meeting minutes - uploaded.${ext.toLowerCase()}`;
  }
  return `Bylaws - posted ${poolDate(String(d.uploaded_at ?? new Date().toISOString()), tz)}.pdf`;
}

async function docsWith(sb: SupabaseClient, s: Session) {
  const { data } = await sb.from('club_documents').select('id, kind, storage_path, file_name, content_type, meeting_date, uploaded_at, drive_file_id')
    .eq('tenant_id', s.tenantId).in('kind', ['bylaws', 'minutes']).is('drive_file_id', null).order('uploaded_at', { ascending: true });
  let copied = 0;
  const errors: Array<{ family: string; error: string }> = [];
  // A bylaws version not yet moved to the private folder is copied once it is.
  for (const d of ((data ?? []) as Row[]).filter(r => r.storage_path)) {
    const name = docFileName(d, s.tz);
    try {
      const { data: file, error } = await sb.storage.from(PRIVATE_BUCKET).download(String(d.storage_path));
      if (error || !file) throw new Error(`Couldn't read the file: ${error?.message ?? 'missing'}`);
      const { token, folderId } = await minutesFolder(sb, s);
      const id = await uploadPdf(token, folderId, name, new Uint8Array(await file.arrayBuffer()), String(d.content_type || 'application/pdf'));
      await sb.from('club_documents').update({ drive_file_id: id }).eq('id', d.id as string);
      copied++;
    } catch (e) {
      errors.push({ family: name.replace(/\.[a-z0-9]+$/i, ''), error: (e as Error).message });
    }
  }
  return { copied, errors };
}

/** Each bylaws version and uploaded minutes not in Drive yet (board_meetings,
 *  after one is posted or uploaded). */
export async function backupDocs(sb: SupabaseClient, tenantId: string, keys: Keys) {
  const s = await openSession(sb, tenantId, keys);
  if (!s) return { ok: true, skipped: true, copied: 0, errors: [] };
  return { ok: true, ...(await docsWith(sb, s)) };
}
export const backupBylaws = backupDocs;

/** The nightly step (PLAN.md BV6): every closed meeting and bylaws version still missing. */
export async function catchUpMinutes(sb: SupabaseClient, tenantId: string, keys: Keys) {
  const out = { minutes: 0, bylaws: 0, errors: [] as Array<{ family: string; error: string }> };
  const s = await openSession(sb, tenantId, keys);
  if (!s) return out;
  // The folder first, so it's there (and remembered) before the first meeting closes.
  await minutesFolder(sb, s);
  const { data } = await sb.from('board_meetings').select(FIELDS)
    .eq('tenant_id', tenantId).eq('status', 'completed').order('meeting_date', { ascending: true }).limit(500);
  for (const m of (data ?? []) as Row[]) {
    try { out.minutes += await backupOne(sb, s, m); }
    catch (e) { out.errors.push({ family: `Minutes of ${m.meeting_date} ${m.title}`, error: (e as Error).message }); }
  }
  const b = await docsWith(sb, s);
  out.bylaws = b.copied;
  out.errors.push(...b.errors);
  return out;
}
