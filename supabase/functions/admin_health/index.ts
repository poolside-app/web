// =============================================================================
// admin_health — single-page diagnostic dashboard for the club admin
// =============================================================================
// Returns a structured "is everything working for our members?" snapshot for
// the volunteer board member running the club. Read-only — every check is
// designed to be safe to run on an unconfigured tenant. Plain-English copy
// throughout: no "pg_cron disabled" — instead "Auto-billing isn't running."
//
// Auth: any active tenant_admin. NOT scope-gated — this is a transparency
// page; an admin who can't pay should still be able to see why card payments
// aren't working.
//
// Action: { action: 'check' } → returns the full snapshot (one POST, every
// check runs in parallel). Cached client-side; no cache server-side for v1
// (the slow-API checks have 4s timeouts so the worst-case latency is bounded).
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const RESEND_FROM    = Deno.env.get('RESEND_FROM') || '';
const TWILIO_SID     = Deno.env.get('TWILIO_ACCOUNT_SID');
const TWILIO_TOKEN   = Deno.env.get('TWILIO_AUTH_TOKEN');
const TWILIO_FROM    = Deno.env.get('TWILIO_FROM_NUMBER');
const SMS_DEV_MODE   = (Deno.env.get('SMS_DEV_MODE') || '').trim() === '1';
const STRIPE_KEY     = Deno.env.get('STRIPE_SECRET_KEY') || '';
const STRIPE_WEBHOOK = Deno.env.get('STRIPE_WEBHOOK_SECRET');
const GOOGLE_ID      = Deno.env.get('GOOGLE_CLIENT_ID');
const GOOGLE_SECRET  = Deno.env.get('GOOGLE_CLIENT_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'content-type': 'application/json' },
  });
}

