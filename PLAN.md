# Poolside — Architecture & Build Plan

> **Status:** greenlit 2026-04-27 — built fresh in a new repo, Bishop Estates frozen at current state.

This is the plan doc. Read it, redline it, ask questions. Code starts after you've set up the new git repo + domain and we've finalized the open decisions at the bottom.

---

## The big picture

```
                          ┌──────────────────────┐
poolside.app           ──▶│  Marketing website   │  (public, signup)
                          └──────────────────────┘

                          ┌──────────────────────┐
admin.poolside.app     ──▶│  Provider admin      │  (just YOU)
                          │  - Tenants CRUD      │
                          │  - Twilio / Resend / │
                          │    GCP / Stripe      │
                          │  - Cross-tenant data │
                          └──────────────────────┘

                          ┌──────────────────────┐
bishopestates.poolside ──▶│  Tenant 1            │
springfield.poolside   ──▶│  Tenant 2            │  (each pool club)
…                      ──▶│  Tenant N            │
                          └──────────────────────┘
                                     │
                          ┌──────────────────────┐
                          │  Same Supabase       │
                          │  project, RLS-       │
                          │  scoped per tenant   │
                          └──────────────────────┘
```

**One codebase** for the tenant frontend. The URL determines who you are.

---

## Provider-shared vs. per-tenant

| Service | Provider-shared | Per-tenant |
|---|---|---|
| Twilio (SMS) | ✅ One account, one number, messaging-service per tenant | ❌ |
| Resend (email) | ✅ One account, sender = "Club Name <noreply@poolside.app>" | ❌ |
| GCP OAuth client (Drive) | ✅ One client, every tenant authorizes their own Drive | ❌ |
| Stripe (billing) | ✅ Connected accounts per tenant for dues; platform fee | ✅ each tenant has their own Stripe Connect account |
| Domain registration | ✅ poolside.app | Optional white-label later |
| Database | ✅ One Supabase project | tenant_id-scoped rows |
| Storage (PDFs, photos) | ✅ Same buckets | tenant_id-prefixed paths |

**Result:** new pool clubs onboard in ~5 minutes with **zero** integration setup. No Twilio account, no Resend account, no GCP project. They click "Sign Up", pay, walk through the wizard, they're live.

---

## Tech stack (recommendation)

| Layer | Recommended | Why | Alternative |
|---|---|---|---|
| Frontend (marketing) | Astro | Static-fast, SEO-friendly, components | Plain HTML |
| Frontend (admin + tenant) | Vanilla JS + ES modules + Supabase JS | Same stack as Bishop Estates → low learning curve, ~80% of code ports | Next.js (better DX, but new framework) |
| Backend | Supabase (Postgres + Edge Functions) | Same as today | — |
| Hosting | Vercel | Same as today, automatic preview deploys | — |
| Auth (provider admin) | Custom (HS256 JWT, like Bishop Estates today) | Pattern already proven | Supabase Auth |
| Auth (tenant members) | Twilio SMS magic-link | Pattern already proven | Magic email links via Resend |

**My honest take:** ship MVP in vanilla JS + Astro for marketing. You can rewrite the tenant frontend in Next.js later if you want better polish, but vanilla is faster to ship and you already know it cold.

---

## Database schema sketch

### New tables

```sql
-- The tenant directory. Each row = one pool club.
create table tenants (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null,         -- 'bishopestates'
  display_name text not null,                -- 'Bishop Estates Cabana Club'
  custom_domain text unique,                 -- 'bishopestates.club' (premium)
  status       text not null default 'active',
                                             -- 'active' | 'suspended' | 'trial' | 'churned'
  plan         text not null default 'starter',
                                             -- 'starter' | 'pro' | 'enterprise'
  created_at   timestamptz default now(),
  -- Per-tenant Stripe customer for billing the SaaS subscription
  stripe_customer_id text,
  trial_ends_at      timestamptz,
  -- Provider-internal notes
  notes text
);

-- Provider admins (you). Different from tenant admins.
create table provider_admins (
  id uuid primary key,
  email text unique not null,
  password_hash text not null,
  is_super boolean default false,
  created_at timestamptz default now()
);
```

### Existing Bishop Estates tables get tenant_id

Every table from Bishop Estates today gets a `tenant_id uuid not null references tenants(id)` column:

