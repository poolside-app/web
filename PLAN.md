# Plan — ship the backlog + test payments, then fix what the review found

Replaces the stale April 2026 plan (still in git history).
Rule: one step at a time. Doug says "execute Step N"; I do it, prove it worked, report, and stop.

## Done overnight, 2026-09-23 → 24 (Steps 1–6, approved together)
- **Step 1 — Safety.** CI (`verify.yml`) is manual-only. Baseline: 27 calls/hour, bridge silent since 17:17 UTC.
- **Step 2 — Failing test first.** `scripts/test_payments.mjs` failed before deploy (2 pass / 10 fail) for the expected reasons.
- **Step 3 — 8 migrations applied**, all recorded.
  - The reconstruct migration guessed an SMS function name wrong (`spend_sms_credits`).
  - Corrected it to the live `consume_sms_credits` before applying.
- **Step 4 — 35 functions deployed**: the whole 9/9–9/10 backlog, the never-deployed `tenant_share`, and test payments. Every one starts and answers.
- **Step 5 — Pages pushed.** Plus one fix found in browser testing: the old "Stripe isn't fully wired" note was overriding test mode.
- **Step 6 — Test passes, 21/21.**
  - Also walked both flows in a real browser: form → fake card checkout → "Payment received" → signed in to the member home, and form → "Simulate Venmo payment" → approved.
  - Whole night used ~110 Supabase calls.
- Test data now in Bishop:
  - 4 approved, paid households: SimTest Card 157230, SimTest Venmo 157230, SimTest UI Family, SimTest UIVenmo Family.
  - 2 unpaid SimTest …758543 applications left over from the failing run. The card one auto-deletes after 60 minutes.
  - Welcome emails went to doug.frevele+simtest…@gmail.com.
- Test mode is ON. Twilio balance is $5.99, about 700 texts.

## Step 7 — Real people try it
- Doug's wife, daughter, neighbor and board members sign up on the live site with their own info, fake-pay, get approved, and get the welcome email and text with a sign-in link.
- Tell testers **not to tap "Unlock the gate"** (the bridge is off, so it spins for 8 seconds then fails). See step A2.

## Step 8 — Clean up (only when Doug says)
- Delete every SimTest and tester application and household, then turn test mode off.
- **Must happen before the gate bridge is turned back on.** Every approved test household has gate access.

---

## Proposed next steps from the 9/24 code review (each needs Doug's OK)

### A. Before testers start (small, today)
- **A1. The Venmo "application received" email is broken.**
  - Its subject is "We got your application — " with nothing after it, and the body says "thanks for applying to" with a blank where the club name should be.
  - Its club link is `https://undefined.poolsideapp.com`.
  - Cause: `applications` submit loads the club without its name or web address. One-line fix.
- **A2. "Unlock the gate" shows even when the gate connection is offline.**
  - Tapping it waits 8 seconds, then fails.
  - Fix: `unlock_gate` check returns "offline" when the bridge hasn't been seen for a few minutes, and the card says so.
- **A3. Synced calendar events show 7 hours early.** The member home shows "Pool Open 12:00 AM – 1:00 PM" next to "Open today 8 AM – 8 PM".
  - Cause: `external_calendar` stores times from Google Calendar (which carry a timezone) as if they were UTC.
  - Fix: convert with the event's timezone. Also re-sync.

### B. Security, before any real member data
- **B1. Seven database functions can be triggered by anyone on the internet** (Supabase's own security advisor flags them):
  - 2 drain a club's prepaid text credits.
  - 5 run background jobs, including **auto-renew card charging**.
  - Fix: one migration revoking public access. Nothing legitimate calls them that way.

### C. Money and seasons (needs a decision)
- **C1. Signups from September through November buy the season that already ended.**
  - The form says "2026 Membership, $600" today. Next season only goes on sale December 1.
  - Options: sell next season from closing day, or pause the form with "2027 opens Dec 1 — join the list".
- **C2. Payment-plan families are told to pay right after paying.**
  - After the first installment, the approval text says "Last step is your dues — tap to sign in and pay".
  - They also get the generic welcome email, and the success page never shows the sign-in button.
  - Not hit at Bishop today, since no plan is set up.

### D. Friendlier screens
- **D1.** Apply form: every validation error shows twice.
- **D2.** Venmo confirmation says "1–10 days". The club's own setting (and the payment option) says 7.
- **D3.** A brand-new member's first screen says "Welcome back".
- **D4.** The member app uses 20 browser pop-ups.
  - Program and volunteer sign-up asks you to *type* who's signing up instead of picking from your family.
  - Errors appear as raw alert boxes.
  - Replace with in-page panels, starting with sign-ups.
- **D5.** With test mode off, the card option still appears for clubs whose Stripe isn't finished (Bishop's is not), then errors at checkout.
  - The "we'll email you a payment link" note is wrong in every case.
  - Fix: show card only when Stripe can actually charge, and delete the note.
- **D6.** Login has no "send it again" button, and the email path has no check-your-spam hint.
- **D7.** A 🧪 Test tag on simulated payments in the Members list, so they're easy to tell apart and clean up.

## Doug's own to-dos
- Set `SMS_GLOBAL_DAILY_CAP` back to 25 (Supabase → Edge Functions → Secrets).
- Decide on Supabase Pro ($25/mo): backups, and no pausing after 7 idle days.
- Keep the bridge off until its polling is fixed and the test households are deleted.