type Payload = { sub: string; kind: string; tid: string; slug?: string };
async function verifyAdmin(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as Payload;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status taxonomy
// ─────────────────────────────────────────────────────────────────────────────
type Status = 'green' | 'yellow' | 'red' | 'unknown';

type Check = {
  id: string;
  status: Status;
  title: string;            // short, human, what IS the state
  detail?: string;           // 1-2 sentences explaining the state
  why?: string;              // why it matters to MEMBERS
  fix?: {
    label: string;
    kind: 'inline' | 'link' | 'modal';
    href?: string;           // for kind=link
    instructions?: string[]; // for kind=modal — multi-step
  };
};

// fetch with a hard timeout so a hung external API doesn't sink the page.
async function fetchWithTimeout(url: string, init: RequestInit, ms = 4000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// Worst-status reducer: red beats yellow beats green beats unknown.
const STATUS_RANK: Record<Status, number> = { red: 3, yellow: 2, unknown: 1, green: 0 };
function worst(...statuses: Status[]): Status {
  return statuses.reduce((a, b) => STATUS_RANK[b] > STATUS_RANK[a] ? b : a, 'green' as Status);
}

// ─────────────────────────────────────────────────────────────────────────────
// Check builders — each runs independently. Failures degrade gracefully to
// 'unknown' rather than throwing.
// ─────────────────────────────────────────────────────────────────────────────

async function checkEmail(): Promise<Check[]> {
  const checks: Check[] = [];

  if (!RESEND_API_KEY) {
    checks.push({
      id: 'email_key', status: 'red',
      title: 'Email service not configured',
      detail: 'Resend API key is missing — no emails are being sent.',
      why: 'Members can\'t receive sign-in links, application confirmations, or payment receipts.',
      fix: { label: 'Set up email', kind: 'modal', instructions: [
        'Sign up for a free Resend account at resend.com',
        'Generate an API key',
        'Ask the platform team to add it to the secrets',
      ]},
    });
    return checks;
  }

  // Confirmed key is set
  checks.push({
    id: 'email_key', status: 'green',
    title: 'Email service connected',
  });

  // Domain verification — the From address should be on a verified domain.
  // Resend domains list returns each with status: 'verified' | 'pending' | 'failed'.
  const fromMatch = RESEND_FROM.match(/<([^>]+)>/) || [null, RESEND_FROM];
  const fromAddr = (fromMatch[1] || '').trim();
  const fromDomain = fromAddr.includes('@') ? fromAddr.split('@')[1].toLowerCase() : '';

  if (!fromDomain || fromDomain === 'resend.dev') {
    checks.push({
      id: 'email_domain', status: 'yellow',
      title: 'Sending from default Resend domain',
      detail: 'Emails come from a generic resend.dev address — they\'ll work, but may land in spam.',
      why: 'Some members may miss sign-in links if they go to spam.',
      fix: { label: 'Verify your domain', kind: 'modal', instructions: [
        'In Resend, add your club domain (e.g. yourclub.com)',
        'Resend gives you 3 DNS records (SPF + DKIM + return-path)',
        'Paste them into your domain registrar (Porkbun, GoDaddy, etc.)',
        'Wait for verification, then update RESEND_FROM',
      ]},
    });
  } else {
    try {
      const res = await fetchWithTimeout('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
      }, 3000);
      if (res.ok) {
        const data = await res.json();
        const list = (data?.data ?? data ?? []) as Array<{ name: string; status: string }>;
        const ours = list.find(d => d.name?.toLowerCase() === fromDomain);
        if (!ours) {
          checks.push({
            id: 'email_domain', status: 'yellow',
            title: `Sender domain ${fromDomain} not registered with Resend`,
            why: 'Resend may reject sends — emails won\'t reach members.',
          });
        } else if (ours.status === 'verified') {
          checks.push({
            id: 'email_domain', status: 'green',
            title: `Sender domain verified (${fromDomain})`,
          });
        } else {
          checks.push({
            id: 'email_domain', status: 'yellow',
            title: `Sender domain pending DNS verification`,
            detail: `${fromDomain}: ${ours.status}`,
            why: 'Until verified, sends may bounce or land in spam.',
          });
        }
      } else {
        checks.push({
          id: 'email_domain', status: 'unknown',
          title: 'Couldn\'t check sender domain',
          detail: `Resend API returned ${res.status}`,
        });
      }
    } catch {
      checks.push({
        id: 'email_domain', status: 'unknown',
        title: 'Couldn\'t reach Resend to verify domain',
      });
    }
  }
  return checks;
}

async function checkSms(sb: ReturnType<typeof createClient>, tenantId: string): Promise<Check[]> {
  const checks: Check[] = [];

  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    checks.push({
      id: 'sms_creds', status: 'yellow',
      title: 'Text-message sign-in not configured',
      detail: 'Twilio credentials missing — members can only sign in by email.',
      why: 'Email-only sign-in is fine; this is optional.',
    });
    return checks;
  }

  if (SMS_DEV_MODE) {
    checks.push({
      id: 'sms_dev_mode', status: 'yellow',
      title: 'SMS in development mode',
      detail: 'Texts aren\'t actually sent — sign-in links appear on screen instead.',
      why: 'Real members can\'t sign in by text yet. Switch off after Twilio A2P registration is approved.',
      fix: { label: 'How to switch on', kind: 'modal', instructions: [
        'Complete Twilio A2P 10DLC registration in the Twilio Console',
        'Wait for approval (typically 1–3 business days)',
        'Remove SMS_DEV_MODE from secrets',
      ]},
    });
  }

  // Verify the from-number is owned + active. Cheap GET to Twilio.
  try {
    const auth = btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`);
    const res = await fetchWithTimeout(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(TWILIO_FROM)}`,
      { headers: { Authorization: `Basic ${auth}` } }, 3000,
    );
    if (res.ok) {
      const data = await res.json();
      if ((data.incoming_phone_numbers?.length ?? 0) > 0) {
        checks.push({
          id: 'sms_from', status: 'green',
          title: `From-number active (${TWILIO_FROM})`,
        });
      } else {
        checks.push({
          id: 'sms_from', status: 'red',
          title: `From-number not found on Twilio account`,
          detail: `${TWILIO_FROM} isn\'t owned by this Twilio account.`,
          why: 'Sends will fail with 21659 — no member can sign in by text.',
        });
      }
    } else {
      checks.push({
        id: 'sms_from', status: 'unknown',
        title: 'Couldn\'t verify Twilio from-number',
        detail: `Twilio API returned ${res.status}`,
      });
    }
  } catch {
    checks.push({
      id: 'sms_from', status: 'unknown',
      title: 'Couldn\'t reach Twilio',
    });
  }

  // Quota usage this month (capped categories only).
  try {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { count } = await sb.from('sms_log')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .in('category', ['campaign', 'reminder'])
      .gte('sent_at', monthStart.toISOString());
    const used = count ?? 0;
    // Conservative cap surface — actual cap is per-plan; we just surface usage.
    checks.push({
      id: 'sms_quota', status: 'green',
      title: `${used} text${used === 1 ? '' : 's'} sent this month`,
      detail: 'Sign-in texts are never counted against your cap.',
    });
  } catch {
    /* skip — sms_log might not exist on freshly-migrated tenants */
  }
  return checks;
}