- `households`
- `household_members`
- `member_sessions`
- `gate_unlock_log`
- `bridge_status`
- `gate_bridges`
- `app_secrets`           ← per-tenant secrets (Drive refresh token, etc.)
- `settings`              ← per-tenant config blob
- `admin_users`
- `admin_user_roles`
- `admin_roles`
- `member_applications`   ← new in Phase 2 (immutable PDF + form data)
- `party_requests`        ← new
- `feedback`              ← new

### RLS

Every tenant-scoped table gets policies like:

```sql
create policy tenant_isolation on households
  for all using (tenant_id = current_setting('request.jwt.claim.tenant_id')::uuid);
```

The tenant_id comes from the JWT. **Provider admins** use a different JWT shape (`is_super=true`) that bypasses RLS — they can see all tenants' data.

### Provider-level secrets

Stored as Supabase **environment variables**, never in DB:

- `RESEND_API_KEY`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

A tenant's admin **never** sees these.

---

## Onboarding flow (a new pool club signs up)

1. **Marketing site** — they land on `poolside.app`, click "Start free trial".
2. **Sign-up form** — email, club name, slug (`bishopestates` → `bishopestates.poolside.app`), password.
3. **Stripe Checkout (optional in MVP)** — collect a card for the trial. Or skip and just track `trial_ends_at` = +14 days.
4. **Tenant created** — row in `tenants`, first admin in `admin_users`, default settings seeded.
5. **Confirmation email** — Resend sends a "Welcome to Poolside" message with their tenant URL.
6. **First login at `<slug>.poolside.app`** — admin lands on the dashboard.
7. **Setup wizard auto-opens** — modal walks them through 7 steps:
   1. 🏛️ Club basics — name, location, swim team
   2. 🪪 Hero text
   3. 🖼️ Background photo
   4. 📍 Pool location, hours, fob activation day
   5. 💳 Payments — Venmo / PayPal handle
   6. 🔗 Connect Google Drive
   7. ✅ Done
8. **They're live.** Members can sign up at the public home page.

---

## Provider admin (admin.poolside.app)

For you only. Routes:

- `/` — dashboard (MRR, active tenants, signups this week, churn)
- `/tenants` — list of tenants, status pill, search
- `/tenants/:slug` — drill-down (impersonate, billing, suspend, notes)
- `/integrations` — provider-level config (Twilio account, Resend domain, GCP redirect URI, Stripe)
- `/settings` — your provider-admin profile

Key feature: **"Impersonate"** — open a tenant's frontend with provider-admin credentials so you can support them.

---

## Tenant frontend (<slug>.poolside.app)

Almost everything from Bishop Estates today, ported with `tenant_id` plumbing.

**Public:**
- Home (hero, gallery, news, sponsors, sign-in)
- Join (membership form)
- Party booking
- Public sign-in via SMS

**Member-side:**
- Gate unlock
- My Family (households)
- Party booking
- (Future) View their dues, history, etc.

**Admin-side:**
- Operations: gate, members, parties, feedback
- Content: news, gallery, sponsors
- Settings: pricing, features, season close
- Onboarding: club identity, payments, Drive backup
- Setup Wizard (auto on first login, button to re-launch any time)

---

## Edge Functions to port

| Bishop Estates today | Poolside | Notes |
|---|---|---|
| `admin_auth` | ✅ port + add tenant_id to JWT | Tenant-aware login |
| `sms_auth` | ✅ port | Twilio shared, per-tenant from-name |
| `unlock_gate` | ✅ port | tenant_id determines bridge |
| `gate_summary` | ✅ port | scoped to tenant |
| `households_admin` | ✅ port | scoped to tenant |
| `oauth_google_callback` | ✅ port | tenant_id in state JWT |
| `ticker_data` | ✅ port | scoped to tenant |
| `push_admin` | ✅ port | scoped to tenant |
| `members_admin` | ❌ retire | already replaced by households_admin |
| `submit_application` | ✨ NEW | replaces Apps Script flow, uses Resend |
| `submit_party_request` | ✨ NEW | replaces Apps Script flow |
| `submit_feedback` | ✨ NEW | replaces Apps Script flow |
| `backup_to_drive` | ✨ NEW | nightly mirror cron |
| `provider_admin` | ✨ NEW | tenants CRUD, integrations |
| `tenant_signup` | ✨ NEW | new club registration |
| `stripe_webhook` | ✨ NEW (later) | billing events |

---

## Bishop Estates migration to Tenant 1

When Poolside reaches feature parity:

