# Google OAuth Verification — submission prep

This doc has everything you (Doug) need to complete the Google OAuth verification submission so the "this app is being tested" warning goes away for everyone connecting Drive auto-archive.

**Status today:** OAuth consent screen is in **Testing** mode. Privacy + Terms pages are now live. Submission ready when you are.

**Scopes Poolside requests** (all kept; per memory `project_google_oauth_verification.md`):

| Scope | Category | CASA needed? |
|---|---|---|
| `openid email profile` | Non-sensitive | No |
| `userinfo.email` | Non-sensitive | No |
| `drive.file` | Sensitive (limited) | No |
| `spreadsheets` | Sensitive | No |

None of these are in the **Restricted** category that requires a CASA security assessment, so verification is the standard 4–6 week review — no third-party security audit, no $5K–$25K vendor cost.

---

## Step 1 — Verify domain ownership (15 min, do once)

1. Go to https://search.google.com/search-console
2. Add property → Domain → enter `poolsideapp.com`
3. Pick the DNS verification method, copy the TXT record Google gives you
4. Add the TXT record at Porkbun (DNS panel for poolsideapp.com)
5. Click "Verify" in Search Console — usually instant once DNS propagates

Once verified, `poolsideapp.com` shows up as an option in Google Cloud Console's "Authorized domains" picker.

---

## Step 2 — Complete the OAuth consent screen

Go to https://console.cloud.google.com/ → select the Poolside project → APIs & Services → **OAuth consent screen**.

User type: **External** (multi-tenant SaaS, not a single-org Workspace tool).

Fill in / verify these fields exactly:

| Field | Value |
|---|---|
| App name | `Poolside` |
| User support email | `doug@poolsideapp.com` |
| App logo | Upload `https://poolsideapp.com/icon-512.png` (Google accepts up to 1 MB; this is 4 KB) |
| Application home page | `https://poolsideapp.com` |
| Application privacy policy link | `https://poolsideapp.com/privacy.html` |
| Application terms of service link | `https://poolsideapp.com/terms.html` |
| Authorized domains | `poolsideapp.com` |
| Developer contact information | `doug@poolsideapp.com` |

Save and Continue → Scopes. Make sure all 4 scopes from the table above are listed. Save.

---

## Step 2b — Register the branded redirect URIs (CRITICAL — do this now)

By default, Google's consent screen displays the host of the OAuth redirect URI to the user. Without this step, users see "to continue to **sdewylbddkcvidwosgxo.supabase.co**" instead of "poolsideapp.com" — which looks like a phishing site and tanks trust.

We proxy the OAuth callbacks through poolsideapp.com via Vercel rewrites, so Google should display `poolsideapp.com`.

In Google Cloud Console → APIs & Services → **Credentials** → click your OAuth 2.0 Client ID → under **Authorized redirect URIs**, add these two:

```
https://www.poolsideapp.com/oauth/google/signin/callback
https://www.poolsideapp.com/oauth/google/drive/callback
```

