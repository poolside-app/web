# External integrations

Each of these is **fully coded** — the moment you set the env var(s) on the
Supabase project, the integration lights up. Until then, code paths fall
back gracefully (dev_link / stub / disabled state) so testing isn't blocked.

Add secrets via Supabase Dashboard → Project Settings → Edge Functions → Manage Secrets,
or via CLI:

```bash
tools/supabase.exe secrets set --project-ref sdewylbddkcvidwosgxo \
  KEY1=value1 KEY2=value2
```

After setting secrets, redeploy any affected function (or just push to git;
Vercel + Supabase pick up changes automatically).

---

## 1. Resend (email)

**Already used by:** `member_auth` (magic links), `applications` (welcome email, reminders).
Wired but no API key yet → returns `dev_link` so testing still works.

**You do:**
1. Sign up at [resend.com](https://resend.com) under `doug.frevele@gmail.com` (memory: account separation).
2. Verify a sending domain — recommend `mail.poolsideapp.com`. Add the DNS records (SPF / DKIM / MX) at Porkbun.
3. Generate an API key.

**Set secrets:**
```
RESEND_API_KEY=<your-resend-api-key>
RESEND_FROM=Poolside <hello@mail.poolsideapp.com>
```

**No code redeploy needed** — functions read the env var on each call.

---

## 2. Twilio (SMS)

**Used by:** `member_auth` (SMS magic links — when someone enters a phone instead of email on `/m/login.html`).
Without keys, returns `dev_link` exactly like the email flow.

**You do:**
1. Sign up at [twilio.com](https://twilio.com).
2. Buy a phone number (~$1/month).
3. Grab your Account SID + Auth Token from the dashboard.

**Set secrets:**
```
TWILIO_ACCOUNT_SID=<your-twilio-account-sid>
TWILIO_AUTH_TOKEN=<your-twilio-auth-token>
TWILIO_FROM_NUMBER=+18005551234
```

**Cost:** ~$0.0079 per SMS sent.

---

## 3. Stripe Connect (payments)

**Used by:** `stripe_connect` (onboarding), `stripe_checkout` (creates Checkout sessions for application/program/pass payments), `stripe_webhook` (verifies signed events and flips paid status).

Standard Connect — each tenant onboards their own Stripe account via the
"Connect Stripe" button in `/club/admin/settings.html`. Charges go directly
to the tenant's account; Poolside takes a 1.5% `application_fee_amount`.

**You do:**
1. Sign up at [stripe.com](https://stripe.com) under `doug.frevele@gmail.com` (account separation per memory).
2. Enable Connect in the Stripe dashboard (Settings → Connect → Get started).
3. Get your platform's Secret Key (starts with `sk_test_` or `sk_live_`).
4. **Configure the webhook** in Stripe Dashboard → Developers → Webhooks:
   - URL: `https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/stripe_webhook`
   - Events: `checkout.session.completed`, `account.updated`
   - Copy the signing secret (starts with `whsec_`).

**Set secrets:**
```
STRIPE_SECRET_KEY=<your-stripe-secret-key>
STRIPE_WEBHOOK_SECRET=<your-stripe-webhook-signing-secret>
```

**After setting:** each tenant clicks "Connect Stripe" in their settings to
onboard their own account. The button is grey until the platform key is set.

---

## 4. Google OAuth

**Used by:** `google_oauth` (init + callback). Adds "Sign in with Google"
buttons to `/m/login.html` and `/club/admin/login.html`. Without keys, the
button shows an error page when clicked.

**You do:**
1. Open [Google Cloud Console](https://console.cloud.google.com/), create a project (or use existing).
2. APIs & Services → OAuth consent screen → External, fill in basics, add scopes `email` and `profile`.
3. APIs & Services → Credentials → Create Credentials → OAuth Client ID → Web application:
   - Authorized redirect URI: `https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/google_oauth?action=callback`
4. Copy the Client ID + Client Secret.

**Set secrets:**
```
GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your-client-secret>
```

(Optional override: `GOOGLE_REDIRECT_URI` if you change the callback path.)

---

## Already configured (per memory)

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — auto-set by Supabase
- `ADMIN_JWT_SECRET` — used to sign tenant_admin + member tokens
- `VERCEL_TOKEN`, `VERCEL_PROJECT_ID` — for auto-provisioning subdomains in `tenant_signup`

---

## Verification

After setting any secret, smoke-test the relevant flow:

- **Resend:** apply for membership; admin approves → applicant should receive a real welcome email instead of a dev_link.
- **Twilio:** go to `/m/login.html`, enter a phone number that matches a member → real SMS arrives.
- **Stripe:** an admin clicks "Connect Stripe" → finishes onboarding → applies for membership with `payment_method=stripe` → checkout works end-to-end.
- **Google OAuth:** sign in with Google → bounces through Google → back to `/m/` (or `/club/admin/`) signed in.
