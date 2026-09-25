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
  - 8 approved, paid SimTest households (4 more from the two A1 test runs on 9/24).
  - 2 unpaid SimTest …758543 applications left over from the failing run. The card one auto-deletes after 60 minutes.
  - Welcome emails went to doug.frevele+simtest…@gmail.com.
- Test mode is ON. Twilio balance is $5.99, about 700 texts.

## Step 7 — Real people try it
- Doug's wife, daughter, neighbor and board members sign up on the live site with their own info, fake-pay, get approved, and get the welcome email and text with a sign-in link.
- The gate card now says "Remote unlock is offline right now" while the bridge is off (A2, fixed 9/24).

## Before testers (found 9/24 walking the app at phone size)
- **T1. ✅ Fixed 9/25:** the emergency contact was being thrown away.
  - The signup form requires it, but the server never saves it: `applications` has no column for it, so it's dropped at submit.
  - The family's "Emergency contact" box is blank after approval.
  - Fix: save it on the application and copy it to the household at approval.
- **T2. ✅ Done 9/25:** cleared my leftover test data, so testers and Doug see only real people. The test scripts now remove their own families when they finish.
  - **Found while doing it:** Bishop's Google Drive backup has been disconnected since June (Google says "token expired or revoked"), so no application has been backed up. Doug has to reconnect it in Settings → Drive backup with his Google login.
  - 12 SimTest households and their applications.
  - An old automated-test program ("E2E Swim 736327", $50, "Coach E2E") that shows on the public page and in "Today".
  - Four stale "Gate bridge offline" tasks.
  - This also resets the "$7,200 collected" figure, which is counting fake payments.
- **T3. Bishop's own settings (Doug's call).**
  - Pool hours say 8 AM – 8 PM, but Bishop's Google Calendar says "Pool Open 7:00 AM – 8:00 PM", and both show together.
  - The home page still says "SUMMER 2026".
- **Tester notes.**
  - One signup per household. Each person needs their own email and cell, because the same one can't be used twice.
  - A daughter at home is best added from My family → Add a member, which also tests that feature.
  - Keep the platform daily text limit (`SMS_GLOBAL_DAILY_CAP`) at 100 until testing is over.

## Step 8 — Clean up (only when Doug says)
- Delete every SimTest and tester application and household, then turn test mode off.
- **Must happen before the gate bridge is turned back on.** Every approved test household has gate access.

---

## Proposed next steps from the 9/24 code review (each needs Doug's OK)

### A. Before testers start (small, today)
- **A1. ✅ Fixed 9/24:** the Venmo "application received" email was broken.
  - Its subject is "We got your application — " with nothing after it, and the body says "thanks for applying to" with a blank where the club name should be.
  - Its club link is `https://undefined.poolsideapp.com`.
  - Cause: `applications` submit loads the club without its name or web address. One-line fix.
- **A2. ✅ Fixed 9/24:** "Unlock the gate" showed even when the gate connection was offline.
  - Tapping it waits 8 seconds, then fails.
  - Fix: `unlock_gate` check returns "offline" when the bridge hasn't been seen for a few minutes, and the card says so.
