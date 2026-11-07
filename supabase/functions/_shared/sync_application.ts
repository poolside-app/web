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
  updateRowCellByAppId, readHeaders, SHEET_HEADERS, type DriveGrant,
} from './google_drive.ts';
import { renderApplicationPdf, type ApplicationForPdf, type PolicyForPdf } from './application_pdf.ts';
import { fmtPoolStamp, tenantTimeZone, wallParts, zoneOrDefault } from './pool_time.ts';
import { driveSeason, rosterRecord, rowByHeaders } from './drive_row.ts';
import { familyFolder } from './drive_family.ts';

export type SyncResult =
  | { ok: true; pdf_id: string; spreadsheet_id: string; tab_name: string; row_index: number; skipped?: never }
  | { ok: true; skipped: true; reason: string }
  | { ok: false; error: string };

// Build everything needed to render the legal-evidence PDF for an
// application. Exposed so callers (submit handler, retry queue) can render
// the PDF once and reuse the bytes (e.g. attach to the confirmation email
// AND upload to Drive without re-rendering).
export async function loadApplicationForPdf(
  sb: SupabaseClient,
  tenantId: string,
  applicationId: string,
): Promise<ApplicationForPdf | null> {
  const [tenantRes, appRes] = await Promise.all([
    sb.from('tenants').select('id, slug, display_name, timezone').eq('id', tenantId).maybeSingle(),
    sb.from('applications').select('*').eq('id', applicationId).eq('tenant_id', tenantId).maybeSingle(),
  ]);
  if (!tenantRes.data || !appRes.data) return null;
  const tenant = tenantRes.data as { id: string; slug: string; display_name: string; timezone?: string };
  const app    = appRes.data    as Record<string, unknown>;

  const { data: policies } = await sb.from('policies')
    .select('slug, title, body, sort_order')
    .eq('tenant_id', tenantId)
    .order('sort_order', { ascending: true });

  const policyTitles: Record<string, string> = {};
  const waivers = (app.waivers_accepted as Record<string, boolean> | null) ?? {};
  const acceptedAt = app.accepted_at
    ? fmtPoolStamp(app.accepted_at as string, zoneOrDefault(tenant.timezone))
    : null;
  const policiesFull: PolicyForPdf[] = (policies ?? []).map(p => {
    policyTitles[p.slug as string] = p.title as string;
    return {
      slug: p.slug as string,
      title: p.title as string,
      body: (p.body as string) ?? '',
      sort_order: (p.sort_order as number) ?? 0,
      accepted: !!waivers[p.slug as string],
      accepted_at: waivers[p.slug as string] ? acceptedAt : null,
    };
  });

  let tierLabel: string | null = null;
  if (app.tier_slug) {
    const { data: settings } = await sb.from('settings')
      .select('value').eq('tenant_id', tenantId).maybeSingle();
    const tiers = (settings?.value as { membership_tiers?: Array<{ slug: string; label?: string }> } | undefined)?.membership_tiers ?? [];
    const t = tiers.find(x => x.slug === (app.tier_slug as string));
    if (t) tierLabel = t.label ?? null;
  }

  const submittedAt = new Date(app.created_at as string);
  return {
    id: app.id as string,
    tenant_display_name: tenant.display_name,
    // Pool time, with its zone named ("Sep 23, 2026, 7:49:22 PM PDT") so it stays unambiguous.
    submitted_at: fmtPoolStamp(submittedAt, zoneOrDefault(tenant.timezone)),
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
    waivers_accepted:  waivers,
    policies_titles:   policyTitles,
    policies:          policiesFull,
    signature_primary: (app.signature_primary as string | null) ?? null,
    signature_guardian:(app.signature_guardian as string | null) ?? null,
    is_renewal:        app.is_renewal === true,
    membership_year:   (app.membership_year as number | null) ?? null,
    plan_agreement:    planAgreementForPdf(app.plan_agreement, tenant.timezone),
  };
}

// The payment plan agreement a plan family signed at checkout (PLAN.md CL2),
// with its time in pool time.
function planAgreementForPdf(raw: unknown, tz?: string): ApplicationForPdf['plan_agreement'] {
  const a = raw as { lines?: unknown; authorization?: unknown; signature?: unknown; signer?: unknown; signed_at?: unknown } | null;
  if (!a || !Array.isArray(a.lines)) return null;
  return {
    lines: a.lines.map(String),
    authorization: String(a.authorization ?? ''),
    signature: typeof a.signature === 'string' ? a.signature : null,
    signer: typeof a.signer === 'string' ? a.signer : null,
    signed_at: a.signed_at ? fmtPoolStamp(new Date(String(a.signed_at)), zoneOrDefault(tz)) : null,
  };
}

