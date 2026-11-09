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
- Only the secretary and the president can use it. Pat can't.
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
  - Changes are saved with a Save button. The page then shows "Edited Sep 30 by Pat", and the previous version is kept in the audit log.
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
- **H3. ✅ Member sign-in formats the number as you type** — (555) 010-0199, the same as the board sign-in.
- **H4. ✅ Payment plan deadlines work across New Year.**
  - Deadlines are ordered by season (fall → spring → summer), so a plan like "50% by Dec 1, the rest by May 1" saves.
  - The last deadline is always "the rest (100%)", with no box to fill in.
  - Today they're sorted Jan–Dec, so December counts as "last" and the save fails whatever you type.
  - The server places fall deadlines in the calendar year before the season too.
  - Also fixed: a family joining after a deadline pays that share in their first payment instead of being refused a plan, the signup form stops offering pay-in-two once the last deadline has passed, and keyfobs aren't switched off over a fall deadline.
- **H5. ✅ Discounts actually come off the price.**
  - Each signup or renewal carries a code discount and a referral credit. Card checkout, payment plans and the Venmo amount all use the reduced price.
  - If it comes to $0, "Confirm, nothing to pay" marks them paid.
  - The credit and code use are recorded only once the payment clears.
  - Also fixed: one-click Approve in the Pipeline was making every family a Family household whatever level they picked, which sets their renewal price. The Venmo check now shows the amount after discount.
- **H6. ✅ Referral rewards: credit or refund, approved, tracked** (Doug, 9/26).
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
  - **Safety:** if the new family's payment is refunded or canceled first, the reward is canceled. Credit plus cash never adds up to more than the member's own membership.
  - **Tracking:** a Referral rewards list under Money: who referred whom, both payments, unlock date, approved by, paid by and how, reference, and totals (credit owed, cash paid this season). Every step is also in the audit log.
  - Also fixed: the "new to the club" check ran after the new family's own household existed, so every referral would have been rejected. "Approve & verify Venmo" never started the referral at all. Refunded and disputed card payments couldn't be recorded (the database refused the status), so a refund couldn't void anything.
- **H7. ✅ Discount codes.**
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
  - Board pages went from 38 to 34, and server functions from 54 to 50.

### J. Consolidate setup and settings (Doug, 9/26: "too many setup areas?")
Doug chose all of these. Rule: every setting is edited in exactly one place, and every other screen links there.
- **✅ J1. One setup checklist, on the dashboard.**
  - Replaces the setup wizard, the "Finish setting up" page, the setup banner on every page, and both dashboard cards.
  - One list: logo, front-page headline, pool location and hours, membership prices, how members pay, policies and waivers, sign up your own family, invite your board, share your join link.
  - Each item opens the real settings screen. The wizard's copies of those screens are deleted.
  - New clubs land on the dashboard with the checklist open. A small "Setup: 5 of 9" note on other pages links back to it until it's done.
- **✅ J2. Status page folds into the checklist.** "What members can do right now" becomes checklist lines. Email and text provider checks move to Doug's provider admin, since a club board can't fix them anyway.
- **✅ J3. Phone alerts are on the dashboard only.** The duplicate card in Settings goes.
- **✅ J4. Each thing in one place.** The Apply form page keeps its heading and links to Policies, Emails and Season instead of repeating their editors.
- **✅ J5. One Season section in Settings:**
  - Pool season dates, and signups open/closed with the closed message.
  - New: "Next season goes on sale on ___". There's no screen for this today; it silently defaults to December, and it decides which season a payment buys (C1, and H4's plan deadlines).
- **✅ J6. One source for pool hours: Settings** (Doug, 9/26).
  - Optionally a different time per day of the week.
  - Calendar-feed events that repeat on most days (Google's daily "Pool Open") are hidden from Today and the calendar, so hours never show twice.
  - Doug: confirm Settings has the right opening time. It says 8 AM; Google Calendar says 7 AM.
- **✅ J7. One Gate & check-in section in Settings.** Merges "How members get in" and "Remote keyfob access". Shows only methods that exist (the three "coming soon" ones go). The lifeguard-tablet switch lives here.
- **✅ J8. One Money setup page.** Sections:
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

### K. Board positions, notifications by position, and the bylaws (Doug, 10/4)
Doug's ask: the club's board positions with job descriptions, editable during club setup and any time after, and notifications go to whoever holds the position. Plus a place for the bylaws, always public, next to the minutes.

Doug decided (10/4):
- Positions replace roles: a position decides the person's screens and alerts.
- Add a member help topic "Grounds, bathrooms & cleaning", going to the Grounds Director.
- Documents: just the bylaws, public, with old versions kept.
- The public "Bylaws & board minutes" page shows the board: names and positions. Job descriptions stay board-only.

What's there today: fixed "roles" (Board chair, Treasurer, Membership chair, Volunteer coordinator, Communications, Secretary) that only decide which screens someone sees, a free-text title, and alerts routed by screen permission. Member help topics are assigned to people separately, on the Member help page. The public "Bylaws & board minutes" page exists but has no bylaws (the documents section was removed in May).

Steps (each: failing test first, then the fix, then proof):
- **✅ K1. Positions in the database.** Each position has a title, a one-line purpose, the full job description (editable text), what it gets told about, and what screens it can use. One person can hold several positions (the Vice-President is a second title), and a position can have more than one holder. A club-wide spending rule shows above them all ("Under $50, go ahead. $50 or more needs board approval."). Bishop starts with Doug's seven, word for word. New clubs start with the same seven without the Bishop-only details (bylaw article numbers, 2027 goals, the 170 homes), ready to edit. Doug is set as President. Pat keeps her current access until Doug gives her a position.
- **✅ K2. One Board page** under Settings, replacing "Admins & roles". The spending rule, then each position: who holds it, what it's told about, and its job description. The president edits a position's text, notifications and screens, and assigns someone or invites a new person straight into it. A person's title and access follow their positions. There's always someone with full access. Lifeguard and gate-iPad logins are made here too. A change to someone's access applies on their next click, not when their sign-in renews (that was already true of the old roles, up to a week late).
- **✅ K3. Notifications follow positions.** Each kind of alert belongs to a position. The dashboard task and phone pop-up go to whoever holds it now. An empty position's alerts go to the President, and to the Vice-President if that's empty too. Reassigning a position moves its open tasks with it. Member help topics move here from the Member help page. Gate alerts go to the Facilities Director. Board replies to members are signed with name and position. Proposed for Bishop:
  - President: club business (Poolside plan and billing), member help "something else", and anything whose position is empty.
  - Treasurer: new signups and family changes, payments to check (Venmo, refunds, disputes, failed cards, lapsed plans), referral rewards to approve, member help "membership & dues".
  - Facilities Director: gate and keyfob alerts, member help "keyfob & gate" and "pool problem".
  - Grounds Director: member help "grounds, bathrooms & cleaning" (new topic).
  - Membership & Marketing Director: photos to approve.
  - Events & Rentals Director: party and rental requests and their payments, member help "parties & events".
  - Secretary and Vice-President: nothing on their own today. Meeting follow-ups already go to whoever they're assigned.
- **✅ K4. "My job" on the dashboard.** Each board member sees their position, its purpose and the full description, so every director has their list in front of them.
- **✅ K5. Setup checklist.** "Invite the rest of your board" becomes "Set up your board positions", opening the Board page. It's done when another board member holds a position.
- **✅ K6. Bylaws.** The President or Secretary uploads the bylaws PDF on the Board minutes page. It shows at the top of the public "Bylaws & board minutes" page, always, and the member app links there. Replacing it keeps the old versions with their dates. The same public page lists the board: names and positions.

### L. Meeting agendas from one-liners (Doug, 10/6)
Doug decided (10/6):
- Any board member can add an item for the next meeting at any time: one line, 100 characters at most ("Bathrooms have been complained about").
- Right before the meeting, anyone presses "Create agenda". It builds the agenda in the standard format, with each person's items under their name.
- The agenda is board-only, and anyone on the board can see it at any time. It's sent only when someone presses "Send to the board".
- Anything not checked off at the meeting carries over to the next one. Anything added after the agenda is made still joins it, until the meeting starts.

The format:
1. Call to order and roll call
2. Approve the minutes of the last meeting
3. Reports and items: each position in board order with its holder, and the one-liners that person added under them. Then anyone on the board without a position.
4. Open action items from past meetings (follow-ups not yet done)
5. Action list: who, what, by when
6. Set the next meeting, adjourn

Steps (each: failing test first, then the fix, then proof):
- **✅ L1. One-liners for the next meeting.** A "Next meeting" card on the Board minutes page: an "Add to the agenda" box (one line, 100 characters, with a counter) and the list of what's waiting, each with who added it. People can change or remove their own items; the president can remove anyone's.
- **✅ L2. Create agenda.** It uses the next planned meeting, or asks for the date, time and place and plans one; a meeting can now have a start time. It builds the agenda above, and "View agenda" shows it to any board member.
- **✅ L3. Send to the board.** It goes to every board member by text or email (their own preference), plus a pop-up, with a link to the agenda. Only when someone presses the button. "Send again" is there if it changes.
- **✅ L4. At the meeting.** The meeting's notes screen lists the agenda items to check off. When the meeting closes, anything not checked off goes back on the list for the next meeting, marked where it came from.

### M. Flexible payment plans (Doug, 10/7)
Doug's spec (10/7): a family pays in full, or picks how much to pay today (any amount, $0 included) and the month to be paid off by. The app splits the rest evenly by month, shows every date and amount before they commit, and charges the saved card on each date until it's paid. Everything is built and tested in Stripe test mode first.

Doug decided (10/7):
- Prices stay editable for each membership type. Keep the reactivation fee, with the amount editable.
- Gate access and the key fob start once half is paid. If it isn't fully paid by the "paid in full by" date, the fob is shut off.
- Bishop's deadlines: half by April 10, paid in full by July 15. The board can change them on the Payments page.
- When a card keeps failing, the app turns off the fob and the gate unlock, and flags the family to the board. We use our own retries (4 tries over 2 weeks) rather than Stripe's invoicing.
- A family that cancels partway through gets no refund. When a plan lapses, an email tells them their membership is canceled and how to pay the reactivation fee to come back.
- Poolside takes the $4 per plan payment from every club. Bishop pays no fees at all until Doug switches them on.

Decisions I made:
- Monthly payments fall on the day of the month the family signs up, the 28th at most. The last payment is never later than the paid-in-full date.
- Today's payment is $0, or at least the club's minimum payment.
- When a club passes card fees on to members (Bishop does), each plan payment carries its own card fee, so the club pays nothing.
- Members get a receipt for each payment and an email when one fails. The reminders 14, 7 and 1 days before each charge are turned off.
- A monthly charge is marked paid from Stripe's direct answer to our charge. That's as sure as a webhook, since we made the call ourselves. Card setups and payments made on Stripe's page come in through the signed webhook.
- Paying off early drops any plan fees that haven't been charged yet.

Done 10/7: `node scripts/test_flex_plan.mjs` (offline, 61 checks; `--live` runs M8 on a throwaway club, about 40 calls) and `RENDER_ONLY=plans node scripts/test_screens.mjs --render`.
Families only see a plan once the season on sale has deadlines still ahead. Bishop sells 2026 until next season goes on sale (December 1 by default, Settings → Season, C1), so the plan option appears then.

Steps (each one: a failing test first, then the fix, then proof):
- **✅ M1. The calculator.** Given the price, today's amount and the payoff month, it works out every date and amount, and checks the half-paid and paid-in-full dates. When a plan misses the half rule, it gives the reason and the least the family must pay today. Tested on Doug's Members A, B and C, the rounding case, a late joiner after the half date, and signing up after the paid-in-full date (pay in full only).
- **✅ M2. Club settings** (Payments page):
  - Plans on or off.
  - The deadlines: half by, paid in full by.
  - Minimum payment.
  - Reactivation fee.
  - Which membership types can use a plan.
  - When the gate and fob start: card saved, first payment, or half paid.

  Bishop gets: on, half by April 10, full by July 15, half paid, $25 minimum, $50 reactivation.

  The season's open and close dates stay in Settings → Season. "Turn things off when the pool opens" uses that start date.
- **✅ M3. Choosing a plan** (joining, and renewing): "Pay in full" or "Payment plan", with "pay today" and "paid off by". The schedule shows before they commit, worked out by the server. If the plan misses a deadline, the screen says why and offers the least amount that works. With $0 today, the card is saved on Stripe's page without a charge. Also fixes C2: plan families were told to pay right after paying.
- **✅ M4. Charging.**
  - Each payment goes on its date and comes with a receipt. The plan stops at the total. Retries can't double-charge.
  - A failed card gets one email to the family and up to 4 tries over 2 weeks.
  - Once half is paid, the gate opens and the Facilities Director is told the fob can go on.
  - If the card still fails, the plan lapses. The family is told their membership is canceled and how to come back. The Treasurer gets one email. Gate unlock goes off, and the Facilities Director is told to turn off the fob, starting when the season starts.
  - The same happens to anyone not fully paid by the paid-in-full date.
- **✅ M5. The family's plan in the app.**
  - Shows what's paid, the balance, the next charge and the whole schedule.
  - Update card: if a payment failed, the new card pays it at once.
  - Pay off now.
  - Cancel: no refund, and it works like a lapse.
  - Reinstate: pay what's overdue plus the reactivation fee.
- **✅ M6. The board's table** on Payments.
  - Columns: member, plan, paid, balance, next charge, status (current, past due, paid in full, canceled) and fob (on, not yet, turn off).
  - Past due shows in red.
  - Tap a row for its payments, Mark paid and the reactivation link.
- **✅ M7. Fees.** Turn on Bishop's existing "no Poolside fees" switch. The $4 plan fee stays for every other club.
- **✅ M8. Live test** on a throwaway club with its own Stripe test account and Stripe's test cards. It covers a plan from start to finish, a declined card, a card updated after a failure, paying off early, canceling, a late joiner and the rounding. Then the club is deleted.

### N. From Doug's own signup test (10/7 evening)
What I found:
- Signing up with a phone or email already on file only fails at the last step. A family who backs out of the card page is stuck too: their unpaid application blocks a second try (memory: plan auto-renew + checkout dead end).
- iPhone: the Home Screen app keeps its own storage, separate from Safari's, so it asks you to sign in again. Android doesn't do this.
- The member home's "Add to Home Screen" card only shows Safari's steps. The shared install guide (js/pwa.js) already knows Chrome's, but the member home doesn't use it.
- Parties: members pick a start and an end. The board's "Approve with changes" puts two date-and-time boxes side by side, which runs off a phone screen.
- Party approval sends an email only, no text.
- A photo upload makes a dashboard task but never a pop-up: it skips enqueueAdminTask, so it doesn't follow positions either. (Doug's pop-ups were turned on after the upload anyway.)
- Board replies to help requests are texted, but a text back goes nowhere. There is no incoming-text handling.
- Members have no pop-up notifications at all; only the board does. Announcements reach members only by the separate "Text all members".
- "Text all members": opened and previewed, but nothing was queued (no rows). Needs reproducing at phone size.
- Sponsors → Add sponsor is offset on a phone. Every page and pop-up needs a phone-width check.

Doug decided (10/7):
- Members get notices by pop-up in the app, plus email where it makes sense. Texts are only for "Text all members", sign-in codes and the welcome text at approval.
- Help requests: answered in the app on both sides, with no texts. Texts cost about a penny each way and count against the allowance.
- Every member notice is a pop-up for members who turned pop-ups on: board replies, party decisions, plan receipts, announcements.
- Announcements: a "Notify members" switch on each post, on by default. Members without pop-ups get no email for announcements.
- Meeting agendas: in the app only (pop-up), not by text or email.
- Parties: a fixed length, set by the board (4 hours to start). The board can still change the time when approving.
- Pat: removed from the board. Vice-President stays as an open position. Done 10/7: her leftover hold on it is cleared. Removing someone has to drop their positions too (bug).

Done 10/7–8. Checks: `node scripts/test_signup_notes.mjs [--live]`, `RENDER_ONLY=notes node scripts/test_screens.mjs --render` and `node scripts/check_phone_width.mjs`, which opens every page and pop-up at iPhone width.
Found on the way and fixed:
- The board's billing buttons crashed: Premium Setup, the billing portal, buying texts and changing plans all called a function that didn't exist.
- iPhone Safari zoomed into any form field under 16px and stayed zoomed. That was the "offset" Add sponsor.
- The Events and Volunteer edit windows were too wide on a phone, and so was the Billing page's stat row.

Steps (each one: a failing test first, then the fix, then proof):
- **✅ N1. Signup checks the phone and email on step 1.** "Already a member, sign in" shows on step 1, not at checkout. If the family has an unpaid application waiting, they go back to its payment ("Try again") instead of being blocked.
- **✅ N2. Stay signed in on the iPhone Home Screen app.** The page hands the Home Screen app a one-time sign-in when it's added, so it opens signed in. The member home's install card shows the right steps for Chrome.
- **✅ N3. Parties: date and start time only, for the club's party length** (4 hours, editable). The board's approve screen fits a phone. Members get a text when their party is approved, changed or declined.
- **✅ N4. Photo uploads alert the board** through positions (Membership & Marketing Director, else the President), with a pop-up.
- **✅ N5. Help requests in the app only.** Board replies reach the member by pop-up, else email, never text. Removing a board member also drops their positions.
- **✅ N6. Member pop-ups.** A "Turn on notifications" button in the member app. Board replies, party decisions, plan receipts, and announcements with "Notify members" on all pop up. Meeting agendas reach the board by pop-up only.
- **✅ N7. "Text all members":** reproduce it, fix it, prove a test send.
- **✅ N8. Phone-width sweep:** every page and every pop-up at iPhone size. Fix anything that runs off the screen, starting with Add sponsor.

### O. Faster party booking (Doug, 10/7) — ✅ done 10/8
Doug: "booked, board approved, paid by Venmo, board approved the Venmo… seems sluggish."
Doug decided:
- An open time is approved on the spot (a setting on the Parties page, on).
- Two parties can share a day but not a time; an overlapping time is refused, with the taken times shown.
- Card first, Venmo kept. A card payment books it instantly, and the card fee is always the member's, never the club's.
- Bishop's fee is $250, editable on the Parties page.
- An unpaid approved party holds its time for 2 days, then gives it back and tells the family. A Venmo they say they sent holds it until the board confirms.

Done:
- `_shared/party_slots.ts`.
- The database refuses two paid parties at overlapping times (exclusion constraint, replacing one-per-day).
- The request form shows the day's taken times, the fee and the card total, with "Book it".
- After booking: "Pay $257.78 by card" or "I'll pay $250 by Venmo".
- The daily run releases unpaid times.
- `node scripts/test_signup_notes.mjs --live` checks all of it.

### P. Keyfob requests in the app (Doug, 10/8) — ✅ P1–P4 done 10/8; P5 after closing
Doug decided (10/8):
- A new membership comes with fobs included: **1 per family at Bishop** (Doug changed it from 2 on 10/8). An extra or replacement fob is **$15**, and the board can change both.
- Poolside decides who's new, not a checkbox (Doug asked how an existing member is kept from signing up as "new" for a free fob):
  - A renewal comes from an existing family, so it is never offered one.
  - The signup form's first-page check matches phone, email and **street address** against current members, families imported from the CSV, and anyone who paid for an earlier season. A match is sent to sign in or use their personal link, and is never treated as new.
  - The free fob is counted per family, once ever, so renewing doesn't reset it.
  - The board member who issues the fob sees "included (new family)" or "paid", plus a warning if the name or address matches a past member, so they can charge instead.
  - P2 closed the gap: the first-page check and the final submit turn away imported (prefilled) families and offer "Send me my link". A street address that matches a past or imported family doesn't block (houses change hands); it puts a warning on the free fob for the board.