- **A3. ✅ Done 9/24: every time in the app follows the pool's own time zone** (Doug, 9/24: "ALL times current to the pool — open/close, parties, events, etc.").
  - Proof: `scripts/test_pool_time.mjs` passes 35/35, including real pages on a New York clock and Bishop's real Google feed. "Pool Open" is now stored at 7:00 AM Pacific.
  - The page-render check passed 54/55. The one failure was a separate bug from 9/9 (Billing → text history crashed on an undefined helper), fixed in the same pass.
  - Also fixed along the way: guest passes expiring at 5 PM, evening lifeguard shifts opening on the next day, program dates showing a day early, and Drive sheet and PDF times stamped in UTC.

  **Found:**
  - Synced Google Calendar events show 7 hours early ("Pool Open 12:00 AM – 1:00 PM").
  - Party emails and texts print UTC: a 2 PM party says 9:00 PM.
  - The one-party-per-day rule (in the code *and* the database) uses UTC days. Any party after 5 PM counts as the next day, so two parties can book the same evening.
  - Deadlines ("today", payment-plan cutoff, early-bird, board meeting date, Drive sheet dates) flip to tomorrow at 5 PM Pacific.
  - Every screen shows the viewer's phone time, and times admins type are read in the admin's phone time. That's wrong for anyone outside the pool's zone (Doug setting up a Texas club, a treasurer on vacation).
  - Weekly repeating events shift an hour across daylight-saving changes for those viewers.

  **Sub-steps.** Each one gets a failing test first, then the fix, then proof.
  - **A3.1 Each club gets a time zone.**
    - New `tenants.timezone` field. Bishop = Pacific.
    - Club owners can change it in Settings. New clubs get it automatically from the signup browser, and can change it.
    - The member app, admin pages and public page all receive it with the club details they already load, so no extra calls.
  - **A3.2 Server uses pool time.**
    - A shared `pool_time` helper.
    - Party emails and texts, and every "today" and deadline check, use it.
    - The one-party-per-day rule keys on the pool's date: a database trigger stamps each party's pool date, and the unique index moves to that column.
  - **A3.3 Calendar sync reads Google's time zone**, including all-day events. Then Bishop's feed is re-synced.
  - **A3.4 Every date and time a club page shows is in pool time**, whatever the phone's zone is. One shared `js/pooltime.js`.
    - This covers the member app, public club page and club admin.
    - Doug's own cross-club `/admin` pages are left alone.
  - **A3.5 "Today" and typed-in times are pool time.**
    - What's-on-today, open/closed, the calendar grid, weekly repeats and the check-in counter.
    - Admin event/party/volunteer/lifeguard/meeting/campaign times, and the member's party request form.
  - **A3.6 Proof.**
    - A targeted test script for the server parts.
    - The key pages opened in a headless browser with its clock set to New York; they must still show Pacific times.
    - Cost: about 100–200 calls.