// The club's "Poolside Archive" folder, its own folder and the roster sheet,
// found or made again (also used for the Parties tab, PLAN.md BP2).
export async function ensureRoster(
  accessToken: string,
  tenant: { slug: string; display_name: string },
  grant: Pick<DriveGrant, 'root_folder_id' | 'club_folder_id' | 'spreadsheet_id'>,
): Promise<{ rootId: string; clubId: string; spreadsheetId: string }> {
  const rootId = await ensureFolder(accessToken, 'Poolside Archive', 'root', grant.root_folder_id);
  const clubId = await ensureFolder(accessToken, tenant.display_name || tenant.slug, rootId, grant.club_folder_id);
  const spreadsheetTitle = `${tenant.display_name || tenant.slug} — Membership Roster`;
  const spreadsheetId = await ensureSpreadsheet(accessToken, spreadsheetTitle, clubId, grant.spreadsheet_id);
  return { rootId, clubId, spreadsheetId };
}

export async function syncApplicationToDrive(
  sb: SupabaseClient,
  args: {
    tenantId: string;
    applicationId: string;
    googleClientId: string;
    googleClientSecret: string;
    // Optional: pre-rendered PDF + data, so submit-time can attach to email
    // AND sync without rendering twice. If omitted, sync renders itself.
    prebuilt?: { pdfData: ApplicationForPdf; pdfBytes: Uint8Array };
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

  // 3) Load tenant + app for row-append fields (always need raw app columns).
  const [tenantRes, appRes] = await Promise.all([
    sb.from('tenants').select('id, slug, display_name, timezone').eq('id', args.tenantId).maybeSingle(),
    sb.from('applications').select('*').eq('id', args.applicationId).eq('tenant_id', args.tenantId).maybeSingle(),
  ]);
  if (!tenantRes.data) return { ok: false, error: 'tenant not found' };
  if (!appRes.data)    return { ok: false, error: 'application not found' };
  const tenant = tenantRes.data as { id: string; slug: string; display_name: string; timezone?: string };
  const app    = appRes.data    as Record<string, unknown>;

  // 4) PDF data + bytes — reuse prebuilt if provided, otherwise build now.
  // The board reads the Drive sheet in pool time, so it's written in pool time.
  const tz = zoneOrDefault(tenant.timezone);
  // Filed by the season it's for (PLAN.md BO4): a November signup for 2027 goes in 2027.
  const year = driveSeason(app, tz);

  let pdfData: ApplicationForPdf;
  let pdfBytes: Uint8Array;
  if (args.prebuilt) {
    pdfData = args.prebuilt.pdfData;
    pdfBytes = args.prebuilt.pdfBytes;
  } else {
    const data = await loadApplicationForPdf(sb, args.tenantId, args.applicationId);
    if (!data) return { ok: false, error: 'failed to load application for pdf' };
    pdfData = data;
    pdfBytes = await renderApplicationPdf(pdfData);
  }
  const tierLabel = pdfData.tier_label ?? null;

  // 5) Get access token, ensure folders + spreadsheet + year tab.
  const accessToken = await getAccessToken(grant.refresh_token, args.googleClientId, args.googleClientSecret);

  const { rootId, clubId, spreadsheetId } = await ensureRoster(accessToken, tenant, grant);

  // The family's own folder, "Smith - 123 Oak St", under Families (PLAN.md
  // BZ4, Doug 11/6: "signups and receiepts in that folder per family").
  const familyId = await familyFolder(accessToken, clubId, app.family_name, app.address);

  // A new sheet (the old one was trashed) has none of the old sheet's tabs (PLAN.md BO5).
  const sameSheet = spreadsheetId === grant.spreadsheet_id;
  const cachedYearTab = sameSheet ? ((grant.year_tab_ids ?? {})[year] ?? null) : null;
  const yearTabId = await ensureYearTab(accessToken, spreadsheetId, year, cachedYearTab);

  // 6) Upload PDF first (so the link can be embedded in the sheet row).
  const pdfId = await uploadPdf(accessToken, familyId, `${year} Membership.pdf`, pdfBytes);

  // 7) Append its row to the season tab: the same row the nightly run writes (drive_row.ts rosterRecord), by
  // column name against the tab's own header row.
  const fobs = app.household_id ? ((await loadFobs(sb, args.tenantId)).get(app.household_id as string) ?? { active: [], waiting: 0 }) : { active: [], waiting: 0 };
  const record = rosterRecord(app, { tz, tierLabel, pdfId, fobs });
  const headers = await readHeaders(accessToken, spreadsheetId, year);
  const rowValues = rowByHeaders(headers.length ? headers : SHEET_HEADERS, record) as (string | number | null)[];
  const rowIndex = await appendRow(accessToken, spreadsheetId, year, rowValues);

  // 8) Persist updated cache + sync log.
  const newYearTabIds    = { ...(sameSheet ? (grant.year_tab_ids ?? {}) : {}), [year]: yearTabId };
  await updateGrantCache(sb, args.tenantId, {
    root_folder_id: rootId,
    club_folder_id: clubId,
    spreadsheet_id: spreadsheetId,
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

// Mark an application's row in Drive as verified. Best-effort — never throws
// or blocks the caller. Skips silently if Drive isn't connected, the row
// hasn't been synced yet (rare race), or the cell already has a value
// (write-once: a manual note or prior verification stays put).
//
// `method` is one of 'stripe' | 'venmo' | 'paypal' | 'manual' — drives the
// label (Stripe → "Stripe ✓ May 1", everything else → "Manual ✓ May 1").
export async function markVerifiedInDrive(
  sb: SupabaseClient,
  args: {
    tenantId: string;
    applicationId: string;
    method: string;
    googleClientId: string;
    googleClientSecret: string;
  },
): Promise<void> {
  try {
    const { data: log } = await sb.from('drive_sync_log')
      .select('spreadsheet_id, tab_name')
      .eq('tenant_id', args.tenantId).eq('application_id', args.applicationId)
      .maybeSingle();
    if (!log?.spreadsheet_id || !log?.tab_name) return;  // not synced yet — skip silently

    const grant = await loadGrant(sb, args.tenantId);
    if (!grant) return;

    const accessToken = await getAccessToken(grant.refresh_token, args.googleClientId, args.googleClientSecret);
    const dShort = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: await tenantTimeZone(sb, args.tenantId) });
    const verifiedString = args.method === 'stripe'
      ? `Stripe ✓ ${dShort}`
      : `Manual ✓ ${dShort}`;

    await updateRowCellByAppId(
      accessToken,
      log.spreadsheet_id as string,
      log.tab_name as string,
      args.applicationId,
      'Verified',
      verifiedString,
    );
  } catch (e) {
    // Best-effort: log but never bubble. App's verification still succeeded.
    console.error('markVerifiedInDrive failed (non-fatal):', (e as Error).message);
  }
}

/** Each level's name, by slug. */
export async function tierLabels(sb: SupabaseClient, tenantId: string): Promise<Record<string, string>> {
  const { data } = await sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle();
  const tiers = (data?.value as { membership_tiers?: Array<{ slug: string; label?: string }> } | undefined)?.membership_tiers ?? [];
  return Object.fromEntries(tiers.map(t => [t.slug, t.label ?? t.slug]));
}

/** Each family's working fob numbers (oldest first) and how many wait to be issued (PLAN.md BR4). */
export async function loadFobs(sb: SupabaseClient, tenantId: string): Promise<Map<string, { active: string[]; waiting: number }>> {
  const { data } = await sb.from('keyfobs').select('household_id, card_number, status, issued_at')
    .eq('tenant_id', tenantId).in('status', ['active', 'requested']).order('issued_at', { ascending: true });
  const out = new Map<string, { active: string[]; waiting: number }>();
  for (const f of (data ?? []) as Array<{ household_id: string; card_number: number | null; status: string }>) {
    if (!out.has(f.household_id)) out.set(f.household_id, { active: [], waiting: 0 });
    const e = out.get(f.household_id)!;
    if (f.status === 'active' && f.card_number != null) e.active.push(String(f.card_number));
    else if (f.status === 'requested') e.waiting++;
  }
  return out;
}

// Back up one application now, or queue it for a retry. Never throws: the
// caller's own step (a signed renewal, PLAN.md BO6) has already succeeded.
export async function backupToDrive(sb: SupabaseClient, tenantId: string, applicationId: string): Promise<void> {
  const env = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env;
  const googleClientId = env?.get('GOOGLE_CLIENT_ID'), googleClientSecret = env?.get('GOOGLE_CLIENT_SECRET');
  if (!googleClientId || !googleClientSecret) return;
  try {
    const r = await syncApplicationToDrive(sb, { tenantId, applicationId, googleClientId, googleClientSecret });
    if (!r.ok) await enqueueDriveSync(sb, tenantId, applicationId, r.error);
  } catch (e) {
    try { await enqueueDriveSync(sb, tenantId, applicationId, (e as Error).message); } catch { /* best-effort */ }
  }
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