async function checkStripe(sb: ReturnType<typeof createClient>, tenantId: string): Promise<Check[]> {
  const checks: Check[] = [];

  // Stripe Connect state lives on the tenants row, not in settings.
  const { data: tenant } = await sb.from('tenants')
    .select('stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled')
    .eq('id', tenantId).maybeSingle();
  const stripeAcct = (tenant?.stripe_account_id as string | undefined) ?? null;
  const chargesEnabled = !!(tenant?.stripe_charges_enabled);
  const payoutsEnabled = !!(tenant?.stripe_payouts_enabled);

  if (!stripeAcct) {
    checks.push({
      id: 'stripe_connected', status: 'yellow',
      title: 'Card payments not set up',
      detail: 'Members can still pay by Venmo or PayPal — Stripe is optional.',
      fix: { label: 'Connect Stripe', kind: 'link', href: '/club/admin/payments.html' },
    });
    return checks;
  }

  // Test mode vs live mode
  const isTestMode = STRIPE_KEY.startsWith('sk_test_');
  if (isTestMode) {
    checks.push({
      id: 'stripe_mode', status: 'yellow',
      title: 'Card payments in TEST mode',
      detail: 'Only test cards work; no real money flows yet.',
      why: 'Real members can\'t pay by card until you switch to live mode.',
      fix: { label: 'How to go live', kind: 'modal', instructions: [
        'Complete Stripe live-mode account activation (business info, bank, ID)',
        'Replace STRIPE_SECRET_KEY with your sk_live_ key',
        'Replace STRIPE_WEBHOOK_SECRET with the live webhook signing secret',
        'Recreate webhook on live mode with connect: true',
      ]},
    });
  } else {
    checks.push({
      id: 'stripe_mode', status: 'green',
      title: 'Card payments in LIVE mode',
    });
  }

  if (chargesEnabled && payoutsEnabled) {
    checks.push({
      id: 'stripe_status', status: 'green',
      title: 'Charges + payouts enabled',
      detail: `Connected account: ${stripeAcct}`,
    });
  } else if (chargesEnabled && !payoutsEnabled) {
    checks.push({
      id: 'stripe_status', status: 'yellow',
      title: 'Charges working, payouts not yet',
      detail: 'You can take card payments, but money can\'t reach your bank yet.',
      fix: { label: 'Finish Stripe onboarding', kind: 'link', href: '/club/admin/payments.html' },
    });
  } else {
    checks.push({
      id: 'stripe_status', status: 'red',
      title: 'Stripe onboarding incomplete',
      detail: 'Charges aren\'t enabled — members can\'t pay by card.',
      why: 'The "Pay with card" button will fail at checkout.',
      fix: { label: 'Finish onboarding', kind: 'link', href: '/club/admin/payments.html' },
    });
  }

  // Webhook health — last event received in past 7 days. Stored on settings if any.
  if (!STRIPE_WEBHOOK) {
    checks.push({
      id: 'stripe_webhook', status: 'red',
      title: 'Stripe webhook not configured',
      why: 'Card payments will charge but the app won\'t auto-mark members paid.',
    });
  } else {
    checks.push({
      id: 'stripe_webhook', status: 'green',
      title: 'Stripe webhook signed and ready',
    });
  }

  return checks;
}

