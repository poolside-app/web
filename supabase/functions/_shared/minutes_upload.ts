// =============================================================================
// minutes_upload.ts — minutes of a meeting not taken in Poolside (PLAN.md BW)
// =============================================================================
// Doug, 11/5: "if we had a meeting and didn't use the meeting feature, i want
// to be able to say here was a meeting... select a date only... upload the
// minutes and it backs it up and posts it... saying meeting minutes from
// 1/1/2026... then you click the link and it shows the minutes." His picks:
// posted at once (no approval), any board member, PDF, Word or a photo,
// Members or Board only each time.
//
// Each upload is a club_documents row of kind 'minutes' with its date and who
// sees it. The file goes straight from the phone to the private club-docs
// folder (BY4: a one-time upload link, never through the server); readers
// get links that work for an hour, like the bylaws. Whoever uploaded it or
// the President can delete it; its Drive copy (drive_minutes.ts) stays.
// board_meetings uses these; tested offline by scripts/test_minutes_upload.mjs.
// =============================================================================

import { PRIVATE_BUCKET } from './club_docs.ts';

// deno-lint-ignore no-explicit-any
type Sb = any;
type Me = { id: string | null; name: string; isOwner: boolean };   // id null: Poolside's own sign-in

export const MAX_BYTES = 25 * 1024 * 1024;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  [DOCX]: 'docx',
  'application/msword': 'doc',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(TYPES).map(([mime, ext]) => [ext, mime]));
BY_EXT.jpeg = 'image/jpeg';

/** A PDF, a Word file or a photo, by its type or, when the phone gave none, its name. */
export function minutesFileType(contentType: unknown, fileName: unknown): { mime: string; ext: string } | null {
  const ct = String(contentType ?? '').trim().toLowerCase();
  if (TYPES[ct]) return { mime: ct, ext: TYPES[ct] };
  if (ct && ct !== 'application/octet-stream') return null;
  const ext = (String(fileName ?? '').toLowerCase().match(/\.([a-z0-9]+)$/) ?? [])[1] ?? '';
  const mime = BY_EXT[ext];
  return mime ? { mime, ext: TYPES[mime] } : null;
}

/** "Meeting minutes from 1/1/2026". */
export function uploadedTitle(day: string): string {
  const [y, m, d] = String(day).split('-').map(Number);
  return `Meeting minutes from ${m}/${d}/${y}`;
}