Click Save. (Keep any older `*.supabase.co` URIs registered for now as a rollback fallback — remove them once you've confirmed sign-in + drive-connect both work end-to-end on the new URIs.)

The functions already use these URIs in code; once Cloud Console is saved, OAuth flips to the branded host on the next sign-in attempt. No deploy required.

---

## Step 3 — Click "PUBLISH APP"

This moves the app from Testing to "In production — pending verification". Users who weren't on the Test Users list can now go through the OAuth flow, but they'll see the "this app is being tested" warning until verification completes.

After clicking Publish, Google will prompt you to **submit for verification**. Click that.

---

## Step 4 — Submit for verification (paste-ready justifications)

Google asks a justification per restricted-or-sensitive scope. Paste these in.

### `https://www.googleapis.com/auth/drive.file`

> Poolside uses `drive.file` to auto-archive each pool club's membership applications to the club's own Google Drive. Specifically: when a club's admin connects Drive, Poolside creates one yearly folder (e.g. "2026 Sign-ups") and uploads PDF copies of approved member applications into it.
>
> We chose `drive.file` over the broader `drive` scope because we only need access to files Poolside itself creates — never the user's pre-existing Drive content. The user retains full ownership of all created files; deleting Poolside's connection does not delete or modify any file in their Drive.
>
> **Where users see this**: when an admin clicks "Connect Google Drive" on /club/admin/payments.html → Drive Backups card. Demo video shows the full flow from initial connection to seeing the auto-uploaded PDF in their Drive folder.

### `https://www.googleapis.com/auth/spreadsheets`

> Poolside uses `spreadsheets` to maintain a roster spreadsheet for each pool club. Specifically: when a club's admin connects Drive, Poolside creates a single roster spreadsheet (alongside the application-archive folder) and appends a row to it each time an application is approved or a payment is verified.
>
> We chose `spreadsheets` over `spreadsheets.readonly` because we need to append rows and apply basic formatting (column widths, frozen header row) to the spreadsheet Poolside creates. We do not read content from spreadsheets the user already had in Drive.
>
> **Where users see this**: same Drive Backups card on /club/admin/payments.html. After connecting, an "📊 Open roster sheet" button appears that opens the live spreadsheet. Demo video shows a row being appended in real time after an application is approved.

### `https://www.googleapis.com/auth/userinfo.email` and `openid email profile`

> Used for "Sign in with Google" on the admin and member sign-in pages, and for "Sign up with Google" on the marketing-site signup page. We use the verified email + Google sub to find or create the user's account on the matching pool club. The display name from Google is used to prefill the admin's display name during signup.

---

## Step 5 — Demo video (3–5 min, YouTube unlisted)

Google requires a demo video showing the OAuth flow + how each restricted scope is used in your app. Upload to YouTube as **Unlisted**, paste the URL in the verification form.

### Shot list / script

**Intro (0:00–0:20)**
- Visit https://poolsideapp.com
- Show the marketing site briefly
- Point at the footer: "These are our Privacy and Terms pages, linked from every page of the app."

**Sign-in flow with Google — non-sensitive scopes (0:20–1:00)**
- Click "Sign up with Google" on https://poolsideapp.com/signup.html
- Show the Google consent screen — point out app name "Poolside" + scopes shown
- Grant access
- Show the form pre-filled with email/name
- Complete signup, land on the new club's admin

**Connect Drive — drive.file + spreadsheets (1:00–3:30)**
- Navigate to Settings → Integrations → "Google Drive auto-archive — Connect / manage →"
- Lands on Members → Payments → Drive Backups card
- Click "Connect Google Drive"
- Show the Google consent screen — point out the two restricted scopes (drive.file + spreadsheets) and the per-scope explanations Google shows
- Grant access
- Back on Poolside: show the connected status, the "Open Drive folder" link, and the "Open roster sheet" link
- Click "Open Drive folder" — shows a clean folder (Poolside just created it) named "Poolside Sign-ups"
- Click "Open roster sheet" — shows an empty roster spreadsheet with a header row Poolside created

**Show the actual scope usage (3:30–4:30)**
- Back to admin → Members → Pipeline (or simulate a new application coming in)
- Show an approved application
- Switch to the Drive folder → refresh → show the new PDF that Poolside just uploaded
- Switch to the roster sheet → refresh → show the new row Poolside just appended

**Disconnect (4:30–5:00)**
- Back to Members → Payments → Drive Backups card
- Click "Disconnect"
- Confirm: "Existing PDFs and rows in your Drive are NOT deleted — only Poolside's ability to write new ones is removed."
- Done.

### Recording tips

- Use OBS Studio (free) or Loom — both export to YouTube directly.
- 1080p, 30fps is plenty.
- Talk it through verbally — Google reviewers like hearing the explanation, not just seeing the screen.
- Don't show real applicant data — use a test club with fake names. Bishop Estates fixtures work; create a "John Sample" application.

---

## Step 6 — Submit and wait

Once you've pasted the justifications + uploaded the video URL + filled the contact email, hit Submit.

**Expected timeline:** 4–6 weeks. Google may come back asking for clarifications — usually they want either a clearer demo video, more specific scope justification, or proof that something on your domain works as described. They send everything to the developer contact email.

**While you wait — Test Users keep working:**
- Anyone you've added to the OAuth consent screen → Test users list bypasses the warning entirely
- Use this to onboard the first handful of beta clubs without the scary screen
- Cap is 100 test users, more than enough for the verification window

---

## Checklist (track your progress)

- [ ] DNS-verified `poolsideapp.com` in Google Search Console
- [ ] OAuth consent screen — all fields filled, including privacy + terms URLs
- [ ] App logo uploaded (icon-512.png from poolsideapp.com)
- [ ] PUBLISH APP clicked → moved out of Testing
- [ ] Justifications pasted per scope (4 scopes)
- [ ] Demo video recorded + uploaded to YouTube (unlisted)
- [ ] YouTube video URL pasted in submission form
- [ ] Submitted
- [ ] First-line email reply received from Google verify@google.com (acknowledgment)
- [ ] Resolution email received (approval, or clarification request)
- [ ] If clarification: respond within their stated window (usually 14 days)
- [ ] Final approval — warning gone for all users 🎉

---

## After approval

When Google says you're verified:
1. The "this app is being tested" warning disappears for everyone — you don't need to do anything else
2. You can remove Test Users from the OAuth consent screen (optional cleanup)
3. The 100-user cap is gone — unlimited new clubs can connect Drive

If you ever add a NEW restricted scope later (e.g., `gmail.send`), you'll need to re-verify. Adding non-sensitive scopes (e.g., `calendar.events`) doesn't trigger re-verification.
