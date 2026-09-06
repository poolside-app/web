// =============================================================================
// households_import — CSV import for households + primary contact members
// =============================================================================
// The "every club has a different spreadsheet" problem is solved by NEVER
// assuming column meaning. The admin uploads their file as-is; we parse it,
// suggest a mapping using header-name heuristics, then let them override any
// wrong guesses through a UI. They confirm → we preview validation results
// → they commit → we bulk-insert.
//
// Actions:
//   { action: 'parse_csv',    csv_text }       -> headers + sample + suggested_mapping
//   { action: 'preview',      rows, mapping }  -> validation summary + samples
//   { action: 'commit',       rows, mapping }  -> bulk insert under run_id
// =============================================================================

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function j(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

// Target fields the admin maps INTO. UI shows these in a dropdown for each
// of their columns. '[skip]' = ignore this column entirely.
const TARGET_FIELDS = [
  { key: '__skip__',         label: '— skip —',                     group: 'meta' },
  { key: 'family_name',      label: 'Family / household name',      group: 'household', required: true },
  { key: 'tier',             label: 'Membership tier (name)',       group: 'household' },
  { key: 'address',          label: 'Address (street)',             group: 'household' },
  { key: 'city',             label: 'City',                         group: 'household' },
  { key: 'zip',              label: 'ZIP / postal code',            group: 'household' },
  { key: 'fob_number',       label: 'Gate fob number',              group: 'household' },
  { key: 'emergency_contact',label: 'Emergency contact',            group: 'household' },
  { key: 'notes',            label: 'Notes / comments',             group: 'household' },
  { key: 'dues_paid',        label: 'Dues paid for year? (Y/N)',    group: 'household' },
  { key: 'primary_name',     label: 'Primary member — full name',   group: 'primary', required: true },
  { key: 'primary_email',    label: 'Primary member — email',       group: 'primary' },
  { key: 'primary_phone',    label: 'Primary member — phone',       group: 'primary' },
  { key: 'secondary_name',   label: 'Second adult — full name',     group: 'secondary' },
  { key: 'secondary_email',  label: 'Second adult — email',         group: 'secondary' },
  { key: 'secondary_phone',  label: 'Second adult — phone',         group: 'secondary' },
];

// Heuristic mapping: regex on the column header → target field. Most clubs'
// spreadsheets follow these patterns; admin overrides anything wrong. Order
// matters — first match wins (so /primary.*name/ catches before /name/).
const HEURISTICS: Array<{ pattern: RegExp; target: string }> = [
  { pattern: /^(family|household|last)\s*name/i,    target: 'family_name' },
  { pattern: /^family$/i,                            target: 'family_name' },
  { pattern: /^(tier|membership|plan|level|category)/i, target: 'tier' },
  { pattern: /^(street|address(?!.*2)|addr)/i,       target: 'address' },
  { pattern: /^city|town/i,                          target: 'city' },
  { pattern: /^(zip|postal)/i,                       target: 'zip' },
  { pattern: /^(fob|key.?fob|gate.?fob|fob\s*#)/i,   target: 'fob_number' },
  { pattern: /^emergency/i,                          target: 'emergency_contact' },
  { pattern: /^(notes?|comment|remark)/i,            target: 'notes' },
  { pattern: /(dues|paid|status).*\b(paid|status|y\/?n)/i, target: 'dues_paid' },
  { pattern: /^(dues|paid)$/i,                       target: 'dues_paid' },
  { pattern: /^(primary|head|main|adult\s*1).*name/i, target: 'primary_name' },
  { pattern: /^(primary|head|main|adult\s*1).*email/i, target: 'primary_email' },
  { pattern: /^(primary|head|main|adult\s*1).*(phone|cell|mobile|tel)/i, target: 'primary_phone' },
  { pattern: /^(secondary|spouse|partner|adult\s*2).*name/i, target: 'secondary_name' },
  { pattern: /^(secondary|spouse|partner|adult\s*2).*email/i, target: 'secondary_email' },
  { pattern: /^(secondary|spouse|partner|adult\s*2).*(phone|cell|mobile|tel)/i, target: 'secondary_phone' },
  // Bare "name" / "email" / "phone" map to primary if nothing primary-specific matched first.
  { pattern: /^name$|^full\s*name$/i,                target: 'primary_name' },
  { pattern: /^email$|^e-?mail$/i,                   target: 'primary_email' },
  { pattern: /^(phone|cell|mobile|tel)/i,            target: 'primary_phone' },
];

function suggestMapping(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const used = new Set<string>();
  for (const h of headers) {
    const trimmed = h.trim();
    let target = '__skip__';
    for (const rule of HEURISTICS) {
      if (rule.pattern.test(trimmed) && !used.has(rule.target)) {
        target = rule.target;
        used.add(rule.target);
        break;
      }
    }
    map[h] = target;
  }
  return map;
}

// Minimal CSV parser — handles quoted fields with embedded commas/newlines/quotes
// (RFC 4180-ish). Returns rows as string[][]. Skips trailing blank lines.
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const t = text.replace(/\r\n?/g, '\n');
  while (i < t.length) {
    const c = t[i];
    if (inQuotes) {
      if (c === '"' && t[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"')                       { inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"')  { inQuotes = true; i++; continue; }
    if (c === ',')  { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

function normalizePhone(s: string): string | null {
  if (!s) return null;
  const digits = s.replace(/[^\d+]/g, '');
  if (digits.startsWith('+') && /^\+\d{8,15}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return '+1' + digits;
  if (/^1\d{10}$/.test(digits)) return '+' + digits;
  return null;
}
function parseBool(s: string): boolean {
  if (!s) return false;
  const v = s.trim().toLowerCase();
  return v === 'y' || v === 'yes' || v === 'true' || v === '1' || v === 'paid';
}
function validEmail(s: string): boolean {
  return !!s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

type RowTransform = {
  index: number;
  family_name: string;
  tier: string;
  address: string | null;
  city: string | null;
  zip: string | null;
  fob_number: string | null;
  emergency_contact: string | null;
  notes: string | null;
  dues_paid: boolean;
  primary_name: string;
  primary_email: string | null;
  primary_phone: string | null;
  secondary_name: string | null;
  secondary_email: string | null;
  secondary_phone: string | null;
  errors: string[];
};

function transformRow(headers: string[], values: string[], mapping: Record<string, string>, index: number, defaultTier: string): RowTransform {
  const getVal = (target: string): string => {
    for (const h of headers) {
      if (mapping[h] === target) {
        const idx = headers.indexOf(h);
        return (values[idx] || '').trim();
      }
    }
    return '';
  };
  const errors: string[] = [];
  const family_name = getVal('family_name');
  if (!family_name) errors.push('Missing family name');
  const primary_name = getVal('primary_name');
  if (!primary_name) errors.push('Missing primary member name');
  const primary_email_raw = getVal('primary_email');
  if (primary_email_raw && !validEmail(primary_email_raw)) errors.push(`Bad primary email: ${primary_email_raw}`);
  const primary_phone_raw = getVal('primary_phone');
  let primary_phone: string | null = null;
  if (primary_phone_raw) {
    primary_phone = normalizePhone(primary_phone_raw);
    if (!primary_phone) errors.push(`Bad primary phone: ${primary_phone_raw}`);
  }
  if (primary_name && !primary_email_raw && !primary_phone) {
    errors.push('Primary member needs either email or phone');
  }
  const secondary_name_raw = getVal('secondary_name');
  const secondary_email_raw = getVal('secondary_email');
  if (secondary_email_raw && !validEmail(secondary_email_raw)) errors.push(`Bad secondary email: ${secondary_email_raw}`);
  const secondary_phone_raw = getVal('secondary_phone');
  let secondary_phone: string | null = null;
  if (secondary_phone_raw) {
    secondary_phone = normalizePhone(secondary_phone_raw);
    if (!secondary_phone) errors.push(`Bad secondary phone: ${secondary_phone_raw}`);
  }
  const tierRaw = getVal('tier');
  return {
    index,
    family_name,
    tier: tierRaw || defaultTier,
    address: getVal('address') || null,
    city: getVal('city') || null,
    zip: getVal('zip') || null,
    fob_number: getVal('fob_number') || null,
    emergency_contact: getVal('emergency_contact') || null,
    notes: getVal('notes') || null,
    dues_paid: parseBool(getVal('dues_paid')),
    primary_name,
    primary_email: primary_email_raw || null,
    primary_phone,
    secondary_name: secondary_name_raw || null,
    secondary_email: secondary_email_raw || null,
    secondary_phone,
    errors,
  };
}

async function verifyTenantAdmin(token: string): Promise<{ sub: string; tid: string } | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as { sub: string; tid: string };
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST')   return j({ ok: false, error: 'POST only' }, 405);

  const authz = req.headers.get('authorization') || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  const payload = await verifyTenantAdmin(token);
  if (!payload) return j({ ok: false, error: 'Auth required' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}
  const action = String(body.action ?? '');

  if (action === 'parse_csv') {
    const csv = String(body.csv_text ?? '');
    if (!csv) return j({ ok: false, error: 'csv_text required' }, 400);
    const rows = parseCSV(csv);
    if (rows.length < 1) return j({ ok: false, error: 'No rows found in file' }, 400);
    const headers = rows[0].map(h => h.trim());
    const dataRows = rows.slice(1).filter(r => r.some(c => c.trim() !== ''));
    return j({
      ok: true,
      headers,
      sample_rows: dataRows.slice(0, 5),
      total_rows: dataRows.length,
      suggested_mapping: suggestMapping(headers),
      target_fields: TARGET_FIELDS,
    });
  }

  const sb: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (action === 'preview' || action === 'commit') {
    const headers = Array.isArray(body.headers) ? (body.headers as string[]) : [];
    const rows    = Array.isArray(body.rows)    ? (body.rows as string[][]) : [];
    const mapping = (body.mapping as Record<string, string>) || {};
    if (!headers.length || !rows.length) return j({ ok: false, error: 'headers + rows required' }, 400);

    // Default tier name: if admin didn't map a tier column, all imports get
    // tagged "Imported" so they can be sorted out after.
    const defaultTier = 'Imported';
    const transformed = rows.map((r, i) => transformRow(headers, r, mapping, i, defaultTier));

    // Within-batch duplicate detection: same primary_email OR primary_phone
    // appearing twice in the same file. Email/phone clashes against EXISTING
    // members are also flagged.
    const emailSeen = new Map<string, number>();
    const phoneSeen = new Map<string, number>();
    transformed.forEach(t => {
      if (t.primary_email) {
        const k = t.primary_email.toLowerCase();
        if (emailSeen.has(k)) t.errors.push(`Duplicate email in file (also row ${(emailSeen.get(k) ?? 0) + 1})`);
        else emailSeen.set(k, t.index);
      }
      if (t.primary_phone) {
        if (phoneSeen.has(t.primary_phone)) t.errors.push(`Duplicate phone in file (also row ${(phoneSeen.get(t.primary_phone) ?? 0) + 1})`);
        else phoneSeen.set(t.primary_phone, t.index);
      }
    });

    // Existing-data clash: query household_members for emails/phones we're
    // about to insert. One indexed query each (small N).
    const emails = [...emailSeen.keys()];
    const phones = [...phoneSeen.keys()];
    if (emails.length > 0) {
      const { data } = await sb.from('household_members')
        .select('email').eq('tenant_id', payload.tid).in('email', emails);
      const existing = new Set((data || []).map((r: { email: string }) => (r.email || '').toLowerCase()));
      transformed.forEach(t => {
        if (t.primary_email && existing.has(t.primary_email.toLowerCase())) {
          t.errors.push(`Email already exists in this club: ${t.primary_email}`);
        }
      });
    }
    if (phones.length > 0) {
      const { data } = await sb.from('household_members')
        .select('phone_e164').eq('tenant_id', payload.tid).in('phone_e164', phones);
      const existing = new Set((data || []).map((r: { phone_e164: string }) => r.phone_e164));
      transformed.forEach(t => {
        if (t.primary_phone && existing.has(t.primary_phone)) {
          t.errors.push(`Phone already exists in this club: ${t.primary_phone}`);
        }
      });
    }

    const valid_rows = transformed.filter(t => t.errors.length === 0);
    const invalid_rows = transformed.filter(t => t.errors.length > 0);

    if (action === 'preview') {
      return j({
        ok: true,
        valid: valid_rows.length,
        invalid: invalid_rows.length,
        total: transformed.length,
        sample_valid: valid_rows.slice(0, 5),
        sample_invalid: invalid_rows.slice(0, 20).map(r => ({
          row: r.index + 1,
          errors: r.errors,
          family_name: r.family_name,
          primary_name: r.primary_name,
          primary_email: r.primary_email,
          primary_phone: r.primary_phone,
        })),
      });
    }

    // === COMMIT path ===
    if (valid_rows.length === 0) return j({ ok: false, error: 'Nothing to import — every row had errors. Fix the file and try again.' }, 400);

    // Import creates PRE-FILLED APPLICATIONS, not active members. The club is
    // migrating its existing roster onto Poolside at a season boundary;
    // everyone then claims their pre-filled application (apply.html?claim=…),
    // confirms their info + family, accepts the legal docs, and pays. The
    // existing approve flow turns each into a real household — which is also
    // where the plan's household cap is enforced. Prefilled applications
    // don't consume household slots, so we don't block on the cap here; we
    // just surface an advisory warning if the import is bigger than the plan
    // can ultimately approve.
    const { getHouseholdCapStatus } = await import('../_shared/plan_caps.ts');
    const { data: tenantRow } = await sb.from('tenants').select('plan').eq('id', payload.tid).maybeSingle();
    const capStatus = await getHouseholdCapStatus(sb, payload.tid, tenantRow?.plan);

    const importRunId = crypto.randomUUID();
    let created = 0;
    const failures: Array<{ row: number; error: string }> = [];
    for (const t of valid_rows) {
      // Fold the primary + optional second adult into adults_json so the
      // member sees their family pre-populated and can add more on the form.
      const adults_json: Array<Record<string, unknown>> = [
        { name: t.primary_name, email: t.primary_email, phone: t.primary_phone, signature_url: null },
      ];
      if (t.secondary_name) {
        adults_json.push({ name: t.secondary_name, email: t.secondary_email, phone: t.secondary_phone, signature_url: null });
      }
      const { error: appErr } = await sb.from('applications').insert({
        tenant_id: payload.tid,
        family_name: t.family_name,
        primary_name: t.primary_name,
        primary_email: t.primary_email,
        primary_phone: t.primary_phone,
        address: t.address,
        city: t.city,
        zip: t.zip,
        tier_slug: t.tier || null,
        prior_fob_number: t.fob_number,
        body: t.notes,
        num_adults: adults_json.length,
        num_kids: 0,
        adults_json,
        children_json: [],
        is_new_member: false,           // existing member being migrated
        status: 'prefilled',
        payment_status: 'unpaid',
        claim_source: 'csv_import',
        import_run_id: importRunId,
      });
      if (appErr) { failures.push({ row: t.index + 1, error: appErr.message }); continue; }
      created++;
    }

    // Advisory cap warning — prefilled apps cost nothing, but the admin can
    // only APPROVE up to the plan limit, so flag an oversized migration.
    const projected = capStatus.count + created;
    const overCap = capStatus.cap !== Infinity && projected > capStatus.cap;
    return j({
      ok: true,
      created,
      failed: failures.length,
      failures,
      skipped_invalid: invalid_rows.length,
      prefilled: true,
      plan_label: capStatus.plan_label,
      cap: capStatus.cap === Infinity ? null : capStatus.cap,
      over_cap: overCap,
      ...(overCap ? {
        cap_warning: `Imported ${created} member${created === 1 ? '' : 's'} as pre-filled applications. Heads up: your ${capStatus.plan_label} plan caps at ${capStatus.cap} active households, so you'll only be able to approve ${capStatus.cap} of them until you upgrade.`,
      } : {}),
    });
  }

  return j({ ok: false, error: `Unknown action: ${action}` }, 400);
});