function realDay(s: unknown): string | null {
  const day = String(s ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = new Date(`${day}T12:00:00Z`);
  return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === day ? day : null;
}

const uploadPath = (tid: string, id: string, ext: string) => `${tid}/minutes-${id}.${ext}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Checked = { day: string; fileName: string; type: { mime: string; ext: string } };
function checkUpload(body: Record<string, unknown>): Checked | { ok: false; error: string; status: number } {
  const day = realDay(body.meeting_date);
  if (!day) return { ok: false, status: 400, error: 'Pick the date of the meeting.' };
  const fileName = String(body.file_name ?? '').trim().slice(0, 160) || 'Minutes';
  const type = minutesFileType(body.content_type, fileName);
  if (!type) return { ok: false, status: 400, error: 'Upload a PDF, a Word file or a photo of the minutes.' };
  return { day, fileName, type };
}

/**
 * Step 1 (PLAN.md BY4, Doug 11/6): the date, the kind of file and its size
 * are checked, then the phone gets a one-time link to put the file straight
 * into the private folder. Nothing big passes through Poolside's server,
 * which a 25 MB scan sent as text could run out of time or memory in.
 */
export async function startMinutesUpload(sb: Sb, tid: string, body: Record<string, unknown>):
  Promise<{ ok: true; id: string; upload_url: string; content_type: string } | { ok: false; error: string; status: number }> {
  const c = checkUpload(body);
  if ('ok' in c) return c;
  const size = Number(body.size);
  if (!(size > 0)) return { ok: false, status: 400, error: 'Pick the file with the minutes.' };
  if (size > MAX_BYTES) return { ok: false, status: 400, error: 'That file is over 25 MB.' };
  const id = crypto.randomUUID();
  const { data, error } = await sb.storage.from(PRIVATE_BUCKET).createSignedUploadUrl(uploadPath(tid, id, c.type.ext));
  if (error || !data?.signedUrl) return { ok: false, status: 500, error: `Upload failed: ${error?.message ?? 'no link'}` };
  return { ok: true, id, upload_url: data.signedUrl, content_type: c.type.mime };
}

/** Step 2: once the file is there (its size and type checked again), it's posted. */
export async function saveUploadedMinutes(sb: Sb, tid: string, body: Record<string, unknown>, me: Me):
  Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; error: string; status: number }> {
  const c = checkUpload(body);
  if ('ok' in c) return c;
  const id = String(body.upload_id ?? '');
  if (!UUID.test(id)) return { ok: false, status: 400, error: 'Pick the file with the minutes.' };
  // A second tap on Upload: already posted.
  const { data: had } = await sb.from('club_documents').select('*').eq('id', id).eq('tenant_id', tid).maybeSingle();
  if (had) return { ok: true, row: had };
  const path = uploadPath(tid, id, c.type.ext);
  const name = path.slice(tid.length + 1);
  const { data: found } = await sb.storage.from(PRIVATE_BUCKET).list(tid, { search: name });
  const obj = (found ?? []).find((f: { name: string }) => f.name === name);
  if (!obj) return { ok: false, status: 400, error: 'The file didn\'t arrive. Try again.' };
  const size = Number(obj.metadata?.size ?? 0), stored = String(obj.metadata?.mimetype ?? '');
  if (size > MAX_BYTES || (stored && stored !== c.type.mime)) {
    await sb.storage.from(PRIVATE_BUCKET).remove([path]);
    return { ok: false, status: 400, error: size > MAX_BYTES ? 'That file is over 25 MB.' : 'Upload a PDF, a Word file or a photo of the minutes.' };
  }
  const { data, error } = await sb.from('club_documents').insert({
    id, tenant_id: tid, kind: 'minutes', url: null, storage_path: path, file_name: c.fileName, content_type: c.type.mime,
    meeting_date: c.day, visibility: body.visibility === 'private' ? 'private' : 'members',
    uploaded_by: me.id, uploaded_by_name: me.name,
  }).select('*').single();
  if (error || !data) {
    // Two taps at once: the other one posted it, so the file stays.
    const { data: again } = await sb.from('club_documents').select('*').eq('id', id).eq('tenant_id', tid).maybeSingle();
    if (again) return { ok: true, row: again };
    await sb.storage.from(PRIVATE_BUCKET).remove([path]);
    return { ok: false, status: 500, error: error?.message ?? 'Could not save it.' };
  }
  return { ok: true, row: data };
}

/** Members get the Members ones only, with no more than they need; the board
 *  gets them all, with whether this board member may delete each. Newest first. */
export async function uploadedMinutes(sb: Sb, tid: string, opts: { membersOnly?: boolean; me?: Me }) {
  let q = sb.from('club_documents').select('id, storage_path, file_name, content_type, meeting_date, visibility, uploaded_by, uploaded_by_name, uploaded_at')
    .eq('tenant_id', tid).eq('kind', 'minutes');
  if (opts.membersOnly) q = q.eq('visibility', 'members');
  const { data } = await q.order('meeting_date', { ascending: false }).limit(200);
  return await Promise.all(((data ?? []) as Record<string, unknown>[]).map(async d => {
    const { data: link } = d.storage_path
      ? await sb.storage.from(PRIVATE_BUCKET).createSignedUrl(String(d.storage_path), 3600)
      : { data: null };
    const base = { id: d.id, title: uploadedTitle(String(d.meeting_date)), meeting_date: d.meeting_date, url: link?.signedUrl ?? null, content_type: d.content_type ?? null };
    if (opts.membersOnly) return base;
    return {
      ...base, visibility: d.visibility, file_name: d.file_name, uploaded_by_name: d.uploaded_by_name, uploaded_at: d.uploaded_at,
      can_delete: !!opts.me && (opts.me.isOwner || (!!opts.me.id && d.uploaded_by === opts.me.id)),
    };
  }));
}

export async function deleteUploadedMinutes(sb: Sb, tid: string, id: string, me: Me):
  Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; error: string; status: number }> {
  const { data: d } = await sb.from('club_documents').select('id, kind, storage_path, uploaded_by, meeting_date')
    .eq('id', id).eq('tenant_id', tid).maybeSingle();
  if (!d || d.kind !== 'minutes') return { ok: false, status: 404, error: 'Those minutes aren\'t here any more.' };
  if (!me.isOwner && (!me.id || d.uploaded_by !== me.id)) return { ok: false, status: 403, error: 'Only whoever uploaded them or the President can delete them.' };
  const { error } = await sb.from('club_documents').delete().eq('id', id).eq('tenant_id', tid).eq('kind', 'minutes');
  if (error) return { ok: false, status: 500, error: error.message };
  if (d.storage_path) await sb.storage.from(PRIVATE_BUCKET).remove([String(d.storage_path)]);
  return { ok: true, row: d };
}
