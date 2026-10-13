// =============================================================================
// keep_newest.ts — only the newest photos and announcements are kept (PLAN.md AQ)
// =============================================================================
// Doug, 10/12: announcements "max out at 15"; photos "keep only the newest 30",
// older ones deleted for good, automatically. Full-size photos also fill the
// free plan's storage and can crash a phone showing a long gallery.
//   Announcements: posting one deletes those beyond the newest 15. Pinned
//     posts are never deleted automatically.
//   Photos: adding or approving one keeps the newest 30 approved photos and
//     deletes the rest, files too: older approved ones, rejected ones, and
//     ones the board deleted before deleting was real. Photos still waiting
//     for approval are left alone.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const MAX_POSTS = 15;
export const MAX_PHOTOS = 30;
const BUCKET = 'club-assets';

type Post = { id: string; pinned?: boolean | null; published_at?: string | null; created_at?: string | null };
type Photo = { id: string; status?: string | null; active?: boolean | null; created_at?: string | null; url?: string | null };

const newestFirst = (a?: string | null, b?: string | null) => String(b ?? '').localeCompare(String(a ?? ''));

/** Announcements to delete: beyond the newest `max`, unless pinned. */
export function postsToDrop(posts: Post[], max = MAX_POSTS): string[] {
  return [...posts].sort((a, b) => newestFirst(a.published_at ?? a.created_at, b.published_at ?? b.created_at))
    .filter((p, i) => i >= max && !p.pinned).map(p => p.id);
}

/** Photos to delete: everything but the newest `max` approved, shown ones, and those waiting for approval. */
export function photosToDrop(photos: Photo[], max = MAX_PHOTOS): string[] {
  const keep = new Set([...photos].filter(p => p.status === 'approved' && p.active !== false)
    .sort((a, b) => newestFirst(a.created_at, b.created_at)).slice(0, max).map(p => p.id));
  return photos.filter(p => !keep.has(p.id) && p.status !== 'pending').map(p => p.id);
}

/** The file behind a photo's address, only if it's in the club's own bucket. */
export function storagePathOf(url: string | null | undefined): string | null {
  const m = String(url ?? '').match(new RegExp(`/storage/v1/object/public/${BUCKET}/(.+?)(?:\\?.*)?$`));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/** Delete photos and their files (a file another photo still uses is kept). */
export async function deletePhotos(sb: SupabaseClient, tenantId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const { data: rows } = await sb.from('photos').select('id, url').eq('tenant_id', tenantId).in('id', ids);
  const gone = (rows ?? []) as Photo[];
  if (!gone.length) return 0;
  const { error } = await sb.from('photos').delete().eq('tenant_id', tenantId).in('id', gone.map(p => p.id));
  if (error) throw new Error(error.message);
  const urls = [...new Set(gone.map(p => p.url).filter(Boolean))] as string[];
  const { data: still } = urls.length ? await sb.from('photos').select('url').in('url', urls) : { data: [] };
  const inUse = new Set(((still ?? []) as Photo[]).map(p => p.url));
  const paths = urls.filter(u => !inUse.has(u)).map(storagePathOf).filter(Boolean) as string[];
  if (paths.length) await sb.storage.from(BUCKET).remove(paths);
  return gone.length;
}

export async function keepNewestPhotos(sb: SupabaseClient, tenantId: string, actorId: string | null): Promise<number> {
  const { data } = await sb.from('photos').select('id, status, active, created_at').eq('tenant_id', tenantId).limit(2000);
  const drop = photosToDrop((data ?? []) as Photo[]);
  const n = await deletePhotos(sb, tenantId, drop);
  if (n) await sb.from('audit_log').insert({ tenant_id: tenantId, kind: 'photo.trimmed', entity_type: 'photo', entity_id: tenantId,
    summary: `Kept the newest ${MAX_PHOTOS} photos; deleted ${n} older`, actor_id: actorId, actor_kind: 'tenant_admin' });
  return n;
}

export async function keepNewestPosts(sb: SupabaseClient, tenantId: string, actorId: string | null): Promise<number> {
  const { data } = await sb.from('posts').select('id, title, pinned, published_at, created_at').eq('tenant_id', tenantId).limit(2000);
  const drop = postsToDrop((data ?? []) as Post[]);
  if (!drop.length) return 0;
  const { error } = await sb.from('posts').delete().eq('tenant_id', tenantId).in('id', drop);
  if (error) throw new Error(error.message);
  await sb.from('audit_log').insert({ tenant_id: tenantId, kind: 'post.trimmed', entity_type: 'post', entity_id: tenantId,
    summary: `Kept the newest ${MAX_POSTS} announcements; deleted ${drop.length} older`, actor_id: actorId, actor_kind: 'tenant_admin' });
  return drop.length;
}