- Only when the club has keyfobs turned on (`features.keyfobs`, Doug's provider switch).

Steps (each one: a failing test first, then the fix, then proof):
- **✅ P1. A fob list.** One row per fob: family, person (optional), number, status (requested, active, lost, off), and whether it was included or paid. The board's family record shows them, and so does the family's app.
- **✅ P2. Signup:** "Do you need a keyfob? (1 included)" for new families only, with the first-page check widened to imported families and street addresses. Once paid, the Facilities Director gets a pop-up and a task: "Issue a fob to the Smith family".
- **✅ P3. In the app:** a Keyfobs card with the family's fobs, "Request another fob ($15)" and "Report a lost fob ($15 replacement)". The member pays by card first (card fee on the member), or by Venmo with board confirmation. A lost fob is flagged to be turned off right away.
- **✅ P4. Issuing a fob:** the board member types the fob number into a simple form. Both printed formats are accepted and converted (decimal, or facility,card). A number already given to someone else is refused, and the last digits are shown back to confirm. That marks the fob active and closes the task.
- Built as: the `keyfobs` table and function, Settings → Keyfobs for the board (issue, lost fobs to turn off, add a fob a family already has, the free count and fee), the Keyfobs card in the member app, card payment through `stripe_checkout` (`keyfob`), and the Facilities Director's "gate" alert for every fob task. `node scripts/test_keyfobs.mjs [--live]`.
- Not yet: the CSV import (Doug isn't uploading it yet). When it goes in, a claimed family's fob numbers from the list become active fobs when their membership is approved.
- **P5. Later (after closing, with the panel connected):** typing the number turns the fob on at the gate. Renewals extend it, lapses switch it off, and a lost fob goes off at once. Per the keyfob automation design (memory) this starts with the read-only panel check.

### Q. Keyfobs at checkout (Doug, 10/8) — ✅ done 10/8
Doug decided (10/8):
- No "new or returning" choice up front: Poolside keeps deciding who is new, and a new family gets 1 free fob.
- At checkout, a family can add extra fobs at $15 each with a quantity box. That covers new families, families joining from the club's list, and renewals. New families see "New members get 1 keyfob free" next to it.
- **5 fobs per family in total**, counting the free one. Lost and turned-off fobs don't count. The board can change the 5.
- Extra fobs are **part of the membership total**: one card charge or one Venmo amount, spread with the dues on a payment plan. The board is asked to issue them all at approval, in one task.
- When the club has app unlock on, the checkout just says app unlock is available. Doug doesn't want families thinking they need to buy more fobs.
- In the app: "Lost your fob? Order a new one" ($15). A **broken** fob goes through Member help; the board swaps it free by default, or charges $15 if it looks like damage.

Steps (each one: a failing test first, then the fix, then proof):
- **✅ Q1. Price:** extra fobs on the application (`fob_extra_count`), priced with the membership (`fob_cents`), so card, Venmo, plans and "nothing to pay" all include them. The 5-fob limit is a club setting.
- **✅ Q2. Signup checkout:** the keyfob box moves from page 1 to the payment page: the free fob (new families only, ticked by default), the quantity box, the price lines, and the app-unlock line.
- **✅ Q3. Renewal checkout:** the same quantity box on the renewal page.
- **✅ Q4. Approval:** one helper creates the free fob, the paid extras and the list fobs, with one task for the board, for new families and renewals alike.
- **✅ Q5. In the app and on the desk:** a quantity on "Request another fob" and one payment for all of them; "Lost your fob? Order a new one"; "Fob broken? Ask the board" opens Member help; the board's "Swap broken fob" (free, or charge $15).
- Notes: fobs bought at signup or renewal follow the club's card-fee rule for dues, since they're one charge; fobs bought later in the app always put the card fee on the member. The no-login renewal link (`/renew.html`) has no keyfob box yet; those families can add fobs in the app. `node scripts/test_keyfobs.mjs [--live]` (35 offline, 26 live checks).

### R. Board notes from Doug's computer (10/8) — ✅ done 10/8
Doug decided (10/8):
- On a computer, no "turn on pop-ups on this phone" prompt. Instead, a number on the top tab (and sub-tab) wherever something is waiting.
- The help page's copy button copies only the support email.
- Votes stay as counts, with a minus to take one back. "Plan one for later" goes.
- The Signup form tab goes: the signup link and heading move to Settings → Season.
- The renewal message is one simple screen: email and/or text, a message box filled in ("click here to renew for the new season"), and a clear line saying which season and that it **only goes to last season's members** who haven't renewed. It goes to the person who created the account, with their own link.
- Renewing (from the link or the app): everything filled in; the primary accepts the policies again and signs; then pays in full or by payment plan.
- Auto-renew is reworked: instead of "we'll charge whatever the board sets", the family is sent the new season's price, policies and payment choice to approve, and nothing is charged until they do.

Steps (each one: a failing test first, then the fix, then proof):
- **✅ R1.** Pop-up prompt hidden on computers; waiting-task numbers on every top tab and sub-tab (Keyfobs included).
- **✅ R2.** Copy just support@poolsideapp.com.
- **✅ R3.** Meeting votes: keep a new, empty motion while the meeting is open (the save was dropping it, so the buttons did nothing); a − on each count; remove "Plan one for later".
- **✅ R4.** Remove the Signup form tab; the signup link (with Copy) and heading go to Settings → Season.
- **✅ R5.** Renewal message screen: the season, who it reaches (last season's members not yet renewed, with the count), email and/or text, the message with each family's link added. Texts here are a new exception to the texting rule, on Doug's say-so.
- **✅ R6.** Both renewal pages: policies and the primary's signature before paying; the keyfob box on the link page.
- **✅ R7.** Auto-renew becomes "approve next season": when renewals open, auto-renew families get the price, policies and last season's payment choice; one tap signs and charges the saved card; a reminder after a week; no approval, no charge.
- Notes: approving with the saved card charges it once, then runs the usual renewal approval (season forward, extra keyfobs). A family that used a payment plan last season starts on "Payment plan" (through checkout); one tap is for paying in full. In test mode, a test checkout keeps a pretend card (`sim_pm_`) so one-tap approval can be tried. `node scripts/test_board_notes.mjs [--live]` (26 offline, 10 live checks).

### S. Approve every automatic payment (Doug, 10/8) — ✅ done 10/8
Doug: "I am very concerned about random charges." Decided (10/8):
- Poolside never has card numbers; Stripe keeps the card and Poolside only its reference. Stripe can't show future payments because Poolside schedules them, so Poolside shows them.
- Every plan payment falls on one billing day, **the 1st** (the club can change it). Payments today at checkout, and anything a family does itself, aren't affected.
- **Nothing is charged until a board member ticks it.** Money → Upcoming lists each payment due in the next 30 days, one short line each ("Smith family · $600 total · $150 down · $55 a month · Approve $55, Nov 1"), with its own checkbox.
- 3 days before the billing day, the Treasurer gets a pop-up and a dashboard task; if anything is still unticked on the billing day, it waits and the reminder repeats daily. A family never loses access, or lapses, because the board hadn't approved.
- Approving a payment also approves its retries (3, 7 and 14 days after a decline).
- The same page shows the last 30 days of automatic charges and renewal approvals, paid or declined. No daily summary pop-up.

Steps (each one: a failing test first, then the fix, then proof):
- **✅ S1.** Billing day: plan payments on the club's billing day (default the 1st); a setting on Payments setup.
- **✅ S2.** Approval: `approved_at` on each payment; the daily run charges only approved ones; deadlines don't end a plan over an unapproved payment.
- **✅ S3.** The ask: the Treasurer's pop-up and task 3 days before, daily after the billing day while anything waits; closed when all are approved.
- **✅ S4.** Money → Upcoming: the next 30 days with checkboxes and "Approve checked", undo before it's charged, and the last 30 days of automatic charges.
- Notes: there were no active plans anywhere when this shipped, so nothing was waiting. Older examples in `test_flex_plan` now use a club billing on the 15th or 20th, the arithmetic Doug's examples were worked out with. `node scripts/test_plan_approval.mjs [--live]` (16 offline, 7 live checks).

### T. A simpler Emails tab (Doug, 10/8) — ✅ done 10/8
Doug: "emails tab is super confusing." It listed 29 emails with technical names; 12 were the same welcome email in different payment and app versions; no club had changed any; the editor had a Visual/HTML switch. Decided (10/8):
- **By moment, plain names:** Signing up, Welcome, Payments, Renewals, Parties, Family changes. Each email shows its name, when it goes out, an on/off switch and its subject.
- **Look-alikes merged:** one Welcome email (Poolside adds the right payment line and sign-in line), one Application received, one Plan payment received. 29 become 15. Nothing a family gets is lost: the code that sends them is unchanged and each old version maps to its merged email.
- **Editing is the subject and the message in plain words** (bold, links, bullets). Poolside adds the logo, buttons and payment details. No HTML mode. "Reset to the original" stays. **"Send me a test"** sends it to your own email.
- **It moves to Settings → Emails.**
- The defaults are rewritten in plain words, fixing out-of-date lines (party payment, plan payments).

Steps (each one: a failing test first, then the fix, then proof):
- **✅ T1.** The 15 emails: message plus Poolside's part, the old keys mapped to them, a safe-HTML check on what boards type.
- **✅ T2.** The Emails page: sections, switches, the simple editor with placeholders, a preview ("Show as" for the Welcome versions), Send me a test.
- **✅ T3.** Settings → Emails, and the help pages that mention it.
- Notes: emails now carry the club's logo (Settings → branding). A real welcome email was sent to Resend's test inbox and read back. The one-tap renewal "card declined" email was retired with R7 (nothing sends it). `node scripts/test_emails.mjs [--live]` (22 offline, 4 live checks).

### U. Doug's notes from the board and member pages (10/8) — ✅ done 10/8
Doug decided (10/8):
- In-app board messages say support@poolsideapp.com, not doug@ (both go through Porkbun forwarding; Doug checks support@ is set up there).
- Payments: the card-fee checkbox moves into the Stripe section; the "Emails members get" boxes go; the page says which season it's about; "Current payment plans" becomes "Families on a payment plan" (a saved plan setting isn't a plan).
- Plan deadlines: **two fixed deadlines** with years ("Half paid by", "Paid in full by"), no "add a deadline", no signup cutoff. A late joiner still has to pay enough today to meet the half deadline (already how the plan picker works).
- Member app on a computer: no "turn on notifications" and no "Add to Home Screen".
- Ask the board: solved questions go under "Past questions".
- Keyfobs: "I sent it by Venmo" goes straight to the board to make the fob (check the Venmo when handing it over). No separate approval.
- **Seasons:** a button, "Close 2026 and start 2027", on Settings → Season, replacing "next season goes on sale in". Every page labels the current season. A checklist follows: 2027 prices, deadlines, the renewal message, policies, opening day.
- **From January 1 of the new season,** a family that hasn't paid (and isn't on a plan for it) isn't a member: they can sign in, see "Pay for 2027 to use everything", and use only My family, the calendar, Ask the board and renewing. No photos, gate, parties, keyfobs or news. A family on a plan counts as a member.
- **Member app tabs:** Home (unlock the gate, anything to pay or approve, the fundraiser, today at the pool, news), Calendar (plus parties, programs, volunteering), Photos, Ask the board (questions and past ones), My family (people, keyfobs, payment plan, one-tap renewal, settings).

Steps (each one: a failing test first, then the fix, then proof):
- **✅ U1.** Quick fixes: support@, the payments page, two fixed deadlines, no prompts on computers, Past questions, keyfob Venmo in one step.
- **✅ U2.** Seasons: the current season everywhere, the close-out button and checklist.
- **✅ U3.** The January 1 rule: who's a member, what an unpaid family can use, enforced on the server too.
- **✅ U4.** The member app tabs.
- Notes: Bishop's current season is **2027**: it went on sale 10/7 when Doug asked to start the next season, and is now fixed (it changes only on the button). Families paid for 2026 stay members until Jan 1, 2027. `node scripts/test_season_home.mjs [--live]` (27 offline, 3 live checks).

### V. Member home, second pass (Doug, 10/9) — ✅ done 10/9
Doug, on the tabs: the bottom bar doesn't stay at the bottom; keyfobs belong only on My family; photos on the front page; a smaller top banner with the date and the weather at the pool (for current members) plus what's happening today; remote unlock right under it, only if the club has it; latest news near the top; photos under that; the calendar scrolls on the front page; three tabs.
- **Three tabs:** Home, Ask the board, My family. The bar is fixed to the bottom of the screen everywhere (it sat across the top on a computer before).
- **Home, in order:** a small banner (hi, the date, the weather at the pool, today's hours and first event), remote unlock (only when the club has it; a one-line note when it's offline), anything to do (renewal, a plan needing attention), latest news, the fundraiser, photos, then the calendar with parties, programs and volunteering.
- **My family:** the family card, payment plan, keyfobs, and refer a friend (moved off the banner).
- Weather: Open-Meteo (free, no key), from the pool's map pin, which only signed-in current members get.

### W. A board home for each board member (Doug, 10/9) — ✅ done 10/9
Doug liked the member home and asked for the board page done the same way, one per board member. Mockups shown 10/9 (President, Treasurer, Facilities Director). Doug decided (10/9):
- **The page comes from the ticks.** Whatever the President ticks for a position on Settings → Board (its screens and its alerts) decides that person's home. Nothing extra to set up. When the President changes the ticks, the person's page changes the next time they open it. Someone with two positions gets both; the President (full access) sees everything.
- **Bottom bar on phones, on every board page,** like the member app. Computers keep the top tabs.
- **The gate unlock at the top of every board member's home,** not only the President's, and only when the club has keyfobs and remote unlock on.

The home, in order:
- A small banner: hi, the date, the weather at the pool, today's hours, their position and the season. Three numbers from their screens: money (collected, still owed, on a plan); members (families paid of all, signups waiting, renewals left); gate (check-ins today, keyfobs to make, fobs in use); calendar (parties this week, events this week, program signups); no screens (families paid, open member questions, next meeting). The President gets families paid, collected, on a plan.
- The gate unlock (one quiet line when it's offline).
- **Needs you:** their dashboard tasks and member questions in one list, one button each. Replaces "What needs your attention", "Your tasks" and the Member help card.
- **Today at the pool** and **Coming up** (events, parties, programs, the next board meeting; plan charge days for money people).
- Four quick buttons from their screens (Text all members, Post news, Add an event, Add photos, Upcoming payments, Signups, Member list, Keyfobs, Check-in, Lifeguard shifts…, first four they can use).
- Their job description, and the signup link for those who handle signups.

Steps (each one: a failing test first, then the fix, then proof):
- **✅ W1.** The home: one server call (`admin_tasks` `home`) returns the numbers, to-dos, today, coming up and buttons, limited to the person's screens and alerts. It replaces about ten calls the dashboard makes now. The page is rebuilt as above.
- **✅ W2.** The unlock for every board member: a `gate_admin` action any active board member can use (today only the owner can), logged with who opened it. Shown only with keyfobs and remote unlock on. No real unlock is tested while the bridge is off (a queued unlock could fire when it comes back).
- **✅ W3.** The bottom bar on every board page (Home, the sections they can use, More with the rest, help, member view and sign out), and the top tabs hide sections they can't use. Done once in `js/admin-subtabs.js`, not page by page. Every page checked at iPhone width.
- **✅ W4.** Proof: `scripts/test_board_home.mjs` (offline: what Bishop's President, Treasurer, Facilities Director and Grounds Director each get; live: a few calls with a temporary board login, removed after) and screenshots of three positions on a phone and a computer.
- Notes: "families paid" has no "of 64" (the dues bar never had one: what the 64 is would be arguable). The board meeting links (start one, add to the agenda) stay as rows at the bottom of the home. A Facilities Director's Settings tab now opens Keyfobs; before, the tab was hidden from them. Quick buttons open their form (`announcements.html#text`, `#new`, `events.html#new`, `photos.html#upload`). The "?" button gives way to More on phones. `node scripts/test_board_home.mjs [--live]` (47 offline, 9 live checks).

### X. Keyfobs under Members, and canceling an unpaid request (Doug, 10/9) — ✅ done 10/9
Doug: "keyfob section should be under members… there is a pending keyfob that needs to be paid via venmo… I can't cancel this request on the admin side, nor the member side… I should be able to do this on both." And: "no they can't cancel after it's paid… I want to cancel during that time."
- **Keyfobs moves from Settings to Members** (Pipeline, Households, Renewals, Keyfobs, Policies).
- **Cancel a request that isn't paid yet,** from the app (My family) and from the board's Keyfobs page. Not paid means waiting to be paid, or free (a new family's included fob). Once it's paid, by card, with the dues, or a Venmo the family says they sent, there's no cancel on either side.
- Canceling removes the request (it never had a fob number) and closes its board task. When the board cancels, the family gets a pop-up.
- A card payment that comes in for a request canceled in the meantime (the checkout was still open) isn't lost: the board gets a task to refund it in Stripe or issue the fob.

Steps (each one: a failing test first, then the fix, then proof):
- **✅ X1.** Keyfobs under Members: `js/admin-subtabs.js`, the nav generator, the tab numbers.
- **✅ X2.** `keyfobs` `cancel` for the family and the board, only before payment; the buttons on both sides; the webhook's late-payment task.
- **✅ X3.** Proof: `test_keyfobs` (offline, and live with a temporary family: cancel an unpaid request from each side, refused once paid). `ONLY=cancel node scripts/test_keyfobs.mjs --live` runs just this part (about 12 calls). The late-payment task goes to the Treasurer (the `payments` alert), linked to Money.

### Y. The sponsor pop-up (Doug, 10/11: "the advertising pop up thing doesn't seem to work") — ✅ done 10/11
Found: the pop-up works, but Bishop's was never turned on. On Money → Sponsors the On/Off choice sat in its own box, started at Off, and only took effect after a separate "Save popup settings" button, so adding Ace Hardware on 10/10 didn't turn it on. That button also sent back the whole settings copy loaded with the page, which could undo other settings changed since.
- **✅ Y1.** A switch, "Show a sponsor pop-up when people open the app", that saves the moment it's flipped (and the how-often choice too), with a line saying what members see. It saves only the pop-up setting. `node scripts/test_sponsor_popup.mjs`.
- **✅ Y2.** Sponsors moves from Money to Content (Doug, 10/11: "sponsors should be under content not money"): Announcements, Photos, Board minutes, Member help, Sponsors.

### Z. Drive backup (Doug, 10/11)
The Drive connection had been dead since May 23 (Google cancels a Testing-mode app's sign-in after 7 days). Doug reconnected on 10/11, as you@example.com. One backup kept failing: the Frevele signup he had deleted, retried forever as "application not found".
- **✅ Z1.** A retry drops a backup whose signup was deleted, and deleting a family for good removes its waiting backups. "Retry failed syncs" now tries everything waiting right away; it used to skip items still inside their wait time, so a second press did nothing. `node scripts/test_drive_queue.mjs`.

### AA. The gate back on, without burning Supabase (Doug, 10/11)
Doug wants the phone unlock working again for a few days to show someone, then to try the keyfob panel integration (the `uhppoted` library, PLAN.md P5). In September the bridge's check-in every 1.5 seconds (about 60,000 calls a day) used up the free Supabase plan and the project was blocked. Supabase is still on the free plan (500,000 calls a month); a normal day now is about 1,000.

The fix: the bridge asks "anything to open?" and the cloud holds the question open for up to 20 seconds, answering the moment someone taps Unlock. One call every 20 seconds instead of every 1.5: about 4,300 a day, around 130,000 a month even if it's never turned off, with the gate opening in a second or two instead of waiting for the next check-in.
- **AA1.** `gate_bridge` `poll` with `wait` (up to 20 s): checks every half second for a waiting unlock and returns it straight away. An old bridge that doesn't send `wait` gets today's instant answer.
- **AA2.** The bridge 1.1 (`bridge/gate_bridge.py`): asks with `wait`, drops the separate heartbeat (each check-in counts), never loops faster than every 5 seconds even if the cloud answers early, and backs off up to a minute after errors. Tested offline against a fake cloud that counts calls.
- **AA3.** Doug, on the club PC through TeamViewer: download the new `gate_bridge.py` from www.poolsideapp.com/bridge/gate_bridge.py over the old one, add `POLL_SEC=20` to its `.env` (a safety net if the old file is ever run), and start the PoolsideGateBridge service.
- **AA4.** Proof: the board home shows the gate online, Unlock opens it, and the next day's call count stays near 5,000.
- Safe to turn on now: Bishop has no families, unlocks waiting from before are skipped (anything over 60 seconds old is never fired), and the 4 stuck from June aren't picked up.
- Later: the read-only keyfob panel check (`bridge/panel_check_readonly.py`) on the same PC, which writes nothing to the panels.

### AB. Home Screen steps where people see them (Doug, 10/11)
The first real signup (iPhone, Chrome) never saw how to add the club to her home screen: on the payment screen the steps sat under the "Sign in" button she tapped right away, and in the member app they were at the very bottom of Home, after the calendar (PLAN.md V put them there).
- **AB1.** On the member home, the "Add this club to your home screen" card goes right under the top banner, open, for anyone on a phone who isn't using the installed app. "Not now" tucks it away for two weeks. It's gone in the installed app.
- **AB2.** The payment screen says one line instead: sign in, and the next screen shows how to add it (adding it from the member home is the version that keeps people signed in).
`node scripts/test_season_home.mjs`.

### AC. The name under the app icon (Doug, 10/11)
Saving the app to a home screen labeled it "Bishop Estat": the manifest cut the club's name at 12 characters, mid-word. Doug picked "Cabana Club".
- **AC1.** Settings → the app icon gets "Name under the app icon" (`branding.app_name`). The manifest's short name and the iPhone title use it. Without one, Poolside uses as many whole words of the club's name as fit in 12 characters ("Bishop"), never half a word. Families who already added the app keep the old label until they add it again.
`node scripts/test_signup_notes.mjs --offline`.

### AD. Pop-ups and the bottom bar (Doug, 10/11)
On a phone, the board's bottom bar (PLAN.md W3) sat above most pop-ups (stacking level 70 over 50 or 60), covering their bottom, usually the Save button; and while a pop-up was open, a swipe could scroll the page behind it instead. The member app's bar (9000, over pop-ups at 200) has the same problem.
- **AD1.** While any pop-up is open, the bottom bar steps aside and the page behind stays still (board pages: `js/admin-subtabs.js`; member app: `m/index.html`). The bar also sits below every pop-up, and pop-ups keep a swipe to themselves (`overscroll-behavior: contain`).
`node scripts/test_board_home.mjs`, `node scripts/test_season_home.mjs`, and a check on a phone-size screen with a pop-up open.

### AE. The party person hears about every paid party (Doug, 10/11)
Doug: "When a pool party is paid for, Venmo or credit card, the party person on the board needs to be notified… and be in contact." Before: a card payment booked the party and told only the family; Venmo made a to-do only because it needs approving; an automatically approved request was a phone pop-up only.
- **AE1.** Whenever a party is paid (card, a Venmo the board approves, or free at an open time), the party person (the "rentals" alert: Events & Rentals Director, else the President) gets a to-do on their board home ("Needs you", with the number on Home and Calendar) until they mark it done, plus a phone pop-up and an email. Each says the party, date, time and guests, and the family's contact with tap-to-call, text and email.
- **AE2.** The family's "Your party is booked" email says: questions about your party? Ask the board in the app (Parties & events), which goes straight to the board member who handles parties. No board phone numbers are shared.
- **AE3.** The Parties page shows the family's phone and email as tap-to-call, text and email.
`node scripts/test_party_booked.mjs`.

### AF. The paid count, and tapping a to-do (Doug, 10/11)
- **AF1.** "1 family paid" when 3 had: the count left out the two families who paid with the test card (test payments aren't money in), and the home banner, unlike the old dues bar, didn't say so. Now the count includes them and says how many were test ("3 families paid (2 test)"); "collected" still counts only real money. Same on the dues bar on other pages.
- **AF1b.** Doug, 10/11: the Wood family's Venmo was a test too; he approved it with the regular button. While a club is in test mode, every payment the board marks received (approving a Venmo at signup, verifying one later, or "mark paid" on Money) now counts as a test payment, like the Simulate button. Wood's is marked as a test.
- **AF2.** Only the button on a to-do opened it. Now tapping anywhere on the row opens it ("Mark done" stays separate), and a party to-do opens that party on the Parties page (`parties.html#p=<id>`).
`node scripts/test_board_home.mjs`, `node scripts/test_party_booked.mjs`.

### AG. The Home Screen app opens to the board for board-only people (Doug, 10/11)
Doug's one Home Screen app was added from the member side, so it opens there. Since his family was deleted it showed the member sign-in page every time ("keeps logging me out"), though his board sign-in in the same app was fine. Now the member sign-in page, finding no member sign-in but a board one, opens the board straight away when that board login isn't linked to a member; a board member who is also a member gets a "Go to the board" button instead (no bouncing between the two).
`node scripts/test_board_home.mjs`.

### AH. One app for board members who are also members (Doug, 10/11) — ✅ done 10/11
Doug: "if I sign in as a member, I still want the board to take priority… board notifications, but also member notifications… if you get removed from the board, the default goes back to member side… if a member gets invited to the board, it should then default to board."
- **AH1. Board first.** The Home Screen app opens to the board whenever it has a board sign-in. "Member view" (board home and More) switches to the member side for the rest of that visit; "Board tools" on the member side switches back. Removed from the board: the board sign-in stops working, so the app drops it and opens the member side from then on. Invited to the board: "Board tools" appears on their member side; once they sign in to the board there, the app opens to the board. (Replaces AG's button-only case.)
- **AH2. Both kinds of pop-ups, one switch.** Turning on pop-ups on either side signs the phone up for board and member pop-ups, for a board login matched to the family (linked, or the same phone or email, as `is_board_member`). Turning off board pop-ups no longer cuts off member ones on the same phone.
- **AH3. Each pop-up opens its side.** Member pop-ups open the member side even though the app is board first.
`node scripts/test_one_app.mjs`, plus a check in a browser.

### AI. Adding the app brings both sign-ins (Doug, 10/11) — ✅ done 10/11
Doug deleted and re-added the Home Screen app and the board side asked him to sign in again: an iPhone app keeps its own storage, separate from Safari, and only the member side carried its sign-in into a newly added app (PLAN.md N2). "If you are signed in either member or board, it should bring both logins when saving the PWA app."
- **✅ AI1.** On an iPhone, the member home and the board home both keep one-time sign-ins ready for whichever of the two this phone is signed in to, in the page address and the app manifest (`js/handoff.js`, shared). Member: as before (7 days, `member_auth` `handoff`). Board: `tenant_admin_auth` `handoff`, one hour and once only, exchanged with the existing `verify_link`.
- **✅ AI2.** The newly added app, on its first opening, signs itself in to both, then opens to the board (board first, PLAN.md AH). A sign-in in a link someone shared is cleaned off and never used in a browser tab.
`node scripts/test_handoff.mjs [--live]`, plus a check in a browser.

### AJ. A read-only list of every keyfob (Doug, 10/12)
The first read (10/12) found both controllers, 135 keyfobs each, 52 that never expire, 41 that open the Pump Room. Next, the list itself, to audit against the membership spreadsheet when it's imported (PLAN.md P5 audit design).
- **AJ1.** `bridge/panel_check_readonly.py --export` writes one row per keyfob, combined across both controllers, to a CSV on the club PC: the number as stored and in both printed forms (10-digit and facility,card), valid from and until, never expires, expired, each door by name, and whether both controllers have it. No door PINs. Same read-only guard (three layers); nothing leaves the PC.
`python3 scripts/test_panel_export.py` (offline, a fake controller).

### AK. The board opens every door; members open the front gate (Doug, 10/12) — ✅ done 10/12
Doug: "if you are on the board can you have it unlock each specific door? access to all doors? then on the member side they can only unlock the front gate? (the mens and womens bathrooms are on there but they are not actually connected yet)". Answers: the wired doors are Main Gate, Snack, Pump Room and Swim Shack; every board member gets every door; members keep the front gate only.
- **AK1. The doors on file.** `gate_panels.doors` lists each door Poolside can open: its name, its controller (serial and address) and its door number. Bishop: Main Gate (snack shack controller, door 1), Snack (door 2), Pump Room (pump room controller, door 1), Swim Shack (door 2). Mens and Womens stay off the list until they're wired. A club with no list has just the front gate, as before. `gate_unlocks.door_key` records which door was opened.
- **AK2. The board home.** The gate card shows one button per door, for every board member. `gate_admin` `board_unlock` takes the door and refuses one that isn't on the list. Members: unchanged, the front gate only (`unlock_gate` never takes a door).
- **AK3. Bridge 1.2.** The Main Gate keeps the proven web-page recipe. The other doors open with uhppoted's `open_door`, sent straight to that door's controller (the same way the read-only check reads them). Until the club PC runs 1.2 the board sees only the Main Gate, and `gate_bridge` never hands an older bridge another door (it would open the Main Gate instead).
- **AK4.** Settings → Remote keyfob access → recent unlocks shows the door and the board member's name.
- Doug's step: download the new bridge on the club PC and restart the service (PowerShell, as for 1.1).
`node scripts/test_gate_doors.mjs`, `node scripts/test_gate_poll.mjs` (both offline). ✅ Bridge 1.2 on the club PC; Doug tapped all four doors on 10/12 and each opened (9 of 9 unlocks ok, each under a second).

### AN. Deleting an announcement deletes it (Doug, 10/12)
Doug: "I can turn the announcement I made and delete it off the front page, but can't fully delete it off the announcement section in admin page… if it's off shouldn't it fully delete?" "Remove post" only hid a post (`posts.active = false`). It stayed in the board's list marked "Removed", with no way to get rid of it.
- **AN1.** "Remove post" becomes "Delete post": after one confirm ("…for good, can't be undone"), `posts_admin` `delete` deletes the row and notes the title in the audit log.
- **AN2.** Posts removed before this (Bishop has three: "Oktober Fest Today!" twice and "Bjj") get a Delete button on their card, so Doug clears them himself.
`node scripts/test_posts_delete.mjs` (offline), then Doug deletes his three and I check they're gone.

### AO. The bridge checks in every 2 minutes (Doug, 10/12) — ✅ done 10/12
Doug: "lets change that and update to once every 5 minutes.. we dont need that quick of response". Taps don't wait for a check-in (each one is held open and answered the moment a tap comes), so fewer check-ins don't slow the doors. The free Supabase plan ends any call at 150 s, so the longest hold is about 2 minutes. Doug chose "every ~2 min, taps instant" over "every 5 min, taps can wait".
- **AO1.** `gate_bridge` holds a check-in up to 120 s (was 20 s), about 720 calls a day instead of 4,200. While holding, it looks for a tap every second (was every half second, to stay inside the 2 s CPU limit per call) and stamps "last seen" every 30 s, so Online, the outage alarms and the Settings card read the same as before.
- **AO2.** The cloud tells the bridge how long to ask for next time (`next_wait`), so this never needs another trip to the club PC.
- **AO3.** Bridge 1.3: uses `next_wait` (kept between 5 and 130 s), sets each call's time limit from its wait, and retries straight away (no back-off) when a long hold is cut short, since that isn't an outage. Doug installs it with the same admin PowerShell steps as 1.2.
`node scripts/test_gate_poll.mjs` (offline). ✅ Live 10/12: bridge 1.3 installed; after `gate_bridge` deployed (Supabase's deploy service failed for about 40 minutes first), "last seen" ticked every 30 s across 4 minutes, as a 2-minute hold does (20-second check-ins tick every 20 s). Supabase's function logs had stalled, so the call count is still to read from them later.

### AP. Lists that stay short with 100+ families (Doug, 10/12) — ✅ done 10/12
Doug: "with 100+ members the list will be so long.. shouldn't this list minimize? How can we prevent the list from super growing and doom scrolling". Two lists grow with the club: the board's "Needs you" (one row per fob to issue, signup, Venmo…) and the Keyfobs page's "All fobs" table (one row per fob, about 205 after the import). Rule: lists show work, not history; history is a lookup. Nothing is deleted, only folded.
- **AP1. Needs you groups repeats.** Three or more to-dos of the same kind become one row ("🔑 12 keyfobs to issue", "📝 5 signups to review") with one Open button to their page. Tapping the row shows them one by one, each still with Mark done. The rows count toward the 6 shown before "Show N more".
- **AP2. Keyfobs page: the work first, compact.** Lost fobs to turn off and fobs to issue are one compact entry each, oldest first, the first 10 shown, then "Show N more". "Waiting on payment" folds into one line you open.
- **AP3. Keyfobs page: all fobs become a lookup.** Search by family, address or fob number (either printed form). Without a search only the count shows ("205 fobs · 171 families") and "Show all families". Then it's one row per family with its fobs and their buttons, 25 at a time. "Add a fob a family already has" folds into one line.
- The folding rules are in `js/list-fold.js`, shared by both pages.
`node scripts/test_long_lists.mjs` (offline), then both pages in a browser with 200 made-up fobs and 30 to-dos.

### AQ. The rest of the long lists, and caps on photos and news (Doug, 10/12) — ✅ done 10/12
Doug: "Under households we have the same problem? … show families under keyfobs works. But should we be able to hide as well? … Are we going to have these problems elsewhere?" Then: announcements "max out at 15"; photos "30? Then they auto delete?"; and "I don't want the web page or PWA or phone to crash if we load up the 150+ households". Answers: households are text, so 171 can't crash a phone; full-size photos can (each one takes about 40 MB of memory to show), and they'd fill the free plan's 1 GB at roughly 250–300. Doug chose to keep only the newest 30 photos and the newest 15 announcements, older ones deleted for good automatically.
- **AQ1. Households like Keyfobs.** Search by name, address, phone, email or fob number. Counts you tap to filter ("171 families · 150 paid · 21 unpaid", "3 removed" when there are any). The list only shows after a search, a count or "Show all", then 25 at a time with "Show 25 more" and "Hide".
- **AQ2. Hide.** On Keyfobs' family list, and on Households.
- **AQ3. Signups 25 at a time** on Approved, Rejected, Pending and All. "Needs attention" is the work and always shows whole.
- **AQ4. Photos.** Shrunk to 1600 px on upload, on the board's Photos page and the member app. Only the newest 30 approved photos are kept: adding or approving one deletes the rest, with their files, except photos still waiting for approval. Deleting a photo now deletes it and its file (it used to only hide it). The Photos page says so.
- **AQ5. Announcements: the newest 15.** Posting one deletes older ones beyond the newest 15. Pinned posts are never deleted automatically. The Announcements page says so.
- Shared rules: `js/list-fold.js` (pages), `_shared/keep_newest.ts` (which posts and photos go).
`node scripts/test_long_lists.mjs` (offline), then the pages in a browser with made-up data, then one live post and photo check.

### AR. Doors, access levels and passes (Doug, 10/13) — ✅ AR1–AR5 done 10/13
Doug: "Shouldn't we put … when keyfobs are active… dates and times? And what doors? We should have a global doors and members and board access… then maybe a special all access? For a specific length? Like when someone volunteers … and needs to get into a pump room? … when someone has a party, they need to gain access to the snack shack. This will obviously not be at every club."

What Bishop's old keyfob program does today (read 10/13):
- Two time windows: "Members" every day 6:00 AM–8:30 PM, Apr 7, 2025–Oct 31, 2026, and "Board" any time.
- 94 people have Main Gate, Mens and Womens on Members hours. 42 have all six doors any time.
- "Swim Team" and "Pool Help" types exist, but nobody is on them.

Doug's answers:
- Passes open with the phone now and go on keyfobs later.
- A paid party gives the host the Snack Shack automatically, from the pool's opening to closing time that day.
- Members get 6:00 AM–8:30 PM, changeable on the Keyfobs tab.
- Any board member can give a pass.

Steps:
- **AR1. The club's doors.** Bishop's list adds Mens and Womens as keyfob-only doors: they're on the controllers, but no remote lock is wired, so they never get an Unlock button.
- **AR2. Access levels on the Keyfobs tab.** Each level has its doors, days and hours, and the date it ends. Bishop starts with the two it uses:
  - Member: Main Gate, Mens, Womens, every day 6:00 AM–8:30 PM, until Oct 31.
  - Board: every door, any time.
  The board changes hours, doors and end dates there. Every fob shows its level (new families' fobs are Member; the board can set a fob to Board), with its doors, hours and end date. A club without doors sees none of this; a club with one gate has one Member level.
- **AR3. The member app's Unlock follows the Member level.** Outside its hours it says when the gate opens for members, instead of opening. The board home stays any time.
- **AR4. Passes.** Any board member, on the Keyfobs tab:
  - "Give a pass": a family, any doors (all of them for "all access"), from and to dates and times, and a note ("Pump room: pool chemicals").
  - During the pass, that family's app shows an Unlock button for each of those doors. It ends on its own, and the board can end it early.
  - Every unlock is logged with the pass.
- **AR5. Parties.** When a party is paid, its family gets a Snack Shack pass for that day, from the pool's opening to closing time (Settings → the pool's hours). A canceled party loses it.
- Later, with the panel automation (P5): levels and passes go onto the keyfobs themselves (doors, hours, dates on the controllers).
`node scripts/test_access.mjs` (offline), plus a browser check with made-up data (Keyfobs access and passes, the board home's Passes, the member app's door buttons). Built from `_shared/access.ts`, `js/passes.js`, and the `gate_admin` pass actions.

### AS. Keyfobs & Access: dates, "pool closed", texted passes, the keyfob sync (Doug, 10/13) — ✅ AS1–AS4 built 10/13 (needs bridge 1.4 for the sync)
Doug: "how can we also update to the access control via app? … board app and the member apps have access at specific times/dates… when the pool is closed, on the app, it should say pool is closed, no access… and why… closed for the season? not open until X time… there should be a start and stop date for the access/fobs… when should you dump to the system… should we dump every night if there is something pending?… i also want a manual dump button".

Writing to the panels doesn't take the doors down. The old program's upload rewrites every card, which causes the blip. Poolside writes only what changed, card by card (put_card), and member hours are one time-window write per controller.

Doug's answers:
- Rename the tab "Keyfobs & Access", with everything on it, only for clubs with keyfobs.
- The app and keyfobs follow the same hours and dates.
- Sync nightly plus a button.
- Write the sync now with automatic syncing off.
- Passes can be texted to members and guests.
- The button checks first, then sends.

Steps:
- **AS1. The tab.** "Keyfobs & Access" (nav and page), shown only when the club has keyfobs.
- **AS2. Start and stop dates, and "the pool is closed".** Each level gets a first day as well as a last day.
  - The member app shows no button while the Member level is closed, only why and when it opens: "The pool is closed for the season" (the Season switch is off, or past the last day, with the club's closed message), "Member access starts May 23", or "The pool is closed. It opens tomorrow at 6:00 AM".
  - The board home follows the Board level the same way (any time unless changed).
- **AS3. Text a pass.**
  - A pass can go to a member family (pop-up, and a text when ticked) or to anyone by name and mobile (a guest: landscaper, pool tech, a volunteer who isn't a member).
  - A guest's text has a private link (`/pass.html?t=…`) that shows the pass's doors with Unlock buttons only during the pass, with no app or sign-in. The link stops working when the pass ends or is ended.
  - Every guest unlock is logged with the pass.
- **AS4. The keyfob sync (P5's writing), "check first, then send".**
  - "Sync keyfobs now" on Keyfobs & Access asks the gate computer to read both controllers. Poolside then shows what would change for the fobs it manages: fobs to add, ones to change (doors, dates, hours), ones to turn off, and the Member hours window.
  - Cards Poolside doesn't manage (today's 135, until the import) are never touched.
  - "Send to the doors" writes exactly those changes, reads each card back, and reports what's live. A card's keypad PIN is kept.
  - A nightly check-and-send runs only when the "Auto keyfob activations" switch is on (provider admin, off for now).
  - Bridge 1.4 does the reading and writing. Doug downloads it like 1.3.
`node scripts/test_access.mjs`, `node scripts/test_keyfob_sync.mjs`, `python3 scripts/test_gate_bridge_loop.py` (all offline), browser checks with made-up data, then a read-only "Check" at Bishop with Doug before any "Send".

### AT. Payment-plan families show as on a plan, never "Venmo" or "Unpaid" (Doug, 10/13) — ✅ AT1–AT3 done 10/13
Doug: "a family signed up, but they selected a payment plan along with venmo somehow?" They didn't. a family chose the card payment plan ($200 today by test card, then $44.44 a month through July). Signups labels every payment that isn't a plain card payment "💸 Venmo". A plan family's signup stays "pending" until the plan is paid off (only the plan's start sets that), so Signups also called them Unpaid, then Overdue after 10 days. It kept them in Needs attention with a "Verify payment received" button, and that button would mark them paid in full by Venmo while the plan kept charging.
- **AT1. Signups.**
  - Each method has its own name: Card, Payment plan, Venmo, Check, Cash, Free.
  - A plan family shows "On plan · $200 of $600 paid", or "Plan ended".
  - They get no Unpaid or Overdue, no Verify or Remind button, and they're not in Needs attention. Their pop-up says the rest is charged on billing days after a board member approves it on Money → Upcoming.
- **AT2. The server agrees.**
  - `applications` `list` attaches each plan's status and amount paid. Needs attention, Unpaid and Overdue leave out plan families.
  - `verify_payment` refuses a family on a plan.
  - The board home's Signups number and Payments' outstanding list leave them out too; their payments are on Upcoming.
- **AT3. Households.** A family on an active plan shows "On plan" instead of Unpaid, with its own count.
`node scripts/test_flex_plan.mjs` (offline part).

### AU. Plans by card only; text sizes in the app; plain code wording (Doug, 10/13) — ✅ AU1–AU3 done 10/13
Doug: "make sure that it is ONLY enables... payment plans for stripe only... no venmo allowed, even with deposit... also go check out the text sizes and font for the app.. some seem off... and the coupon code section doesn't sound right.. hard to understand".

What's there now:
- Plans are already card only for families. On the signup form the plan is its own choice, "charged to your card". Renewals have no Venmo at all. The server only builds a plan through card checkout, and the first payment ("pay today") is part of that checkout. A family's "Venmo" was the Signups label (AT).
- The one way around the card: on Payments → Families on a payment plan, a board member can "Mark paid" a single plan payment, meant for cash or a check.
- Typing boxes are 14–15px, but iPhones don't zoom into them: `js/phone-fit.js` has stopped that since 10/7 (N8). So they stay as they are.
- Codes appear in three places: the family's "Have a code?" (signup and renewal), the board's Discounts card on Payments, and the member home's code banner.

Doug's answers: remove the board's "Mark paid" on plan payments, so plans are card only, period. For text, "dont remember... go check", so I check every member screen, the signup and renewal forms and the board's pop-ups at iPhone width. For codes, "its the coupon code narrative": the explaining sentences, written plainly everywhere they appear.

Steps:
- **AU1. Card only, locked in.** The board's "Mark paid" on a plan payment is gone, and `payment_plans` `mark_paid` refuses. Tests fail if a plan is ever offered with Venmo, or built without card checkout.
- **AU2. Text.** I checked every member screen, the signup form and the board home and Passes pop-up at iPhone width, with the Frevele test family's real data. What's broken gets fixed:
  - The member header ("Bishop Estates Cabana Club · Pat Smith · Sign out") squeezes "Sign out" onto two lines, and a board member's "Board tools →" makes it worse. Links stay on one line, and the member's name is hidden on phones (Home already says "Hi, Pat!").
  - On My family, "Refer a friend" is the only card title not in the heading font. It now matches Keyfobs.
  - On the signup form, the description under every choice (app or no app, membership level, free keyfob) is semibold, because every label there is. Descriptions are regular weight, and titles stay bold.
  - The pop-up's × and the photo arrows ‹ › fall back to Arial. They use the app's font.
  - Left as tuned for phones: the calendar's small day numbers, the 14–15px typing boxes, and the rest of the sizes.
  - Not mine to change: the signup form's heading reads "2026 Membership" while 2027 is on sale. That's the club's heading setting, so it's Doug's call.
- **AU3. Code wording.** Plain sentences wherever codes are explained:
  - The board's Discounts card: what a code does, how families use it, and that one discount counts. Its fields get plain labels ("What it's for", "Discount", "Last day to use it", "How many families can use it", "Show it on the member app's home screen"). Each code's line reads "$50 off · until May 1, 2027 · used by 3 of 10 families".
  - The family's "Have a discount code?": "✓ EARLYBIRD: $50 off." The code-or-referral note becomes "You have a code and a friend's referral, and only one can count. We used your code because it saves more ($50 vs. $25)." The problem messages ("That code isn't valid. Check the spelling.") are already plain and stay.
  - The member home banner: "Early bird: save $50 on your renewal", then "Use code EARLYBIRD by May 1. Type it in "Have a discount code?" when you renew."
`node scripts/test_flex_plan.mjs` (AU1), `node scripts/test_screens.mjs` (AU2), `node scripts/test_money.mjs --offline` (AU3), all offline; checked at iPhone width with made-up codes.

### BA. A "Get the app" page that shows how (Doug, 10/19) — parked until Doug says
Doug: "some people are not aware what a PWA app actually is... how can this be more user friendly to explain and show how this works". Not the App Store for now; switching later is a thin wrapper around the same app.
- One short link and QR code for the welcome text, the renewal message and a pool poster. It goes to a page that detects the phone and shows the 3 steps with real screenshots for that phone.
- If the page was opened inside Gmail, Facebook or Instagram, where "Add to Home Screen" isn't possible, it says "Open this in Safari first" with a button. `js/pwa.js` doesn't detect these today.
- Plain words everywhere ("Get the app: open the gate, get notifications, stay signed in"), never "PWA".
- Done 10/19 meanwhile: a printable flyer with a QR code to `/m/` and the steps, in `web/handouts/` (not in git).

### BB. Show the time Poolside saves the board (Doug, 10/19) — ✅ done 10/19
Doug: "We used to have this... i want to show how much time is saved by using this app... we currently have a link to jotform... probably an hour of my time to setup... our treasurer would then line by line (excel) see who signed up.. if they paid by venmo, she would cross reference each payment... if it was a credit card... verify from our paypal linked account... I would then... start activating each keyfob... at least an hour a week in batch keyfobs... is there a cost savings to any of this to show?"
- History: an Impact page (`tenant_metrics`, commit 2959f7b, April) estimated hours from generic per-row minutes (posts, photos, events). Doug removed it on 9/26 with other extras (PLAN.md I3: "too many features… too convoluted").
- This time it counts Bishop's real old work, only for things that actually happened in Poolside this season, with each estimate shown and editable. Proposed defaults:
  - each signup the treasurer didn't key into Excel and check: 10 min
  - each Venmo or card payment confirmed without cross-checking Venmo or PayPal: 5 min
  - each keyfob issued or turned off without a remote session: 10 min
  - the signup form for the season (was Jotform): 60 min
  - each family reached by the renewal message: 2 min
  - each party booked without phone tag: 20 min
  - each door opened remotely or pass given (a trip to the pool avoided): 15 min
  - each plan payment charged automatically: 5 min
- Real money, kept separate from time: anything the club no longer pays (Jotform, PayPal card fees it used to absorb that families now pay through Stripe), and late fees collected. Only what Doug confirms.
Doug's answers: a page under Insights; $20 an hour, "make it clear that if we were paying someone for it"; no other money (time only).

Steps:
- **BB1. Insights → Time saved.**
  - A big number ("About 37 hours"), then "If the club paid someone $20 an hour to do this work, it would have cost about $740."
  - It counts since the club started on Poolside.
  - Each row shows what used to be done by hand, how many times Poolside did it, the minutes each, and the hours.
  - Board members with Settings can change the minutes and the hourly rate (`settings.time_saved`).
  - Every board member can see it.
- **BB2. What counts:**
  - signups and renewals approved (10 min);
  - payments confirmed: dues, parties, keyfobs (5 min);
  - keyfobs issued or turned off in Poolside, not fobs brought over from the old program (10 min);
  - plan payments charged on their own (5 min);
  - parties booked (20 min);
  - doors opened remotely by the board and passes given, not test unlocks (15 min);
  - the signup form, once per season (60 min).
- `_shared/time_saved.ts` holds the rules; `admin_tasks` gets `time_saved` and `time_saved_save` actions.
- A help article covers it.
`node scripts/test_time_saved.mjs` (offline). Live 10/19: Bishop shows "About 10 hours" (doors opened remotely are most of it, from the 10/12 tap tests). A board member with no screens now has Insights in the bottom bar (`test_board_home` updated).

### CQ. Locks on where the money goes, and who can change the board (Doug, 11/8)
Doug, on a stolen full-access login switching the club's Stripe account: "Ya that's kinda a problem… The stripe thing", "Do the text confirm swapping that", "If you think password protect by text is good enough for things then that's fine" (no board passwords required), "Should we have something that has 2 people on the board that need to reply? So it's extra secure?", "when setting up a new season there should be a reminder to check the Venmo and stripe accounts to ensure they are up to date".
- **CQ1. A fresh texted code** to the person's own phone before: connecting a different Stripe account (`stripe_connect` `switch_account`), changing the club's Venmo handle, giving someone full access (an invite or a position with "Everything"), and changing a board member's mobile number or email. A code works once, for that one change, for 10 minutes.
- **CQ2. A heads-up** by text to every full-access board member whenever one of those happens, naming who did it, and also when someone uses Text all members or downloads every household as a CSV.
- **CQ3. A second board member approves** the changes Doug picks: the change waits, with a to-do and a text to the approvers, until one of them approves with their own texted code. Until then nothing changes, so payments keep going to the current account. Expires after 7 days.
  Doug's answers 11/8: a second approval for switching Stripe accounts, changing the Venmo handle, and giving someone full access (not a board member's phone or email, which get the code and the heads-up only). The approver is the Treasurer or anyone else with full access; a club with nobody else gets Poolside, on the provider console. The approver gets a text with a link to the change on their board, and approves it with their own texted code.
- **CQ4. The new season's checklist** gets "Check that payments still go to the club", showing the Stripe account's name and the Venmo handle as they are now, linked to Money setup.
- Failing test first: `test_money_locks` (52 checks, offline), in CI. Built 11/8 on Doug's "Build deploy". No board passwords (Doug: text codes are enough). There is no screen to change a board member's phone or email today (it comes from their invite), so CQ1's fourth lock has nothing to guard yet; add the code if one is ever built. Text all members already needed a second board member to release it, so it only gets the heads-up. `test_stripe_preflight` updated: switching now asks for a code and changes nothing until approved.

### CP. "What the app does" video, next to Full app experience (Doug, 11/8)
Doug: "create a video highlighting the benefits of the app… put that video next to the selection of full app experience… the party booking party specifically, unlock by phone, communications features, chat feature. See an issue take a photo. Ease of signing up… no wait time if you pay by card… unlock is already loaded on phone. Full calendar which will have swim meet and practice schedules", then "Same type of video like you did tutorials. Just don't click through as fast".
- **CP1. The video.** Made like the step-by-step tour (`tour.mjs`, PLAN.md BD2): the real member pages with the made-up club's data, a camera that zooms into what's in use, a ring on what matters, a short title per step, one spoken line per step in the tour's voice, texts and pop-ups as bubbles. Slower than the tour: about 140 words a minute, and each screen held until its line is done plus a beat. Captions burned in, since many people watch muted. Its own script, `member_video.mjs`, so the tour stays as it is.
- **CP2. The story,** one family on one phone:
  1. Signing up takes a few minutes; pay by card and you're in straight away, no waiting on the board.
  2. The welcome text signs you in, no password, and the app on the Home Screen opens signed in.
  3. Open the gate from your phone during pool hours.
  4. Book a party: pick a day and time, pay, and it's booked.
  5. Ask the board: a message goes to the board member who handles it, and their reply pops up. See an issue? Take a photo and send it.
  6. Club news as pop-ups.
  7. The calendar: swim meets, practices and club events.
  8. Close: "Choose the Full app experience. It's free with your membership."
- **CP3. On the join form.** Under "Full app experience", a "Watch what the app does" button with its length, playing like the add-the-app videos (`js/pwa.js`), from `/videos/`.
- Accurate claims only: the gate button works in season during member hours, and swim schedules show only once the club adds them.
- Test first: the video's script runs every step against the made-up club and stops if anything it taps isn't on the screen (like `test_demo_video`); the join form's button and video file are checked offline.
- Doug's answers 11/8: about 90 seconds; the made-up club (Maple Grove), so it fits every club; Bishop's swim meets and practices will come from the swim team's own calendar link, synced in; and also show pay over time, the whole family on the app, renewing next year in one tap, and keyfobs in the app. Those four are a short closing run (a few seconds each), so the main parts keep their slower pace. Made from the 90-second video's script (`promo.mjs`, which the add-the-app tutorials also came from): Ava's voice, subtitles on screen, the music under her, the phone with a big title per part. Doug sees it before it goes on the join form.
- Built 11/8: `scripts/demo_video/member_video.mjs` (Ava at 150 words a minute, a beat after each line), 1:55 with everything Doug picked, `videos/what-the-app-does.mp4` (9.7 MB, 720p), the full-size copies in `handouts/`. The join form shows "Watch what the app does (1:55)" under Full app experience, which plays it in place, and the Full app line now reads "Open the gate from your phone, book parties, ask the board (with a photo), get club news, and see the calendar." `test_member_video` (13 checks, in CI). Not deployed: Doug watches it first.

### CO. A membership discount for each board member (Doug, 11/8)
Doug: "when adding that board member, there should be a spot that has a check box allowing for a free membership? … Or have a discount apply right there?", then "Yes plan build dwploy". (Bishop's rule: half off over 80 member families, free over 100; the President sets each person's discount and changes it when the count passes 80 or 100.)
- **CO1. Set it on the Board page.** Inviting someone has "Membership discount": None, Half off, Free, or another percent. Each board member's row shows it ("Free membership") and the President changes it there (`board` `set_member_discount`, President or full access only). Stored on the board login (`admin_users.member_discount_pct`).
- **CO2. It comes off their family's dues by itself,** for as long as they're on the board: on their renewal (their family has a member linked to their board login, PLAN.md CN) and on their own signup started from their board home ("Sign up your own family", which sends their board sign-in, `applications.board_admin_id`). Never from a phone number typed into the public form, so nobody can claim a board member's discount by typing their number. Dues only, not keyfobs or parties. One discount counts: the biggest of the board's, a code, or a friend's referral (`discount_kind` 'board'). Free goes the "nothing to pay" way.
- **CO3. The signup, renewal and the board's Signups say "Board member discount".**
- Someone who paid before their discount was set is refunded by hand. A board member who leaves the board pays full price from their next renewal.
- Failing test first: `test_board_discount` (27 checks, offline), in CI. Built 11/8; all 66 offline suites pass.

### CN. A member invited to the board is linked to their family (Doug, 11/8)
Doug: "If a board member is invited, I want to be able to invite them the normal way… if they are already a member, it will link the accounts and both options for board or member view can flip back and forth… we would need to sign up under the same phone number".

Today: the board side's "Member view" (board home, and More on phones) shows only when the board login is linked to a family member (`admin_users.linked_member_id`). That link is made only when a family is approved after the person is on the board (`autoLinkAdminToMember`, primary's phone or email). Invited after joining, they get no Member view, and the setup list asks them to "Sign up your own family". The family side's "Board tools" already matches by phone or email. Deleting the family clears the link (the foreign key sets it to null).
Doug 11/8, on the plan: "If it's a family Membership, the family shouldn't have board access.. So track that by the phone number". The link is one person, by their mobile number; nobody else in the family gets anything.
- **CN1. Link at the invite.** `tenant_admin_auth` `invite_admin`: the one active family member at the club with the same mobile number is linked. The Board page says so: "They're a member too (Skeen Family), so they can switch between the board and their family." An email-only invite links nobody.
- **CN2. Board members already on the board** are linked the same way the next time they open the board (`me`, only while not linked).
- **CN3. The person, not the primary.** The signup's link at approval matches the board member's number against every adult in the family with a phone, so a spouse on the board is linked to themselves, not the person who opened the membership. By phone only (it used email too).
- **CN4. Phone only everywhere.** Today the family side's "Board tools" and the shared pop-up switch (`_shared/board_member.ts`) also match by email, so a spouse who shares the board member's email would see Board tools and could register their phone for board pop-ups. Both become the link or the same mobile number only.
- Signing in stays per side: Member view opens their family side, which asks for a texted code the first time on that phone; after that both sides stay signed in and the switch goes straight across. (A board sign-in never signs anyone into a family, so a mistyped number can't open someone else's family.)
- Failing test first: `test_board_link` (15 checks, offline, pretend database; Member view for a linked board member checked in the page source), in CI.
- Built 11/8 on Doug's "Yes build it", not deployed yet. All 65 offline suites pass.

### CM. A family that skips the app, and removing a saved card (Doug, 11/8)
Doug: "Have we checked the flow of someone doesn't have the full app experience and just buys a membership… have a button to remove their card… make sure though it will auto reject all future payments etc.. Check all scenarios".

Doug's answers 11/8: on a plan with payments left, "Swap only until paid…. Unless they cancel… no refund on payments" (Cancel plan, which ends the membership with no refund, then lets them remove it); the family removes it, not the board ("Family only"); announcements by email to families no pop-up reached; the no-app welcome text without a link.

What a "Just sign me up" family (`no_app_member`) gets today, traced in the code 11/8:
- Fine as is: every payment email (welcome with the plan, receipts, gate on at half, declined, last try, canceled, Welcome back), party decisions, help replies (email when no pop-up reached them), the dues reminder, the renewal message and one-tap renewal (both links need no sign-in). Updating a card, reinstating, Pay now and keyfob extras need a sign-in, which works in any browser with a texted or emailed code.
- **CM1. The welcome text.** The form tells them "No SMS reminders are sent unless you later opt into the app", but approval still texts them a sign-in link.
- **CM2. After paying by card,** the "You're in!" page's big button is "Sign in to your member home", even though they chose no app. Say they're a member and see you at the pool, with a small "sign in any time".
- **CM3. Pop-ups with no email.** These reach nobody without pop-ups on (every no-app family, and app families who never added it to the Home Screen): "Your keyfob is ready" and "Your new keyfob is ready" (pick it up from the board), "Keyfob request canceled", and after a refund "Your membership has ended" and "Your party is canceled". Send the same words by email when no pop-up reached anyone in the family (`notifyHousehold`), as one new email, "Message from the club" (22 emails).
- **CM4. Announcements** are pop-ups only (Doug 10/7), so a no-app family never sees club news.

Removing a saved card. Where cards live: Stripe customers on the club's account; `households.auto_renew_pm_id` (auto-renew) and `payment_plans.stripe_payment_method_id` (plans). Nothing in the app removes one today.
- **CM5. "Remove my card"** on My family, showing which card ("Visa ending 4242"), with a confirm: "Nothing can be charged to it again. Past payments and receipts stay." It removes every card on the family's Stripe customers (an old card left after Update card too), clears both fields, turns auto-renew off and keeps the auto-renew consent as revoked (as Turn off does), and logs it. Test-payment cards are cleared without Stripe.
- What it stops, each checked by a test: approving a renewal with the saved card refuses ("There's no saved card", already true); the daily run never charges the family; turning Connect to a different Stripe account no longer counts their card.
- Scenarios: no card saved (no button); auto-renew card only; a plan with payments left (Doug's answer); a plan waiting at Stripe's page (no card yet); a plan paid off, canceled or lapsed (removable; reinstating takes a card again on Stripe's page); several cards; test cards; past payments, receipts and refunds untouched.
- **CM6. A plan with no card is skipped by the daily run without a word** (`if (!plan.stripe_customer_id || !plan.stripe_payment_method_id) continue`), so its payments sit unpaid until a deadline cancels it. Never silent: it becomes the declined-payment path (the family is told to pay in the app, the board gets its to-do).
- Failing test first: `test_card_remove` (31 checks) and `test_no_app` (22), both in CI.
- Built 11/8, not deployed yet. On a plan with payments left, My family shows the card with why it stays and a Switch card button (to the plan); once the plan is paid off or canceled, Remove my card works. "Message from the club" is the 22nd email (Family changes section, two versions: a keyfob notice, an announcement). Announcements go through the email queue, so on Resend's free plan about 75 go the same day and the rest with the next morning's daily run; the board's toast says how many. The no-app Venmo page now says "a welcome email and text". All 64 offline suites pass.

### CL. A signed payment plan agreement, and emails that follow a plan family through (Doug, 11/7)
Doug, after the email walk-through: "Do all that… all together and deploy", plus "If they have a payment plan, we should have another signature that they accept the payment and payment plan agreements…".
- **CL1. The payment plan agreement.** One text, built from the schedule they picked (`planAgreement` in `_shared/payment_terms.ts`, and `js/plan-agreement.js` for the screen, kept word for word the same): every payment and its date, the total; charged on its date once the board approves it, a receipt each time; a declined card is tried again and can be updated in the app; the club's deadlines ("75% paid by May 23, everything paid by July 1"); missing one cancels the membership, gate access and keyfob off, back by paying what's overdue plus the reactivation fee; when gate access starts; pay off early any time; Cancel plan ends the membership at once, no refund. Then "I agree to this payment plan and authorize Bishop Estates Cabana Club to charge my card on the dates above."
- **CL2. A second signature.** The plan picker (join form, renewal link, renewal in the app) shows the agreement under the schedule with its own signature pad; changing the schedule clears it. Checkout won't start a plan without it (`stripe_checkout` `application_plan`, 409 `needs_plan_signature`) and saves the text they saw and the signature on the signup (`applications.plan_agreement`). Their signed membership PDF has a "Payment plan agreement" page.
- **CL3. Emails that follow the plan.** The welcome, and now a "You're renewed" for a renewal on a plan, carry "Your payment plan": the agreement's lines. The payment that reaches half says their gate access is on. After the last try of a declined card the family is told again: pay it in the app before the next deadline or the membership is canceled. Paying to come back gets "Welcome back", not a bare receipt.
- **CL4. The join form's plan text** says the first deadline's real share ("75% paid by May 23"), not "half".
- Failing test first: `test_plan_agreement` (offline), 32 checks, in CI.
- Done 11/7. The agreement is saved at checkout, after the form is sent, so the PDF attached to the welcome email (made at approval) has it; the Drive copy made when the form is sent doesn't. A $0-today renewal on a plan used to get no email at all; it now gets "You're renewed" with the plan. The last-try email and pop-up go only when the card was retried (not when a club has no retry days). `test_test_level` and `test_receipts` updated for the signature step and the longer receipt function. The live plan test (`scripts/lib/flex_plan_live.mjs`) sends a signature.

### CK. Every email checked against what changed (Doug, 11/7)
Doug: "go check all the emails... are they correct format? correct for eveyrhting we have changed recenelt?", "check that along with the content as well". Rendered all 30 versions of the 21 family emails with the Emails page's sample details, read each, and read the board emails built in place. The layout is right at phone width (nothing wider than the screen, buttons and boxes in place); receipts, the Venmo line and the declined-card wording match BZ and CJ. Wrong for what changed:
- **CK1. "The board member who handles"**, singular, since member questions go to everyone with the topic (CE): the party-booked email's "It goes straight to the board member who handles parties", and four places in the family app. Two of those also said "You'll get a text when they reply"; replies are a pop-up, or an email when it didn't reach them, never a text (Doug 10/7).
- **CK2. Board invites said "admin"**: the email's subject "You're an admin on …" and "you've been added as a Events & Rentals Director", and the text's "you've been added as an admin". Now "You're on the … board" and "added to the board as Events & Rentals Director".
- **CK3. The board's plan-ended email** said "canceled because your payments weren't…" (the family's sentence, sent to the board) and, like the board's party-booked email, wasn't in the club's email look (BG5). The party one also said "Parties & events, which comes to you", which depends on the ticks.
- **CK4. The Emails page's samples**: the plan-canceled preview used "your card could not be charged" (no longer a reason, CJ), and the volunteer thank-you previewed with blanks ("Thank you for helping with .", "Use code  when…").
- Failing test first: `test_emails` CK checks.

### CJ. Payment plans: only a missed deadline cancels; a failed payment tells the board (Doug, 11/7)
Doug, on why a keyfob goes off when a plan ends: "IF they have not paid up to the terms… like half before open and then full amount before the correct date, it's deactivated…. If the payment doesn't go through for whatever reason during that time that it should be active, it can leave on, but we need the notification that the payment was fucked up", "Only cancel or turn off keyfob if they miss a deadline", "If they click a cancel membership button, it should cancel right away", "if someone on a payment plan misses a payment we should be notified right away". The deadlines stay his to set (Money → Payments → Money setup); he likes "paid in full by opening day" ("no swim on credit") and will decide.
- **CJ1. Every deadline counts.** The daily run cancels a plan (membership canceled, keyfob and app Unlock off at once, the reinstate path as before) when a deadline has passed with a payment due by then still unpaid, the first deadline as well as the paid-in-full date (`missedDeadline` in `_shared/plan_ops.ts`). Before, only the paid-in-full date counted. Never over a payment the board hadn't approved (S2).
- **CJ2. A failed card no longer cancels anything.** The card is still tried on the retry days; after the last try the plan stays open, past due, and the family can update their card and pay what's overdue in the app. The keyfob stays on unless a deadline is missed.
- **CJ3. The board hears right away.** On a plan payment's first decline, whoever gets payment alerts gets a to-do and a pop-up: whose payment, how much, why, the next try and the next deadline (`plan.payment_failed`, the "payments" alert). After the last try fails, it's replaced with "still hasn't gone through". Both clear themselves when the payment goes through (the card's retry, or the family paying in the app).
- **CJ4. Cancel plan cancels right away**: the keyfob and app Unlock go off then, not when the season starts.
- Wording: the family's declined-card email says what happens by the next deadline instead of "If it still can't be charged, your membership is canceled"; the app, the help article, Money setup and the email list say only a missed deadline cancels.
- Failing test first: `test_plan_approval` (offline): `missedDeadline` (each deadline, paid, not passed, not approved); `failedPaymentTask`'s wording; the daily run never ends a plan for a card and checks every deadline; the first decline and the last try tell the board; a payment clears it; Cancel plan turns access off at once; no "can't be charged… canceled" left for families.

### CI. Before the board gets the app: a check of who's told what (Doug, 11/7)
Doug: "Run through scenarios and see what else we missed with things like this… notifications for each board member… Any other changes based off of other things we did… Check check check. I'm about to hand out this to the board". Checked: every kind of to-do and who it reaches with Bishop's positions filled (all routed; none only to full access), every position's board loaded as a preview (all eight fine), the emails to board members (to everyone holding the alert), and the preview against every board page's reads.
- **CI1. "Turn off the key fobs" when a plan ends** had CH's problem: linking to Payments, even with no keyfob. Same rule now (`fobOffTask`): only with a keyfob on the doors' list, in season, with the nightly sync off; "tap Sync keyfobs now", opening Keyfobs & Access.
- **CI2. Wording that named a position**: the plan-ended email said "the Facilities Director is asked to turn off their key fobs", and Money setup's plan options named the Facilities Director and the Treasurer. Alerts go by the ticks on Settings → Board, so they now say what happens instead of who.
- For Doug to decide (Settings → Board), not code: gate and keyfob alerts reach only the President though the Grounds and Events & Rentals Directors have the Keyfobs screen; the Vice-President has no alerts or screens; photo approvals reach five positions and "Something else" six.
- Failing test first: `test_plan_approval` CH/CI checks: `fobOffTask`; `enforceEnd` uses it and never Payments; no position named in the email or the plan options.

### CH. The "key fobs can be turned on" to-do only when there's a keyfob to turn on (Doug, 11/7)
Doug: "I have a notification for giving a keyfob but it goes to the payments…. Then I go to keyfobs and nothing is there too". This morning's payment run saw the $1 test family pass half paid and made "Frevele Family have paid half their dues: their key fobs can be turned on", linking to Money → Payments. That to-do is from before Poolside managed keyfobs: it went out though the family has no keyfob at all, so Keyfobs had nothing for them.
- **CH1.** When a plan family's gate access comes on (half paid, or paid up again), the keyfob person gets a to-do only if the family has a keyfob on the doors' list, the Season switch is open (otherwise member fobs stay off anyway) and the nightly keyfob sync is off (otherwise it turns them on by itself). It says "tap Sync keyfobs now to turn their keyfob on" and opens Keyfobs & Access (`fobOnTask` in `_shared/plan_ops.ts`). With no keyfob there's nothing for the board to do: the family's app Unlock works as soon as access comes on.
- The test family's to-do from this morning is dismissed once this is live.
- Failing test first: `test_plan_approval` (offline): `fobOnTask` with and without keyfobs, off-season, with the nightly sync on, its wording and link; `grantAccessIfReady` counts the family's keyfobs and uses it. The live plan test expects no to-do for a family without a keyfob.

### CG. Date and time boxes stay inside their column on iPhones (Doug, 11/7)
Doug, with a screenshot of Start a board meeting: "The pop up is a little offset at the top". On his iPhone the Date box ran past the pop-up's right edge and Starts at slid under Location: Safari draws date and time boxes at their own width and ignores the width they're given. Chrome doesn't, so the offline renders never showed it. The signup page and the member app's party form already had the fix, page by page.
- **CG1.** `js/phone-fit.js`, on every page with a date or time box and only on iPhones, turns off Safari's own drawing of them (`appearance: none`, the signup page's recipe), lets them shrink to their column (`min-width: 0`), keeps them 44px tall when empty, and lines the date up on the left.
- **CG2.** The meeting pop-up's paired fields (title and date, start time and location) stack one per row on phones, as the signup form's do.
- Failing test first: `test_board_meetings` (offline): the iPhone fix in phone-fit.js and on every page with a date or time box; in Chrome at iPhone width with an iPhone's browser, the pop-up's fields one per row, none past its edge.

### CF. No lifeguard and gate logins on Settings → Board (Doug, 11/6)
Doug asked what the "Lifeguard and gate logins" section at the bottom of the Board page is (a login that only shows check-in and the person's own lifeguard shifts, for a gate iPad or a guard), then: "Remove that… dumb".
- **CF1.** The section goes: its heading, list and "Add a lifeguard or gate login" form (`club/admin/board.html`). No club has one (checked 11/6), so nobody loses a login. The check-in page and the gate-login role stay in the code; board members still open check-in from Settings → Gate & check-in. Lifeguards picking their own shifts needed those logins; lifeguard scheduling is off at every club, and its help article says Poolside support sets a lifeguard login up if a club ever wants it.
- Help: Board members, Check-in and Lifeguards no longer send anyone to the section.
- Failing test first: `test_positions` K2 (offline): the Board page has no lifeguard or gate login section or its invite form; `test_help_articles` keeps every bold path real.

### CE. Member help questions go to everyone with the topic ticked (Doug, 11/6)
Found in the Facilities Director's preview: "You handle: Keyfob & gate…" with "Doug Frevele (President)" under every topic. Each topic went to one person, the first position on the Board list with it ticked, and Bishop's President has every topic ticked, so every question would keep going to Doug after others join. Doug: "Can multiple people get the topic" → "Yes do that. Multiple people should be able to see the member help questions".
- **CE1. Everyone with the topic ticked sees the question.** A member's question is no longer handed to one person when it arrives: everyone who holds a position with its topic ticked (none: the President, as before) sees it on Member help, has it on their dashboard and gets the pop-up (the to-do is the topic's alert, `notice`, not one person). Full access still sees every question. `canSeeHelpRequest` takes who gets the topic; `help_requests` `list` shows a person what's handed to them plus every topic they get.
- **CE2. Whoever answers first handles it.** The first board reply makes them the one handling it (`assigned_admin_id`): the to-do moves to them alone, the family's later replies pop up for them, and everyone else sees "Pat is handling it" on Member help. Hand-off (Hand to…) works as before.
- **CE3. Who handles what lists everyone** for each topic, and "You handle" is the topics you get, from the same rule, so they can't disagree (in a position's preview too: "Facilities Director (this position)"). The dashboard says "For the Facilities Director" for a person holding it, not the first position on the list.
- **CE4. The family's app** says "Sent to the board members who handle keyfob & gate" and "The board is handling this" until someone answers, then their name, as now.
- Sign-ups made from a member question (`volunteer` `from_help`) follow the same rule.
- ✅ CE1–CE4 live 11/6 (cf57f35) on Doug's "Ya go ahead".
- **CE5. Only your own topics** (Doug 11/6: "the secratary right now only handles the something else.. The secratary shouldn't see all the other items that could be helped"). Member help's Who handles what shows a board member only the topics that come to them ("You handle: Something else", and who else shares it); someone with none is told so and where it's set. Full access (the President) still sees every topic and who has it. `help_requests` `topics` sends only theirs; the page lists only what it's sent.
- Failing test first: `test_help_requests` (offline): the rule with several people, the list's filter, the to-do's alert, the first reply's claim, both pages' wording; in Chrome, Member help's Who handles what with two names. CE5: the topics sent to someone without full access are only theirs; in Chrome, a Secretary's Who handles what lists only Something else, and someone with none is told so.

### CD. The club setup list goes to whoever you pick (Doug, 11/6)
Doug, after the Secretary's preview showed the whole setup list: "That list of setup should only be president or maybe we have an accisible tab for poolside onboarding setup? We can select who deals with the setup… might not always be the president". His picks: a position you choose (Club setup, like the other alerts), and the list on their home plus a Setup tab.
- **CD1. A "Club setup" alert** on Settings → Board, ticked on positions like the others (`NOTICES.setup` in `_shared/positions.ts`, which also gives the Policies screen its step needs). Whoever holds a ticked position handles setup; if nobody does, it goes where every unassigned alert goes: the President (so Bishop needs no change). `tenant_admin_auth` `me` says `handles_setup`.
- **CD2. Only they see the list.** `tenant_settings` `setup_status` (`_shared/setup_person.ts`): for them, every step; for everyone else, only "Sign up your own family" (it's theirs), as its own small card on their home, and no one-line reminder on other pages. Seven steps can only be saved with full access (logo, headline, address, pool and hours, prices, how members pay, board positions); someone handling setup without full access sees those marked "Needs full access: ask the President" instead of a button that would fail. On the Board page, ticking Club setup on a position without full access says so.
- **CD3. A Setup tab under Settings** (`club/admin/setup.html`), for whoever handles setup and anyone with full access: the full list, always open, even after Hide for now or when it's all done. Anyone else who reaches it sees who handles setup and their own step.
- Help: Getting started says who sees the list and where the tab is.
- Failing test first: `test_setup_person` (offline): the alert and who it goes to; the steps each person gets; `me` and `setup_status` wired; the tab's rule in the nav; in Chrome, a Secretary's home (only their own step, no reminder), the setup person's home and Setup tab, the full-access notes, and the Board page's alert.

### CC. See a board member's view, look only (Doug, 11/6)
Doug: "is there a way i can see each board members board page as i have selected their options..? just a view somehow?" He picked "Open their board": their real board home with their banner, quick buttons, tabs, bottom bar and the to-dos that go to them, look only, President only.
- **CC1. The look-only sign-in.** `tenant_admin_auth` `view_as` (`admin_id`): the President (an owner) only, for an active board login of the same club other than themselves. It returns a one-hour sign-in of a new kind, `board_view` (`_shared/board_view.ts`: who it's for, who's looking). Every function already refuses any sign-in that isn't `tenant_admin`, so by default it can do nothing. Three open just the reads the board home makes (`VIEW_READS`): `tenant_admin_auth` `me`, `admin_tasks` `home` / `list` / `count`, `tenant_settings` `setup_status`. Anything else gets 403 "This is a look-only preview" (not 401, so nothing signs out). `me` answers as them (their screens from the database, so it shows today's ticks), never renews into a real sign-in, and says who's looking. Nothing is recorded as theirs: no last sign-in, no pop-up devices, no hand-off.
- **CC2. "See their view" on Settings → Board**, beside each board member but you (President only). It opens their board home in the same tab (so it works in the Home Screen app), with a bar on top: "👁 Viewing as Sam Brooks · Treasurer. Look only." with "Their screens" and "Close". Close goes back to Settings → Board.
- **CC3. The preview tab never touches your own sign-in.** `js/board-view.js` loads first on the board home. It keeps the look-only sign-in in this tab only, and every board sign-in this tab reads or writes is the tab's own copy, so your sign-in (other tabs, the Home Screen app) is untouched, and so is anything else the page saves. It also stops any call outside `VIEW_READS` before it leaves the phone ("Look only: nothing changes in a preview"), and skips pop-up sign-up and the Home Screen hand-off.
- **CC4. Their other screens.** Their screens look the same as yours for anyone who can open them; what differs is which ones. So in the preview, tapping a tab, a quick button, a to-do or More's links shows "Sam can open:" with each section and its tabs (from the app's own nav rules, `AdminNav.sectionsFor`), instead of leaving their home. Any other board page opened in a preview tab goes back to it.
- Failing test first: `test_board_view` (offline): `view_as` is for owners, same club, active, not yourself; the token is `board_view`, an hour; only `VIEW_READS` accept it, each refusing anything else before doing any work, with 403; every function that reads a board sign-in checks its kind; `me` never renews it. In Chrome: the Board page's button, the preview home with the bar, their bottom bar and screens only, no call outside `VIEW_READS`, your sign-in in storage unchanged, the screens list, Close.
- Needs the functions deployed (`tenant_admin_auth`, `admin_tasks`, `tenant_settings`) before the pages work, so it waits for Doug's "deploy".

- ✅ CC1–CC4 live 11/6 (134e8d7) on Doug's "deploy". Live check with a made-up preview sign-in: every change refused (403 in the three, 401 everywhere else), the three reads answered. Bishop has no other active board login yet, so Doug had nobody to preview.
- **Doug 11/6, next:** "so there has to be an actual live board member? i can't just see it the way it is" → "yes build that and deploy - i dont want to need to invite someone.. just see and interacti with thier interface". His pick: open their screens too, look only.
- **CC5. See a position's view, nobody needed.** Each position on Settings → Board gets "See this position's view" (President only). `view_as` with `position_id` gives the same look-only sign-in with `pos` and no person (`sub` is the empty id). `me` answers as the position: its title, its screens, no owner. The home and its to-dos (`admin_tasks`) and Member help (`help_requests` `list` / `get` / `topics`, now in `VIEW_READS`) are worked out as if they held it: alerts for the position come to the preview, and member questions and to-dos assigned to whoever holds it now show too.
- **CC6. Their screens open.** Tabs, quick buttons and to-dos now open their screens, in the preview, instead of the list. `js/board-view.js` is first on every board page. A screen's reads go through a new function, `board_preview`: it takes only the look-only sign-in, only reads on its list (`PREVIEW_READS`, every one checked to write nothing; three tidy up as they read, as they do for anyone: expired texts, an unfinished keyfob check, a season never pinned), checks the President who opened it is still an active President, then asks the screen's own function as that President with a one-minute sign-in and answers as the preview (`is_owner`, `me`). Anything else is stopped on the phone and refused by the server. A screen they can't open says so ("The Facilities Director can't open this screen") with Back. Texting, calling and emailing links, and the member side, stay shut.
- Failing test first: `test_board_view` grows: the position sign-in and `me`; `PREVIEW_READS` only reads, each a real action, none writing; `board_preview`'s order (sign-in, list, President, then forward, action forced); every board page loads `board-view.js` first; in Chrome a position preview, opening Keyfobs through the relay, a screen they can't open, the Board page's position button.

- ✅ CC5–CC6 live 11/6 (13de243). Live check as Bishop's Grounds Director: reads as the position, every change refused.
- **CC7. Two things Doug found on the Secretary's preview (11/6):** "under home and sign up your family... it drags on.. check the formatting of this.. then also for example i click on keyfobs and access, which they dont have access to... why is the icon even there?"
  - The setup list's "Sign up your own family" step: its two buttons never moved to their own line, so at phone width the words stood one to a line down the page. Every step now puts its buttons under the words when they don't fit beside them. Not only the preview: Doug's own home has that step.
  - Keyfobs & Access in the Members tabs: the tab strip is drawn with every tab, and the tabs a person can't use were hidden once, when the page learned who's signed in. Switching between Households and Renewals redraws the strip, and the hidden tabs came back (Signups and Keyfobs & Access for the Secretary). The strip now leaves out the tabs a person can't use every time it's drawn (`js/admin-subtabs.js`, the same rule as the bottom bar). Board and Sponsors, which never hid any, now do too. Real board members had this, not only the preview.
- Failing test first: `test_board_view` CC7 (offline, Chrome): a Secretary's Members tabs before and after switching to Renewals, and Settings → Board's tabs; the setup step's words at least 180px wide at phone width.

### CB. No spending rule on the board's screens (Doug, 11/6)
Doug, on Settings → Board while adding board members: "remove the spending rule top boarder thing.. .thats stupid".
- **CB1.** The yellow "Spending rule for every position" box at the top of Settings → Board goes, with its Edit window. So does the "Spending rule:" line under Your job on the dashboard, since nobody could change it any more. Screens only (`club/admin/board.html`, `club/admin/index.html`); the saved rule stays in the database unused, so nothing on the server changes.
- Failing test first: `test_positions` K2 and K4 (offline): neither page shows or edits a spending rule.

### CA. "Add the app" videos for families (Doug, 11/6)
Doug: "can you make a video describing and walking through how to add the app to your home screen on a iphone/android". His picks: made like the 90-second video ("you created a video before... do that same thing"), for families (the member app), two short ones (iPhone, Android), Ava's voice with subtitles.
- **CA1. The app's own steps match today's phones.** Since iOS 26, Safari's Share button sits behind "•••" next to the address bar, and Add to Home Screen has an "Open as Web App" switch (on). The member app's "Add this club to your home screen" card and the board's activation page still say "Tap Share at the bottom of Safari". New iPhone steps: tap ••• next to the address bar, then Share (on older iPhones, Share is at the bottom); scroll down and tap Add to Home Screen; leave Open as Web App on and tap Add. `js/pwa.js`, `club/admin/activate.html`.
- **CA2. The iPhone video (about 45 seconds).** The real member app (the made-up Maple Grove club, like every demo video) in a drawn iPhone with Safari's bottom bar: open the club's link in Safari (from Gmail and the like, open it in Safari first); ••• → Share → Add to Home Screen → Open as Web App on → Add; the icon on the Home Screen; open it, already signed in; Turn on notifications → Allow.
- **CA3. The Android video (about 45 seconds).** The same in a drawn Android phone with Chrome: the app's own "Add to home screen" button → Install (no button: Chrome's ⋮ menu → Add to Home screen); the icon; open it, signed in; notifications → Allow.
- Made by `scripts/demo_video/homescreen.mjs` with `homescreen.html` (the 90-second video's voice, subtitles and music), writing `handouts/poolside-home-screen-iphone.mp4` and `-android.mp4`, each with a small copy and subtitles. The narration says "your club", so it fits any club; the screens show Maple Grove.
- Failing test first: `test_demo_video` (offline): the app's iPhone steps, and both scripts' steps in order with every screen they tap drawn on the stage.
- ✅ Made 11/6: 7 checks failed first; now `test_demo_video` passes (33), and the suites near the changes. iPhone 48 s, Android 42 s, checked frame by frame (the share sheet slowed down so Add to Home Screen is ringed before it's tapped; Safari's bar no longer covers the app's tab bar). The board's "put the board app on my phone" help article has the new iPhone steps too. The videos are in `handouts/` (not in git).
- **CA4. The video in the app, under the written steps** (Doug 11/6: "where would the video be hosted if we can create a link to them on the app? I still want the directinos so if epople know how to do it... but if they dont they can refer to the video"; "yes go ahead and deploy it"). Hosted on poolsideapp.com itself, next to the pages (Vercel's network, nothing extra to pay, no YouTube ads or "up next"): `videos/add-app-iphone.mp4` and `videos/add-app-android.mp4`, 720p copies of about 6 MB each so they load on cell data, written by `homescreen.mjs` with the others. The written steps stay as they are. Under them, "▶ Watch a 48-second video" plays the one for the phone: the iPhone video on the iPhone tabs (Safari and Chrome; Chrome's steps already send people to Safari), the Android one on Android, switching with the tabs. Tapping it plays the video right there in the card (full screen on an iPhone). On the member Home's "Add this club to your home screen" card (`js/pwa.js`) and the board's activation page (`club/admin/activate.html`). Not on a computer, which is told to open the page on a phone.
- Failing test first: `test_demo_video` CA4 (offline): both files exist, are under 8 MB, and their length matches the label; the member card at iPhone width with an iPhone's browser shows the steps and the iPhone video, the Android tab switches it, and tapping plays it in the card; the activation page has it too; no rewrite in `vercel.json` catches `/videos/`.
- ✅ Made 11/6: 10 checks failed first; now `test_demo_video` passes (44) and every offline suite. The web copies are 5.9 MB (iPhone, 47.6 s) and 5.3 MB (Android, 42.4 s), 720p, made from the same frames.

### BZ. A real PDF receipt for every card payment (Doug, 11/6)
Doug: "the recpeit isn't like an official one... can you make a PDF of some sort?... save them in the google backup... make a family folder... when someone signs up they get 2 pdf... one is their membership.. second is a receiept". His answers 11/6: folder "Smith - 123 Oak St" is good; "for venmo payments, we arent sending reciepts.... under any venmo payment, make sure it says board needs to approve... and use the venmo reciept as your receipt"; "put the address of the club on the reciept too"; not in the app: "its fine if they are all just emailed and then if someone needs one we can send it out agian". Then: "whatever the address the club enters, is what the address is on there... make sure during onboarding, there is an address tab... no resending receiept... we can email itfrom drive... go and build it.. then deplyoy".
- **BZ1. The receipt PDF** (`_shared/receipt_pdf.ts`): the club's name and address, "Receipt 2027-0001" (numbered per club per season), the date paid, who paid (name and email), what for ("2027 Family membership", "Plan payment 2 of 5", "Party on June 14", "2 keyfobs"), the amount, the card fee if any, the total, "Paid by Visa ending 4242", and for a plan what's left. One `receipts` row each (number, what, amount, family, payment, Drive file).
- **BZ2. Every card payment gets one, attached to the email it already sends:** a signup or renewal (two PDFs: the signed membership form and the receipt), each plan payment, a party, keyfobs, a program, a donation.
- **BZ3. Venmo: no receipt.** Wherever a family pays by Venmo (the signup form, renewal, parties, keyfobs, donations) and in those emails, one line: "The board confirms Venmo payments. Your Venmo receipt is your receipt."
- **BZ4. A folder per family in Drive:** a "Families" folder in the club's folder, one folder per family ("Smith - 123 Oak St"), holding "2027 Membership.pdf" and every receipt ("2027 Receipt 0001.pdf"). New files only; the old "2027 Sign-ups" folder stays as it is. The roster's rows still link to the membership PDF, now in the family's folder. The board sends a copy again from Drive; nothing to resend in Poolside.
- **BZ5. The club's address:** a "Club address" box on Settings → Club info, exactly as the club types it (until then, its location), and "Enter your club's address" in the setup checklist on the board home.
- Not in the app. A help article, "Do families get a receipt?".
- Built 11/6: `test_receipts` (new, offline) failed 34 of 35 first; now 59 pass, and every offline suite (58; `test_drive_backup` now expects the family folder, `test_emails` 21 emails, the demo site rebuilt). One migration (`receipts`). ✅ Live 11/6: the migration, 11 functions and the pages. Doug 11/6: "yes clear the test receipts when we delete the test family", so real receipts start at 0001. Then "add the club logo at the top": the club's logo top left, the name and address beside it, kept with each receipt (`logo_url`). Bishop's logo is a WebP photo of the pool, which a PDF can't hold, so the PNG app icon Poolside made from it is used instead (`logo_icon_url`); one it can't use or fetch is left off. ✅ Live 11/6 (Doug: "deploy"): built and tested (65 checks), migration applied, six functions redeployed. A redeploy of `applications` failed to boot for about two minutes (a name declared twice); fixed at once, no signups in that window, and `test_housekeeping` now parses every function so CI catches it.

### BY. Three fixes from the 11/5 review (Doug, 11/6)
Doug, on the review: "yes... do your unpaid plan idea", "yes do your idea for payment for deleted signup", "yes go do that for the minutes upload". The test club is on hold ("we'll do that later").
- **BY1. A plan waits for its first payment.** A plan is still saved when the family reaches Stripe's page, but as "waiting", not active. Stripe's confirmation (the first payment, or the card saved when nothing is paid today) makes it active. Everything that charges or counts plans reads active ones only, so a family who left Stripe's page drops out of the board home's money numbers, Money → Plans, the Signups "On plan" pill (it reads "Card not paid", BS4), the family's app, and the member check (a renewing family who backed out of a plan isn't counted a member). The daily run deletes waiting plans over 7 days old (Stripe's page closes after a day and its confirmation retries for 3), so an imported family's never-started plan doesn't stay for good. BX's checks stay as a second guard. One migration (the new status).
- **BY2. A signup's Stripe page closes with the signup.** Before the 24-hour cleanup deletes an unpaid card signup, a family's unfinished signup is set aside for a new one, the owner deletes a signup, an unpaid renewal with no family is swept, or a family is deleted for good, Poolside closes its open Stripe page (Stripe's "expire"), so it can't be paid any more. If Stripe says it was paid after all, the signup is kept (cleanup, set-aside, sweep) or the owner's delete is refused. A family who goes back and starts over gets a new page and the old one is closed, so nobody pays twice. `_shared/checkout_close.ts`.
- **BY3. Money for a signup that's gone reaches the Treasurer.** If a card payment still lands for a signup or plan that no longer exists, the Treasurer gets a to-do and a pop-up: "Jane Smith (jane@…) paid $1.34 by card on Nov 6 for a signup that was deleted. Refund it in Stripe, or ask them to sign up again." Today it's taken silently. A to-do only, like the canceled-keyfob one (Doug 10/20: the board decides what to undo).
- **BY4. Uploaded minutes go straight to storage.** The page asks `board_meetings` for a one-time upload link (`upload_minutes_start`, which checks the date, type and size first), sends the file straight into the private club-docs folder, then `upload_minutes` saves it once the file is there (size checked again; one over 25 MB is removed). Nothing big passes through Poolside's server, so a 25 MB scan works. Photos are still shrunk first. The Drive copy is unchanged; it already copies the file as is.
- Failing tests first: `test_plan_approval` (BY1), `test_orphan_payments` (new: BY2, BY3, the pretend database and Stripe), `test_minutes_upload` (BY4), all offline. Deploy `stripe_checkout`, `stripe_webhook`, `payment_plans`, `applications`, `member_auth`, `households_admin`, `board_meetings`.
- The $1 test plan's last three payments (11/7–11/9) must still charge. It's under way, so it stays active; checked after each deploy.
- Built 11/6, not live yet. Failing first: 9 checks in `test_plan_approval`, all 12 in `test_orphan_payments`, the new ones in `test_minutes_upload`; now all pass, and every offline suite (57; BG4's two checks in `test_signup_fixes` now look at `checkout_close.ts`). The migration is applied (it only adds the status). ✅ Live 11/6 (Doug: "go ahead and deploy"): `stripe_webhook`, `payment_plans`, `member_auth`, `applications`, `households_admin`, `board_meetings`, then `stripe_checkout` last, each booted; the page pushed. Live, read-only: Upcoming still lists the $1 test plan's 3 approved payments and the plan is active; the server's upload link took a file straight into storage (removed after, nothing posted); 26 MB is refused before the upload.

### BX. Payments for a signup that never paid don't show on Upcoming (Doug, 11/5)
Doug, after his own-Gmail $1 signup (left on Stripe's page) sat on Money → Upcoming next to the real one: "they are both lined up in there which I think is also a bug. If they aren't a member I shouldn't be able to approve payments." Deleted that signup and its plan at his request first.
- Why: a plan is saved when the family reaches Stripe's page, before they pay. Until then it's "active" with every payment pending, so Upcoming listed all 5, the first included, and the board could tick them (nothing would charge: there's no card). The 24-hour cleanup deletes the unpaid signup but not its plan (no link between the two tables), so the plan would stay on Upcoming for good, and the paid-in-full deadline never ends it because its payments were never approved.
- **BX1. Only plans under way.** A plan counts once its first payment is in or a card is saved (the same rule as setting aside an unfinished signup). Upcoming, the Treasurer's "Approve N plan payments" to-do and the approve button skip the rest.
- **BX2. The cleanup takes the plan too.** When the 24-hour cleanup deletes an unpaid card signup, its never-started plan goes with it.
- Failing test first: `test_plan_approval` (offline). Deploy `payment_plans` and `applications`.
- ✅ Done 11/5. 11 checks failed first; now 27 pass, plus the other plan and signup suites (flex plan, signup notes, signup fixes, test level). `payment_plans` v75 and `applications` v128 deployed. Live, read-only: Upcoming lists only the $1 test family's 4 payments, and approving a payment that isn't under way is refused. `member_auth`, `stripe_checkout` and `stripe_webhook` share plan_ops but only gained unused exports, so they weren't redeployed mid-test.

### BW. Upload minutes for a meeting not taken in Poolside (Doug, 11/5)
Doug: "if we had a meeting and didn't use the meeting feature, i want to be able to say here was a meeting... select a date only... upload the minutes and it backs it up and posts it... saying meeting minutes from 1/1/2026... then you click the link and it shows the minutes." And "dont overwrite anything". His picks: posts right away (no approval), any board member, PDF, photo or Word, Members or Board only each time.
- **BW1. "📎 Upload minutes"** on Content → Board minutes, next to Start a meeting: a date, the file (PDF, Word, or a photo; a photo is shrunk like the others but kept sharp enough to read), and 👥 Members (the default) or 🔒 Board only. Nothing else to fill in. Typed meetings are untouched.
- **BW2. Posted at once.** Members see "Meeting minutes from 1/1/2026" on the Bylaws & board minutes page, in date order with the typed ones; tapping it opens the file (a link that works for an hour, like the bylaws). Board only never shows to members. The board's list shows it too.
- **BW3. Kept private.** The file goes straight to the private club-docs folder (a `board_meetings` `upload_minutes` action, not the public upload), as a `club_documents` row of kind `minutes` with its date and who sees it. One migration.
- **BW4. Backed up.** Copied to the Drive "Board minutes" folder as "2026-01-01 Meeting minutes - uploaded.pdf" (or .docx, .jpg), right away and caught by the nightly run if that fails (BV).
- **BW5. Delete:** whoever uploaded it or the President. The Drive copy stays, like everything else in Drive.
- Word files: an iPhone opens them in the browser; some Android phones download them to open.
- Failing test first: `test_minutes_upload` (new, offline: the server action against the pretend database and Google, and the members' page and the board's page rendered in Chrome). Deploy `board_meetings` and `google_drive_sync`.
- ✅ Done 11/5. 52 checks failed first; now 54 pass, and every offline suite (56). The file goes straight to the private club-docs folder (the public one doesn't take Word files). On phones the board's list now puts the badges under the title (typed meetings too; titles were squeezed to a word a line). Migration applied, `board_meetings` and `google_drive_sync` deployed, pages pushed.

### BV. Board minutes and bylaws backed up to Google Drive (Doug, 11/5)
Doug: "we should probably backup the meeting minutes as well in the google drive". His picks: drafts too, Board-only minutes too, PDF, the bylaws too, one draft file kept up to date. Today Drive gets only signups, signed renewals, the roster and the Parties tab; minutes and bylaws live only in Poolside. Bishop's Drive is connected (last nightly run 11/5, no errors).
- **BV1. A "Board minutes" folder** in the club's Drive folder (Poolside Archive → the club), made again if trashed, like the others.
- **BV2. The minutes as a PDF** (`_shared/minutes_pdf.ts`): the club, title, date, place and times in pool time; attendance; notes; each motion with Proposed by · Seconded by, the count and the outcome; follow-ups. A draft says "Draft, not approved yet" at the top; an approved copy says when and who approved it (and who approved for someone).
- **BV3. One draft file per meeting.** Saved when the meeting closes ("2026-11-05 November board meeting - draft.pdf") and rewritten whenever the draft changes (Save changes, an amendment), never a second draft file.
- **BV4. An approved file** the moment the last approval lands ("… - approved 2026-11-12.pdf"), from the same copy members see. An approved amendment adds "… - amended, approved 2026-11-20.pdf"; earlier files stay. Board-only minutes too.
- **BV5. The bylaws:** each new version posted is copied to the same folder ("Bylaws - posted 2026-11-05.pdf").
- **BV6. Nothing waits on Drive.** The copy runs after the page has its answer; one that fails, or a club that connects Drive later, is caught by the nightly run (a new step 5 in `nightlyDrive`: drafts that changed, approvals and bylaws not yet copied). Deleting a meeting in Poolside leaves its Drive files, like signups.
- Tracking: `board_meetings` gets `drive_draft_file_id`, `drive_draft_hash` (so an unchanged draft isn't rewritten) and `drive_posted_count`; `club_documents` gets `drive_file_id`; the Drive grant caches `minutes_folder_id` (cleared on reconnect). One migration.
- Settings → Backups & archive and the Drive help article say minutes and bylaws are copied; the board-minutes article too.
- Failing test first: `test_minutes_drive` (new, offline, the pretend Google and database; the pretend Google learns to rewrite a file). Deploy `board_meetings` and `google_drive_sync`.
- ✅ Done 11/5. 15 checks failed first; now 54 pass, and every offline suite (55). Migration applied, `board_meetings` and `google_drive_sync` deployed, pages pushed.

### BU. Motions: tap who made it and who seconded (Doug, 11/4, for the 11/5 meeting)
Doug: "it would be nice to simply click new motion, you check the persons name who started the motion, then vote from there if needed… someone can second the motion as well". His picks: "Do count plus all In favor" and "Needs a second to vote." Today "+ Add motion" has typed "Proposed by" and "Seconded by" boxes.
- **BU1. Made by and Seconded by are names to tap:** everyone marked present (board members ticked and people added by hand), plus "Other…" to type a name. Tap again to take it back. Whoever made the motion isn't offered as its second. Marking someone present adds them to every motion's names.
- **BU2. Needs a second to vote.** Until a second is picked, Yes, No, Abstain, All in favor, Passed and Failed are greyed out, with "Needs a second before the vote." Tabled still works.
- **BU3. "All in favor (N)"** sets Yes to everyone marked present, No and Abstain to 0, and the motion to Passed. The counts still work for a split vote, and − takes one back (a guest who didn't vote).
- The minutes still read "Proposed by … · Seconded by …"; nothing changes for meetings already written. The page only: no server change.
- Failing test first: `test_motions` (new, offline, renders the meeting page in Chrome).
- ✅ Done 11/4. 16 checks failed first; a screenshot then showed the vote buttons on when a meeting opens (the page switched every button back on after drawing), so a 17th check was added, failed, and was fixed. The help article says how. Every offline suite passes. Pages only, pushed.

### BT. Choices after every refund and chargeback (Doug, 11/4)
Doug, on "4 Family" after refunding it in Stripe (BN5 test 7): "says approved card unpaid... what are my options... what should my options be?" Then: "build it that way with the options... but keep them a member until the board member does something about it... make sure that we have proper options on all refunds... so like if we refund for a keyfob".
Found: the refunded signup read "Unpaid" with "Verify payment received" and "Send reminder" (the reminder would ask the family to pay again), and Waiting for payment listed it as owing $300. And a referral reward, which Poolside pays as a refund on the member's own card payment, gave the Treasurer a refund to-do and marked that payment partly refunded.
- **BT1. Nothing changes until a board member picks.** Every refund and chargeback on the club's Stripe gives the Treasurer one to-do, which opens Money → Payments → "Refunds and chargebacks". Each says what was paid for, the family, how much (all or part), and its choices. Picking one closes the to-do; Mark done on the to-do keeps things as they are.
- **BT2. Membership** (a signup, a renewal, or plan payments, a payoff included):
  - Keep them as members, and say how they paid instead if they did (check, cash or Venmo: the signup then reads paid that way).
  - End their membership: their dues for that season go back to unpaid (a new family isn't counted as last season's member, so it gets no renewal invite), a payment plan stops with no more charges, each fob in use gets a "turn it off" to-do for the keyfob person, and the family gets a pop-up. Parties and other bookings aren't changed. Their record stays, so they can join again.
  - The signup says "Refunded", "Partly refunded" or "Chargeback" with the amount instead of Unpaid, has no Verify or Reminder, and isn't on Waiting for payment. Its details show the same choices.
- **BT3. Keyfobs:** Turn the fob off (one in use gets a "turn it off" to-do; one not handed out yet is canceled, with a pop-up), or Keep it. With several fobs on one payment, tick which.
- **BT4. A party:** Cancel it (off the calendar, the party doors end, a pop-up), or Keep it. One already canceled just gets OK.
- **BT5. A program:** Take them off it, or Keep them on. **A donation:** Take it off the fundraiser (the thermometer goes down), or Leave it. **A payment Poolside can't match:** OK, handled in Stripe.
- **BT6. A chargeback** gets the same choices, and says Stripe decides it: answer it in Stripe, and if the club wins the money comes back.
- **BT7. Refunds Poolside makes itself** (a referral reward paid back to the member's card) make no to-do and don't mark the payment refunded.
- **BT8. Loose ends:** a reactivation payment keeps its Stripe payment id so a refund on it is matched; Delete for good also removes to-dos about the family's plan payments.
- Failing tests first: `test_refund_options` (new: the choices, each one against the pretend database, the webhook's wiring, the Signups and Waiting for payment fixes, and the Refunds card in Chrome).
- ✅ Done 11/4: 22 checks failed first (the rest needed the new rules to run at all); now 73 pass, and every offline suite passes. The migration is applied (`20261105000100_plan_end_refunded.sql`). Deployed `stripe_webhook`, `payments_admin`, `parties_admin`, `households_admin`, then the pages (Doug: "deploy it").

### BS. Fixes from the first Stripe test-card signups (Doug, 11/4)
Doug, signing up on Bishop with Stripe's test cards (BN5): "it allowed me to do a family membership even with 1 person... also it let me add myself with no birthday even though it says required." And, after I deleted his first test family by hand: "ok fix the left overs."
- **BS1. Delete for good removes everything tied to the family.** It left the family's keyfob to-do (the empty Keyfobs badge Doug saw on 11/3) and their payment plan. Now it also deletes the family's payment plans with their payments, the auto-renew card consents, and every to-do about the family, its signups, keyfobs, parties, plans or help requests.
- **BS2. Every birthday is required on the signup form**, as its label says: each adult's and each child's. The form stops on the first one missing, under that field. The server refuses a signup with a person and no birthday too. Renewals aren't changed.
- **BS3. A level can say the fewest people it covers.** Doug: "family needs 2 or more.. but keep in mind we want to scale this.. allow for single membership?"
  - Money setup → Membership prices gets "At least (people)" beside "Covers up to (people)", for every club.
  - Bishop's Family is set to at least 2. New clubs start with Family at least 2 and Single up to 1.
  - The form greys out a level that's too big for the family, with a note: "Family is for 2 or more people. Single covers just you." The server checks it too.
  - A club with no level for one person (no Single) still lets one person pick Family: the minimum applies only when another level covers the family.
  - The setup checklist already sends a new club to Membership prices ("Set your membership prices"), so there's no new setup step.
- Failing tests first: `test_signup_fixes` (BS2, BS3) and `test_drive_queue` (BS1, with the purge's other checks), offline.
- ✅ Done 11/4. 18 checks failed first (`test_drive_queue` 3, `test_signup_fixes` 15); 7 checks on the real form in Chrome were added after the fix. Deployed `applications`, `households_admin`, `tenant_signup`; Bishop's Family set to at least 2 (`20261104000100_tier_min_people.sql`). Live: a person with no birthday is refused ("Add a date of birth for …") and one person on Family is refused ("Family is for 2 or more people. Single covers just you."), nothing saved. The live test scripts now send birthdays and two adults on Family. Every offline suite passes.
- **BS4. A card signup that hasn't paid isn't the board's to approve.** Doug, seeing his declined-card test on Signups: "why is … 3 pending? and i need to approve". It sat in Needs attention with "Approve & create household", which would make a member who never paid.
  - A signup by card or payment plan that's still unpaid leaves Needs attention and its count. Under Pending and All it says "Card not paid", with no Approve or Reject. Its details say: they didn't finish paying (they left the card page or the card was declined); paying approves them on their own; if they don't, Poolside removes it 24 hours after they signed up. Delete for good stays.
  - The server refuses to approve one too ("They haven't paid by card yet…").
  - Not changed: an imported family's claimed signup (the club chasing a member it knows) keeps its Approve, the same families the 24-hour cleanup skips.
  - Failing tests first: `test_signup_fixes` (the rule, the server, and the Signups list in Chrome).
  - ✅ Done 11/4. 7 checks failed first (the rule, the server, the Signups list in Chrome). Deployed `applications`. Every offline suite passes.
- **BS5. A chargeback on a paid-off plan names the family.** Doug paid off his test family's plan with the dispute card ($566.74, payments 2 and 3 at once). The Treasurer's to-do said "a card payment Poolside couldn't match": one card payment on two plan payments, and the matcher asked for exactly one. Now it says "Chargeback on payments 2 and 3 of a payment plan (the family's name)", and the same for a refund. Nothing else changes: still a to-do only (Doug 10/20).
  - The tests' pretend database now answers "exactly one" like the real one: nothing, when two rows match.
  - Failing test first: `test_money_fixes` (the matcher against the pretend database).
  - ✅ Done 11/4. 4 checks failed first; every offline suite passes. Deployed `stripe_webhook` (Doug: "deploy it").

### BR. A better-looking roster, with keyfob numbers (Doug, 11/3)
Doug, looking at the Bishop sheet: "the format looks kinda lame.. spice it up a little.. auto expand the width… we dont need the DOB of the kids in there… ensure we have the keyfob numbers in there as well once we import/sign people up."
- **BR1. Every column fits what's in it.** Each night the widths are set from the longest line in each column (and its header), so nothing is cut off. Lists put one person or one step per line, and the row grows to fit: Other Adults, Keyfobs, and a party's What happened.
- **BR2. The look.** The family's name comes first and stays put when scrolling right, with the header row. Submitted comes right after it (Doug, 11/3). Status, Type and Verified on the roster, and Status on Parties, get colored chips: green approved or paid, amber waiting, red turned down or canceled, blue new or requested, purple renewal. The header gets a sun-colored underline, and the Parties tab is sun-colored. It's set again on every run, so a tab made before keeps up, without piling up repeated rules.
- **BR3. Children by name only.** Birthdays stay in the PDF.
- **BR4. Keyfobs:** the family's working fob numbers, one per line, plus how many are waiting to be issued. For an imported family not approved yet, the numbers from the club's list.
- **BR5. The roster is rewritten from Poolside each night,** like Parties: a row per signup, renewal and imported family for the season, kept up to date (a fob issued, a payment confirmed, an approval) by its App ID. A signup still shows up the moment it's sent. A row whose signup was deleted keeps its details, marked "Deleted from Poolside". A column the board adds of its own is kept. New: a Status column (Approved, Not paid yet, Paid, waiting for approval, Venmo to check, Turned down, Imported, not signed yet, Renewal not signed yet), so a family that isn't a member can't be mistaken for one, and imported families are listed before they sign.
`node scripts/test_drive_look.mjs`.

### BQ. Drive works the moment it's connected, with no buttons (Doug, 11/3)
Doug connected the Bishop Google account and no folder showed up: Poolside made it only at the next signup or nightly run. He asked whether a club should need to sync even once ("keep in mind when we scale this out").
- **BQ1. Connecting runs the catch-up right away,** in the background after Google sends the board back: the folder, the sheet, the Parties tab, and every signup so far. Settings shows the time it ran.
- **BQ2. A signup copied into a different sheet is copied again** into the one in use. That covers a club switching Google accounts (its records no longer split between two Drives) and a folder that was trashed. Reconnecting the same account finds the same sheet, so nothing is copied twice.
- **BQ3. The three buttons go:** Retry failed syncs, Copy anything missing now, and Reapply spreadsheet styling. The nightly run and BQ1 do their jobs. Settings keeps the account, the last backup time, any error, the folder and sheet links, and Disconnect.
- Later, past about 30 clubs: the nightly run calls the function once per club instead of all clubs in one call, so it can't run out of time.
`node scripts/test_drive_parties.mjs`.

### BP. Parties in the Drive backup, and a nightly catch-up (Doug, 11/3)
Doug: a Parties tab in the same sheet with the history of every party, "even if they are scheduled and cancelled to track what actually happened". He also asked if all of it backs up nightly. It didn't: a signup copies the moment it's sent, and a failed one waited for someone to press "Retry failed syncs". Parties weren't backed up at all, and Poolside kept only each party's latest state, not its steps.
- **BP1. Every step of a party is recorded as it happens.** A database trigger on `party_bookings` writes `party_history`, so all six places that change a party are covered. Steps: requested, approved, turned down, Venmo sent, paid (card or Venmo), canceled (by the family, by the board, released for not paying in time, or automatically because the time was taken), moved, and price changed. Stripe refunds and chargebacks come from the audit log. Each step keeps the family name and the party's details, so a deleted family's parties still show. Bishop's one party starts from what's on it now.
- **BP2. A "Parties" tab in the roster sheet,** one row per party, by party date: Party Date, Time, Family, Party, Guests, Amount, Paid By, Status, What happened (each step with its date), Requested, Party ID. A row is updated in place by its Party ID and never removed, even after the party is deleted in Poolside.
- **BP3. Nightly, about 2 AM pool time, for every club with Drive connected:** retry every waiting backup; copy any missing signup or signed renewal (never an imported family that hasn't signed, nor an unsigned renewal; the old "Sync missing applications" button copied those); bring the Parties tab up to date. That button is now "🔄 Copy anything missing now" and does the same for its club, right away.
`node scripts/test_drive_parties.mjs`.

### BO. The Drive backup, checked before Bishop's own Google account goes in (Doug, 11/3)
Doug: make sure it backs up everything, names, addresses and phone numbers as xxx-xxx-xxxx, and the proper documents; he is switching the connection from his personal Google to the Bishop Estates one. Checked 11/3: connected as his personal Gmail since 10/11, last backup 10/22, nothing waiting, and the Google app is published (the connection outlived Testing's 7 days). New signups and claimed imports are backed up (a PDF and a sheet row). Found:
- **BO1. Picking the account.** Google's screen now always asks which account (it could quietly reuse the one the browser is signed into), and afterwards it comes back to Settings → Backups & archive, not Money → Payments.
- **BO2. Phone numbers as 408-555-1234** in the sheet and the PDF: the primary, every adult, and the emergency contact. The sheet showed 14085551234 (Sheets read "+1408…" as a number) and the PDF +14085551234. Zip is kept as text so a leading zero stays.
- **BO3. Everyone in the sheet.** Two new columns: other adults (name, phone, email) and children (name, birthday), plus New or Renewal. The PDF already had them. Rows are written by the tab's own header names, so an older tab still lines up and "Verified" still finds its column. A family name that starts with = can't become a formula.
- **BO4. Filed by season.** A signup for the 2027 season goes in "2027 Sign-ups" and the "2027" tab even when it's sent in November 2026. It used to go by the date sent, which split one season across two tabs.
- **BO5. Trashing the folder.** The next backup made a new sheet but then wrote to a tab it remembered from the old one, and failed every time. The tab is now looked up in the sheet it writes to. (BN6 0b depends on this.)
- **BO6. Renewals are backed up.** A signed renewal was never sent to Drive. Now it is, when it's signed, with its signature on the PDF (it printed "no signature on file"), titled Membership Renewal with its season.
- Then Doug: Settings → Backups & archive → Disconnect, then Connect Google Drive, and pick the Bishop account. The next signup makes the folders there. The 4 test signups already backed up stay in his personal Drive. BN6 0b still applies: the test-card signups in BN5 land in the Bishop Drive, so its folder is trashed on go-live day.
`node scripts/test_drive_backup.mjs`.

### BN. Test and turn on the member side: sign-ups and payments (Doug, 11/1) — BN1 done 11/1; BN2 and BN3 are Doug's
Doug: "lets stop building random shit.... when i get time this week, we need to fully test/deploy the member side... sign ups and payments... create a plan.. step by step on what i/we need to do to get this completed".

Nothing new gets built except the two small pieces the payment tests already need (BK5's test level, BK6's account switch). This puts BK, BL4 and BM's switch-on into one order. Test mode first, so nothing costs money until it all works.

Where it stands (read 11/1, read-only):
- Bishop has 4 households, all tests (3 paid by test payment), and one plan on a fake card whose Nov 1 payment is ticked and waiting; the daily run never sends a fake card to Stripe.
- Test payments are on. Bishop's Stripe connection is unfinished (charges off). Sign-ups are off. No calendar feed. The season is closed, so the gate stays off for members until it opens.
- Stripe is on the test key. Only the clubs' webhook secret is in Supabase; Poolside's own (`STRIPE_WEBHOOK_SECRET_PLATFORM`) isn't yet. That one is for Poolside's own sales, not families' payments.
- Every daily job ran cleanly.

- **BN1. Me: the two pieces the tests need** (no time from Doug). Offline tests first, deployed, one check on a throwaway club.
  - BK5: a hidden $1 test level, offered only by a link and only to someone whose email or phone matches a board login, on a short plan; each payment still ticked on Money → Upcoming. Doug 11/1: "lets do weekly".
    - Money → Payments gets a "🧪 $1 test level" box (owner only): Add it, which shows the link (`/apply.html?level=board_test`), and Remove it. The level is a stored level marked `test` ("Test: $1 a week (board only)", $5), so every price lookup works as it does for real levels (an unknown level would fall back to the first one, $600).
    - Hidden everywhere else: the join form without the link, the club's share page, renewals, and Insights' dues totals (`_shared/test_level.ts`).
    - Joining on it needs an email that's a board login's, where anything after a + is ignored (Doug's email with +test1 reaches him and isn't on his Frevele test family), or a board login's phone. Anyone else is told it's for the board.
    - Its plan is fixed: $1 today, then $1 every 7 days for 4 weeks ($1.34 each with Bishop's card fee). No "Pay today" or "Paid off by" boxes. The plan is `plan_type 'weekly'`, so Upcoming, the plans list and Stripe's page say "a week", not "a month". Each payment still needs the tick, and the Treasurer's to-do comes 3 days before each. Monthly plans don't change (checked).
    - Test families use a made-up 555 phone, since Doug's own number is on his Frevele test family. Texts to 555 numbers are skipped; they sign in by email.
    - `test_test_level` offline; then live on the throwaway club in `flex_plan_live` (`ONLY=W`): the quote, the board-email rule, the weekly dates, and a real $1.34 Stripe test charge to a saved card.
    - ✅ Done 11/1. `test_test_level` 65 checks (51 failed first), including the join form drawn in Chrome from the link and without it. Live on a throwaway club (`ONLY=W`, 9 calls): families don't see it, its link does; someone off the board is refused; a board email with +w2 joins; checkout takes $1.34 and says "4 weekly payments"; the plan saves as weekly on the right dates; Upcoming says weekly; the daily run charged the approved second payment, a real $1.34 Stripe test charge, to the saved card; the rest wait. Every offline suite passes (one check's window widened for the new line). Deployed `applications`, `stripe_checkout`, `stripe_webhook`, `payment_plans`, `member_auth`, `tenant_admin_auth`, `tenant_public`, `tenant_share`, `admin_tasks`.
  - BK6's prep: Money → Payments gets "Connect a different Stripe account"; once the key is live, a test-mode connection is set aside and Connect starts fresh; the fake-card plan is closed quietly (the family stays paid).
    - Doug 11/1, on the test families: "Delete them first". So nothing closes test-card plans in code: the test families and their plans are deleted right before going live (BN6).
    - **BN1b.** Money → Payments → Money setup → Card payments (Stripe) gets **Connect a different Stripe account** (owner only), shown once an account is connected. It asks first, then forgets the saved account (written in the Activity log) and opens Stripe's sign-up for a new one. It refuses while any family has a real card saved with the current account (a payment plan or auto-renew), because saved cards can't move to another Stripe account by themselves; the message points to support@.
    - The safety net: if Stripe says the saved account doesn't exist for the current key (a test-mode account once the live key is in), Connect Stripe and Refresh status set it aside and start fresh instead of showing Stripe's error (`_shared/stripe_account.ts`).
    - The help article "How do I turn on card payments?" says how to switch.
    - Offline checks in `test_stripe_preflight` (BN1b), failing first; `--live` on a throwaway club in Stripe's test mode: a saved account Stripe doesn't know is replaced with a fresh one, the switch is refused with a saved card and works without; the Stripe test accounts it makes are deleted.
    - ✅ Done 11/1. `test_stripe_preflight` BN1b: 15 offline checks (14 failed first). Live (`--live`, a throwaway club, Stripe test mode): Refresh status sets an account Stripe doesn't know aside; Connect Stripe makes a fresh account and opens Stripe's sign-up instead of an error, written in the Activity log; the switch is refused while a family has a card saved and works without one; the Stripe test accounts and the club were deleted after. The live run found Stripe words a lookup differently ("does not have access to account"), now covered (failing check first). Deployed `stripe_connect`. Every offline suite passes.
- **BN2. Doug: start Stripe's live activation** (~15 minutes, laptop). It can take a day or more, so start it first. Poolside's Stripe account → Activate payments (business, bank, ID), then Connect's platform profile. Nothing in the app changes until BN6.
- **BN3. Doug: Bishop ready, still in test mode** (~15 minutes).
  1. Settings → Features → tick Sign-ups.
  2. Calendar → Events → + Add a calendar feed, with the Google calendar's secret iCal address.
  3. Money → Payments → Resume onboarding. Stripe's test form takes made-up answers (or its "use test data" buttons): code 000000, birth date 01/01/1901, ID number 000000000, address line `address_full_match`, routing 110000000, account 000123456789.
  4. Money → Payments → 🧪 Test payments off.
  - Me: Stripe says charges are on and Poolside saw it (`account.updated`); the calendar syncs and shows on the member Home; the app's card buttons open Stripe.
- **BN4. Doug on his iPhone, me checking: sign-ups for real** (~20 minutes; any time after BN3 step 1).
  1. Board side, Calendar → Sign-ups: + Shift ("Snack Shack test", tomorrow, 2 spots, free lunch) and + Job (a photo, $5 off).
  2. Member view (the Home Screen app): the Sign-ups tab shows 2. Sign up for both; two to-dos arrive.
  3. The job: I'm done, with a photo. Approve it from the to-do. The code shows on the Sign-ups tab and arrives by email; the thank-you with the photo is on the news.
  4. The next morning: the to-do asks who came to the shift. Tick yourself.
  5. Ask the board with a photo, then "Post as a job" on the board side.
  - Me: every row, the email delivered, and the code taking $5 off a checkout (on a throwaway club). Then Doug decides whether to delete the test posts and the thank-you; Bishop's news is public.
- **BN5. Doug on his phone, me at the laptop: the 8 test-card tests (BK3)** (~45 minutes, no real money). I fill each in my browser up to Stripe's page and send the link; Doug types the test card. Each new family uses Doug's email with +1, +2… so each is new and the emails reach him.
  1. A new family by card (4242 4242 4242 4242): approved on its own, welcome, paid.
  2. A payment plan signup: the first payment and the saved card go through Stripe. Bishop's next billing day (Dec 1) comes after the switch to live, so the later charge is checked on a throwaway club's Stripe test account now, and for real in BN7.
  3. A declined card (4000 0000 0000 0002): nothing approved, a clear message.
  4. A card the bank asks to confirm (4000 0025 0000 3155).
  5. A party by card: booked, the Snack Shack pass, the party person's to-do.
  6. Keyfobs by card.
  7. A refund in Stripe: the Treasurer's to-do.
  8. A disputed charge (4000 0000 0000 0259): the Treasurer's to-do.
  - Then BK4: whatever breaks gets fixed, failing test first, and that test is run again.
  - Results, 11/4 (Doug typed each card, I checked Poolside, Stripe and the emails):
    1. ✅ $309.27 pay in full, approved on its own, welcome email. Found BS2 (no birthday) and BS3 (one person on Family).
    2. ✅ $51.81 first plan payment, card saved, approved, Drive, welcome email and text. Found BS1 (Delete for good left the plan and a to-do).
    3. ✅ Declined: nothing approved, no family made. Found BS4 (Signups offered to approve it).
    4. ✅ The bank's confirm step (3D Secure "authenticated"), $309.27, approved.
    5. Waits: parties are closed until the board opens them for the season. Test it then, or in BN7.
    6. ✅ 2 keyfobs, $31.21 ($30 + $1.21 card fee), paid, a to-do each, the family's pop-up.
    7. ✅ A full refund in Stripe: the signup reads refunded, the Treasurer's "[REVIEW] Stripe refund" to-do; the family stays a member until the board decides.
    8. ✅ The dispute card on a plan payoff ($566.74): the Treasurer's "[URGENT] Chargeback" to-do. Found BS5 (it said "couldn't match").
    - Two welcome emails bounced: made-up addresses typed for test families. Use Doug's email with a + from now on.
- **BN6. Doug: going live (BK6)** (~20 minutes, once Stripe has activated).
  0. Me, first: delete the test families, their plans and the test party (Doug 11/1: "Delete them first"). His board login stays. ✅ Done early, 11/3 (Doug: "remove all the members as they were just test people"): the four test families deleted for good through Delete for good (their 10 people, 4 signups, 4 fobs, the party), then the fake-card plan and its 10 payments, 2 auto-renew consents, the party's history and 28 stale backup records; the 2 past test-party calendar events hidden. Kept: Doug's board login and an expired board-made door pass from 10/13. BN5's test signups come after this, so they go again here. ✅ Again 11/4 (Doug: "go delete all the members and make the club fresh/new"): the 3 BN5 test families deleted for good (4 people, 3 signups, the paid-off plan, 5 fobs, 7 to-dos), then the 2 signups left without a family. Bishop has no families, signups, fobs, plans or open to-dos; Doug's board login stays.
  0b. Doug, the same day: trash the "Poolside Archive" folder in the club's Google Drive. The next signup makes a fresh one (folders and the sheet are found again by name, and made again if gone), so real families start in a clean folder. Not before: the test-card signups in BN5 would fill it again. Trash only the folder; don't press Disconnect (switching to the Bishop Google account is BO's last step).
  1. Stripe, live mode → Webhooks: two endpoints at the same address as test. Connected accounts get the 7 events; "Your account" gets checkout.session.completed and customer.subscription.updated/deleted. I send the exact list then.
  2. Supabase → Edge Functions → Secrets: the live `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_WEBHOOK_SECRET_PLATFORM`.
  3. Money → Payments → **Connect a different Stripe account**: Bishop's own Stripe account, in Doug's name for now, with his bank. It's a second Stripe account, not Poolside's.
  - Me: charges are on, each webhook arrives, and Plan & billing and the payment pages still open. Bishop's card buttons don't work between steps 2 and 3; nobody real is paying yet.
  - ✅ Done 11/5. Steps 1–3 by Doug; webhooks answer 200 and the three secrets changed (checked by digest, not read). Bishop's new live Stripe account (the club Gmail, Doug as representative) was approved at 23:39 UTC: charges and payouts on. The old test account was set aside. Fees stay waived. From now on the `--live` and `--stripe` test scripts hit live Stripe through the deployed functions. 0b (trash the Drive folder) is still Doug's.
- **BN7. Doug: real $1 tests (BK7)** (a minute a payment, about $5 of real money). Doug signs up on the $1 level with his real card and approves each payment on Money → Upcoming. I check each charge, receipt and payout in Stripe. The first $1 is refunded from Stripe to check that a live refund reaches the Treasurer. Bishop then stays live.
  - ✅ First $1, 11/5 (UTC 11/6 04:59): signed up with the club Gmail plus +test1, paid on Stripe Checkout live, webhook 200, signup approved, weekly plan saved ($1 paid, $1 due 11/12, 11/19, 11/26 and 12/3, Poolside fee 0, card fee 34¢ each), welcome email delivered. Fobs turn on at half paid (the third $1), so the fob to-do is checked then. A first try with Doug's own Gmail was stopped by the board-only check (403) and left an unpaid signup, which the 30-minute cleanup deletes 24 hours after it was made (UTC 11/7 05:00).
  - Doug 11/5: "adjust the payments to go once a day... I just want to test this feature". The 4 payments left on this one test plan moved to 11/6, 11/7, 11/8 and 11/9 (data only, no code). The 6 AM daily run charges each one Doug has ticked on Money → Upcoming; fobs turn on with the 11/7 payment.
- **BN8. Doug: decisions before the CSV import (BL4).**
  - Supabase Pro ($25 a month, for backups) before real families' details go in.
  - Cap the card fee at 3%, or not.
  - Whose Stripe takes dues for good. The club's own account before the import is the clean way.
  - Vercel Hobby.
  - The test sign-ups and their thank-you on the news (the test families go at BN6).
  - Then the CSV import and the renewal message get their own plan.

Doug's time: about 2 hours this week, plus a minute per $1 payment. Supabase calls: about 200. Texts: only welcome texts, to Doug's own number.

### BM. Sign-ups: shifts and jobs, with a thank-you (Doug, 10/23) — ✅ built 10/29; Doug ticks it on for Bishop
Doug: "some type of sign up genius feature... there is an event coming up and we need a person for the snack shack… or we have a broken sprinkler, here is a photo come fix it… bathrooms need painting. Someone do this." With a thank-you each time: "sometimes it's nothing, sometimes it might be free food at the event, sometimes it might be a discounted membership". On the member side: "I don't want a pop up of it, but maybe a bubble and a number saying that there are sign ups available... its own section."

Already there (April, off at Bishop: Settings → Features → Volunteer): the board's Calendar → Volunteer page posts an opportunity (title, what to do, start and end, spots, place) and sees who signed up; members see a Volunteer card on Home and sign someone in the family up, or cancel. This builds on it.

Doug's answers 10/23: any board member posts; the volunteer taps Done and the board member who posted it approves ("Board member who posted it also needs to approve it"), or the President; when approved, "auto post something on the news board with approval photo and thanking that member... only once it's approved"; shifts the same (the poster ticks who came); money off is a discount code ("A discount code"), shown in the app and emailed; the thank-you names the family; someone signing up gives the poster a to-do; no door access from a job ("the board will give the day pass in a text").

How it works:
- A **shift** has a date, time and spots ("Snack Shack, Saturday's meet, 10–2, 3 people") and can belong to a calendar event. A **job** has photos, a do-by date or "anytime", and usually one spot ("Broken sprinkler by the kiddie pool").
- The **thank-you** on each post: nothing, a line the board writes ("Free lunch at the meet"), or money off next season ($ or %), given as a one-family discount code at approval, listed on Money → Discounts like any code.
- **Members:** a Sign-ups tab at the bottom of the app (Home, Sign-ups, Ask the board, My family) with a number on it: open sign-ups the family could still take. No pop-ups, no texts. Shifts by date, jobs by do-by date, with photos and the thank-you; sign up picks someone in the family; Mine shows what they took, a Done button (with a photo) and, once approved, their thank-you and code. Members of the current season only, as with the gate and parties. A family can cancel until the shift starts or until they tap Done.
- **The board:** Calendar → Sign-ups (was Volunteer). Post a shift or a job, add photos, set the thank-you, see who took it. To-dos for the poster: someone signed up; a job marked done (approve, or send it back with a note); a shift that ended (tick who came).
- **On approval:** the thank-you is given, the code shows in their app and is emailed, and a news post goes up: "Thanks to the Rivera family for fixing the sprinkler by the kiddie pool!" with the Done photo. No pop-up with it. Thank-you posts don't count toward the 15 announcements Poolside keeps (PLAN.md AQ), so a real announcement is never pushed off; the newest 10 thank-yous are kept.

Steps, one at a time, each with tests first (offline; live checks on a throwaway club, never Bishop's families, PLAN.md BL3):
- **BM1.** The server: shifts and jobs, photos, the thank-you, Done and approve, any board member posts, the to-dos, the code at approval and its email, the thank-you news post.
  - ✅ Done 10/29. `_shared/signups.ts` (the rules), `_shared/signups_db.ts` (after a shift, the poster's to-do), the `volunteer` function rewritten, migration `20261029000100_signups_shifts_jobs.sql` (also news posts get `image_url` and `kind`), the email "Thank you for helping" (Settings → Emails → Sign-ups; 20 emails now), thank-you posts kept apart from the 15 announcements (newest 10). `test_signups` 35 offline checks (all failed first) and 16 live on a throwaway club that is deleted afterwards; the thank-you email arrived. Edge Functions now deploy with `scripts/deploy_functions.py <slug>…`.
- **BM2.** The board's Sign-ups page.
  - ✅ Done 10/29. Calendar → Sign-ups (was Volunteer; any board member sees it): + Shift and + Job, photos (shrunk on the phone), the thank-you (nothing, a line, $ or % off). The list puts first what's waiting for you (a job to approve, a shift that's over), then open ones, then done lately. People shows each sign-up; a job marked done has their note and photo with Approve and Send back; a finished shift has tick boxes and Save who came. A dashboard to-do opens it (`#o=<id>`). Settings → Features calls it Sign-ups. `test_signups` 10 more checks, drawn in Chrome with sample answers (failed first).
- **BM3.** The member Sign-ups tab with its number.
  - ✅ Done 10/29. A Sign-ups tab after Home (only when the club has sign-ups on), with a bubble: open ones the family could still take; no pop-up. It lists jobs (photo, do-by date) and shifts (time, spots left) with the thank-you and Sign up (picks someone in the family; two people from one family can take spots, the same person can't take two). Mine: Cancel, "I'm done" with an optional photo and note, what the board said if it was sent back, and once approved "Thank you!" with their code. The old Volunteer card left Home. News posts show their photo (the member app and the club page). `test_signups` 7 more checks, drawn in Chrome with sample answers (written with the tab, so they passed first time); the live check passes again (68 in all).
- **BM4.** Ask the board: "Post as a job" on a member's question, bringing its photo.
  - ✅ Done 10/29. Member help → a question → 📋 Post as a job (when sign-ups are on) opens the job form filled in with the member's words and their photos, copied out of the private help folder (`volunteer` `from_help`; who it went to or the President only). `test_signups` 3 offline checks and 2 live (failed first live). The throwaway club's cleanup now removes its help photos too.
- **BM5.** Turn it on at Bishop, the help article, and the demo club's sample sign-ups.
  - ✅ Done 10/29, except the switch: Bishop's Settings → Features → Sign-ups is Doug's to tick (the change to Bishop's live settings wasn't mine to make). Help article "How do sign-ups work?" (Calendar & Parties). The demo club has three sample sign-ups (the Snack Shack shift, the sprinkler, the bathroom doors waiting for Sam to approve) that work end to end and remember what a visitor does until Start over: signing up, I'm done, approving (a THANKS code and a thank-you on the news), ticking who came. `test_demo_site` 7 more checks (failed first).

### BL. Pre-flight before the payment tests (Doug, 10/22) — BL1 done 10/22; BL2, BL3 next
Doug: "is there anything we can go through to ensure the app works well? ... i want to 100% make sure we are good to go". He starts BK next week.

Checked 10/22 (free, read-only): all 5 daily and repeating jobs ran on schedule for the last 4 days with no failures, and today's payment run answered cleanly. The email domain (poolsideapp.com on Resend) is verified and sending. Vercel builds pushes on its own again (b9f05d7 deployed without help). Club payments' webhook is set up right.

Found: Poolside's own sales (text-message packs, setup help, a club's plan upgrade) are charged on Poolside's own Stripe account, but Stripe's one webhook only reports club accounts' payments. Those payments would go through and never be recorded (no credits, no plan change). No such Stripe payment has ever happened, test or real.

Where those sales live: every club's Settings → Plan (`club/admin/billing.html`), for the club's owner: its Poolside plan and upgrades, extra texts ($100 for 3,000), Premium Setup ($500, $750 over 100 households) and the subscription. That money goes to Poolside. Money → Payments is separate: the club's own money from families, into the club's Stripe. None of this affects Bishop (Enterprise, Poolside's fees waived, 25,000 texts a year); it matters from the second club on.

More found 10/22 (Stripe test mode, read-only plus one test-mode payment never charged and canceled):
- Plan upgrades can't start at all: the three plan prices were never set up in Stripe (`STRIPE_PRICE_STARTER`/`PRO`/`ENTERPRISE` unset), and the message sends clubs to hello@poolsideapp.com, not support@ (BG7).
- A club's subscription being canceled or failing to renew would also never reach Poolside (the same webhook gap).
- Family checkouts (signup, party, keyfobs, donations, plan payments) don't say "card", so Stripe shows whatever the club's account allows. Bishop's allows Affirm, Klarna, Cash App Pay, Amazon Pay and Link by default. The card fee passed on assumes a card (2.9% + 30¢); Affirm and Klarna cost the club about 6%. Saving a card for a plan is already card only.
- Checked fine: Stripe takes the $0 Poolside fee every Bishop payment sends.

Doug's answers 10/22: family checkouts card only; self-serve plan upgrades; he clicks the Stripe setup himself; then the full live run.

- **BL1. Fix that webhook gap.** `stripe_webhook` accepts either of two signing secrets: `STRIPE_WEBHOOK_SECRET` (club accounts, as now) and `STRIPE_WEBHOOK_SECRET_PLATFORM` (Poolside's own account), checked in `_shared/stripe_sig.ts`. Doug adds the second webhook in Stripe (the same address; "your account" events: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted) and puts its secret in Supabase. Offline test first.
- **BL1b. Self-serve plans that work.** Also found: a club already on a plan that picks another would start a second subscription and pay twice, and Bishop-style lower plans say "Upgrade to". Now:
  - The three yearly prices live in `_shared/poolside_plans.ts` and must match Plan & billing, pricing.html and home.html (checked). The checkout carries the price itself on a fixed Stripe product per plan (`poolside_plan_starter`…, made on first use), so Stripe needs no prices made by hand, in test or live.
  - A club with no plan pays by Stripe checkout. A club already on one switches that same subscription: going up charges the difference for the rest of the year now, going down leaves a credit for its next renewal. Never two subscriptions.
  - Plan & billing says "Switch to" for a lower plan; the error points to support@. The webhook reads the plan from the subscription (or its product), not price IDs.
  - Offline tests first, then one check against Stripe's test mode with throwaway objects removed afterwards (no Supabase calls).
- **BL1c. Family checkouts are card only** (Apple Pay and Google Pay still show). Every checkout Poolside makes says `payment_method_types[0]=card`: signup, renewal, plan, party, keyfobs, program, pass, donation, reactivation, and Poolside's own sales. Offline test that no checkout is missing it.
- ✅ BL1, BL1b, BL1c done 10/22. `test_stripe_preflight` 28 offline checks (all failed first; the card-only check first passed two checkouts that weren't, and was tightened), plus 5 against Stripe's test mode (Starter → Pro charged the difference on the same subscription; Pro → Starter left a credit). Deployed `stripe_webhook`, `tenant_admin_auth`, `stripe_checkout`, `donations`, `payment_plans`; live, Plan & billing's upgrade made a card-only yearly $2,400 checkout on `poolside_plan_pro` (closed afterwards; Bishop stays Enterprise). Doug's part: the second webhook in Stripe test mode and its secret in Supabase (`STRIPE_WEBHOOK_SECRET_PLATFORM`); again in live at BK6.
- **BL2. Walk every card payment in the code before Doug's phone time.** Each kind (signup, renewal, plan start, party, keyfobs, donation, program, pass, reactivation, text packs, setup help, plan upgrade) from the button to Stripe to the webhook to what the family and board see, run offline with Stripe's real message shapes. Fix what's wrong, failing test first. So BK3 finds nothing silly.
  - ✅ Done 10/22. Every checkout's handoff to the webhook matches (what each sends is what the webhook reads), and the shapes Stripe has never seen were tried on Bishop's Stripe test account (nothing charged, each closed after): the one-off payment, saving a card with it, the plan's $0-today card save, the plan catch-up/pay-off. Found and fixed (`test_stripe_preflight`, failed first):
    - A family who ticks auto-renew had their card saved with no Stripe customer (Stripe only makes one when told to), so next season's charge would have found nothing to charge. Now `customer_creation=always` whenever a card is kept.
    - After Stripe's sign-up, the club landed on Settings, not Money → Payments where Connect Stripe is and the status refreshes; an expired Stripe link landed nowhere useful. Both go to Payments now, and an expired link starts a fresh one. The note now names the "Resume onboarding" button that's actually there.
    - Fine as is: account.updated keeps the club's card status, the 24-hour unpaid-signup check asks the club's own Stripe account, auto-renew and plan charges use the club's account, and Stripe takes the $0 Poolside fee.
- **BL3. One full live run of every check.** Smoke, end to end, every page rendered (board, member, public), every page at phone width, and the live parts of the targeted suites. About 1,000 Supabase calls; Poolside uses about 35,000 of the free plan's 500,000 a month. The live suites haven't all run together since September, so some failures will be out-of-date tests; each real one gets fixed with a failing test first.
  - Before the run, found 10/22: the live tests use example.com emails and 555 numbers, and Poolside sent to them. Mail to example.com bounces, and bounces count against the sending reputation every club's emails depend on (1 bounce in 105 this month so far). Now every email and text skips addresses no real person has (`_shared/test_recipients.ts`: example.com/.net/.org, .test, .invalid, localhost, the 555 area code) at all 13 places Poolside sends, and reports them as sent. A 555 exchange in a real area code still gets its text. `test_stripe_preflight` BL3 (failed first). The Premium Setup notice's fallback address is support@, not Doug's own email. 16 functions redeployed.
  - ✅ Run 10/22 (about 1,500 Supabase calls in all, with reruns). Every live suite passes. Doug keeps every help topic on the President ("I'll fill them in as needed.. leave them alone"), so the member-help tests skip sending a test question whenever it would land with a real board member (it would pop up on Doug's phone). He'll tell the 4 families about the stray text himself, and reconnect Bishop's Google calendar.
  - What the run found and what was done:
    - `e2e.py` texted Bishop's 4 real families ("Closed today - back at 10am 706171", ~2:58 PM) from its Text all test, deleted Bishop's season and payment plan settings, and its cleanup deleted the club's Text all history. Settings restored the same day (season 2027, on sale in October; the plan as it was that morning); e2e fixed (skips anything club-wide while real families exist, restores exactly, deletes only its own rows). Doug told.
    - `test_board_home` would have opened Bishop's real gate (the bridge is on): it never taps while the bridge is on now. `test_payments` restores Test payments instead of forcing them on.
    - The page check shared one browser profile, so the member home was silently redirected to the board side and never checked; each page gets its own now. The Activity log was 9px too wide on a phone (a long word); fixed.
    - The positions test left its two bylaws files posted on Bishop after they moved to the private folder; removed, and its cleanup fixed.
    - Out-of-date checks brought up to the app as it is: plan payments need the board's tick (S), renewals need a signature (R6), minutes need approval and are members only (BJ1–BJ3), agendas are pop-up only, parties share a day but never overlap, the fixed plan "options" list is retired (M), the households list folds, the member home greets by name, test families are paid for the club's season (2027), and more.
    - Settings → Season no longer says "when next season goes on sale" (that setting was replaced by the season button, U2).
    - Bishop has no Google calendar feed connected now; the feed check skips. (Ask Doug.)
- **BL4. Doug's decisions before real families pay (not before testing).**
  - Supabase is on the free plan, which has no backups you can restore (Supabase: daily backups start on Pro, $25 a month). Upgrade before real families' money and details go in.
  - Bishop passes the card fee on: about 3.04% ($18.23 on $600). Card networks generally cap a surcharge at 3%. Cap it at 3% or present it differently; ask whoever handles the club's money.
  - Real dues should land in the club's own Stripe and bank, not Doug's (taxes, the club's records). Connect the club's account before the CSV import.
  - Vercel's free Hobby plan is for non-commercial use, and check it can still deploy before making the repo private.

### BK. Test card payments end to end, then go live (Doug, 10/21) — planned, BK1 is Doug's
Doug: "how can we successfully test the payments... i think this is the next step". His answers 10/21: all 8 test-card tests; "once we test and working its live, i want to keep it live and active for payments"; every family stays ("i'm going to test the payments... ensure they work.. and then import the csv"); real $1 tests ("i want to test payments like $1 weekly... i'm willing to pay for these tests"), on a weekly test plan; Bishop uses Doug's own Stripe account for now; whose account long term is decided later.

Where it stands (checked 10/21, read-only): Bishop has Poolside's own Test payments on (the fake card page, used since 9/24), so Stripe has never run there. The platform's Stripe key is a test key. Bishop's Stripe connection (Standard, test mode) was started 5/20 and never finished: 6 things still due, charges off. The webhook listens to connected accounts for the 7 events the code handles. A plan's first payment has never gone through Stripe's real checkout (PLAN.md M tested the rest with stand-ins). There's no way yet to swap a club's Stripe account, and a test-mode account can't be used once the live key is in.

- **BK1. Finish Bishop's Stripe connection, in test mode (Doug, ~5 minutes).** Money → Payments → Resume onboarding (in the setup section). Stripe's test form takes its own made-up answers. I check Stripe says charges are on and Poolside saw it (`account.updated`).
- **BK2. Turn off Poolside's Test payments at Bishop** so card buttons open Stripe's real checkout. Still test money: no real card works.
- **BK3. The 8 test-card tests.** I fill each signup or booking in my browser up to Stripe's page and send Doug the link; he types the test card on his phone (I can't type card numbers into the live site, even test ones). I check every result (the signup, emails, to-dos, the gate, the money split in Stripe) and write it down.
  1. A new family by card: approved on its own, welcome, gate on.
  2. A payment plan signup; then the next payment approved on Money → Upcoming and charged to the saved card (plan payments fall on Bishop's billing day, the 1st, so the charge itself runs the morning of Nov 1).
  3. A declined card (4000 0000 0000 0002): nothing approved, a clear message.
  4. A card the bank asks to confirm (4000 0025 0000 3155).
  5. A party by card: booked, the Snack Shack pass, the party person's to-do.
  6. Keyfobs by card.
  7. A refund in Stripe: the Treasurer's to-do.
  8. A disputed charge (4000 0000 0000 0259): the Treasurer's to-do.
- **BK4. Fix what breaks**, one at a time, failing test first.
- **BK5. A hidden $1 test level on a weekly plan.** A membership level marked "test" isn't shown on the signup page; only someone whose email or phone matches one of the club's board logins can pick it (by a link, `?level=`). Its plan charges $1 today and $1 a week for 4 weeks ($1.34 each with Bishop's card fee passed on), each still ticked by the board on Money → Upcoming. Real levels keep their monthly plans. Offline tests first.
- **BK6. Going live.** Doug: activate Poolside's own Stripe account for live payments and Connect, add the live webhook (connected accounts, the same events), and set the live `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Supabase. Me, before that: Settings → Payments gets "Connect a different Stripe account" (for the club taking over from Doug later), Connect Stripe starts fresh when the saved account belongs to test mode, and plans saved with Stripe test cards are closed quietly (their families stay paid). Then Doug connects Bishop to his own Stripe account and bank.
- **BK7. Real $1 tests.** Doug signs up a family on the $1 test level with his real card and approves each weekly payment; I check each charge, receipt and the money in his Stripe; the first $1 is refunded from Stripe to check the live refund. Bishop then stays live. The CSV import comes after.

Cost: about 100–150 Supabase calls over the month. The only texts are welcome texts, to Doug's own number. Real money: about $7 in charges, less the one refund.

### BJ. The demo walkthrough fix list (Doug, 10/21) — ✅ BJ1–BJ8 done 10/21
Doug walked demo.poolsideapp.com with Claude chat and brought a 27-item list (`handouts/poolside-fix-list-for-claude-code.md`). Broken out item by item (where the problem is, size, what I'd do) as a picker; most "broken screens" were the demo answering unknown calls with an empty OK. His picks: "do 1, 2, 3, 4a, 5, 22, 24a, 26, 28, 29. Skip 4b, 6–21, 23, 24b, 25, 27. Order: as listed … with a short report after each step." And: "lots of these were from the demo page.. really dont care much about it.. dont change those unless it was checked… on the minutes… if you are already a member and logged in, it should load, you dont need to sign in again." Minutes approval answers: board members who attended approve; the President can approve for someone after 7 days.
- **BJ1. Bylaws, minutes and board names: members only (item 1).** Today `/governance.html` is public (K6, "always public") and `board_meetings` `list_public` answers anyone with a club's slug; the bylaws PDF sits in the public `club-assets` folder.
  - `board_meetings` `governance` replaces `list_public`: it needs a sign-in (a member of that club whose household member row is active, or a board member) and answers nothing without one. The club comes from the sign-in, not a slug.
  - The page uses the sign-in already on the phone (member, else board), so a signed-in member goes straight in. With none, or an expired one, it goes to `/m/login.html?next=/governance.html`, which brings them back after signing in (`next` only accepts a path on the same site).
  - Bylaws PDFs move to a private folder (`club-docs`); the page gets links that work for an hour. Bishop's one PDF moves the first time anyone opens the page; new uploads move when posted. Old public links stop working.
  - The link leaves the public club page's footer (`club/index.html`); it stays in the member app's footer and on the board side. Board wording about bylaws being public changes.
  - `node scripts/test_minutes.mjs` (offline, new; renders the page signed in and signed out). Live after deploy: the page's call without a sign-in returns nothing (1 call).
  - ✅ Done 10/21. 32 offline checks (20 failed on the old code). Live: signed out → 401 with no bylaws, minutes or names; the old anonymous call → 401; a board sign-in for Bishop → its 1 closed minutes, the board, and a bylaws link that opens the PDF. Bishop's bylaws PDF moved to the private folder on that first read; the public copy is gone, so its old link no longer opens. 3 calls.
- **BJ2. Minutes: Members or Board only (item 2).** No public option; Members preselected; existing public minutes become Members; every "public page" line reworded.
  - ✅ Done 10/21. `board_meetings.visibility` is 'members' or 'private' (default 'members'; Bishop's 3 public meetings became Members). The editor's Members/Board only choice always has one picked; a page from before still sending 'public' gets Members. Board minutes page, help article and the older suites' wording updated. `test_minutes` 42 checks (10 new failed first). Live: the members' page still lists Bishop's 1 closed meeting (1 call).
- **BJ3. Minutes approval (item 3).** Submit for approval → each board member who attended gets a pop-up and an "Approve minutes" to-do → Approve / Request changes → "3 of 4 approved" → posts for members the moment the last approves. Request changes returns it to draft with the comment; resubmitting restarts approvals. After 7 days the President can approve for someone (recorded). Approved minutes lock; changes become an amendment with the same approval. Board-only minutes never post.
  - The flow: **Close meeting** (as today: the end time, unchecked agenda items go back) → the minutes are a **draft** the note-taker (or President) can still fix → **Submit for approval** → **waiting for approval** (locked) → **approved**. Members see only the approved version: a copy is kept when the last approval lands (`posted_json`), so a later fix never shows until it's approved too.
  - Approvers: the board members ticked in "Who's here?" (attendees with a board login that's still active). Members and guests who sat in are listed, not asked. The person who submits counts as approving (they wrote them). If nobody else is asked, the minutes are approved on submit.
  - Each approver: a pop-up and an "Approve minutes" to-do (`minutes.approve`, only theirs) that opens the meeting read-only with **Approve** and **Request changes**. Approving clears their to-do. The meeting shows "2 of 3 approved · waiting on Erik Larsen" here and on the list.
  - **Request changes** (a note is required): back to draft with the note shown on the meeting; everyone's approve to-dos close; the note-taker gets a pop-up and a "Changes asked on the minutes" to-do until they resubmit. Resubmitting starts approvals over and asks everyone again.
  - Reminders: the daily run sends a pop-up to anyone still waiting 3 and 6 days after it was submitted. From day 7 the President sees **Approve for Erik Larsen**, recorded as approved by the President for them (and in the audit log); on day 7 the President gets one pop-up saying so.
  - Approved minutes are locked to edits. **Save changes** on approved minutes starts an amendment: it becomes a draft again (members still see the approved version), and goes through the same approval; when approved, members see it marked "Amended".
  - Decisions I made (Doug can overrule): the submitter counts as an approval; the note-taker or President can take submitted minutes back ("Edit again") to fix a typo, which restarts approvals; reminders on days 3 and 6; meetings already closed before this keep their minutes as approved, so nothing disappears from the members' page.
  - Tables: `board_meetings` gains `minutes_status` (draft / submitted / approved), `approval_round`, `submitted_at/by`, `changes_note/by_name/at`, `posted_json`, `posted_at`, `posted_count`, `approved_at`; new `board_minutes_approvals` (one row per approver per round: pending / approved / voided, who decided, on behalf). The rules are in `_shared/minutes_approval.ts`. `test_minutes` covers them offline.
  - ✅ Done 10/21. `test_minutes` 77 checks (35 new failed first; one renders the editor as an attendee who can't edit and taps Approve). All 44 offline suites pass. Live with two throwaway board logins (14 checks, ~14 calls, all removed after): close → draft; submit → 1 of 2, the other's to-do; locked while waiting; changes need a note, send it back, the note-taker's to-do; resubmit → round 2; President can't approve-for before 7 days; approve → on the members' page; a change to approved minutes is an amendment and members keep the approved text. Bishop's closed minutes were kept as approved. Help article updated.
- **BJ4. Party dates separate from the pool season (item 4a).** First/last party date, blackout dates with a reason, days of the week, earliest/latest start, minimum notice, maximum days ahead; greyed out in the member's picker and refused by the server. Until set, parties follow the pool season.
  - Found: there's no party date rule today at all. The server only refuses a past time, and the member form is a plain date-and-time box. So "until set" means no limits, as now.
  - Settings → `settings.parties`: `from`/`until` (first and last party day, full dates like the access levels), `blackouts` [{from, to, reason}], `days` (weekdays allowed), `earliest`/`latest` (start time window), `notice_days` (at least N days ahead), `ahead_days` (at most N days ahead). Edited on Parties → Party settings; checked by `cleanRules` before saving.
  - One set of rules in two copies that must agree: `_shared/party_rules.ts` (server) and `js/party-rules.js` (member page), like `venmo.ts`/`venmo.js`; the test runs both over the same days.
  - Member side: the date-and-time box becomes a month calendar (blocked days greyed; tapping one says why, e.g. "No parties: swim meet") and a start-time list from the allowed window in 30-minute steps (8 AM–8 PM when the club sets none), with times another party holds marked booked. `tenant_public` sends the rules.
  - Server: `member_auth` `request_party` refuses a blocked day or time with the same reason. The board can still move a party anywhere when approving it.
  - `node scripts/test_party_dates.mjs` (offline; renders the member's calendar).
  - ✅ Done 10/21. `test_party_dates` 36 checks (35 failed first; the two copies agree over 570 days for 4 rule sets; renders the member's calendar: blocked day greyed with its reason, weekdays, first allowed day picked, start window, booked times). All 45 offline suites pass (`test_signup_notes`' label check updated). Live: Bishop's settings and member page carry the rules, all empty (2 calls). Help article updated.
- **BJ5. Referrals only for families who weren't members last season (item 5).** Match phones, emails and street address against last season's members; plain reason to the family; the board sees it ("Member in 2026") and can override.
  - Found: two checks, both "ever a member here", by email and phone only: one takes the $25 off at signup (`membership_price` `wasMember`), the other gives the referring member their reward when the family pays (`referrals` `isEligibleNewMember`). The family isn't told why, and the board sees a referral as "Not a new family" only after payment.
  - One rule for both (`_shared/referral_eligibility.ts`): the family doesn't count if any of its phones, emails or its street address (tidied: "Ln." = "Lane", case and punctuation ignored) matches a household paid through last season or later. Two or more seasons lapsed counts. "Last season" is the season before the one they're signing up for.
  - At signup the match is made at once: no $25 off, the price box says "The referral discount is for families who weren't members here last season" (without saying what matched), and the referral is recorded as not counting, with the board's reason ("Member in 2026: same address as the Smith Family").
  - The board's referral list (Money → Payments) shows those with **Count it anyway** (payments permission): the member gets their reward as usual (when the family has paid, the 30 days start). The family paid full price; refunding their $25 is by hand. Recorded who counted it (`referrals.override_by/at`).
  - Only a current member gets a referral link (`get_my_code` checks the household is a member this season). The member app's wording changes to "weren't members here last season".
  - `node scripts/test_referral_rule.mjs` (offline).
  - ✅ Done 10/21. `test_referral_rule` 25 checks (14 failed first). All 46 offline suites pass (`test_money`'s two H6 checks point at the moved code). Six functions that share the pricing code redeployed together. Live with a throwaway referral code on a Bishop test family (3 checks, 4 calls, removed after): a family at a last-season member's address (typed in capitals with a period) gets no $25 and the rule in plain words, without what matched; a brand-new family gets the $25. Found by the live check: the signup price leaves out fields it doesn't list, so the reason didn't reach the form; fixed, with a check.
- **BJ6. Party wording follows "Approve open times automatically" (item 22).**
  - Found in two places: the member's party form ("Request a party … Your club's admin reviews requests and approves them") and Settings → Features → Party rentals ("you approve with one click"). The form's button and the message after booking already follow the setting.
  - On: "Book a party … Pay by card and it's booked on the spot. Paying by Venmo holds the time until the board confirms your payment." Off: "Request a party … The board looks at your request and lets you know." Party rentals on Settings says the same, from the club's setting. Checked in `test_party_dates` (renders the form both ways).
  - ✅ Done 10/21. `test_party_dates` 39 checks (3 new failed first). All 46 offline suites pass; `test_demo_site` caught an apostrophe that broke Settings' script before it shipped.
- **BJ7. The demo shows card payments working (24a); the Keyfob / RFID gate box shows on when a club's gate is connected (26).**
  - 24a: the "Card payments aren't available yet" line on Money → Payments shows when Stripe's status doesn't say Poolside's own setup is done; the demo's answer left that out. Now the demo says "Stripe ready". (Real clubs: that's Doug's Stripe step, 24b.)
  - 26: "Keyfob / RFID gate" is one of Settings → Gate & check-in's "how members get in" choices, saved separately from the gate itself. When the club's gate is connected (Remote keyfob access: Active), it now shows ticked, "(connected)", and can't be unticked. Any club, the demo included.
  - ✅ Done 10/21. `test_demo_site` 19 checks (4 new failed first; renders Payments and Settings with the demo's answers).
- **BJ8. The demo club: Start over resets everything (28); real screens for Doug's re-recording (29).** Ask Doug first: item 29 includes party booking, the Venmo confirm and the sponsor pop-up, which he unticked as items 9–12 and 14.
  - Doug 10/21: "All of 29": the demo remembers what you do until Start over.
  - Found: the demo keeps what you do in its service worker's memory, which the browser wipes when the worker sits idle (about 30 seconds in Chrome). That's why "Confirm selected" looked like it did nothing: the confirm was recorded, then forgotten. Now the worker saves the demo's state in the browser's own storage (Cache Storage, this visitor only) after each change and reads it back; **Start over** clears it and the page's own storage.
  - Parties: booking keeps the party (Your party requests, the board's Parties list); paying by card marks it paid and booked (a note says the card page is skipped); a Venmo the family says they sent waits in Money → Payments → Venmo to check. Paid parties go on the club calendar as "Private event" (the real app does the same), including the made-up ones already there. The host family's app shows the Snack Shack button on party day (the Riveras have one today).
  - Venmo confirm: works, and stays confirmed: Signups show them paid.
  - Sponsors: turning on the pop-up on Sponsors shows it in the member app, and the sponsor strip shows the club's sponsor. Settings saved on Settings stay saved.
  - Board minutes: the demo answers every Board minutes call (start, the editor, who's here, agenda, motions, follow-ups, close, submit, approve, ask for changes) from saved state. The demo has one person signed in, so when Sam submits, the other board members who were there approve a few seconds later on their own (a note says so; in a real club each gets a pop-up). Then the minutes post on the members' Bylaws & board minutes page.
  - All of it is the demo's answers (`scripts/demo_video/site_data.mjs`, `demo/demo-sw.js`, `demo/demo-ui.js`); the real app is unchanged. `test_demo_site` walks each one with the demo's answers, one shared state as the worker keeps it.
  - ✅ Done 10/21. `test_demo_site` 47 checks (27 new failed first: the answers, then Board minutes, the members' minutes page, Venmo to check and the member app on screen with one shared state). Checked live on demo.poolsideapp.com: a confirmed Venmo stays confirmed after the worker restarts. The live check found Board minutes' bylaws box showing a red error (the demo's old answer was the wrong shape); fixed, with a check. The bylaws link goes to a made-up page, `demo/bylaws.html`. It also found the sponsor pop-up never showing in the demo: the member app and the club page asked for it before its script (deferred) had run, which the demo's instant answers always hit and a fast phone could too. Both pages now wait for the script (`test_sponsor_popup` runs the waiting in that moment; its checks failed first, and caught that my first fix still missed it). `sw.js` keeps the `demo-state` cache when it clears old ones. All 46 offline suites pass.

### BI. The home page, rewritten in the video's style (Doug, 10/20) — built 10/20, waiting for Doug's OK to go live
Doug: "rewrite home page". Asked 10/20, he picked: the video's look (pool blue, big bold titles, white phones with the real app, icons); "Try the demo club" as the main button, "Start your club" second; short; the video near the top. Replaces the BG7 draft (wording fixes only, never shipped); its truth checks (`scripts/test_home_page.mjs`) stay.
- Sections: the hero (title, the two buttons, a family's phone and the treasurer's); the video (the small copy, loads only when played, subtitles burned in); the mess (crossed-off Venmo note, spreadsheet, texts); how it works in the video's five parts, each with a phone picture and one short paragraph, then one line of everything else included; pricing (first season free, the three plans, setup help, fees, the gate add-on); a short FAQ; "See it working" with the two buttons; the footer.
- Phone pictures are the real pages with the made-up Maple Grove club, made by `scripts/demo_video/home_shots.mjs` (the video's harness, no Supabase calls), so they can be re-made when the app changes. Pictures and the video go in `media/`.
- Every claim checked against the code, as BG7 did. Prices must match `pricing.html` and `billing.html`.
- `node scripts/test_home_page.mjs`: the BG7 truth checks, the five parts, the demo button first, the video and pictures exist and load lazily, prices agree across the three files, and the page renders at phone and laptop width with nothing spilling sideways. Added to the offline CI list.

### BH. A 90-second video like the Smartiply one (Doug, 10/20) — ✅ done 10/20 (Doug: "i think this is good for now")
Doug, on the BD2 tour: "its good, just not great... the voice is weird.. the structure is weird... the chapter word is also weird". Then, of a 1:38 app promo on YouTube (Smartiply, by Rightcolours): "can you make something like this?" Picked: pool blue, a Mac voice (Ava (Premium), downloaded on his Mac), music I find (a Pixabay track, free for commercial use, no credit needed: `handouts/music/`, kept out of git). After a 19-second sample: "voice is good, script ok, build it but again the voice is a little weird.. put subtitles?"
- The look, from the reference: a flat pool-blue background with soft diagonal stripes, clean white phones, a big bold title sliding in beside the phone for each part (no chapter numbers, no "Chapter"), two phones side by side when two people are involved, labeled icons popping in around the phone, short calm lines over upbeat music, and a problem → how it works → tagline story.
- Subtitles burned in at the bottom, one sentence at a time. Each sentence is its own voice clip, so the words on screen change exactly when she starts the sentence. Also a `.srt` file.
- The music is leveled under the voice: about 15 dB below her while she speaks, louder in the pauses between parts, faded out at the end. The track is loud in places, so its level is measured and the music turned down more there.
- The approved script (one wording change: "their own to-do list", since the voice reads "to-dos" badly; and "keyfobs" and the web address are spelled out for the voice only):
  1. "Running a pool club shouldn't feel like a second job. No more chasing Venmo screenshots. No more spreadsheets. Meet Poolside." (a messy Venmo note, a spreadsheet and a "did they pay?" text get crossed off)
  2. SIGN UP IN 5 MINUTES: "A family signs up from their phone in about five minutes: their details, their kids, the club's policies, signed."
  3. PAID. APPROVED. DONE.: "They pay by card, Venmo or a payment plan. Card payments approve themselves, so the board has nothing to do." (the family's and the Treasurer's phones)
  4. THE GATE KNOWS: "Paid families open the gate from their phone, and their keyfobs follow who's paid."
  5. NOTHING TO CHASE: "Every Venmo payment carries a code, so the board confirms a whole batch at once. Plan payments go out only when the board ticks them."
  6. YOUR BOARD, SORTED: "Each board member opens to their own to-do list: parties, keyfobs and questions, in one place."
  7. "Poolside. Run your pool club, not your spreadsheets. Try it yourself at demo.poolsideapp.com."
- Built like the tour: `node scripts/demo_video/promo.mjs` (`promo.html` is the stage; the taps and typing the two videos share moved to `drive.mjs`), the made-up Maple Grove club, every Supabase call answered by `data.mjs`. Output `handouts/poolside-promo.mp4` (1920×1080), `poolside-promo-small.mp4` (1280×720, for texts and email) and `poolside-promo.srt`. `encode.swift` takes the music and its volume curve. `node scripts/test_demo_video.mjs` checks the script, the subtitles and the music levels.
- As built 10/20: 1:16 (shorter than 90 seconds once the screens kept up with the voice), `handouts/poolside-promo.mp4` (55 MB), `poolside-promo-small.mp4` (18 MB), `poolside-promo.srt`. Recorded at 60 frames a second. Measured in the finished file: her voice about -17 dB while she speaks, the music about 15 dB under her, up to about -25 dB in the longer pauses, faded out at the end. Each subtitle appears the moment its sentence starts.
- Found making it: Chrome stops drawing a phone page that's wholly off screen, so a scroll there never finishes. A phone off screen now waits just inside the bottom edge, see-through. And a phone page scrolling something into view could scroll the whole stage; the stage is now fixed in place.

### BG. Fix what the audit found (Doug, 10/20) — ✅ BG1–BG9 shipped 10/20; the home page rewrite waits for Doug's OK
Doug's answers 10/20: run all steps, a short report after each; refunds and chargebacks get a to-do only (no automatic undo); keep families at 8; "no late fees on here... remove it"; replies go to a new Club email, else the President; Setup is $500 up to 100 households, $750 above; the demo is a whole made-up club anyone can click through (BG9).
Doug picked 42 of the 47 audit items (all but 5, 15, 23, 46, 47; 15 is his own Stripe step). Details per item: `handouts/audit/findings.md` (kept out of git). Each step: a failing test first, the fix, the test passing, deploy, commit. Security first.
- **BG1. Sign-in safety** (items 1, 4, part of 2) — ✅ 10/20. `node scripts/test_signin_safety.mjs` (offline, 23 checks); live: 5 wrong board passwords lock, the right one is refused until the 15 minutes pass. A sign-in text or email that can't be sent never shows the code or link on screen; it says to try again, and a text that fails falls back to emailing the code when there's an email. Board passwords and board codes lock for 15 minutes after 5 wrong tries, with an email to that person. Email lookups use exact matches. Sign-in codes don't count toward the daily text limit (they keep the per-phone limit).
- **BG2. Texts** (items 2, 30) — ✅ 10/20. `node scripts/test_texts.mjs` (offline, 13 checks). SMS_GLOBAL_DAILY_CAP set to 900. Texts wait in `sms_queue`; the daily `payment_plans` run sends them (`drainSmsQueue` in `_shared/send_sms.ts`) and reports `texts_sent` / `texts_waiting`. The platform's daily text limit goes to 900 (under T-Mobile's 1,000 a day for the Sole Proprietor number). Renewal-message texts over the day's limit go the next morning by themselves, and the screen says so. The renewal text and the board-invite text are reworded (plain characters only).
- **BG3. Money** (items 6, 7, 8, 14, 22) — ✅ 10/20. `node scripts/test_money_fixes.mjs` (offline, 30 checks); live: a pretend $25 donation at Bishop went through the test checkout and the thermometer read $1,025 (the $1,000 Bishop typed is now its outside amount), then removed. Also fixed: the Terms page listed old rates (0.5% dues, 2% parties, 5% late fees). Refunds and chargebacks on every kind of card payment reach the Treasurer as a to-do and pop-up (nothing is undone by itself). The old Mark paid buttons run the same step as Venmo to check. A card donation adds to the board's outside amount instead of replacing it. Late fees come out entirely: the Money setup card, the nightly assessment, the help article and the website mentions (the empty table stays). Donations follow the Test payments switch.
- **BG4. Signups** (items 9–13, 18–21) — ✅ 10/20. `node scripts/test_signup_fixes.mjs` (offline, 22 checks); in a browser, 5 adults caps children at 3; live: a 10-person signup and Single for 4 people are refused with plain messages, nothing saved. Bishop's Single now covers 1 person (Money setup → Membership prices, "Covers up to"). The signup form stops at 8 people with "ask the board about larger families". A paid card signup that can't be approved opens a to-do. A family starting a plan gets the Sign in button. Each level can say how many people it covers (Bishop: Single is one person), and the card signup only offers levels that fit. Unpaid card signups are checked with Stripe before they're deleted. A released party paid late is re-booked if the time is free, else a refund to-do. The welcome text goes whenever there's a phone. Policies are recorded by the club's own list.
- **BG5. Emails** (items 12, 16, 17, 24) — ✅ 10/20. `node scripts/test_email_fixes.mjs` (offline, 15 checks); `test_emails --live`: 19 emails on Settings → Emails, the dues reminder previews right. Reply-to on every club email: Settings → Club info → Club email, else the President (`_shared/reply_to.ts`). Dates in plan emails read "Sunday, August 1" (`fmtPoolDay`). The dues reminder moves into Settings → Emails with "approved" and "waiting" versions, the amount and the Venmo button (email only, per the notification rule). Replies go to a new Club email box on Settings → Club info, else the President. The plan receipt shows a real date. The plan reminder and party-released emails move into the list; the board invite and sign-in emails get the same look but stay fixed.
- **BG6. Screens and help** (items 29, 31–34, 41, 43, 44) — ✅ 10/20. `node scripts/test_screen_fixes.mjs` (offline, 29 checks; 27 fail on the old code). Every changed page renders at phone width with no script errors; Privacy and Terms are 390 px wide again. "Pipeline" is now "Signups". Five new help articles: check-in, the Venmo code, canceling a party or fob, who gets which alert, the text allowance. Signup wording, Plan & billing for a club on a set plan, the three layout slips, plain words, small polish, the debug code, the four help fixes and the new help articles.
- **BG7. The website and your console** (items 25–28, 35, 36, 40, 43) — ✅ 10/20 except the home page, which waits for Doug's OK (draft in the working copy, `scripts/test_home_page.mjs` comes with it). `node scripts/test_site_fixes.mjs` (offline, 12 checks; all 12 fail on the old code). Doug to confirm support@poolsideapp.com forwards in Porkbun. Home page made true (Doug sees the new text before it goes live), one Setup price ($500 up to 100 households, $750 above, and Plan & billing charges by size), the signup link, the "see a real club" link goes to the demo (BG9), one contact address (support@poolsideapp.com), the console tidied, a limit on new clubs per hour and per email (still instant), /club-demo/ removed.
- **BG8. Housekeeping** (items 3, 37–39, 42, 45) — ✅ 10/20. `node scripts/test_housekeeping.mjs` (offline, 18 checks). Real names, Doug's mobile and the Gmail are out of the current files (git history still has them until the repo is private). H4 runs again (the test was stale, the app was right). `.github/workflows/offline-tests.yml` runs all 43 offline suites on every push. `offline.html` + `sw.js` v3. vercel.json headers. Scheduled calls wait 30 s; `net._http_response` cleared once (database 79 MB → 33 MB). DMARC p=quarantine is Doug's DNS change in a few weeks. Names and the real phone number out of current files (Doug makes the repo private; if Vercel then won't deploy an organization's private repo on Hobby, move the repo to his own GitHub account). The offline tests run on every push and H4 is fixed. An offline page for no signal. Protective headers. The database clean-up and 30-second scheduled-call timeouts. DMARC to quarantine is Doug's DNS change, in a few weeks.
- **BG9. The demo club** (item 28) — ✅ 10/20, live at demo.poolsideapp.com (checked in Chrome: every call answered in the browser, the door note shows, both sides open). `node scripts/test_demo_site.mjs` (renders all 36 board and member screens with the demo's answers; offline). Build: `node scripts/demo_video/build_demo_site.mjs` → `demo/demo-data.js`. Found on the way: the gate check-in page and My shifts always said "Could not load" (they never loaded `js/admin-flags.js`); fixed. Doug: "make it clear this is a demo pool… an entire example that people can have access to… auto login/all features enabled… mess around on the admin side… it really does nothing… i dont want texts generated or sent nor emails… label things like this button WOULD send a text or email". demo.poolsideapp.com runs the real pages with Maple Grove's made-up data answered inside the visitor's own browser (the demo video's approach), so nothing reaches Supabase, Twilio, Resend or Stripe and it costs no calls. A start screen picks "the board side" or "the member app", signed in already; every page carries a "Demo club, nothing here is real" banner; anything that would text, email, charge or open a door says what it would have done ("In a real club this texts 142 families. Nothing was sent."). Each visitor gets their own copy, reset when they close it.

### BF. A full audit (Doug, 10/19 night) — ✅ list ready 10/20, waiting on Doug's picks
Doug: "go line item by line item, page by page, box by box and completely audit the app… ensure things make sense.. they actually work… is there anything better we can do?" Then: "Just go… find everything… I'll expect a big list in the morning." Asked: everything (his provider admin and the marketing site too); list first, he picks; nothing in the app changes.
- Passes, riskiest first: money; the gate and keyfobs; sign-in and keeping clubs apart; the board's pages; the member app and signup; emails, texts and pop-ups; help; provider admin and the marketing site; the database, the setup and the tests.
- How: every page and pop-up at phone width with the made-up club (no Supabase calls), the server code behind each read against what the page promises, every word read for sense, the offline tests, sweeps for broken wiring (a button calling an action no function handles, an id that isn't on the page), Supabase's own security and speed advisors, and the public repo checked for secrets.
- The list: broken, wrong, confusing, could be better; each with where, why it matters and the fix. Kept out of the public repo (security findings): `handouts/audit/`.
- Done 10/20: 63 findings merged into 47 ranked items (`handouts/audit/audit-ranked.md`, tick boxes in `audit-picks.html`, details in `findings.md`). Nothing changed in the app. Next: Doug picks; each picked item becomes its own step here.

### BE. Fixes found making the video (Doug, 10/19) — ✅ BE1–BE3 done 10/19
Doug: "you found some errors, yes fix those… At the end of the season.. when we close the season, we need to shut the keyfobs off…. NOT the board members". Asked: fob changes go to the doors "Nightly, by itself".
- **BE1. A Member fob follows the season and the family's payment.** Today every active fob gets its level's doors and dates, paid or not, so a family who didn't renew gets in again next season. Now a fob on the Member level is on the doors only while the Season switch is Open and its family may use the gate, the same rule as the app's Unlock (`unlock_gate`: household active, dues paid, a member for the season, which counts a payment plan). Closing the season (Season switch → Closed) takes every Member fob off; board, staff and every other level stay as they are. A family who pays gets their fob back at the next sync; one who doesn't stays off. `_shared/keyfob_sync.ts` (`syncPlan`, `loadSyncPlan`), the reason on each line of the check ("season closed", "not paid for 2027").
  - The nightly check-and-send does it with no one tapping, once "Auto keyfob activations" is on for the club (Doug's switch, /admin/ Overrides). It stays off at Bishop until the fob list is imported and checked: until then Poolside doesn't manage Bishop's member fobs, so nothing changes at the doors.
  - With the nightly off, closing the season gives the keyfob person a to-do to send the changes, so it isn't forgotten.
- **BE2. A renewal is confirmed to the family.** A renewal paid by card (or saved card, or a Venmo the board confirms) sends nothing today. Now: a confirmation email (Doug's rule: receipts by email, always) and a pop-up, from the renewal's approval.
- **BE3. The Keyfobs page says how it works now.** Its intro and the lost-fob row still say to program each fob at the panel; with the sync, Poolside puts fobs on the doors and takes lost ones off.

### BD. A demo video (Doug, 10/19) — ✅ first cut done 10/19 (handouts/poolside-board-demo.mp4, 2:25)
Doug: "are you able to make a video tutorial on how to demo this app?... you can't just create a video?" Then: "the intent right now is to show how the app works for the board... the benefits.. how efficient it is.. how it works... how it literally automates everything if someone pays by credit card and they already have a keyfob etc."

The story, checked against the code so it claims only what Poolside does:
1. What the board used to do each season (the signup form, typing families into a spreadsheet, checking Venmo and PayPal, the gate computer).
2. Paid by card: nothing for the board. A card payment marks the signup paid and approves it (`stripe_webhook` → `applications` `approve`), which sets up the household, closes the signup to-do, sends the welcome email and text, and texts family members their app link. A fob already in Poolside needs nothing: the sync puts every active fob on its level's doors and dates.
3. Venmo: the code in the note and "Venmo to check" (BC1). Venmo can't tell Poolside a payment arrived, so a person still confirms.
4. Keyfobs: a new fob is one to-do (hand it over, type its number). Poolside writes it to the doors at "Sync keyfobs now", or nightly once "Auto keyfob activations" is on (off at Bishop). A lost fob reported in the app is turned off the same way.
5. Each board member's home, and a button per door.
6. Parties book themselves: an open time is approved on the spot, card books it, and the family's app opens the party door that day.
7. Insights → Time saved.

Found while checking: a fob doesn't depend on the family having paid. Every active fob gets the Members level's doors and dates, so when next season's Members dates are set, a family who didn't renew still gets in unless their fob is turned off. Raised with Doug 10/19; not part of the video.

Defaults (Doug didn't pick):
- About 2–3 minutes, landscape (1920×1080 MP4), to show a board or another club. Burned-in captions, so it works with the sound off, plus a Mac voice reading them (Karen, Doug's pick from eight samples on 10/19; a free Premium voice from System Settings would sound better, then re-make it).
- A made-up club, "Maple Grove Swim Club", with made-up families. Every Supabase call is answered by the script, so no real family shows and no calls are used.
- One or two phones on screen ("Family's phone", "Board's phone") with a dot showing each tap. The story: a family signs up and pays by Venmo, the board confirms it in a batch, each board member's home, the member app, opening the gate, a party, and Time saved.
- Things only a real iPhone shows (Add to Home Screen, pop-ups arriving, the Venmo app, the gate opening) aren't in it. Doug can screen-record those and they can be spliced in.
- `scripts/demo_video/` records it (Chrome through puppeteer, then Apple's AVFoundation through Swift, no downloads), so it can be re-made in minutes after the app changes. It stops if any screen it taps isn't there. The video goes to `handouts/` (not in git).

As built: 9 scenes, 2:25, 1920×1080 with sound (40 MB), plus `handouts/poolside-board-demo-small.mp4` at 1280×720 (21 MB) for phones and email (`DEMO_SIZE=720`). Title; what the board used to do (crossed off); paid by card (the Riveras renew: accept the policy, sign, pay, a stand-in for Stripe's card page, then the board's families paid and collected go up); Venmo (the Patels' code, then Venmo to check, two ticked and confirmed); keyfobs (issue the Larsens' fob, Sync keyfobs now, Send to the doors); each board member's home and a door button; families (Unlock the gate, a booked party and its Snack Shack door); Time saved (about 73 hours, $1,462); the end card. Every scene's caption is its narration. `node scripts/demo_video/record.mjs` re-makes it (about 3 minutes, builds its encoder the first time); `node scripts/test_demo_video.mjs` checks every screen in it still works with the made-up club (offline).

**BD2. ✅ The step-by-step tour, done 10/19:** `handouts/poolside-tour.mp4` (5:07, 1920×1080, 91 MB), `handouts/poolside-tour-small.mp4` (1280×720, 24 MB, fits a text or email), and `poolside-tour.srt` (captions to load in YouTube, Drive or a player). Made by `node scripts/demo_video/tour.mjs` (`stage2.html`, the same harness and made-up club; `ONLY=<chapter>` records one). Siri Voice 5 at rate 150 with a pause after each sentence. Found while making it, and fixed: on a phone the signup form's "Make next season's renewal one tap" box was squeezed into a narrow column (`apply.html`, it now wraps like the payment choices).

**BD2 as asked (Doug, 10/19):** "a little shitty… I'm hoping a step by step of signing up… pay by credit card.. pay by Venmo… make payments.. then where it gets you and how easy it is… even with other family member and phone login with text… The notification part is good for board members. Speech is very rushed." Asked: one video with chapters (about 6 minutes); "make payments" = a payment plan; voice: a Premium Mac voice (Karen (Premium), else Ava (Premium)), which Doug downloads.
- Chapters: signing up step by step (who's in the family, a phone and the "text them a link" box for each adult and teen, policies and signature, membership level); paying by card (to the welcome text and the app); paying by Venmo (the code, the board's batch confirm, the welcome); a payment plan (part now, the rest on set dates, the board ticks each payment before it's charged); the family's other phones (the link a spouse or teen gets, and signing in with a texted code); and the board side kept short (pop-ups, each home, keyfobs nightly, Time saved).
- Slower speech: one short line per step, spoken while that step is on screen, a pause between sentences, and a slower rate.
- Texts can't be filmed, so each one (the welcome text, a family member's link, a sign-in code) shows as a message bubble with Poolside's real wording.
- After BE, so the video says what the fixed app does.
- Doug: "go look at best ways to create tutorials... use those methods". The methods, from screencasting guides and Mayer's multimedia-learning principles:
  - Short chapters, one task each, each opened by a title card, with the chapter list on screen (segmenting, signaling, pre-training). About 6 minutes in all (viewers finish 3–6 minute videos).
  - About 140 words a minute, one breath per sentence, "you", the exact button named; each line spoken while that step happens; a beat before each tap and the result held on screen (temporal contiguity).
  - A "camera" that zooms into the part of the phone in use (people watch on phones), a ring on what matters, nothing extra on screen (coherence).
  - Short step titles on screen, not the narration (redundancy), plus a captions file for sound-off viewers (Doug: "Step titles + captions file").
  - A natural voice (the voice principle): Siri Voice 5, Doug's Mac's system voice (`DEMO_VOICE=system`).
  - The made-up club, Maple Grove (Doug's pick), so it can be shared anywhere.
- Storyboard: 0 what you'll see; 1 signing up step by step; 2 paying by card, the welcome text, into the app; 3 paying by Venmo and the board's batch confirm; 4 a payment plan and the board approving each payment; 5 a spouse's link and signing in with a texted code; 6 what the board gets (pop-ups, their home, fobs on overnight); 7 recap. Texts and pop-ups use Poolside's real wording.

Not in it yet, if Doug wants them: his own voice or a Premium Mac voice, real-iPhone moments, and the Keyfobs page's intro, which still says to program each fob at the panel (older than the sync), so the video scrolls past it.

### BC. Make Venmo easier to check (Doug, 10/19) — ✅ BC1 and the batch approval done 10/19; BC2, BC3 are ideas only
Doug, after seeing the example: "go... create the auto load family name, amount, and code... then put that code into the poolside app as well.. batch approval would be great!"

BC1 as built:
- **Every Venmo payment gets a 4-character code** (letters and numbers that can't be confused, like K7Q2). A database default, `public.venmo_code()`, fills it on signups, parties and keyfobs.
- **The "Pay with Venmo" button fills in the rest.** It opens Venmo to the club's handle with the amount and a note like "Cabana Club 2027 dues - Frevele - #K7Q2" (the club's app name, what it's for, the family, the code). `_shared/venmo.ts` and `js/venmo.js` build the same note and link.
  - Signup: after submitting, a "Pay $600 with Venmo" button plus a QR code for computers, and the same link in the "application received" email. Before submitting, step 4 says the button comes after you submit, because the code doesn't exist until then.
  - Parties and keyfobs in the member app: a "Pay with Venmo" button next to "I paid by Venmo", then the family taps "I paid". A family paying for several fobs in one Venmo gets every fob's code in the note ("#M3PX #W9HC").
- **The code shows on the board's screens:** Signups (the "💸 Venmo · #K7Q2" pill, and "with #K7Q2 in the note" in the signup's Venmo check), the party's banner, and the keyfob's Venmo note.
- **Batch approval: Money → Payments → "💸 Venmo to check"** (shows only when something is waiting). Venmo signups not yet paid, approved parties not yet paid, and keyfobs the family says they sent, with family, what it's for, amount and code, and boxes to tick; "says they sent it" ones first. A family's fobs are one line. "✓ Confirm selected" runs the same step as each one's own button, one at a time, and lists any that didn't go through: approve and verify a new signup, verify an approved one, book a party, or confirm the keyfobs. `payments_admin` `venmo_waiting` lists them. `node scripts/test_venmo_codes.mjs`.
- Also fixed: on a phone, an unpaid party's long status ("Approved — pay to confirm") squeezed the party's text to one word a line. The status now takes at most half the row.
Doug: "is there a way to streamline this process? is there a way to autoload a note in the venmo payment? anything would help with venmo".
- Venmo has no public way for a club's app to see payments. Pay-with-Venmo through PayPal checkout would be automatic but costs about card fees, which defeats the point of Venmo.
- **BC1. A matching note on every Venmo payment.** Every "Pay with Venmo" button (signup, parties, keyfobs) opens Venmo with the amount and a short note already filled in: "BECC 2027 dues · Frevele · #K7Q2". Poolside shows the same code next to the family on the board's Venmo checks, so the treasurer looks for the code and taps once.
- **BC2. Venmo checks itself, the treasurer still confirms.** The treasurer's Gmail forwards Venmo's "paid you" emails to a Poolside address. Poolside reads the name, amount and code, and marks the matching family "Venmo arrived". The treasurer gets a pop-up and confirms with one tap (Doug's rule: Venmo always needs a board OK). Only genuine Venmo emails count.
  - How it can break, and what happens:
    - Venmo changes its email layout. Poolside flags any Venmo email it can't read, and checking goes back to by hand.
    - Venmo emails get switched off, or the Gmail filter or forwarding stops (a new treasurer, a new address). Nothing arrives, and it's back to by hand.
    - The family deletes the code or pays from a spouse's account. It becomes a "possible match" by name and amount.
    - Someone sends a fake email. Only emails genuinely signed by Venmo count, and the treasurer still confirms.
  - Rules: it needs the club's own Venmo account, not the treasurer's personal one, or her personal payments would be forwarded too. A Gmail forwarding address has to be confirmed once with a code Poolside shows on Settings.
  - It's a helper, never the record: worst case is a missing or wrong "arrived" flag, and the treasurer checks Venmo as today.
- **BC3. Or: upload Venmo's statement.** The treasurer downloads Venmo's CSV statement, maybe weekly, and uploads it. Poolside matches every payment at once by code, then name and amount, for one bulk confirm. Nothing to forward and less to break, but it's not instant.

### AZ. Text family members a link to get the app (Doug, 10/19) — ✅ AZ1–AZ3 done 10/19
Doug: "if someone signs up... dad signs up, his number works for a login... he wants the wife and kid to also have the app, he has to then share the link with them... can you put a checkbox under each name adding a phone number saying something like click checkbox to text this family member a link for login..? i want it easy to share the app with family members".

What's there now:
- The signup form asks for a phone for each extra adult (optional) and each child (optional, "only if they have their own phone"). Anyone with a phone or email on file can sign in with a code; teens 13+ and adults can also open the gate.
- At approval only the primary is texted and emailed a sign-in link. Everyone else has to be told by the family. The form's hint "we text a 1-tap link" isn't true until they try to sign in.
- My family → "+ Add a member" (primary only) takes a phone too, and sends nothing.

Proposal:
- **AZ1. On the signup form**, under each extra person's phone: "Text [name] a link to get the app". The texts go out when the family is approved, alongside the primary's welcome text, each with that person's own one-time sign-in link (7 days; after that they sign in with their number and a code). The misleading hint goes.
- **AZ2. On My family**, the same box on "+ Add a member". Each person with a phone who hasn't used the app gets a "Text them the app link" button, and people who have used it show "Using the app". This covers families who already signed up, imported families and renewals.
- **AZ3. Limits.** One link per person per day and a few per family per day. The text names the club and who added them (Twilio handles STOP). A family invite becomes an allowed text in the notification rule.
Doug's answers:
- Adults and teens 13+.
- "ticked automatically, but make it clear as to what this box does".
- Texts only.

Built 10/19:
- `_shared/family_invite.ts` holds the rules: `canInvite`, `inviteText`, `inviteBlocked`, `sendFamilyInvite`.
- `household_members.app_invited_at` (migration `20261019000100_family_invite.sql`).
- The signup form's box: "Text them a link to get the app".
- At approval, `applications` texts the ticked adults and teens, unless the family chose no app.
- `member_auth`: `add_household_member` takes `invite`, there's a new `invite_member` action, and `me` returns `uses_app`.
- My family has the box, a "📲 Text them the app link" button and "✓ Using the app".
- Found while testing: with Settings → Season closed, the signup page told new families "Applications closed" even with "Memberships are" Open. Fixed as AX2.

`node scripts/test_signup_notes.mjs` (offline part); checked at iPhone width with made-up members; live: `me` returns `uses_app`, and inviting a child is refused with no text sent.

### AY. Board help: a complete FAQ, and "Still need help?" that reaches a person (Doug, 10/19)
Doug: "its more benecifical to ask questions on how to do things... like a chat to me... and if i dont know i can come here and ask you... the FAQ area would be really helpful to QC this and make sure that everything is on there we need... then another chat section that would text me?... should we do this in an option for setting... like a service? text doug (from poolside, not bishop estates)... SLA? or an admin can set it up so that it texts a specific member that knows more about the app?" No AI helper (parked).

What's there now (Help, `club/admin/help.html`):
- 14 articles in `club/admin/help/articles/*.md`, five of them unchanged since May. Nothing covers keyfobs and passes, the gate, payment plans and approving charges on Upcoming, parties, discount codes and referrals, the season switch, renewals and auto-renew, board positions and alerts, member questions (Ask the board), photos, Text all, emails, households, donations, programs, lifeguards or the calendar.
- "Still need help?" only opens an email to support@poolsideapp.com, an address that may not reach anyone.

Doug's answers (10/19):
- Questions go to the board member the club picks as its app expert. If there's none, or they choose "Ask Poolside", they go to Poolside (Doug).
- Answers happen inside Poolside, in a conversation like members' "Ask the board", never by personal phone number. The person answering is told by email (and a text from Poolside's number if Doug wants), and the reply reaches the asker as a pop-up and an email.
- No SLA. The screen says "usually within a day" and promises nothing. A paid "Priority support" SLA for future paying clubs is saved in memory, not built.

Steps:
- **AY1. The FAQ, checked against the app.** Each of the 14 articles is reread against how the app works today and fixed or removed. The missing topics above get written, in plain steps that name the real buttons. A test fails if an article names a screen or button the app doesn't have. ✅ Done 10/19: 44 articles in 9 groups.
  - All 14 old articles were rewritten; many named screens that had moved ("Settings → Admins", "Members → Applications", roles instead of positions).
  - 30 new ones cover the missing topics.
  - Search words are listed for every article.
  - The page's "we reply the same business day" became "we usually reply within a day".
  - `node scripts/test_help_articles.mjs` checks every bold menu path step by step against the board menu and pages, and every bold button against the app's screens.
- **AY2. "Still need help?" becomes a conversation.** The board member types the question, and it reaches the club's expert in their board app (a pop-up and a to-do), with who asked and the screen they were on. Either side can hand it to Poolside. Replies arrive as pop-ups and email, and the history stays together.
- **AY3. The setting.** On Settings → Board, the club picks its app expert, or "Poolside" (Doug).

### AX. A closed season shows no hours on the calendar (Doug, 10/19) — ✅ done 10/19
Doug: the board home said the pool is "Open 8–8" after it closed. Settings → Season → "Season is: Closed for the off-season" already switches the board home, the member app, the club's page and member unlocks to closed, and Doug sets it himself. One place ignored the switch: the month calendar printed each day's hours ("8A–8P") on every day. It does that in four copies (the member app, the club's page, and the board's Calendar, twice).
- **AX1.** While the season is closed, the calendar shows no hours on any day. Events still show.
- Opening day and Closing day (Settings → Season) still don't open or close anything by themselves; Doug didn't pick that.
- **AX2. New families can sign up while the pool is closed (Doug, 10/19: "yes let new families sign up while closed... confirming this is an option in the settings correct?").** A closed season used to replace the signup form with "Applications closed" too, even with "Memberships are" Open. Now only "Memberships are: Frozen — block new applications" stops new signups. While closed, the form shows the club's closed message and "You can still sign up now for next season." Settings explains which switch does what, and the help article matches. ✅ Done 10/19.
`node scripts/test_season_home.mjs` (offline part).

### AW. The keyfob sync's first real job was never handed out (10/18) — ✅ fixed 10/18
Bishop closed for the season. Doug ended the Members time window in the old Windows program and asked me to check that member fobs turn off tomorrow. Bridge 1.4 went on the club PC, and I queued a read-only check (both controllers' Members and Board windows, plus a few board and member fobs). The cloud never handed it over. The database only takes "update the oldest one" (sort plus limit) when the sort column is also returned, and the sync claim didn't return `created_at`. The unlock claim returns `requested_at`, so doors were never affected. Meanwhile the waiting job ended every 2-minute hold at once, so the bridge checked in every 5 seconds until I cancelled the job (about 6 minutes, roughly 70 calls).
- **AW1.** The claim returns `created_at`. A job that can't be handed out fails at once with the reason, so it can never cut check-ins short again.
- **AW2.** A test fails if any "update the oldest" in a function doesn't return the column it sorts by.
- **AW3. What I found and did, with Doug's OK ("turn off all members.. leave the 41... live").** Doug's change in the old program hadn't touched the Members window. It set every fob's own end date to October 19, the 41 board, landscaper, lifeguard and party fobs too. With bridge 1.4 I wrote 84 changes, all read back live. The 41 went back to their old end dates on both controllers: 39 never expire, one family 2099-10-30, another 2026-10-30, Board window, doors and PIN unchanged. The Members window (2) now ends 2026-10-17 on both controllers, so all 94 member fobs are off. Poolside's Member level also ends 2026-10-17, so the app's Unlock matches. A fresh read of all 135 fobs and both windows confirmed it. The old program still says October 19 for everyone and October 31 for the Members window, so an upload from it would undo this.
`node scripts/test_keyfob_sync.mjs` (offline).

### AV. Real payments: a free rehearsal, then $1 live tests (Doug, 10/14) — plan only, starts when Doug says
Doug: "once i make a couple of more changes, I want to link a bank account and then test the payments... can I do this with like 1 payment weekly for like 1$ and then put it into my account? how reliable is this? I want to ensure all this payment stuff works".

Where things stand (checked 10/14):
- Every payment so far has been a Poolside test payment (`settings.payments.test_mode` on). A real Stripe Checkout has never run, so the webhook has never read a real card off a real payment.
- Poolside's own Stripe key is still a test key (`sk_test_`).
- Bishop's Stripe account is connected but unfinished: `stripe_charges_enabled` and `stripe_payouts_enabled` are both false. It's Standard Connect, so a family's payment lands in Bishop's own Stripe account and pays out to the bank on that account. Bishop's platform fee is waived.
- Bishop passes the card fee on (`pass_stripe_fee`): $1 of dues charges $1.34, and the club nets $1. Stripe keeps its fee (about 34¢) even when a payment is refunded.
- Plans can't charge weekly. A plan payment falls once a month on the billing day (the 1st), only after a board member approves it on Money → Upcoming, and Bishop's minimum plan payment is $25 (`min_installment_cents`, a setting). For a faster test, I move a test plan's next payment to today and the nightly run charges it the next morning. That's a data change on a test plan, not a code change, and only with Doug's OK each time.

How reliable:
- Stripe itself is very reliable. The risk is our side.
- The real-Checkout webhook path is untested, which is what AV1 is for.
- Poolside runs on the free Supabase plan. If the project is down or over its limit, Stripe's notices fail (Stripe retries for 3 days) and the nightly plan charges don't run. Supabase Pro removes that risk before real families pay.
- `stripe_webhook` checks one signing secret (`STRIPE_WEBHOOK_SECRET`). Stripe gives each webhook endpoint its own secret. Family payments are events on Bishop's connected account, and Poolside's own billing events are on Poolside's account. If those need two endpoints, the webhook has to accept two secrets, which is a small code change. AV1 shows whether it's needed.
- The event list in INTEGRATIONS.md is out of date. The webhook handles `checkout.session.completed`, `charge.refunded`, `charge.dispute.created`, `payment_intent.payment_failed`, `account.updated`, `customer.subscription.updated` and `customer.subscription.deleted`.

Whose bank: payouts go to the bank on Bishop's Stripe account. Use the club's bank and EIN, not Doug's own, because Stripe reports the income on a 1099-K to whoever owns the account.

Steps:
- **AV1. Free rehearsal in Stripe's test mode (no real money).**
  - Doug finishes Bishop's Stripe setup in test mode (Stripe accepts test details) and turns off Poolside's 🧪 Test payments, so the real Stripe Checkout runs on the test key.
  - Doug pays with Stripe's test cards: 4242 4242 4242 4242 works, and 4000 0000 0000 0341 saves fine but declines when charged later.
  - Each flow once:
    - pay in full;
    - a plan with money today;
    - a plan with $0 today (card saved, charged later);
    - an extra keyfob;
    - a party;
    - a donation;
    - a plan payment approved on Upcoming and charged by the nightly run, with its due date moved to today;
    - the declining card, through its retries;
    - a refund from Stripe.
  - After each one I check the database: the signup, household, plan and payments rows, the emails, and that Poolside shows the refund. No live calls beyond Doug's own taps.
- **AV2. Go live.**
  - Doug switches Poolside's Stripe account to live and sends me the live key and webhook secret. I set them as secrets; they never go in the repo.
  - Doug adds the live webhook to `https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/stripe_webhook` with the events above, for connected accounts. The second secret is added only if AV1 showed it's needed.
  - Bishop connects again in live mode with the club's bank and EIN. A new account's first payout takes about 7 to 14 days, then about 2 business days.
  - Supabase Pro first, if Doug decides on it.
- **AV3. Real $1 tests on Doug's card.**
  - A one-use code takes $599 off the Family level, so dues are $1 ($1.34 by card). Pay in full, then see it in Stripe, in Poolside as paid, and later in the bank. Refund it from Stripe and check Poolside shows it refunded.
  - A small plan: the minimum plan payment is lowered to $1, and a code brings the total to $3. Pay $1 today, then approve the next payment on Upcoming and let the nightly run charge it.
  - Doug locks his card in his bank app before one charge to see a real decline and the retry 3 days later, then unlocks it.
  - The cost is a few dollars in Stripe fees.
- **AV4. Clean up.** Delete the test codes, put the minimum back to $25, refund whatever Doug wants back, and delete the test families when Doug says. Then real families can pay.

While Poolside's test payments are off, anyone who signs up pays real money. That's fine before launch, but Doug should know.

### AL. A Raspberry Pi bridge at Bishop (Doug, 10/12) — parked, not started
Doug: "test this on a raspberry pi at some point… at my house, setup a pi, and simply plug and play into the cabana club to see what happens." The Windows PC keeps running the bridge until the Pi has proven itself. The bridge's Python already runs on Linux; what's missing is the install and a safe way to try it at home.
- **AL1. The Pi.** Raspberry Pi 4 or 5, booting from the USB SSD (SD cards die when a pump house loses power), Raspberry Pi OS Lite 64-bit, wired ethernet, a small UPS. Python 3.11 or newer is built in, which uhppoted needs (3.10+).
- **AL2. Code: `bridge/install_pi.sh`.** One script that creates a `poolside` user, a venv in `/opt/poolside-bridge` with `requests`, `python-dotenv` and `uhppoted`, downloads `gate_bridge.py` and `panel_check_readonly.py`, and installs a systemd service (`Restart=always`, after `network-online.target` and `time-sync.target`, so it waits for the network and the right time). Logs go to the system journal, not a file on the SSD (`gate_bridge.py` writes `bridge.log`, and nothing trims it).
- **AL3. Code: two small bridge changes.**
  - A `--check` mode. It sends one heartbeat (claims nothing), confirms uhppoted loads, looks for controllers read-only, prints what it found and exits. Safe at Doug's house with Bishop's real `.env`. Running the full bridge at home is not safe: it could take an unlock and then fail to reach a door it can't see from there.
  - The stale guard uses the cloud's `server_time` instead of the PC's own clock. A Pi has no clock battery, so for a moment after power comes back its time can be wrong.
- **AL4. At home.** Run `install_pi.sh`, copy the `.env` from `C:\PoolsideGateBridge`, run `--check`: "credentials accepted, uhppoted ready, no controllers (not at the pool)". Leave the service off.
- **AL5. At the club (plug and play).**
  - On the Windows PC (admin PowerShell): `Stop-Service PoolsideGateBridge`.
  - Plug the Pi into the pool network and power. It starts by itself.
  - From here I check that it's checking in (SQL, no extra calls). Then Doug taps all four doors and runs `panel_check_readonly.py` on the Pi.
  - To go back: unplug the Pi and run `Start-Service PoolsideGateBridge`.
  - Never leave both running. Two bridges with the same key both check in, which doubles the calls.
- Afterward: decide which one stays. If it's the Pi, set the Windows service to Manual.

### AM. More clubs with gates — parked until Bishop is right (Doug, 10/12)
What has to change before the gate and doors go to other clubs, in order. Nothing here is built.
- **AM1. Supabase Pro.**
  - Each bridge makes about 130,000 calls a month, and the free plan has 500,000 for everything, so it runs out at two or three clubs.
  - Pro includes 2 million, then about $2 a million.
  - Code: raise the held check-in from 20 s to about 55 s (`_shared/bridge_poll.ts` cap, `WAIT_SEC` in `gate_bridge.py`, `scripts/test_gate_poll.mjs`), about 45,000 calls a month per bridge. That stays well inside the Edge Function time limit.
- **AM2. Set up a club's doors on a screen, not in SQL.**
  - Code: the bridge reports what it finds on the club's network (uhppoted `get_all_controllers`, read-only: serial, address, firmware, door count) in a new `gate_bridge` action, stored on `gate_panels` (a `controllers` list).
  - Code: a door editor on `/admin/gate-integrations.html` that names each controller's doors and writes `gate_panels.doors` (checked by `doorsFor` in `_shared/gate_doors.ts`).
  - Code: each club's door rules, held on each door (e.g. `members: true`, `staff: true`, hours). Today the rule is fixed: board all doors, members the front gate. `unlock_gate` would then offer members their doors, and `gate_admin` would check the board's.
- **AM3. A box you ship, not a remote-in install.**
  - The Pi from AL, pre-loaded.
  - Code: pairing. A club's first boot has no `.env`. The provider admin shows a short code, the box sends it to a new `gate_bridge` `pair` action and gets its bridge ID and secret back, so nobody pastes secrets.
  - Code: self-update. Each check-in answers with the latest bridge version, its download address and its checksum (signed). The bridge downloads it, checks it, swaps itself in and restarts. If the new one can't check in within a few minutes, it goes back to the old one. Then an update never needs anyone at the club.
- **AM4. Other door systems.**
  - The bridge picks how to open a door by `panel_type`: `mengqi_hxc7000` (the web-page recipe) or UHPPOTE-type controllers (uhppoted, most cheap 2- and 4-door boards).
  - Each new kind is one more adapter in `gate_bridge.py`, built only when a paying club has it.
  - Cloud systems (Brivo, Openpath/Avigilon, Kisi) need no bridge: an Edge Function calls their service with the club's key.
  - The gate request form already asks what a club has.
- **AM5. Before about ten clubs: a live connection instead of check-ins.**
  - Today, while a check-in waits, `gate_bridge` asks the database twice a second for each bridge, which adds up across clubs.
  - Code: the bridge keeps a Supabase Realtime connection open (a private channel per club, with a short-lived token from a new `gate_bridge` action), and a new unlock reaches it instantly.
  - A slow check-in every few minutes stays, as the heartbeat and to catch anything missed. The bridge falls back to held check-ins if the connection drops.
  - Realtime counts connections, not calls (500 at once on Pro).
- **AM6. One screen for every bridge.** Provider admin: each club's bridge, its version, when it last checked in, and recent failed unlocks. The `gate_bridge_monitor` cron already raises an alarm when one goes quiet.

## Doug's own to-dos
- Set `SMS_GLOBAL_DAILY_CAP` back to 25 (Supabase → Edge Functions → Secrets).
- Get Supabase Pro ($25/mo) when real families start signing up (decided 10/14): daily backups, and 4x the room before a lockout. Until then everything in it is test data.
- Keep the bridge off until its polling is fixed and the test households are deleted.
- Reconnect Google Drive (Settings → Drive backup). It has been disconnected since June. First publish the Google app (console.cloud.google.com → Poolside project → Google Auth Platform → Audience → Publish app), or it will drop again after 7 days.
- Invite the other board members as admins (keyfob, parties, etc.). Only Doug and Pat are in the app today. Each one turns on pop-ups once from the dashboard; on iPhone, the admin page has to be added to the Home Screen first.