### B. Security, before any real member data
- **B1. ✅ Fixed 9/24:** seven database functions could be triggered by anyone on the internet (Supabase's own security advisor flagged them).
  - Proof: `scripts/test_rpc_lockdown.mjs` passes 11/11. A stranger is refused on all seven, the server still spends text credits, and the scheduler ran a job after the lock.
  - New functions now start private, so this can't creep back. The advisor no longer flags any open functions.
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
- **D8.** Member home: put "your family · dues paid" near the top. Right now it's the last card, under photos, news and the calendar.
- **D9.** "Coming up: No upcoming events" sits above a calendar full of events, because feed events (Google Calendar) aren't counted. The admin dashboard's "Upcoming events: 0" has the same cause.
- **D10.** The admin money ticker counts simulated payments as money collected. Show them separately, or leave them out.
- **D11.** Gate-offline alerts pile up: four open tasks for the same outage. Keep one open task per outage.
- **D12.** Members → Households on a phone: the table is cut off after two columns (dues and fob are off-screen), and the Help button covers the list. Use cards on narrow screens.
- **D13.** Login: the placeholder is cut off on phones, and the button says "Send me a link" even when a phone number gets a code instead.

### E. Member help requests (Doug, 9/25)
Goal: a member sends a question or problem from the app. It goes to the one board member who handles that topic, it's tracked until solved, and the board texts the member back.

Doug decided (9/25):
- Topics: Keyfob & gate, Membership & dues, Parties & events, Pool problem. Anything else, or a topic with nobody assigned, goes to the president.
- Members send it in the app, not by text. They can add a photo.
- The assigned board member gets a phone pop-up only, no text or email.
- Board replies are saved in the app and texted to the member.
- No reminders. Open requests stay on the dashboard until someone marks them solved.

What exists today: only the anonymous feedback box. It can't route or reply, and its alerts reach only the president. It stays as is, for anonymous suggestions.

Defaults I chose (say if any are wrong):
- The pop-up goes only to the assigned person. The president can see every request, but only gets pop-ups for unassigned topics.
- A board member can hand a request to someone else ("this is really a keyfob thing").
- If the member has no cell number, the reply goes by email instead.
- The member sees their requests, status and replies in the app, and can reply back.
- Photos are private: only the member and the board can open them.
- A board member who handles a topic but hasn't turned on pop-ups sees a warning on their dashboard. With "pop-up only", that person otherwise gets nothing.
- The gate's "Ask the board to enable keyfob access" message links straight to a Keyfob help request.

Steps (each: failing test first, then the fix, then proof; about 10–30 Supabase calls each):
- **E1. ✅ Done 9/25: tasks can be for one person.**
  - Proof: `scripts/test_task_routing.mjs` passes 20/20, including two temporary board logins: the keyfob person sees and closes their task, and the party person, who has the same permission, can't see it. Cost: 4 calls, plus 6 to start the deployed functions and about 10 for the page check.
  - Added: every board member now gets a "Turn on pop-ups" card on the dashboard. The only switch was in Settings, which only the president can open, so nobody else could ever have received a pop-up. On an iPhone that hasn't added the board app to its Home Screen, the card explains how.
  - Also: tasks meant only for the president never popped up at all. They do now.
  - Dashboard tasks can name one board member. Only that person and the president see them, and the pop-up goes only to that person.
  - Also fixes a mislabel. Some alerts are tagged with permission names that don't exist ("operations", "membership"), so only the president ever sees them. This covers anonymous feedback, gate offline and "primary member changed". Gate offline goes to the keyfob person.
- **E2. ✅ Done 9/25: help requests on the server.** New `help_requests` function and tables. Photos are stored privately.
- **E3. ✅ Done 9/25: member app.**
  - "Ask the board" is in the hero and in a "Questions for the board" card. Pick a topic, write, and optionally add a photo (shrunk on the phone).
  - The member sees who it went to, its status, and replies, and can reply back.
  - The reply text's link opens the conversation, even from a signed-out phone after signing in.
  - The gate's "not set up" message offers Ask the board with the keyfob topic.
- **E4. ✅ Done 9/25: board side.**
  - A Member help inbox (Content → Member help, plus a dashboard card) with Open / Solved / All.
  - The conversation, a reply box that texts the member, I'm on it / Mark solved / Reopen, hand-off, and delete (president only).
  - "Who handles what" sits at the top of the inbox, not in Settings, because Settings is president-only and the inbox is where everyone looks. The president picks, and everyone sees it.
  - A board member who gets questions but has pop-ups off on every device gets a dashboard warning they can't dismiss.
  - Proof: `scripts/test_help_requests.mjs` passes 46/46.
    - Routing by topic, and the president for "Something else".
    - Nobody else can see a request.
    - A private photo.
    - Reply texted to the member.
    - Member reply, hand-off, solve, reopen by reply, and Done on the dashboard = solved.
    - President-only delete removes the photo.
    - Only the president picks topics.
  - Also walked through both sides in a phone-sized browser.

### F. Board meeting minutes (Doug, 9/25)
Already built: a start button that records the time; attendance checkboxes from the board members in the app, plus a box to add people by hand; notes; motions with vote counts; follow-ups; and a public minutes page (footer link "Bylaws & board minutes").

Doug decided (9/25):
- Any board member can start a meeting and take notes.
- Closing a meeting puts it on the public page right away.
- Afterward, only the note-taker and the president can edit, and the page shows "edited on".
- Follow-ups stay on the assigned person's dashboard until marked done.

Problems found:
- New meetings default to "Board only", so closing one doesn't publish it.
- Only the secretary and the president can use it. Kristin can't.
- Re-opening to fix a typo erases the real end time, and when it's closed again, the end time becomes the edit time.
- The minutes disappear from the public page while being edited.
- There's no record of edits, and anyone with access can permanently delete published minutes.
- The public page doesn't show what time the meeting started and ended.
- Starting takes two steps (New meeting, then Start).

Steps (each: failing test first, then the fix, then proof):
- **F1. ✅ Done 9/25: anyone on the board can start.**
  - Proof: `scripts/test_board_meetings.mjs` passes 22/22 with temporary board logins. A board member without the secretary permission starts a meeting in one tap. Another board member can read it but can't change it, and the president can. Also checked in a phone-sized browser: dashboard → Start a meeting → the clock is running; a second board member sees it read-only.
  - The dashboard has a "Start a meeting" card, since some board members can't see the Content tab. If a meeting is already running, it offers to open that one first.
  - Lifeguard / gate-iPad logins are not board members. They can't open minutes and aren't on the attendance list.
  - One "Start a meeting" button creates the meeting and starts the clock, with a running timer.
  - Every board member can read all minutes, including board-only ones.
- **F2. ✅ Done 9/25: closing publishes.**
  - Proof: `scripts/test_board_meetings.mjs` passes 32/32. A new meeting is public. Closing it puts it on the public list, and the public page shows it as "Friday, September 25, 2026 · 7:02 PM – 8:15 PM" even on a New York phone clock. A board-only closed session stays off the page, but every board member can still read it.
  - The button now says "Close meeting", and its confirmation says whether the minutes go public. The closed banner shows the times and links to the public page.
  - Bishop's one existing meeting (an empty June draft) keeps its board-only setting.
  - New meetings are public by default, with a board-only switch kept for closed sessions (member discipline, legal).
  - The public page shows the date plus start and end times.
- **F3. ✅ Done 9/25: edits after closing.**
  - Proof: `scripts/test_board_meetings.mjs` passes 41/41 (`--offline` runs just the free checks).
    - The note-taker fixes closed minutes. They stay closed and public with the same start and end times, record who edited them, and the old version is in the audit log.
    - Another board member can't fix them. The note-taker can't delete them, and the president can (a copy goes to the audit log).
    - The public page shows "Edited Sep 25 by …".
    - Also clicked through in a phone-sized browser: typing shows "Not saved yet", and Save changes shows "edited Sep 25 by …" with the times unchanged.
  - "Re-open for editing" is gone. Closing twice no longer moves the end time.
  - Closing the editor with unsaved fixes asks first.
  - The note-taker and the president can edit a closed meeting. It stays public, and its real start and end times are kept.
  - Changes are saved with a Save button. The page then shows "Edited Sep 30 by Kristin", and the previous version is kept in the audit log.
  - Only the president can delete published minutes.
- **F4. ✅ Done 9/25: follow-ups are tracked.**
  - Proof: `scripts/test_board_meetings.mjs` passes 48/48.
    - Nothing goes on a dashboard while the meeting is running.
    - Closing puts the board member's follow-up on their dashboard with its due date, and leaves out one for a non-board member.
    - Marking it done on the dashboard marks it done in the minutes.
    - A follow-up added after closing goes on the dashboard, and marking it done in the minutes clears it.
  - Typing a board member's name (from the suggestions) links it. A hint under the row says whether it goes on their dashboard or stays in the minutes only.
  - Each follow-up can be assigned to someone from the board list, or to a typed-in name for someone who isn't on the board.
  - When the meeting closes, each follow-up assigned to a board member becomes a task on that person's dashboard, with its due date and a pop-up. Uses E1.
  - Marking it done in either place marks it done in both.

Suggested order: E1 first (both features use it), then F1–F4 (small, mostly fixes), then E2–E4.

## Doug's own to-dos
- Set `SMS_GLOBAL_DAILY_CAP` back to 25 (Supabase → Edge Functions → Secrets).
- Decide on Supabase Pro ($25/mo): backups, and no pausing after 7 idle days.
- Keep the bridge off until its polling is fixed and the test households are deleted.
- Reconnect Google Drive (Settings → Drive backup). It has been disconnected since June.
- Invite the other board members as admins (keyfob, parties, etc.). Only Doug and Kristin are in the app today. Each one turns on pop-ups once from the dashboard; on iPhone, the admin page has to be added to the Home Screen first.