1. Create tenant row: slug=`bishopestates`, display_name=`Bishop Estates Cabana Club`.
2. Export current data (households, settings, members, etc.) → import into Poolside DB with `tenant_id` set.
3. Cut `bishopestates.poolside.app` over to the new app.
4. (Optional) Keep old domain redirecting to new for ~1 year.
5. Decommission old Vercel project.

Estimated migration window: 1 day. The household model + Edge Function patterns we built are **directly portable** — that work isn't wasted, it just lives in a new repo with `tenant_id` plumbed through.

---

## Domain & email

| What | Recommendation |
|---|---|
| Primary domain | `poolside.app` (~$25/yr at Namecheap, ~$15 at Porkbun) — short, memorable. Check `.club` and `.com` availability too. |
| Backup names if `poolside.app` is taken | `usepoolside.com`, `poolclub.app`, `cabana.app`, `poolside.club` |
| Email — admin / support | `support@poolside.app`, `doug@poolside.app` |
| Email — transactional from-address | `noreply@poolside.app` (verified at Resend; SPF/DKIM/DMARC) |
| Tenant subdomains | `*.poolside.app` (wildcard DNS A record → Vercel) |
| Custom-domain feature for premium tenants | Vercel supports adding tenant's domain → maps to their tenant's subdomain |

