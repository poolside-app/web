# Poolside

Multi-tenant SaaS for community pool clubs. Members. Gate access. Party booking. Email confirmations. Photo galleries. Nightly Drive backups. Built so volunteer pool boards can stop running their clubs from spreadsheets.

**Status:** prototype phase. Real Supabase backend wiring in progress.

## Live surfaces

| Path | Purpose |
|---|---|
| `index.html` | Marketing landing (`poolsideapp.com`) |
| `signup.html` | Free-trial signup |
| `wizard.html` | First-login setup wizard for new tenants |
| `admin/` | Provider admin dashboard (`admin.poolsideapp.com`) |
| `club-demo/` | Example tenant frontend (each tenant gets a subdomain like `bishopestates.poolsideapp.com`) |
| `club-demo/admin/` | Tenant admin views (campaigns, swim lessons) |

## Architecture

Multi-tenant via subdomain routing. One codebase, one Supabase project, RLS-scoped data per tenant. Every push deploys instantly to all clubs.

See [`PLAN.md`](./PLAN.md) for the full plan: architecture, schema, pricing, feature roadmap, gate-integration vetting model, campaigns spec, swim-lessons spec, calendar strategy, monetization tiers, deployment timeline.

## Repo structure

```
web/
├── index.html              ← marketing landing
├── signup.html
├── wizard.html
├── PLAN.md                 ← full architecture + decisions
├── admin/                  ← admin.poolsideapp.com
│   ├── index.html          ← provider dashboard
│   └── gate-integrations.html
└── club-demo/              ← <slug>.poolsideapp.com (per-tenant)
    ├── index.html          ← tenant home (member-facing)
    ├── calendar.html
    └── admin/              ← tenant admin (club admins)
        ├── campaigns.html
        └── swim-lessons.html
```

## Stack

- Frontend: vanilla HTML / CSS / JS (Fraunces + Inter)
- Backend: Supabase (Postgres + Edge Functions) — wiring in progress
- Hosting: Vercel
- Email: Resend (`noreply@poolsideapp.com`)
- SMS: Twilio
- Payments: Stripe Connect (Tier-1 fee surfaces)
- Domain: `poolsideapp.com` (Porkbun)

## License

Source-available. License terms TBD before first non-Bishop-Estates tenant signs up.