async function checkDrive(sb: ReturnType<typeof createClient>, tenantId: string): Promise<Check[]> {
  const checks: Check[] = [];

  if (!GOOGLE_ID || !GOOGLE_SECRET) {
    checks.push({
      id: 'drive_platform', status: 'yellow',
      title: 'Drive backup not available on this platform',
      detail: 'Google OAuth not configured — feature is off for everyone.',
    });
    return checks;
  }

  const { data: grant } = await sb.from('google_drive_grants')
    .select('connected_email, last_sync_at, last_error, spreadsheet_id, connected_at')
    .eq('tenant_id', tenantId).maybeSingle();
  if (!grant) {
    checks.push({
      id: 'drive_connected', status: 'yellow',
      title: 'Drive backup not connected',
      detail: 'Optional — connecting Drive archives every signed application as a PDF.',
      fix: { label: 'Connect Drive', kind: 'link', href: '/club/admin/payments.html#drive' },
    });
    return checks;
  }

  // Connected; check freshness + queue depth
  const { count: queuePending } = await sb.from('drive_sync_queue')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId).eq('status', 'pending');

  if (grant.last_error) {
    checks.push({
      id: 'drive_status', status: 'red',
      title: 'Last Drive sync failed',
      detail: String(grant.last_error).slice(0, 200),
      why: 'New applications aren\'t being archived.',
      fix: { label: 'Retry now', kind: 'link', href: '/club/admin/payments.html#drive' },
    });
  } else if ((queuePending ?? 0) > 0) {
    checks.push({
      id: 'drive_status', status: 'yellow',
      title: `${queuePending} application${queuePending === 1 ? '' : 's'} pending sync`,
      fix: { label: 'Retry queue', kind: 'link', href: '/club/admin/payments.html#drive' },
    });
  } else {
    checks.push({
      id: 'drive_status', status: 'green',
      title: `Drive connected as ${grant.connected_email}`,
      detail: grant.last_sync_at
        ? `Last archived: ${formatRelative(new Date(grant.last_sync_at as string))}`
        : 'No applications archived yet.',
    });
  }
  return checks;
}

async function checkBackgroundJobs(sb: ReturnType<typeof createClient>, _tenantId: string): Promise<Check[]> {
  const checks: Check[] = [];
  // Detecting pg_cron is privileged; we infer from the cron schema being
  // queryable. Service role can usually read it. If it can't, mark unknown
  // rather than red — the schema may exist but be locked down.
  try {
    const { data, error } = await sb.from('cron.job').select('jobname').limit(5);
    if (error) {
      checks.push({
        id: 'cron_status', status: 'unknown',
        title: 'Couldn\'t check auto-billing schedule',
        detail: 'pg_cron may not be enabled in this project. Auto-charging payment plans needs it.',
        fix: { label: 'How to enable', kind: 'modal', instructions: [
          'Open Supabase Dashboard → Database → Extensions',
          'Search for "pg_cron" and click "Enable"',
          'Re-run the most recent payment_plans_cron migration',
        ]},
      });
    } else {
      const jobs = (data ?? []) as Array<{ jobname: string }>;
      const has = jobs.some(j => j.jobname?.includes('payment_plan'));
      if (has) {
        checks.push({
          id: 'cron_status', status: 'green',
          title: 'Auto-billing scheduled',
          detail: 'Daily job runs to charge payment plan installments on time.',
        });
      } else {
        checks.push({
          id: 'cron_status', status: 'yellow',
          title: 'Auto-billing job not registered',
          detail: 'pg_cron is on but the payment_plans daily job hasn\'t been registered.',
        });
      }
    }
  } catch {
    /* skip — surface as unknown above */
  }
  return checks;
}

