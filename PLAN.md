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

### D. Friendlier screens — ✅ all done 9/25
Proof: `scripts/test_screens.mjs` passes 41/41: 28 offline checks, 3 live (`--live`), and 12 in a phone-sized browser (`--render`).
- **D1. ✅** Signup form errors show once. A missing field gets its message right under that field; a whole-step problem shows next to the button.
- **D2. ✅** The Venmo thank-you uses the club's own wait (Bishop: 7 business days), not "1–10 days".
- **D3. ✅** A member's first visit says "Welcome to…", and later ones say "Welcome back".
- **D4. ✅** The member app has no browser pop-ups left (there were 20).
  - Messages and confirmations are in the page.
  - Program and volunteer sign-ups pick from your family, with "Someone else" to type a name.
  - Found along the way: every Cancel button in the member app's pop-up panels, plus "+ Upload a photo" and "Join waitlist", was white text on white. Fixed.
- **D5. ✅** Card payment is offered only when Stripe can actually charge (or test payments are on). The wrong "we'll email you a payment link" note is deleted.
- **D6. ✅** Sign-in: after sending, the button counts down to "Send it again". The email message says to check spam and promotions.
- **D7. ✅** Families paid with a test payment get a 🧪 Test tag in Members.
- **D8. ✅** The family and dues card is right under the greeting on the member home.
- **D9. ✅** "Coming up" and the dashboard's "Upcoming events" include Google Calendar events.
  - A daily event like "Pool Open" is left out, since Today already shows the hours.
  - A weekly event shows only its next date.
- **D10. ✅** The "$ collected" total leaves out test payments and says how many it left out.
- **D11. ✅** Gate-offline alerts: one open task per outage, closed automatically when the bridge comes back. The "back online" and "integration is live" pop-ups no longer use the made-up "operations" label.
- **D12. ✅** Members → Households shows as cards on a phone. Admin pages leave room under the list so the Help button doesn't cover the last row.
- **D13. ✅** The sign-in box placeholders fit on a phone (member and board). The member button says "Text me a code" or "Email me a link", depending on what's typed.

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

### G. Sign in with Google removed (Doug, 9/25) — ✅ done
- Google's login for Poolside is still in Testing mode, so only people on its test list could use it. Everyone else got "Access blocked".
- Removed:
  - The buttons and code on the member and board sign-in pages and the start-a-club page.
  - The join-form prefill, the club-signup Google branch and the `google_oauth` function (undeployed).
  - Its website forwarding rule, the stored Google IDs, and the privacy-page lines.
- Sign-in is now a cell number with a 6-digit text code (listed first), or an email link as the backup. The board also has email + password.
- Google Drive backup is separate and kept. It still needs the Google app published (not Testing), then a Drive reconnect.
- Proof: `scripts/test_screens.mjs --live`, G1 checks.

### H. From Doug's own signup test (9/26)
Doug decided (9/26):
- Referral reward is $100 per new family, as credit or (if the member wants) a refund. The board approves each one.
- It's capped at a free membership.
- A new family joining through a link saves $25, set in the board settings.
- Early bird becomes a discount code, open to everyone.
- One discount per membership: the bigger one applies.

Found while looking:
- An approved referral credit is saved on the family but never taken off anything, so they'd pay full price.
- The early-bird setting only shows a banner. Checkout never applies the discount.

Steps (each: failing test first, then the fix, then proof):
- **H1. ✅ Signup page 1 asks "Your name".** It fills in Adult #1 on page 2, and the family last name from it (both editable). Today page 1 only asks for the family last name, so Adult #1 starts empty.
- **H2. ✅ Membership level defaults by headcount.** 2+ people picks Family; 1 adult picks Single. Anything the family picks themselves is left alone. Choosing Single with 2+ people shows a gentle note.
- **H3. ✅ Member sign-in formats the number as you type** — (925) 771-9074, the same as the board sign-in.
- **H4. Payment plan deadlines work across New Year.**
  - Deadlines are ordered by season (fall → spring → summer), so a plan like "50% by Dec 1, the rest by May 1" saves.
  - The last deadline is always "the rest (100%)", with no box to fill in.
  - Today they're sorted Jan–Dec, so December counts as "last" and the save fails whatever you type.
  - The server places fall deadlines in the calendar year before the season too.
- **H5. Discounts actually come off the price.**
  - Each signup or renewal carries a code discount and a referral credit. Card checkout, payment plans and the Venmo amount all use the reduced price.
  - If it comes to $0, "Confirm, nothing to pay" marks them paid.
  - The credit and code use are recorded only once the payment clears.
- **H6. Referral rewards: credit or refund, approved, tracked** (Doug, 9/26).
  - **Settings** (board admin → Referral program): the member's reward (default $100) and the new family's discount (default $25).
  - **The new family** saves $25 when they join through a member's link. Only one discount per membership: if they also have a code, the bigger one applies, and they're told so.
  - **The referring member always earns their full reward**, even when the new family ends up using an early-bird code instead of the referral discount (Doug, 9/26).
  - **The 30-day wait, known on all sides:**
    - The Refer panel explains the rules up front: 30 days after the new family pays; credit or refund; the board approves; up to a free membership.
    - The member gets a text when the new family pays ("The Johnsons joined with your link. Your $100 unlocks Oct 26") and another on unlock day.
    - The board's approval screen shows the unlock date and can't approve before it.
    - A nightly job (1 call a day) unlocks rewards.
  - **The member chooses** credit toward their next dues (the default) or a $100 refund. Either way it goes to the board.
  - **Approval:** a board member with the payments permission, never for their own family. The approval screen spells it out: "The Smiths referred the Johnsons." It shows both payments, each with the date it was verified, who verified it, and its transaction code (Stripe payment ID, or the Venmo/check reference).
  - **Refund:**
    - To the card the member paid their dues with, through Stripe, which sends a receipt automatically.
    - Or by Venmo or check, with the reference required.
    - The member is texted when it's approved and when it's sent.
  - **Safety:** if the new family's payment is refunded or cancelled first, the reward is cancelled. Credit plus cash never adds up to more than the member's own membership.
  - **Tracking:** a Referral rewards list under Money: who referred whom, both payments, unlock date, approved by, paid by and how, reference, and totals (credit owed, cash paid this season). Every step is also in the audit log.
