// =============================================================================
// drive_family.ts — a folder per family in the club's Drive (PLAN.md BZ4)
// =============================================================================
// Doug 11/6: "make a family folder, then all receipts go in there... signups
// and receiepts in that folder per family", named like "Smith - 123 Oak St"
// (so two Smith families don't mix). Poolside Archive → the club → Families →
// the family: "2027 Membership.pdf" (sync_application.ts) and each card
// receipt, "2027 Receipt 0001.pdf" (receipts.ts). The board emails a copy
// from there when someone asks; nothing is resent from Poolside. Like the
// rest of the Drive code it only adds; deleting in Poolside leaves the files.
// Tested offline by scripts/test_receipts.mjs and test_drive_backup.mjs.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ensureFolder, getAccessToken, loadGrant, updateGrantCache, uploadPdf, type DriveGrant } from './google_drive.ts';
import { receiptFileName, renderReceiptPdf } from './receipts.ts';

type Keys = { googleClientId: string; googleClientSecret: string };
export const FAMILIES_FOLDER = 'Families';
const safe = (s: unknown, max: number) => String(s ?? '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, max);

/** "Smith - 123 Oak St": the family and the first line of its address. */
export function familyFolderName(family: unknown, address: unknown): string {
  const name = safe(family, 60) || 'Family';
  const street = safe(String(address ?? '').split(/[,\n]/)[0], 60);
  return street ? `${name} - ${street}` : name;
}

/** The club's folder, found or made again, its id kept on the grant. */
export async function clubFolder(sb: SupabaseClient, tenantId: string, grant: DriveGrant, token: string, club: string): Promise<string> {
  const rootId = await ensureFolder(token, 'Poolside Archive', 'root', grant.root_folder_id);
  const clubId = await ensureFolder(token, club, rootId, grant.club_folder_id);
  if (rootId !== grant.root_folder_id || clubId !== grant.club_folder_id) {
    await updateGrantCache(sb, tenantId, { root_folder_id: rootId, club_folder_id: clubId });
    Object.assign(grant, { root_folder_id: rootId, club_folder_id: clubId });
  }
  return clubId;
}

/** Families → "Smith - 123 Oak St", found by name or made. */
export async function familyFolder(token: string, clubId: string, family: unknown, address: unknown): Promise<string> {
  const familiesId = await ensureFolder(token, FAMILIES_FOLDER, clubId, null);
  return await ensureFolder(token, familyFolderName(family, address), familiesId, null);
}

/** Every receipt not in Drive yet, into its family's folder (after a payment,
 *  and the nightly run catches any that failed). */
export async function backupReceipts(sb: SupabaseClient, tenantId: string, keys: Keys) {
  const out = { copied: 0, errors: [] as Array<{ family: string; error: string }> };
  const grant = await loadGrant(sb, tenantId);
  if (!grant) return { ...out, skipped: true };
  const { data: todo } = await sb.from('receipts').select('*').eq('tenant_id', tenantId).is('drive_file_id', null)
    .order('number', { ascending: true }).limit(50);
  if (!todo?.length) return out;
  const { data: t } = await sb.from('tenants').select('slug, display_name').eq('id', tenantId).maybeSingle();
  const token = await getAccessToken(grant.refresh_token, keys.googleClientId, keys.googleClientSecret);
  const clubId = await clubFolder(sb, tenantId, grant, token, String(t?.display_name || t?.slug || 'Club'));
  const folders = new Map<string, string>();
  for (const r of todo as Array<Record<string, unknown>>) {
    const name = familyFolderName(r.family_name ?? r.payer_name, r.family_address);
    try {
      if (!folders.has(name)) folders.set(name, await familyFolder(token, clubId, r.family_name ?? r.payer_name, r.family_address));
      const id = await uploadPdf(token, folders.get(name)!, receiptFileName(r), await renderReceiptPdf(r));
      await sb.from('receipts').update({ drive_file_id: id }).eq('id', r.id as string);
      out.copied++;
    } catch (e) {
      out.errors.push({ family: name, error: (e as Error).message });
    }
  }
  return out;
}