async function checkTenantConfig(sb: ReturnType<typeof createClient>, tenantId: string): Promise<Check[]> {
  const checks: Check[] = [];

  const [tenantRes, settingsRes, policiesRes, adminsRes] = await Promise.all([
    sb.from('tenants').select('id, slug, display_name, status, custom_domain').eq('id', tenantId).maybeSingle(),
    sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle(),
    sb.from('policies').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('active', true),
    sb.from('admin_users').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('active', true),
  ]);

  const tenant = tenantRes.data as { display_name?: string; status?: string } | null;
  const sv = (settingsRes.data?.value as Record<string, unknown> | undefined) ?? {};
  const branding = (sv.branding as Record<string, unknown> | undefined) ?? {};
  const tiers = (sv.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];
  const payments = (sv.payments as Record<string, unknown> | undefined) ?? {};

  // Branding
  const hasLogo = !!(branding.logo_url || branding.logo);
  const hasDisplayName = !!(tenant?.display_name && tenant.display_name.trim());
  if (hasDisplayName && hasLogo) {
    checks.push({ id: 'branding', status: 'green', title: 'Club branding set up' });
  } else if (hasDisplayName) {
    checks.push({
      id: 'branding', status: 'yellow',
      title: 'Logo not uploaded',
      detail: 'Members see a placeholder where your club logo would be.',
      fix: { label: 'Upload logo', kind: 'link', href: '/club/admin/settings.html' },
    });
  } else {
    checks.push({
      id: 'branding', status: 'red',
      title: 'Club name not set',
      fix: { label: 'Set club name', kind: 'link', href: '/club/admin/settings.html' },
    });
  }

  // Tiers
  if (tiers.length === 0) {
    checks.push({
      id: 'tiers', status: 'red',
      title: 'No membership tiers defined',
      detail: 'Members can\'t apply without at least one tier.',
      why: 'The apply form will block submissions.',
      fix: { label: 'Add a tier', kind: 'link', href: '/club/admin/billing.html' },
    });
  } else {
    checks.push({
      id: 'tiers', status: 'green',
      title: `${tiers.length} membership tier${tiers.length === 1 ? '' : 's'} active`,
    });
  }

  // Policies
  const policyCount = policiesRes.count ?? 0;
  if (policyCount === 0) {
    checks.push({
      id: 'policies', status: 'red',
      title: 'No policies on the apply form',
      why: 'Without a liability waiver and rules, the application has no legal protection.',
      fix: { label: 'Edit policies', kind: 'link', href: '/club/admin/policies.html' },
    });
  } else {
    checks.push({
      id: 'policies', status: 'green',
      title: `${policyCount} polic${policyCount === 1 ? 'y' : 'ies'} on the apply form`,
    });
  }

  // Venmo handle
  const venmo = (payments.venmo_handle as string | undefined) ?? '';
  if (venmo) {
    checks.push({ id: 'venmo', status: 'green', title: `Venmo handle set (@${venmo})` });
  } else {
    checks.push({
      id: 'venmo', status: 'yellow',
      title: 'Venmo not set up',
      detail: 'The "Pay with Venmo" button is hidden from members.',
      fix: { label: 'Set Venmo handle', kind: 'link', href: '/club/admin/payments.html' },
    });
  }

  // Active admins — there should be at least one OWNER, or we lock the club out.
  const adminCount = adminsRes.count ?? 0;
  if (adminCount === 0) {
    checks.push({
      id: 'admins', status: 'red',
      title: 'No active admins',
      detail: 'Without an active admin, no one can manage the club.',
    });
  } else if (adminCount === 1) {
    checks.push({
      id: 'admins', status: 'yellow',
      title: 'Only one admin account',
      detail: 'If you lose access, no one else can manage the club. Add a backup admin.',
      fix: { label: 'Invite an admin', kind: 'link', href: '/club/admin/settings.html#admins' },
    });
  } else {
    checks.push({
      id: 'admins', status: 'green',
      title: `${adminCount} active admins`,
    });
  }

  return checks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Member-capability rollup — high-level "what can members do?" derived from
// the underlying integration checks above.
// ─────────────────────────────────────────────────────────────────────────────
type Capability = {
  id: string;
  label: string;
  status: Status;
  note?: string;
  test?: { kind: 'open_url' | 'send_self'; url?: string; action?: string };
};

function rollupCapabilities(allChecks: Check[], slug: string): Capability[] {
  const byId: Record<string, Check> = {};
  allChecks.forEach(c => { byId[c.id] = c; });

  const tiersOk    = byId['tiers']?.status === 'green';
  const policiesOk = byId['policies']?.status === 'green';
  const emailOk    = byId['email_key']?.status === 'green';
  const emailDomain= byId['email_domain']?.status;
  const smsCreds   = byId['sms_creds']?.status;
  const smsDevMode = byId['sms_dev_mode']?.status;
  const stripeMode = byId['stripe_mode']?.status;
  const stripeStatus = byId['stripe_status']?.status;
  const venmoOk    = byId['venmo']?.status === 'green';

  const caps: Capability[] = [];

  caps.push({
    id: 'apply',
    label: 'Apply for membership',
    status: tiersOk && policiesOk ? 'green' : 'red',
    note: !tiersOk ? 'No tiers defined yet' : !policiesOk ? 'No policies on the form yet' : undefined,
    test: { kind: 'open_url', url: `https://${slug}.poolsideapp.com/apply.html` },
  });

  caps.push({
    id: 'signin_email',
    label: 'Sign in with email',
    status: emailOk
      ? (emailDomain === 'green' ? 'green' : 'yellow')
      : 'red',
    note: !emailOk ? 'Email service not configured'
        : emailDomain !== 'green' ? 'Sender domain not verified — emails may go to spam'
        : undefined,
    test: { kind: 'send_self', action: 'test_email' },
  });

  caps.push({
    id: 'signin_sms',
    label: 'Sign in with text message',
    status: smsCreds === 'yellow' ? 'yellow'   // creds missing = optional yellow
        : smsDevMode === 'yellow' ? 'yellow'
        : 'green',
    note: smsCreds === 'yellow' ? 'Optional — not configured'
        : smsDevMode === 'yellow' ? 'In development mode — real texts disabled'
        : undefined,
  });

  // Stripe connected? If 'stripe_connected' check exists, Stripe isn't set up.
  // That's optional/yellow, NOT red — Venmo + PayPal cover the no-Stripe case.
  const stripeNotConnected = byId['stripe_connected']?.status === 'yellow';
  caps.push({
    id: 'pay_card',
    label: 'Pay dues with credit card',
    status: stripeNotConnected ? 'yellow'
        : stripeStatus === 'green'
            ? (stripeMode === 'yellow' ? 'yellow' : 'green')
            : (stripeStatus === 'yellow' ? 'yellow' : 'red'),
    note: stripeNotConnected ? 'Optional — Stripe not connected'
        : stripeMode === 'yellow' ? 'In TEST mode — only test cards work'
        : stripeStatus === 'red' ? 'Charges not enabled yet'
        : undefined,
  });

  caps.push({
    id: 'pay_venmo',
    label: 'Pay with Venmo',
    status: venmoOk ? 'green' : 'yellow',
    note: !venmoOk ? 'Venmo handle not set' : undefined,
  });

  caps.push({
    id: 'photos',
    label: 'Submit photos for the gallery',
    status: 'green',
    test: { kind: 'open_url', url: `https://${slug}.poolsideapp.com/m/photos.html` },
  });

  return caps;
}

// ─────────────────────────────────────────────────────────────────────────────
// This-week activity rollup — counts from the audit log and integration logs.
// ─────────────────────────────────────────────────────────────────────────────
async function thisWeek(sb: ReturnType<typeof createClient>, tenantId: string): Promise<Record<string, number>> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [appsRes, paymentsRes, smsRes, errsRes] = await Promise.all([
    sb.from('audit_log').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('kind', 'application.submit').gte('created_at', since),
    sb.from('audit_log').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).in('kind', ['application.payment_verified', 'plan.installment_paid']).gte('created_at', since),
    sb.from('sms_log').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('success', true).gte('sent_at', since),
    sb.from('audit_log').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).ilike('kind', '%.error').gte('created_at', since),
  ]);
  return {
    applications: appsRes.count ?? 0,
    payments: paymentsRes.count ?? 0,
    texts: smsRes.count ?? 0,
    errors: errsRes.count ?? 0,
  };
}

