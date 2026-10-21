// =============================================================================
// club_docs.ts — the bylaws file, private (PLAN.md BJ1)
// =============================================================================
// The board uploads the bylaws PDF through tenant_upload, which puts it in the
// public club-assets folder. Since the bylaws are for members only (Doug,
// 10/21), board_meetings moves each one to the private club-docs folder (when
// it's posted, or the first time it's read for files posted before) and hands
// out links that work for an hour. A forwarded link stops working.
// =============================================================================

export const PRIVATE_BUCKET = 'club-docs';
const PUBLIC_BUCKET = 'club-assets';
const LINK_SECONDS = 3600;

export type DocRow = { id: string; url: string | null; storage_path?: string | null; file_name?: string | null; uploaded_by_name?: string | null; uploaded_at?: string };

/** The file's path in club-assets, if `url` is that club's own upload there; otherwise null. */
export function publicPathOf(url: string | null | undefined, supabaseUrl: string, tid: string): string | null {
  const prefix = `${supabaseUrl}/storage/v1/object/public/${PUBLIC_BUCKET}/`;
  if (!url || !url.startsWith(prefix)) return null;
  const path = url.slice(prefix.length).split('?')[0];
  if (!path.startsWith(`${tid}/`) || path.includes('..')) return null;
  return path;
}

// deno-lint-ignore no-explicit-any
type Sb = any;

/** Moves a public upload to the private folder; returns its private path (or null if it can't). */
export async function moveToPrivate(sb: Sb, supabaseUrl: string, tid: string, row: DocRow): Promise<string | null> {
  if (row.storage_path) return row.storage_path;
  const from = publicPathOf(row.url, supabaseUrl, tid);
  if (!from) return null;
  const { data: file, error } = await sb.storage.from(PUBLIC_BUCKET).download(from);
  if (error || !file) { console.error('[club_docs] download', from, error?.message); return null; }
  const to = `${tid}/bylaws-${row.id}.pdf`;
  const up = await sb.storage.from(PRIVATE_BUCKET).upload(to, file, { contentType: 'application/pdf', upsert: true });
  if (up.error) { console.error('[club_docs] upload', to, up.error.message); return null; }
  const { error: rowErr } = await sb.from('club_documents').update({ storage_path: to, url: null }).eq('id', row.id);
  if (rowErr) { console.error('[club_docs] row', row.id, rowErr.message); return null; }
  await sb.storage.from(PUBLIC_BUCKET).remove([from]);
  return to;
}

/** The rows as readers see them: each with a link that works for an hour, and no storage path. */
export async function withLinks(sb: Sb, supabaseUrl: string, tid: string, rows: DocRow[]) {
  return Promise.all(rows.map(async ({ storage_path, ...r }) => {
    const path = await moveToPrivate(sb, supabaseUrl, tid, { ...r, storage_path });
    if (!path) return r;   // couldn't move it yet: still the old link, and the next read tries again
    const { data } = await sb.storage.from(PRIVATE_BUCKET).createSignedUrl(path, LINK_SECONDS);
    return { ...r, url: data?.signedUrl ?? null };
  }));
}