**Email setup (~30 min):**
1. Buy domain
2. Sign up Google Workspace ($6/mo) or use forwarding for free
3. Add MX records for inbox
4. Add SPF + DKIM + DMARC for Resend (Resend's dashboard generates them)
5. Verify in Resend
6. Verified ✓ — emails send from `noreply@poolside.app`

---

## Pricing thoughts (just sketches)

Per memory: tiered annual subscription, web-sold to avoid Apple cut. Sketch:

| Tier | Price | Features |
|---|---|---|
| Starter | $99/yr | Up to 100 households, 1 admin, email + Drive backup |
| Pro | $199/yr | Up to 250 households, 3 admins, SMS sign-in, gate bridge |
| Enterprise | $399/yr | Unlimited households, white-label sender domain, priority support |

Plus 1% transaction fee on dues / parties / keyfobs / guest passes (per memory). Stripe Connect handles the platform fee transparently.

**Defer Stripe to MVP+1.** Launch with manual Venmo/check, add Stripe when you have 5+ tenants asking for it.

---

## Tomorrow morning's deployment checklist

| # | Step | Time | Cost |
|---|---|---|---|
| 1 | Buy `poolsideapp.com` at Porkbun | 5 min | ~$12/yr |
| 2 | New GitHub repo `poolside-app` (same account, **public** from day 1) | 3 min | $0 |
| 3 | Push prototypes there as initial commit | 5 min | $0 |
| 4 | New Vercel project pointing at the new repo | 5 min | $0 (Hobby) |
| 5 | Connect `poolsideapp.com` + add wildcard `*.poolsideapp.com` in Vercel | 10 min | $0 |
| 6 | New Supabase project "poolside-prod" | 5 min | $0 (Free tier) |
| 7 | Verify `poolsideapp.com` at Resend (3 DNS records) | 10 min | $0 (3k/mo free) |
| 8 | Email inbox: ImprovMX free forwarding to Gmail (or Workspace at $6/mo later) | 10 min | $0 |
| 9 | Set provider env vars in Vercel + Supabase secrets | 15 min | $0 |
| 10 | First production deploy — marketing site live at `poolsideapp.com` | 2 min | $0 |

**Total active time:** ~75 min · **Recurring:** ~$1/mo for the domain.

## Gate Integrations — paid add-on, vetting-first

A premium feature on top of the base subscription. **Critical:** keyfob panels vary wildly between vendors and even between firmware versions of the same vendor. We never publish a template for a panel we haven't actually tested end-to-end on real hardware. Three paths:

| Path | When | What tenant pays | What we promise |
|---|---|---|---|
| **A. Verified template** | Tenant's panel matches one we've fully tested | $250 setup + $25/mo | Ships in ~5 days, will work |
| **B. Compatibility request** | Panel isn't on our verified list yet | $0 to submit, ~1 week response | Honest yes/no/maybe evaluation |
| **C. Custom integration** | Panel feasible but new for us | $500–$2,000 setup quoted up front + $25/mo | Fixed quote before any work; on-site testing required |

### First (and currently only) verified template: MENGQI-CONTROL HXC-7000

Codifies what we already built for Bishop Estates so future clubs **with the same panel** can deploy it in one click:
- ESP32 Wiegand sniffer + Raspberry Pi bridge
- TCP/IP HTTP POST to MENGQI-CONTROL HXC-7000 admin endpoint (firmware ≥ 2.4)
- Pre-flashed Pi ships from us with tenant_id + auth token baked in
- Bridge phones home → integration goes live
- Members tap to unlock from their phones with full audit log
- **Tested with:** Bishop Estates Cabana Club, panel firmware 2.4.7

### Pricing model (recommendation)

| | Cost | Why |
|---|---|---|
| **Setup fee (one-time)** | **$250** | Hardware BOM ~$85 (Pi + ESP32 + cables + enclosure + shipping) + ~$25 provisioning labor + ~$140 margin |
| **Monthly recurring** | **$25/mo** | Ongoing support, bandwidth, software updates, 1-year hardware warranty replacement |

Premium add-on positioning: **clubs that don't want to pay self-select out**, which is fine — gate integration isn't right for everyone.

Bishop Estates as Tenant Zero gets the integration **grandfathered free** — eat the cost as the price of testing the model.

### New tables (added to Poolside schema)

```sql
-- Provider creates these only AFTER an integration has been tested end-to-end
-- on real hardware. Each template = one panel kind we'll one-click ship for.
create table gate_integration_templates (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  display_name    text not null,
  description     text,
  hardware_summary text,
  panel_manufacturer text,
  panel_model        text,
  panel_firmware_min text,                  -- 'firmware ≥ 2.4'
  protocol           text,                  -- 'tcp/ip-http' | 'rs-485' | 'osdp' | etc.
  setup_fee_cents int default 25000,
  monthly_cents   int default 2500,
  status          text default 'production',-- 'beta' | 'production' | 'deprecated'
  setup_guide_url text,
  hardware_bom_url text,
  first_pilot_tenant_id uuid references tenants(id), -- who we first verified it on
  verified_at     timestamptz,                       -- when it was promoted from request
  created_at      timestamptz default now()
);

-- Tenants whose panels match a verified template request the integration
-- through this table.
create table tenant_gate_integrations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  template_id     uuid not null references gate_integration_templates(id),
  status          text not null default 'requested',
                  -- 'requested' | 'paid' | 'shipped' | 'active'
                  -- 'paused' | 'cancelled'
  bridge_id       uuid references gate_bridges(id),
  panel_ip        text,
  setup_paid_at   timestamptz,
  shipped_at      timestamptz,
  activated_at    timestamptz,
  cancelled_at    timestamptz,
  notes           text,
  created_at      timestamptz default now()
);

-- Tenants whose panels are NOT on the verified list submit info here. Provider
-- reviews, evaluates, quotes — or declines — one-by-one.
create table gate_integration_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  manufacturer    text,
  model           text,
  firmware        text,
  protocol        text,                     -- 'tcp/ip' | 'rs-485' | 'wiegand' | 'osdp' | 'proprietary' | 'unknown'
  description     text,                     -- free-form notes from tenant
  panel_photo_url text,
  reader_photo_url text,
  install_photo_url text,
  status          text default 'submitted',
                  -- 'submitted' | 'reviewing' | 'quoted'
                  -- 'accepted' | 'declined' | 'added-to-templates'
  admin_notes     text,
  quoted_setup_cents int,
  quoted_monthly_cents int,
  reviewed_at     timestamptz,
  promoted_template_id uuid references gate_integration_templates(id),
  created_at      timestamptz default now()
);
```

### Provisioning workflow

1. **`requested`** — tenant clicks "Request integration." Stripe Checkout link sent automatically.
2. **`paid`** — setup fee landed. Bridge appears in provider's queue.
3. **Provisioning** — flash Pi with bridge code, embed tenant_id + auth token, sticker-label, box.
4. **`shipped`** — provider clicks Mark Shipped, pastes tracking number. Tenant gets email with setup guide.
5. **`active`** — bridge auto-detects tenant on first connect, status flips. Members can unlock.

### Provider admin UI

- `/admin/gate-integrations` — Templates tab + Tenant deployments tab + Hardware inventory tab
- See prototype at `/poolside-prototype/admin/gate-integrations.html`

## Campaigns — in-app announcements + sales

Pool clubs need a way to talk to their members in-app: announce events, sell party tickets, run donation drives, push renewal reminders. **Campaigns** is that feature.

### What it is

A club-managed pop-up message that shows up when a member opens the app. Each campaign has:
- Title + body text + optional emoji + optional inline image
- Optional CTA button (label + URL + color)
- Schedule (start/end dates) and frequency rule (once-per-member, every-open, until-clicked, etc.)
- Audience filter (all / paid-only / unpaid-only / role-based / specific households)

### Use cases the club admin will reach for

| Type | Title | CTA |
|---|---|---|
| Event sale | 🎆 4th of July Party — $25/family | "Get tickets →" → Eventbrite |
| Donation drive | 🪑 New lounge chairs fund | "Donate via Venmo →" |
| Operational | 🌊 Pool closed Saturday for cleaning | (no CTA) |
| Renewal nudge | 🪪 Renew before Feb 1 — save $50 | "Renew now →" |
| Welcome | 👋 Welcome to the 2026 season! | (no CTA) |

### Data model

```sql
create table campaigns (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  title           text not null,
  body            text,
  emoji           text,
  image_url       text,
  cta_label       text,
  cta_url         text,
  cta_style       text default 'primary',  -- 'primary'|'amber'|'green'|'red'
  audience        text not null default 'all',
                  -- 'all'|'paid-members'|'unpaid-members'|'admins-only'
                  -- |'new-members'|'specific-households'
  audience_filter jsonb,
  starts_at       timestamptz default now(),
  ends_at         timestamptz,
  frequency       text not null default 'once',
                  -- 'once'|'once-per-day'|'every-open'|'until-clicked'|'until-dismissed'
  status          text not null default 'draft',
                  -- 'draft'|'active'|'paused'|'ended'
  created_by      uuid references admin_users(id),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index campaigns_active_idx on campaigns(tenant_id, status, starts_at, ends_at);

create table campaign_views (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid not null references campaigns(id) on delete cascade,
  member_id       uuid not null references household_members(id) on delete cascade,
  first_seen_at   timestamptz default now(),
  last_seen_at    timestamptz default now(),
  view_count      int default 1,
  clicked         boolean default false,
  clicked_at      timestamptz,
  dismissed       boolean default false,
  dismissed_at    timestamptz,
  unique (campaign_id, member_id)
);
```

### Builder UX (admin side)

Three-level escalation:

- **Level 1 (90% use case):** pick a template → fill title/body → optional CTA → publish. ~30 seconds.
- **Level 2 (collapsed "Advanced"):** audience targeting, frequency rule, schedule, CTA color
- **Level 3 (Pro/Enterprise):** A/B testing, multi-step campaigns, automation rules

Templates ship with sensible defaults: 🎆 Event tickets · 💸 Donation drive · 📢 Announcement · 🪪 Renewal · 👋 Welcome · 🌊 Pool closed.

### Member experience

On every app-open (post-auth), client fetches `/api/next-campaign`. If a match is returned, modal renders over a dimmed background. Tap CTA or Dismiss → recorded in `campaign_views` → won't show again per the frequency rule.

### Tier strategy

Available in **all tiers** (Starter through Enterprise) — paywalling basic campaigns kills the product's stickiness. What's gated:

| Feature | Starter | Pro | Enterprise |
|---|---|---|---|
| Active campaigns at once | 1 | 5 | unlimited |
| Audience targeting | All only | + paid/unpaid/admins | + custom-household |
| Frequency rules | Basic | + every-open / until-clicked | + automation |
| Click-through analytics | ❌ | ✅ | ✅ + funnel reports |
| A/B testing | ❌ | ❌ | ✅ |
| **Embedded ticketing (Poolside-hosted, 1.5% fee)** | ❌ | ✅ | ✅ |

### Embedded ticketing as a future Poolside revenue stream

For MVP, CTAs link out to Eventbrite / Venmo / etc. — clubs handle their own ticketing.

For Pro/Enterprise tiers later, **Poolside hosts the ticketing flow** itself: tenant creates a campaign, picks "Sell tickets via Poolside", sets price + capacity, Stripe Connect collects payment, Poolside takes a 1.5% platform fee. Aligns with the existing transactional-fee strategy in `transactional_fee_surfaces` memory.

### Where it sits in the admin

Tenant admin → **Content tab** → 📢 Campaigns card.

Or — depending on usage — promote to top-level alongside Operations / Content / Settings / Onboarding once it becomes a daily-use feature.

## Swim Lessons — paid bookings, native to Poolside

Pool clubs run lessons. It's a real revenue stream. Today they manage it on a clipboard, an Eventbrite, or a Google Form. **Native swim-lessons platform** kills the duplicate data entry and creates a Tier-1 transactional fee surface for Poolside.

### What it ships with

- **Programs** — what the club sells (Summer Swim Team, Private Lessons, Mommy & Me, etc.)
- **Sessions** — when each program meets (recurring or one-off)
- **Bookings** — who signed up for which session, payment status
- **Instructors** — staff/coaches with name, bio, photo
- **Payments via Stripe Connect** — Poolside takes 1.5% per booking (Tier 1 fee surface, per `transactional_fee_surfaces` memory)

### Onboarding integration

Setup wizard step 5 (Payments + Optional features) gets a **swim-lessons checkbox**:

> ☐ **Swim lessons or swim team**
> Members book + pay through the app. Stripe handles checkout (1.5% Poolside fee per booking).

If checked → Swim Lessons admin tab visible on first login. If unchecked → hidden, can enable later in Settings → Features. **All tiers see the feature available** — the checkbox is just "show in nav by default."

### Schema

```sql
create table swim_programs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  name          text not null,
  format        text,                -- 'group' | 'private' | 'recurring' | 'cert'
  description   text,
  price_cents   int,
  capacity      int,
  duration_min  int,
  active        boolean default true,
  created_at    timestamptz default now()
);

create table swim_sessions (
  id            uuid primary key default gen_random_uuid(),
  program_id    uuid not null references swim_programs(id) on delete cascade,
  starts_at     timestamptz not null,
  ends_at       timestamptz,
  instructor_id uuid references swim_instructors(id),
  notes         text
);

create table swim_bookings (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  session_id    uuid not null references swim_sessions(id),
  household_id  uuid not null references households(id),
  student_name  text not null,        -- often a kid; doesn't need to be a household_member
  student_age   int,
  notes         text,
  payment_status text default 'pending',  -- 'pending' | 'paid' | 'refunded' | 'comped'
  stripe_payment_intent_id text,
  booked_at     timestamptz default now()
);

create table swim_instructors (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  name          text not null,
  bio           text,
  photo_url     text,
  active        boolean default true
);
```

### Tier strategy

Available in **all tiers**. Monetized via 1.5% transaction fee through Stripe Connect. Clubs that prefer Venmo/check can still use the booking flow (capacity tracking, roster, confirmation email) — just no auto-payment, no Poolside cut.

### Prototype

- Admin: `poolside-prototype/club-demo/admin/swim-lessons.html` — programs list, stats card with Stripe-fee callout, expandable session view, recent bookings table, instructor table.

## Calendar — native, drop the Google Calendar embed

### Decision: replace GCal embed with native calendar derived from operations data + iCal export

### Why drop GCal embed

Pool clubs that use GCal do double data entry:
1. Approve a party request in Poolside → also add it to GCal
2. Schedule swim lessons in Poolside → also add to GCal
3. Run a campaign with a date → also add to GCal
4. Set pool-closure days in settings → also add to GCal

**The events already exist in Poolside data.** The calendar should derive from them.

### How the native calendar works

A virtual feed that unions:
- `party_requests` where `status='approved' AND date >= now()`
- `swim_sessions starts_at >= now()`
- `campaigns` where `ends_at >= now()` (small visual marker, links to popup)
- `pool_closure_days` from settings (manual or recurring)
- `manual_events` table for custom one-offs ("Membership meeting Thursday 7pm")

```sql
-- Just for the bits that don't fit any other source
create table manual_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  title       text not null,
  description text,
  starts_at   timestamptz not null,
  ends_at     timestamptz,
  all_day     boolean default false,
  location    text,
  created_by  uuid references admin_users(id),
  created_at  timestamptz default now()
);
```

### Member experience

- Monthly grid view (mobile: agenda list)
- Color-coded events: 🎉 parties · 🏊 lessons · 🌊 pool closed · 📋 events · 🎆 campaigns · 🛠 maintenance
- Filter chips at top to show/hide categories
- **"Subscribe in your calendar"** button gives them `webcal://` URL → they paste into Apple/Google/Outlook → events auto-update with reminders for free

### What gets removed

- The "Google Calendar" Onboarding card (sec-cal in Bishop Estates)
- The GCal step from setup wizards (no `cal-src-input` field)
- The iframe embed on the home page
- One fewer integration to maintain, one less thing for tenants to configure

### What stays optional

If a tenant *really* wants to merge events from an external Google Calendar (e.g., they already maintain it for non-pool stuff), they can paste a public iCal URL → Poolside reads it and merges those events into the calendar. One-time, one-way, no OAuth.

### Prototype

- Member view: `poolside-prototype/club-demo/calendar.html` — monthly grid with event dots, filter chips, "Subscribe in your calendar" CTA, agenda list with source pills (FROM PARTY REQUESTS / FROM SWIM LESSONS / FROM CAMPAIGNS / etc.)

## Feature modules — the full revenue map

Beyond swim lessons + campaigns, here's the catalog of things pool clubs sell or schedule. Most collapse into shared engines so we don't build N features when 4 patterns cover everything.

### Four core mechanics (everything reduces to these)

| Pattern | Examples | Engine |
|---|---|---|
| **Bookings** (slot + capacity + price) | Swim lessons, yoga, water aerobics, day camp, cabana rental, lane reservations, tournament entries, lifeguard cert | `programs` / `program_sessions` / `program_bookings` (generalized swim_*) |
| **POS / Tab** (item catalog + per-purchase charge) | Snack shack, pro shop, sunscreen station, replacement keyfob fees | `items` + `tabs` + `tab_charges` + monthly settlement |
| **Punch cards / credits** (prepaid bundles) | 10-pack guest passes, snack vouchers, lesson packages | Credit balance per household, decrement on use |
| **Recurring billing** (auto-charge schedule) | Membership dues, locker rental, premium parking, monthly patron | Stripe Subscriptions per household |

Plus two non-commerce systems:

| Pattern | Examples | Engine |
|---|---|---|
| **Volunteer hours** (track time + buy-outs) | "4 work hours per family per season" + $25/hour buy-out | Shifts + signups + per-household hours ledger |
| **Single transactions** | Day passes, fundraising drives, ticketed events | One-off Stripe charges |

### Build priority

| # | Module | Builds on | $$ impact | Complexity |
|---|---|---|---|---|
| 1 | **Programs & Bookings** (generalize swim_lessons) | Refactor before more code ships | High — unlocks swim + yoga + camp + cabana + tournaments at once | Medium |
| 2 | **Snack shack tab system** | New | High — every club has one | Medium-Hard (POS UX on iPad) |
| 3 | **Guest passes & day passes** | New | Medium | Easy |
| 4 | **Punch cards / credit packs** | New | Medium | Medium |
| 5 | **Volunteer hours + buy-outs** | New | Low $$ direct, high stickiness | Medium |
| 6 | **Donations / fundraising** | Extends campaigns | Low-Medium | Easy |
| 7 | **Membership dues automated billing** | New, Stripe Subscriptions | Highest long-term ($900/yr/club) | Hard (dunning, prorations, refunds) |

### Per-club revenue with everything turned on

A fully loaded Pro club running all modules:

| Stream | Annual $ | Poolside 1.5% |
|---|---|---|
| Subscription (Pro) | — | $199 |
| Membership dues (yr 2+) | $60,000 | $900 |
| Programs (lessons, yoga, camp) | $20,000 | $300 |
| Snack shack | $30,000 | $450 |
| Party rentals | $9,000 | $135 |
| Guest/day passes | $5,000 | $75 |
| Donations | $5,000 | $75 |
| Volunteer buy-outs | $1,500 | $23 |
| **Total per club / yr** | **$130,500 + sub** | **~$2,160** |

At 100 fully-loaded clubs: **~$216K revenue / ~$183K profit**.

At 500 mixed-utilization clubs: **~$500K revenue / ~$400K profit**.

### Generalize swim_* schema before more code ships

```sql
create table programs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  name          text not null,
  category      text not null,         -- 'swim'|'fitness'|'camp'|'rental'|'class'|'tournament'|'other'
  format        text,                  -- 'group'|'private'|'recurring'|'one-off'
  description   text,
  price_cents   int,
  capacity      int,
  duration_min  int,
  active        boolean default true,
  created_at    timestamptz default now()
);

create table program_sessions (
  id            uuid primary key default gen_random_uuid(),
  program_id    uuid not null references programs(id) on delete cascade,
  starts_at     timestamptz not null,
  ends_at       timestamptz,
  instructor_id uuid references program_instructors(id),
  notes         text
);

create table program_bookings (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  session_id    uuid not null references program_sessions(id),
  household_id  uuid not null references households(id),
  participant_name text not null,
  participant_age int,
  notes         text,
  payment_status text default 'pending',
  stripe_payment_intent_id text,
  booked_at     timestamptz default now()
);

create table program_instructors (
  id, tenant_id, name, bio, photo_url, active, ...
);
```

Same shape, broader use. The category field changes icons + form prompts; the engine doesn't care.

## How updates roll out to all tenants

One codebase serves N tenants. **Every push goes live for every club within 30 seconds**, no per-tenant action.

```
git push origin main
   ↓ (~30 sec)
Vercel auto-rebuilds the whole app
   ↓
ALL N tenants see the new code on next page load
```

Database migrations work the same way: one migration runs once against the shared Supabase, all tenants' data upgrades simultaneously.

### Feature flags for gradual rollout

For features you want to opt-in or beta-test:

```sql
-- Per-tenant settings.json:
{
  "features": {
    "snackShackTab": true,      -- this club has it
    "newCalendarUI": false,     -- not yet
    "programsModule": true
  }
}
```

Code reads `tenant.features.X`. Provider admin flips flags per-tenant.

This is how Slack/Notion/Figma do it — gradual rollouts, beta testers, premium-tier gating, all on one codebase.

### Why this matters as a sales pitch

> "Every club using Poolside gets new features automatically — including the ones we ship next month and next year. Your Excel spreadsheet got its last new feature in 2003."

That's a real differentiator vs the clipboard / Apps Script status quo.

## Realistic timeline

| Phase | Scope | Full-time | Part-time |
|---|---|---|---|
| 0. Setup | New repo, domain, Resend, GCP, new Supabase project | 2 days | 1 wk |
| 1. Multi-tenant foundation | DB schema, tenant resolution, auth scoping | 1 wk | 2 wk |
| 2. Provider admin shell | Tenants CRUD, integrations | 1 wk | 2 wk |
| 3. Tenant frontend port | 80% port from Bishop Estates | 2 wk | 4 wk |
| 4. Edge Functions port | tenant_id everywhere | 1 wk | 2 wk |
| 5. New Edge Functions | submit_application, backup_to_drive, signup | 1 wk | 2 wk |
| 6. Setup wizard + onboarding flow | Modal wizard, signup, welcome email | 1 wk | 2 wk |
| 7. Marketing site | Astro landing, pricing, signup CTA | 3 days | 1 wk |
| 8. Bishop Estates as Tenant 1 | Data import, DNS cutover | 3 days | 1 wk |
| **Total** | | **~9 wk** | **~17 wk (4 mo)** |

---

## Open decisions — answer these before code starts

1. **Domain name.** What did you find available? Going with `poolside.app`?
2. **Tech stack for tenant frontend.** Vanilla JS (faster to ship, what we know) or Next.js (better DX, longer ramp)?
3. **New Supabase project, or reuse Bishop Estates'?** I'd say new — clean schema from day 1, no legacy tables.
4. **Subdomain or path-based?** `bishopestates.poolside.app` (clean, recommended) or `poolside.app/bishopestates` (simpler DNS)?
5. **Stripe in MVP, or skip until 5 tenants?** I lean skip — you can charge manually for the first few clubs.
6. **SMS shared or per-tenant?** Shared = simpler, all clubs use your number. Per-tenant = each gets their own (premium feature).
7. **Free trial length?** 14 days is standard. Or "first season free" as a hook?
8. **White-label custom domain?** Premium tier feature, defer? Or include in MVP?
9. **Marketing site framework — Astro or just plain HTML?** Astro gives you components + SEO; plain HTML is faster.
10. **Naming.** "Poolside" — happy with this name long-term, or open to alternatives?

---

## What I can start on right now (without git / domain / email)

- ✅ This planning doc (done — you're reading it)
- ✅ Database schema in detail (`schema.sql`) — could write this now
- ✅ HTML/CSS mockup of marketing site — could prototype it
- ✅ HTML/CSS mockup of provider admin layout
- ✅ HTML/CSS mockup of tenant frontend (could literally copy Bishop Estates' look)
- ✅ Setup wizard interaction design (clickable HTML mockup)
- ✅ Edge Function interface contracts (input/output shapes)

**Things I CAN'T do without git/domain/email:**
- ❌ Actually deploy any of it (no domain yet)
- ❌ Test multi-tenant subdomain routing live
- ❌ Send real emails / SMS
- ❌ Verify Resend domain (no domain yet)

So: tell me which of the "could-do-now" items to prioritize, and I'll start producing tangible artifacts. No code goes "into prod" until you've got the new repo + domain.

---

*Doc owner: planning artifact, will move to new Poolside repo's README when created.*
