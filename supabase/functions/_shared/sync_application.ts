// =============================================================================
// sync_application.ts — orchestrator: load application → render PDF → upload
// =============================================================================
// Used by both google_drive_sync (admin "test sync" or queue drain) and
// applications.submit (inline sync at submit time).
//
// One-way append-only. Every step is idempotent: safe to call twice for the
// same application_id and it will skip if drive_sync_log shows it's done.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  ensureFolder, ensureSpreadsheet, ensureYearTab, appendRow, uploadPdf,
  getAccessToken, loadGrant, updateGrantCache, driveFileLink,
} from './google_drive.ts';
import { renderApplicationPdf, type ApplicationForPdf } from './application_pdf.ts';

export type SyncResult =
  | { ok: true; pdf_id: string; spreadsheet_id: string; tab_name: string; row_index: number; skipped?: never }
  | { ok: true; skipped: true; reason: string }
  | { ok: false; error: string };

export async function syncApplicationToDrive(
  sb: SupabaseClient,
  args: {
    tenantId: string;
    applicationId: string;
    googleClientId: string;
    googleClientSecret: string;
  },
): Promise<SyncResult> {
  // 1) Idempotency check — already synced? bail.
  const { data: existing } = await sb.from('drive_sync_log')
    .select('id, drive_file_id, spreadsheet_id, tab_name, row_index')
    .eq('tenant_id', args.tenantId).eq('application_id', args.applicationId)
    .maybeSingle();
  if (existing) {
    return { ok: true, skipped: true, reason: 'already synced' };
  }

  // 2) Load grant. Drive not connected → not an error, just a no-op.
  const grant = await loadGrant(sb, args.tenantId);
  if (!grant) return { ok: true, skipped: true, reason: 'drive not connected' };

  // 3) Load tenant + application + policies.
  const [tenantRes, appRes] = await Promise.all([
    sb.from('tenants').select('id, slug, display_name').eq('id', args.tenantId).maybeSingle(),
    sb.from('applications').select('*').eq('id', args.applicationId).eq('tenant_id', args.tenantId).maybeSingle(),
  ]);
  if (!tenantRes.data) return { ok: false, error: 'tenant not found' };
  if (!appRes.data)    return { ok: false, error: 'application not found' };
  const tenant = tenantRes.data as { id: string; slug: string; display_name: string };
  const app    = appRes.data    as Record<string, unknown>;

  const { data: policies } = await sb.from('policies')
    .select('slug, title').eq('tenant_id', args.tenantId);
  const policyTitles: Record<string, string> = {};
  (policies ?? []).forEach(p => { policyTitles[p.slug as string] = p.title as string; });

  let tierLabel: string | null = null;
  if (app.tier_slug) {
    const { data: settings } = await sb.from('settings')
      .select('value').eq('tenant_id', args.tenantId).maybeSingle();
    const tiers = (settings?.value as { membership_tiers?: Array<{ slug: string; label?: string }> } | undefined)?.membership_tiers ?? [];
    const t = tiers.find(x => x.slug === app.tier_slug);
    if (t) tierLabel = t.label ?? null;
  }

  // 4) Render PDF.
  const submittedAt = new Date(app.created_at as string);
  const year = String(submittedAt.getUTCFullYear());

  const pdfData: ApplicationForPdf = {
    id: app.id as string,
    tenant_display_name: tenant.display_name,
    submitted_at: submittedAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    family_name:       (app.family_name       as string) ?? '',
    primary_name:      (app.primary_name      as string | null) ?? null,
    primary_email:     (app.primary_email     as string | null) ?? null,
    primary_phone:     (app.primary_phone     as string | null) ?? null,
    address:           (app.address           as string | null) ?? null,
    city:              (app.city              as string | null) ?? null,
    zip:               (app.zip               as string | null) ?? null,
    emergency_contact: (app.emergency_contact as string | null) ?? null,
    num_adults:        (app.num_adults        as number | null) ?? null,
    num_kids:          (app.num_kids          as number | null) ?? null,
    tier_slug:         (app.tier_slug         as string | null) ?? null,
    tier_label:        tierLabel,
    payment_method:    (app.payment_method    as string | null) ?? null,
    adults_json:       (app.adults_json       as Array<Record<string, unknown>> | null) as unknown as ApplicationForPdf['adults_json'] ?? [],
    children_json:     (app.children_json     as Array<Record<string, unknown>> | null) as unknown as ApplicationForPdf['children_json'] ?? [],
    waivers_accepted:  (app.waivers_accepted  as Record<string, boolean> | null) ?? {},
    policies_titles:   policyTitles,
    signature_primary: (app.signature_primary as string | null) ?? null,
    signature_guardian:(app.signature_guardian as string | null) ?? null,
  };

  const pdfBytes = await renderApplicationPdf(pdfData);

  // 5) Get access token, ensure folders + spreadsheet + year tab.
  const accessToken = await getAccessToken(grant.refresh_token, args.googleClientId, args.googleClientSecret);

  const rootId = await ensureFolder(accessToken, 'Poolside Archive', 'root', grant.root_folder_id);
  const clubId = await ensureFolder(accessToken, tenant.display_name || tenant.slug, rootId, grant.club_folder_id);
  const spreadsheetTitle = `${tenant.display_name || tenant.slug} — Membership Roster`;
  const spreadsheetId = await ensureSpreadsheet(accessToken, spreadsheetTitle, clubId, grant.spreadsheet_id);

  const yearFolderName = `${year} Sign-ups`;
  const cachedYearFolder = (grant.year_folder_ids ?? {})[year] ?? null;
  const yearFolderId = await ensureFolder(accessToken, yearFolderName, clubId, cachedYearFolder);

  const cachedYearTab = (grant.year_tab_ids ?? {})[year] ?? null;
  const yearTabId = await ensureYearTab(accessToken, spreadsheetId, year, cachedYearTab);

  // 6) Upload PDF first (so the link can be embedded in the sheet row).
  const safeFamily = (app.family_name as string ?? 'Family').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
  const dateStr = submittedAt.toISOString().slice(0, 10);
  const pdfFilename = `${safeFamily}-${dateStr}-${(app.id as string).slice(0, 8)}.pdf`;
  const pdfId = await uploadPdf(accessToken, yearFolderId, pdfFilename, pdfBytes);

  // 7) Append row to year tab. Order MUST match SHEET_COLUMNS in google_drive.ts.
  // Date as Sheets serial via DATE formula gives clean numberFormat rendering.
  const dateSerial = `=DATE(${submittedAt.getUTCFullYear()},${submittedAt.getUTCMonth()+1},${submittedAt.getUTCDate()})+TIME(${submittedAt.getUTCHours()},${submittedAt.getUTCMinutes()},${submittedAt.getUTCSeconds()})`;
  const waiversAccepted = (app.waivers_accepted as Record<string, boolean> | null) ?? {};
  const accCount = Object.values(waiversAccepted).filter(Boolean).length;
  const totCount = Object.keys(waiversAccepted).length;
  const policiesCell = totCount > 0 ? `${accCount}/${totCount} ✓` : '—';
  const pdfHyperlink = `=HYPERLINK("${driveFileLink(pdfId)}","📄 Open")`;

  const rowValues = [
    dateSerial,                                              // Submitted (DATE+TIME formula)
    (app.family_name       as string) ?? '',                 // Family
    (app.primary_name      as string | null) ?? '',          // Primary Contact
    (app.primary_email     as string | null) ?? '',          // Email
    (app.primary_phone     as string | null) ?? '',          // Phone
    tierLabel || (app.tier_slug as string | null) || '',     // Tier
    (app.num_adults        as number | null) ?? 0,           // Adults
    (app.num_kids          as number | null) ?? 0,           // Kids
    policiesCell,                                            // Policies (e.g. "3/3 ✓")
    (app.address           as string | null) ?? '',          // Address
    (app.city              as string | null) ?? '',          // City
    (app.zip               as string | null) ?? '',          // Zip
    (app.emergency_contact as string | null) ?? '',          // Emergency Contact
    (app.payment_method    as string | null) ?? '',          // Payment
    pdfHyperlink,                                            // Application PDF (=HYPERLINK)
    app.id as string,                                        // App ID (rightmost, narrow)
  ];
  const rowIndex = await appendRow(accessToken, spreadsheetId, year, rowValues);

  // 8) Persist updated cache + sync log.
  const newYearFolderIds = { ...(grant.year_folder_ids ?? {}), [year]: yearFolderId };
  const newYearTabIds    = { ...(grant.year_tab_ids ?? {}),    [year]: yearTabId };
  await updateGrantCache(sb, args.tenantId, {
    root_folder_id: rootId,
    club_folder_id: clubId,
    spreadsheet_id: spreadsheetId,
    year_folder_ids: newYearFolderIds,
    year_tab_ids: newYearTabIds,
  });
  await sb.from('drive_sync_log').insert({
    tenant_id: args.tenantId,
    application_id: args.applicationId,
    drive_file_id: pdfId,
    spreadsheet_id: spreadsheetId,
    tab_name: year,
    row_index: rowIndex,
  });
  await sb.from('google_drive_grants').update({
    last_sync_at: new Date().toISOString(),
    last_error: null,
  }).eq('tenant_id', args.tenantId);
  // If a queue row existed, mark it done (idempotent — also handles retry case).
  await sb.from('drive_sync_queue')
    .update({ status: 'done' })
    .eq('tenant_id', args.tenantId)
    .eq('application_id', args.applicationId);

  return { ok: true, pdf_id: pdfId, spreadsheet_id: spreadsheetId, tab_name: year, row_index: rowIndex };
}

// Used at submit-time when sync fails: enqueue for later retry without
// blocking the user-facing response.
export async function enqueueDriveSync(
  sb: SupabaseClient,
  tenantId: string,
  applicationId: string,
  errorMsg: string,
): Promise<void> {
  await sb.from('drive_sync_queue').upsert({
    tenant_id: tenantId,
    application_id: applicationId,
    status: 'pending',
    last_error: errorMsg.slice(0, 500),
    next_retry_at: new Date(Date.now() + 60_000).toISOString(),
  }, { onConflict: 'tenant_id,application_id' });
  await sb.from('google_drive_grants')
    .update({ last_error: errorMsg.slice(0, 500) })
    .eq('tenant_id', tenantId);
}