- **H7. Discount codes.**
  - The board makes codes under Money: a code, $ or % off, an expiry date, and optionally a limit on how many families can use it. The early-bird setting becomes one of these.
  - The signup form and the renewal page get "Have a code?". It's checked on the server, and the new price shows before paying.
  - A code can be marked "show on the member home" to replace the early-bird banner, so no campaign is needed.

### I. Trim the app (Doug, 9/26: "too many features… too convoluted")
Doug chose to delete the duplicates and fluff only. Sponsors, donations, Google Drive backup, auto-renew, email templates, photos, programs, volunteer and lifeguards all stay.
Suggested order: before H, so H7's discount codes don't have to live alongside campaigns.
- **✅ I1. Anonymous feedback → gone.** Ask the board covers it (topic "Pool problem", with a photo).
  - Removed: the feedback card and form on the member home and public page, the board's Feedback page, and the `feedback` function.
  - The one stored message is shown to Doug before its table is dropped.
- **✅ I2. Campaign pop-ups → gone.** News posts cover announcements, and H7's discount codes cover early bird.
  - Removed: Money → Campaigns, the `campaigns` function, and the pop-up code on the member home and public page.
- **✅ I3. The Impact page → gone** (Insights → Impact, "Where the time went"). The `impact` permission leaves the role templates and permission list.
- **✅ I4. The member-count line in the member home greeting → gone.** The public page keeps its "X families" line, which can be switched off in Settings.
- **✅ I5. Guest-pass leftovers → gone.** The feature was retired 9/7, but its function, checkout path, payment-report branches and empty tables are still there.
- **Proof:** `scripts/test_screens.mjs` I checks.
  - Nothing links to or calls any of these.
  - The functions are undeployed and the empty tables dropped.
  - The public page, member home, Members and board pages load clean.
  - `test_payments.mjs` still passes 24/24 after the payment functions changed.
  - Board pages went from 38 to 35, and server functions from 54 to 50.

### J. Consolidate setup and settings (Doug, 9/26: "too many setup areas?")
Doug chose all of these. Rule: every setting is edited in exactly one place, and every other screen links there.
- **J1. One setup checklist, on the dashboard.**
  - Replaces the setup wizard, the "Finish setting up" page, the setup banner on every page, and both dashboard cards.
  - One list: logo, front-page headline, pool location and hours, membership prices, how members pay, policies and waivers, sign up your own family, invite your board, share your join link.
  - Each item opens the real settings screen. The wizard's copies of those screens are deleted.
  - New clubs land on the dashboard with the checklist open. A small "Setup: 5 of 9" note on other pages links back to it until it's done.
- **J2. Status page folds into the checklist.** "What members can do right now" becomes checklist lines. Email and text provider checks move to Doug's provider admin, since a club board can't fix them anyway.
- **J3. Phone alerts are on the dashboard only.** The duplicate card in Settings goes.
- **J4. Each thing in one place.** The Apply form page keeps its heading and links to Policies, Emails and Season instead of repeating their editors.
- **J5. One Season section in Settings:**
  - Pool season dates, and signups open/closed with the closed message.
  - New: "Next season goes on sale on ___". There's no screen for this today; it silently defaults to December, and it decides which season a payment buys (C1, and H4's plan deadlines).
- **J6. One source for pool hours: Settings** (Doug, 9/26).
  - Optionally a different time per day of the week.
  - Calendar-feed events that repeat on most days (Google's daily "Pool Open") are hidden from Today and the calendar, so hours never show twice.
  - Doug: confirm Settings has the right opening time. It says 8 AM; Google Calendar says 7 AM.
- **J7. One Gate & check-in section in Settings.** Merges "How members get in" and "Remote keyfob access". Shows only methods that exist (the three "coming soon" ones go). The lifeguard-tablet switch lives here.
- **J8. One Money setup page.** Sections:
  - Membership prices (the Tiers page merges in)
  - How members pay (Stripe, Venmo, PayPal, card-fee pass-through)
  - Payment plans
  - Discounts (H7's codes and H6's referral settings, instead of new pages)
  - Late fees
  - Test payments

  Early bird leaves Members → Renewals.

**Suggested order:**
1. H1–H3 (quick signup and sign-in fixes testers will hit).
2. I (trim).
3. J (consolidate).
4. H4–H7 (plans, discounts and referrals, which land in J8's Money setup page).

## Doug's own to-dos
- Set `SMS_GLOBAL_DAILY_CAP` back to 25 (Supabase → Edge Functions → Secrets).
- Decide on Supabase Pro ($25/mo): backups, and no pausing after 7 idle days.
- Keep the bridge off until its polling is fixed and the test households are deleted.
- Reconnect Google Drive (Settings → Drive backup). It has been disconnected since June. First publish the Google app (console.cloud.google.com → Poolside project → Google Auth Platform → Audience → Publish app), or it will drop again after 7 days.
- Invite the other board members as admins (keyfob, parties, etc.). Only Doug and Kristin are in the app today. Each one turns on pop-ups once from the dashboard; on iPhone, the admin page has to be added to the Home Screen first.