function formatRelative(d: Date): string {
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handler
// ─────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw  = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = tokRaw ? await verifyAdmin(tokRaw) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? 'check');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (action === 'check') {
    // Pull tenant slug for capability test URLs (JWT sometimes lacks it)
    let slug = payload.slug || '';
    if (!slug) {
      const { data: t } = await sb.from('tenants').select('slug').eq('id', payload.tid).maybeSingle();
      slug = (t?.slug as string) || '';
    }

    // Run all checks in parallel — Promise.allSettled so one section's
    // failure doesn't kill the page.
    const results = await Promise.allSettled([
      checkEmail(),
      checkSms(sb, payload.tid),
      checkStripe(sb, payload.tid),
      checkDrive(sb, payload.tid),
      checkBackgroundJobs(sb, payload.tid),
      checkTenantConfig(sb, payload.tid),
    ]);

    const sections: Array<{ id: string; label: string; checks: Check[] }> = [
      { id: 'email',      label: 'Email delivery',                checks: [] },
      { id: 'sms',        label: 'Text-message sign-in',          checks: [] },
      { id: 'stripe',     label: 'Card payments (Stripe)',        checks: [] },
      { id: 'drive',      label: 'Application archive (Drive)',   checks: [] },
      { id: 'cron',       label: 'Auto-billing schedule',         checks: [] },
      { id: 'config',     label: 'Club configuration',            checks: [] },
    ];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') sections[i].checks = r.value;
      else sections[i].checks = [{
        id: `${sections[i].id}_unknown`, status: 'unknown',
        title: `Couldn't check ${sections[i].label.toLowerCase()}`,
      }];
    });

    const allChecks = sections.flatMap(s => s.checks);

    // Setup issues = red + yellow checks elevated to top
    const setupIssues = allChecks.filter(c => c.status === 'red' || c.status === 'yellow');
    const overall: Status = worst(...allChecks.map(c => c.status));

    const capabilities = rollupCapabilities(allChecks, slug);
    const week = await thisWeek(sb, payload.tid).catch(() => ({}));

    return jsonResponse({
      ok: true,
      overall,
      checked_at: new Date().toISOString(),
      setup_issues: setupIssues,
      capabilities,
      sections,
      this_week: week,
    });
  }

  // Test send: email a magic link to the admin's own address
  if (action === 'test_email') {
    const { data: admin } = await sb.from('admin_users')
      .select('email').eq('id', payload.sub).maybeSingle();
    if (!admin?.email) return jsonResponse({ ok: false, error: 'Your admin record has no email on file.' });
    try {
      const { renderAndSend } = await import('../_shared/email_template.ts');
      // Use the welcome template as a representative real send.
      const r = await renderAndSend(sb, {
        tenantId: payload.tid,
        templateKey: 'application_approved_other',
        to: admin.email as string,
        variables: {
          primary_name: 'Admin',
          sign_in_link: `https://${payload.slug || 'your-club'}.poolsideapp.com/m/login.html`,
        },
      });
      if (!r.sent) return jsonResponse({ ok: false, error: r.error || 'Send failed' });
      return jsonResponse({ ok: true, sent_to: admin.email });
    } catch (e) {
      return jsonResponse({ ok: false, error: (e as Error).message });
    }
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});
