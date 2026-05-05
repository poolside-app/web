# Poolside UX Review

**Reviewer:** Claude · **Date:** May 2026 · **Stage:** Pre-launch / pilot · **Posture:** Direct, opinionated, no hedging.
**Screens reviewed:** Member home · Admin dashboard · Admin Households · Admin Payments · Admin Settings · Provider (super-admin) Dashboard.
**Out of scope this pass (re-send when ready):** member calendar / photos / dues-pay / household-edit / party-booking / guest-pass · admin Applications / Announcements / Campaigns / Emails / Impact / Calendar / Policies / Photos / Status / Help / Wizard · super-admin Tenants list / Tenant detail / Billing / Analytics.

---

## TL;DR — fix three things per audience

### Members (3 things)
1. **Land them on what's overdue, not what's possible.** The unpaid-dues pill is the most important pixel on the member home and it's a footnote. Replace the 5-button hero with one CTA: *"Pay $450 by May 31"* (or, if all clear, a single contextual nudge — see redesign).
2. **Stop greeting people by their username.** "Hi, sjfa!" is a login handle. Greet with first name or skip the greeting.
3. **Pick desktop or don't.** Right now the member surface is a 600px column floating in a sea of whitespace on a 1440px screen. Either commit to a real desktop layout, or drop desktop down-tier and design for the iPhone you said is the actual device.

### Club admins (3 things)
1. **Collapse the top nav from 12 tabs to 5.** A 65-year-old volunteer cannot navigate a 12-tab menu of board-jargon labels. Proposed shape: **Home · People · Calendar · Money · Communications · Club info**. (Full IA moves below.)
2. **Make every form auto-save.** "Save changes" on a 6-input settings form is a forgetting tax — the treasurer will edit, navigate, and lose work. Auto-save on blur, show a "Saved · just now" pill. Same for inline edits.
3. **Replace the dashboard stat grid with the action queue.** Treasurer doesn't land here to admire the household count. She lands here because something needs doing. *"What needs your attention"* is the right idea, executed too quietly — promote it to the hero, demote stats to a sidebar.

### Super-admin / Provider (3 things)
1. **Show money and risk, not vanity counts.** ACTIVE TENANTS / TRIALS / HOUSEHOLDS / TOTAL TENANTS is a counter, not a control panel. Replace with **MRR · MRR Δ7d · Failed payments · At-risk clubs · Trials ending <7d**.
2. **Densify the tenants table 2×.** Halve row height, drop card chrome, make every column sortable, add filter chips and ⌘K global search. Add columns the operator actually triages on: **MRR · last admin login · last member login · failed payments · health**.
3. **Drop the friendliness padding.** "Welcome back!", "1 club ever", emoji-decorated headers — your own brief said no. Strip every line of explainer copy from the operator surface.

---

## Per-audience executive summary

### Members — 3/10. Right tone, wrong information architecture.
The serif headlines, the warm navy hero, the "Pool closed for chemicals" event copy — these are *good*. It feels like a pool club, not a SaaS. But the home screen is laid out around what the *system* can do (5 actions in a hero), not what the *member* needs to do (handle what's overdue, see what's coming). The most consequential fact on the page (DUES UNPAID) is rendered as a 12px pill, and there's no "Pay" button anywhere on the screen. A 45-year-old mom on her phone will NOT succeed at the most important member task.

### Club admins — 4/10. The voice is right. The IA is upside-down.
The hint copy ("shown on the home page", "if you have one") is exactly the warm, plain-English tone this audience needs — keep that writer. But the navigation is a maze: 12 top tabs, 10 sub-tabs under Members alone, with labels (Wizard, Impact, Status) that mean nothing to a board treasurer. The dashboard buries the action queue under vanity stats. The settings form requires manual saving. Forms have inconsistent jargon ("eyebrow", "tier", "default city"). The bones of a friendly admin product are here; the IA needs to be torn up and rebuilt on a 5-tab spine.

### Super-admin — 5/10. Right instinct, wrong execution.
Sidebar instead of top tabs, table-with-actions instead of card-with-padding, impersonation banner working — these are correct calls. But it's still designed like a club admin surface: chrome around tables, friendliness copy ("Welcome back — here's how the platform is doing"), zero risk signals, no MRR, no sort/filter. For an operator triaging 50 clubs this is a list of names, not a triage console. The fix is mostly subtractive — strip chrome, strip copy, strip padding — plus add the three signals (money, risk, recency) that aren't there at all.

---

## Per-screen punch lists

Severity: **CRITICAL** = blocks the primary task or actively misleads · **MAJOR** = significant friction or confusion · **MINOR** = polish.

### 1) Member home — `/`

| # | Sev | Issue | Fix |
|---|---|---|---|
| 1.1 | CRITICAL | DUES UNPAID is the most important fact on the page; rendered as a small amber pill in the corner of the household card. No "Pay" button anywhere on the home screen. | Promote unpaid status to a full-width banner with a single primary CTA: **"Pay dues — $450 due May 31"**. Keep the pill on inner pages. |
| 1.2 | CRITICAL | Hero greets with username ("Hi, sjfa!"). | Greet by first name from member profile. If unknown, no greeting — start with the actual content. |
| 1.3 | MAJOR | Hero stacks 5 buttons of equal weight (Request a party / Edit my info / Upload a photo / Subscribe to calendar / Public home →). On mobile this is a wall of buttons before content. | Reduce hero to 1 contextual primary action ("Pay dues" or "Get a guest pass for this weekend") + a single secondary "Quick actions" sheet. |
| 1.4 | MAJOR | Desktop layout is a 600px mobile column with huge dead margins. | Either build a proper desktop layout (sidebar + content), or accept mobile-only and drop the desktop view. |
| 1.5 | MAJOR | "Public home →" button inside a signed-in hero — why would I leave the app I just entered? | Remove from hero. If it's for board members previewing, put it in the footer or an admin-only badge. |
| 1.6 | MAJOR | "TIER: family" — `tier` is jargon, and `family` alone tells the member nothing they don't know. | Show "Family membership · $450/yr" as plain text, or remove. |
| 1.7 | MINOR | "ADDRESS" all-caps eyebrow on the household card is corporate-SaaS. | Sentence case. Or remove the eyebrow entirely — the address is self-evident. |
| 1.8 | MINOR | "Coming up" event list is good. Keep the date chip + icon + title pattern. | (No change.) |
| 1.9 | MINOR | Sign-out link rendered as inline text top-right ("sjfa  Sign out"). Touch target tiny. | Wrap username + Sign out in a 44px tappable avatar menu. |

### 2) Admin dashboard — `/admin`

| # | Sev | Issue | Fix |
|---|---|---|---|
| 2.1 | CRITICAL | 12 top tabs (Dashboard, Members, Calendar, Announcements, Campaigns, Emails, Policies, Photos, Impact, Status, Help, Settings, Wizard). Untenable for a 65-year-old volunteer. | Collapse to 5: **Home · People · Calendar · Money · Messages · Club info**. (Full IA map below.) |
| 2.2 | CRITICAL | Hero is a 8-tile vanity stat grid. None of the numbers are actionable. | Replace hero with the action queue ("What needs your attention"). Move stats to a right-rail or below-the-fold supporting section. |
| 2.3 | CRITICAL | "What needs your attention" is the right pattern but rendered as a quiet card below the stats. Single item, no click affordance beyond an arrow. | Promote to hero. Each item shows count + one-click bulk resolve ("9 open payments → Review", "2 applications waiting → Review"). |
| 2.4 | MAJOR | "FREE TRIAL" status pill but plan reads "Free" — these contradict. | Pick one source of truth. If it's a trial, say "Free trial · 24 days left". |
| 2.5 | MAJOR | "6 / 30 households · Free Forever — 24 left" progress meter at the top. Reads as a paywall but plan is "Free Forever". What is the admin meant to do with this information? | Either remove (if no paywall), or label clearly: "Plan limit: 30 households. 6 used." Don't render a progress bar with no upgrade affordance. |
| 2.6 | MAJOR | "Wizard" as a permanent top-level tab. | Rename "Setup checklist". Hide once setup is 100%. |
| 2.7 | MAJOR | "Impact" — label communicates nothing. | Rename to whatever it actually shows. If it's engagement metrics, "Engagement"; if donations, "Donations"; if it's the public-impact score, kill it — board treasurers don't track impact dashboards. |
| 2.8 | MAJOR | "Status" — ambiguous. System status? Club status? | If platform health, move to a tiny pill in the footer/header. If it's club-state (e.g. "Open for the season"), rename "Season" or "Pool status" and surface on the home. |
| 2.9 | MINOR | Page is a 600px column on a 1280px viewport. Admin needs the width. | Use full width with responsive max-width (e.g. 1200px). Stop centering admin content in a phone column. |
| 2.10 | MINOR | All-caps tile labels (STATUS / PLAN / HOUSEHOLDS) read corporate. | Sentence case throughout. |

### 3) Admin → Members → Households

| # | Sev | Issue | Fix |
|---|---|---|---|
| 3.1 | CRITICAL | The most common admin task on this list is *chase unpaid dues*. The only primary action available is "Add household". | Add a bulk action above the table: **"Send reminder to N unpaid"**. Add row-level "Send reminder" on hover. |
| 3.2 | CRITICAL | No sortable headers. Treasurer at month-end cannot sort by oldest unpaid, by tier, by primary contact. | Make every header sortable. Default sort: longest unpaid first. |
| 3.3 | CRITICAL | "Payments" buried as a sub-tab under Members. It is the treasurer's whole job. | Promote Payments / Money to a top-level tab. (See IA section.) |
| 3.4 | MAJOR | Tier column shows "FAMILY" pill on every row — same value everywhere = visual noise. | Either include the price ("Family · $450") so the column carries information, or hide the column when there's only one tier. |
| 3.5 | MAJOR | "FOB" column all-dashes. | Hide columns until they have data. An all-dash column trains the eye to skip the table. |
| 3.6 | MAJOR | Status pill inconsistency: "PAID 2025" vs "UNPAID" (no year). | Pick one shape. Treasurer-friendly: "Paid · May 1, 2026" / "Unpaid · 60 days late". |
| 3.7 | MAJOR | Primary column shows usernames, not full names ("frev1", "dohlghos", "sifa", "dfnfds"). Dummy data, but exposes that this column will sometimes show usernames in production. | Always render full name; usernames live on profile detail only. |
| 3.8 | MAJOR | No filter chips. Search bar exists but is text-only. | Add quick filters: **Unpaid only · New this year · Renewing soon · Has fob**. |
| 3.9 | MAJOR | Row click target ambiguous — only the family name appears clickable. | Make the entire row clickable, with hover highlight + caret affordance. |
| 3.10 | MINOR | "Powered by Poolside" footer on signed-in admin pages. They're already in Poolside. | Remove on admin/super-admin surfaces. Keep on public/member pages. |

### 4) Admin → Members → Payments

| # | Sev | Issue | Fix |
|---|---|---|---|
| 4.1 | CRITICAL | "Mark paid" has no undo. One misclick records a $450 phantom payment. | Show a 5-second undo toast on every Mark paid. Log to an audit trail. |
| 4.2 | CRITICAL | AMOUNT column all-dashes. The treasurer's #1 question is "how much is owed" and the system doesn't know. | Capture amount at row creation. If unknown, prompt inline; don't render "—". |
| 4.3 | CRITICAL | "KNOWN $ OWED $0.00" with 9 open items reads as "we're square" but means "we don't know amounts". Actively misleading. | Either show the real total once amounts are captured, or rephrase: "9 items open · amounts not captured for any". |
| 4.4 | CRITICAL | No way to record a check / cash payment that came in by mail. Small clubs get paper checks weekly. | Add primary action: **"Record a payment"** — choose member + method (check / cash / Venmo / Zelle / Stripe) + amount + memo. |
| 4.5 | MAJOR | "Payment options setup (Venmo, PayPal, Stripe)" disclosure triangle at top of the working list page. One-time config doesn't belong above an everyday list. | Move to Settings → Payments. If incomplete, show a one-time dismissable banner. |
| 4.6 | MAJOR | No bulk action. End-of-month, treasurer wants "select all 4 Venmo pending → Mark paid". | Checkboxes per row + bulk action bar (Mark paid · Send receipt · Export). |
| 4.7 | MAJOR | "WAITING 2d / 1d / —" conflates two things: (a) admin SLA on out-of-band Venmo confirms, (b) days since dues went unpaid. Same column, different meanings. | Split into two columns or use a single clear "Action needed since" with a tooltip explaining the source. |
| 4.8 | MAJOR | WHAT column conflates payment status ("Venmo payment pending") with what's owed ("Dues for 2026"). | WHAT = what is owed. STATUS column = where it is in the workflow. |
| 4.9 | MAJOR | All "Mark paid" buttons rendered as bright green. Visually shouts. | Demote to secondary style. Reserve the saturated green for the *post-paid* confirmation state. |
| 4.10 | MINOR | Filter chips good (All / Dues / Memberships / Programs / Passes). Add **"Pending my action"** chip — that's the actual triage view. | Add it. Make it the default landing filter. |

### 5) Admin → Settings

| # | Sev | Issue | Fix |
|---|---|---|---|
| 5.1 | CRITICAL | Tab labeled "Settings" — your brief flagged this audience hates that word. Confirmed: contents are *club info* + *public website copy*, not "settings". | Rename: split into **"Club info"** (name, location, swim team, defaults) and **"Website"** or **"Public page"** (front-page intro, headline, tagline). |
| 5.2 | CRITICAL | "Save changes" on a 6+ input form. A treasurer who edits the club name and navigates away will silently lose work. | Auto-save on blur. Show "Saved · just now" pill. Reserve explicit save for transactional flows (publishing a campaign). |
| 5.3 | MAJOR | "Eyebrow" as a field label is publishing jargon. The hint clarifies, but the *label itself* should be self-evident. | Label: "Small line above the headline". Drop the explainer parenthetical; field is self-describing. |
| 5.4 | MAJOR | "Default city / Default zip" — "Default" is jargon. | "City to fill in for new families" / "Zip to fill in for new families". |
| 5.5 | MAJOR | "Re-run wizard" button top-right + "Wizard" tab persisting. | Replace with "Reopen setup checklist". Show only when something is incomplete. |
| 5.6 | MINOR | Red dot next to "Club name" with no tooltip / label. Means? | Either label it ("Required" / "Unsaved" / "Validation error") or remove. Invisible UI. |
| 5.7 | MINOR | Hint copy ("(prefills new households)", "(if you have one)", "(leave blank to use club name)") is the right tone. | Keep this writer. Apply same voice everywhere. |

### 6) Super-admin → Provider Dashboard

| # | Sev | Issue | Fix |
|---|---|---|---|
| 6.1 | CRITICAL | Stat row is vanity counts (ACTIVE TENANTS / TRIALS / HOUSEHOLDS / TOTAL TENANTS). No money, no risk, no recency. | Replace with: **MRR · MRR Δ7d · Failed payments · At-risk clubs · Trials ending <7d · Active admins last 7d**. |
| 6.2 | CRITICAL | Tenants table not sortable, not filterable. Operator triaging 50 clubs cannot find the at-risk ones. | Sortable headers; filter chips: **Trials · Trials ending <7d · Failed payment · No admin login 30d · Stripe disconnected**. |
| 6.3 | CRITICAL | No risk signal anywhere. No way to spot "this club is about to churn" without opening each one. | Add a HEALTH column: green / amber / red with reason on hover. Computed from: failed payments, days since admin login, days since member login, trial state. |
| 6.4 | MAJOR | No global search. To find a club operator must scroll the table. | ⌘K global search across clubs, admin emails, subdomains. |
| 6.5 | MAJOR | Friendliness copy on the operator surface ("Welcome back — here's how the platform is doing", "1 household across the network", "1 club ever"). Your brief explicitly forbids this. | Remove. Operator surface goes terse. |
| 6.6 | MAJOR | Mocked-surface banner shipped on the dashboard ("Gate Integrations is the only mocked surface — everything else is live"). Acceptable in dev, ship-blocker in production. | Replace with a System status pill linking to the Status tab. Wall the banner behind a `?debug=1` flag. |
| 6.7 | MAJOR | Tenant row columns (CLUB / SUBDOMAIN / PLAN / STATUS / HOUSEHOLDS) miss the operator's actual triage signals. | Add: **MRR · last admin login · last member login · failed payments · health**. Drop subdomain to a hover/secondary line. |
| 6.8 | MAJOR | No keyboard shortcuts despite this being explicitly desired. | At minimum: `⌘K` search, `j/k` row nav, `i` impersonate, `e` edit, `?` shortcut sheet. |
| 6.9 | MINOR | Sidebar has both "Integrations" and "Gate integrations" — two top-level rows. | Collapse Gate under Integrations as a section. |
| 6.10 | MINOR | "My profile" + "Sign out" as nav rows. | Move to header avatar menu. Sidebar is for product surfaces, not account. |
| 6.11 | MINOR | Test cockpit visible in production sidebar. | Hide behind debug flag. |
| 6.12 | MINOR | Tenants card has chrome (rounded card, padding) wrapping a dense table. | Drop card chrome — let the table go edge-to-edge. Density wins over decoration on this surface. |
| 6.13 | MAJOR | Confirm an audit log of impersonation actions exists (who · when · which club · what they did). Not visible on this screen, but a platform-owner control panel without one is a compliance liability. | Add an Impersonation log on the Tenant detail and a global view in Audit. |

---

## Information Architecture — concrete moves

### Club admin: 12 tabs → 5

| Current | Target | Notes |
|---|---|---|
| Dashboard | **Home** | Rename. Becomes the action queue. |
| Members → Households | **People → Households** | Stays. |
| Members → Applications | **People → Applications** | Stays. |
| Members → Tiers | **Club info → Membership types** | Tiers is config, not a member view. Move under Club info; rename "Membership types". |
| Members → Renewals | **Money → Renewals** | It's a money/comms task. Move. |
| Members → Payments | **Money → Payments** | Promote. Treasurer's main surface. |
| Members → Programs | **Calendar → Programs** | Programs are events. |
| Members → Parties | **Calendar → Parties** | Parties are events. |
| Members → Volunteer | **Calendar → Volunteer signups** | (If "Volunteer hours per member", keep under People.) |
| Members → Passes | **Calendar → Guest passes** | Passes are time-bound bookings, not a member property. |
| Members → Documents | **Club info → Documents** | Club-wide, not member-scoped. |
| Calendar | **Calendar** | Stays as parent. |
| Announcements | **Messages → Announcements** | Consolidate. |
| Campaigns | **Messages → Campaigns** | Consolidate. |
| Emails | **Messages → Sent log** | This is the *sent record*, not a separate channel. Make it explicit. |
| Policies | **Club info → Policies** | Move. |
| Photos | **Photos** *(top-level)* OR **Calendar → Photos** | If it's a high-engagement member feature, keep top-level. |
| Impact | *Rename or remove* | Decide what it actually is. If engagement metrics, fold into Home. If donations, **Money → Donations**. |
| Status | *Remove from nav* | Make it a small pill in the header. |
| Help | *Avatar menu* | Help docs aren't a primary tab. |
| Settings | **Club info** *(rename)* + **Website** *(new)* | Split as in §5.1. |
| Wizard | *Conditional banner on Home* | Hide unless setup incomplete. |

**Result — 5 top tabs:**
**Home · People · Calendar · Money · Messages · Club info** (+ Photos if you want it top-level).

### Super-admin sidebar

Current: Dashboard / Tenants / Integrations / Gate integrations / Test cockpit / My profile / Billing / Analytics / Support / Sign out.

Target:
- **Dashboard** (default)
- **Tenants**
- **Money** (Billing + Analytics merged — operator's view of revenue, not a marketing analytics tab)
- **Integrations** (with Gate integrations as a sub-tab, not a peer)
- **Audit** *(NEW — impersonation log + admin actions)*
- **Support** (cases, tickets, recent contacts)
- *(account stuff in avatar menu)*
- *(Test cockpit hidden behind debug flag)*

---

## Label changes (current → suggested)

### Members surface
| Current | Suggested |
|---|---|
| "Hi, sjfa!" | "Hi, [first name]" — or no greeting |
| "TIER" | (drop label) — render as "Family membership · $450/yr" |
| "DUES UNPAID" pill in corner | "Dues — $450 due May 31" banner + "Pay now" button |
| "Public home →" | (Remove from signed-in hero) |
| "Subscribe to calendar" | "Add to my phone calendar" |
| "Edit my info" | "My household" |

### Club admin surface
| Current | Suggested |
|---|---|
| Settings | Club info / Website |
| Wizard | Setup checklist |
| Impact | (depends on contents — Engagement, Donations, or remove) |
| Status | (remove from nav; use a pill) |
| Tiers | Membership types |
| Default city | City to fill in for new families |
| Default zip | Zip to fill in for new families |
| Eyebrow | Small line above the headline |
| Configuration / Configure (anywhere) | Set up |
| Audience / Tier / Scope (anywhere) | Who this is for |
| "Save changes" | (remove — auto-save) |
| FREE TRIAL + Free | "Free trial · 24 days left" — single source of truth |
| "Free Forever — 24 left" | "Plan limit: 30 households. 6 used." or remove |
| "Mark paid" (green) | "Mark paid" (secondary) → green confirmation state |

### Super-admin surface
| Current | Suggested |
|---|---|
| "Welcome back — here's how the platform is doing." | (delete) |
| "1 club ever", "1 household across the network" | (delete sub-copy; let numbers speak) |
| "Tenants" | "Clubs" — internal too. "Tenants" is platform-jargon and you don't need it once you've seen which row is which. |
| "Provider Admin" badge | "Platform admin" |
| "Gate integrations" | (sub-section under Integrations) |
| "Test cockpit" | (hide behind `?debug=1`) |

---

## Forms — specific notes

### Apply form (not yet reviewed but inferable)
- Group into max 3 cards: **Your household · Your address · Anything else (optional)**.
- Phone format mask. Address autocomplete.
- Don't ask for tier on apply — admin assigns it on approval.
- One screen, scroll-not-step, unless 8+ fields. Multi-step is friction the volunteer doesn't need.

### Settings form (current)
- Auto-save on blur (§5.2).
- Group cards by *what the change affects*, not by data shape: **What members see · What new households see · How dues work · Who's in charge**.
- For website-content fields (eyebrow, headline, tagline), show a live preview to the right at desktop widths. The treasurer should *see* what they're editing.

---

## Visual hierarchy — universal notes

- **Pick one dominant element per screen.** Right now most admin screens have a hero, a stat grid, AND a card grid all competing. Reduce to one primary, one secondary.
- **Reserve color.** Green = paid confirmation only. Amber = needs attention. Red = error / impersonation. Don't tint pills/buttons green for actions that aren't yet done — it desensitizes the user to the success state.
- **Sentence case all eyebrows.** All-caps `MEMBERS · DUES · ADDRESS` reads corporate-SaaS, not warm-club. Sentence case ("Members", "Dues", "Address") is just as legible and friendlier.
- **Cap content widths sanely per surface:** member ≤ 480px on mobile, ≤ 960px on desktop with sidebar; admin lists full-bleed up to 1200px; super-admin full-bleed up to viewport.

---

## What's missing entirely

### Member surface
- A clear "I forgot my magic link, send another" flow. (Sign-in friction was your stated #1 enemy.)
- Guest pass — appears in your task list but no surface for it.
- A "Help me, something's wrong" path that doesn't require knowing the admin's email.
- Push / SMS preferences. Members will absolutely sign up to get notified about pool closures.

### Admin surface
- Audit log per household ("who changed what when").
- Bulk import (CSV) for migrating from the spreadsheet they're currently using.
- A "season ended" mode that gracefully archives the year's data.
- Export-to-CSV is on Households (good); needs to exist on Payments and every list.

### Super-admin surface
- **Impersonation audit log** (mentioned above; cannot ship without this).
- **MRR breakdown by plan + cohort retention chart.** Tiny, sparkline-shaped, on the dashboard.
- **Health column / health page per club**, computed from: failed payments × days-since-admin-login × days-since-member-login × trial-end-proximity.
- **A "send a note to all club admins" broadcast tool.** When the platform has an outage or a feature ships, you'll want it.

---

## Two redesign mocks (priority screens)

I picked the two screens with the highest leverage:

1. **Admin dashboard** — sets the tone for the whole admin surface; if this gets right, the rest follows.
2. **Super-admin dashboard** — currently furthest from where it needs to be; densifying it unblocks a clear pattern for the rest of the operator UI.

See `redesign-admin-dashboard.html` and `redesign-super-admin.html` for working mocks. Both use Poolside's existing palette (navy `#0a3b5c`, cream `#f4ead7`, amber `#f0a020`, paid-green `#0e8a3e`) and serif headlines (Newsreader). Open `index.html` for the navigable review.

---

## Role-based admins (added pass)

The Board chair can invite other admins and assign them roles so a treasurer-only volunteer doesn't see Messages, a comms-only volunteer doesn't see Money, and so on. This is essential — small clubs have 3-5 board volunteers each doing one job, and showing all of them all of admin defeats the IA work.

### Role model — keep it short and named for jobs

Five fixed roles + Custom. Multi-role allowed. Only Board chair can manage admins.

| Role | Sees | Notes |
|---|---|---|
| **Board chair** | Everything + manages admins | At least one required at all times. Warn on bus-factor-1. |
| **Treasurer** | Home, Money, People (read-only) | Can mark paid, refund, send reminders. Can't change comms or settings. |
| **Membership chair** | Home, People | Approves applications, edits households. Sees no money amounts. |
| **Communications** | Home, Messages, Photos | Posts announcements, sends campaigns, approves photos. |
| **Volunteer coordinator** | Home, Calendar | Schedules events, manages signups. |
| **Custom** | Pick exactly | Edge cases only. Phrase plainly: "Can see money. Can't change anything." |

### How roles change other parts of the spec

1. **Action-queue items must carry a role tag.** Every card in "What needs your attention" gets a `role: 'money' \| 'people' \| 'comms' \| 'calendar' \| 'club'` tag. Home filters by `currentAdmin.roles[]`. Multi-role admins see the union. Board chair sees everything, optionally grouped by role ("Treasurer should handle: 4 · Comms should handle: 3").
2. **Nav is filtered, not greyed out.** Don't render disabled tabs. A comms volunteer's nav is literally `Home · Messages · Photos`. No half-disabled Money tab. No "you don't have permission" walls.
3. **5-tab spine still holds.** Roles map cleanly to subsets of the 5 tabs — Treasurer = Home + Money, Membership = Home + People, etc. Don't invent row-level permissions; gate at section level.
4. **CRITICAL — missing screen: Admins & roles.** Lives at **Club info → Admins & roles**. See `redesign-admins-roles.html` for mock. Required elements:
   - Admin list with role chips, last-login, pending invites inline.
   - Magic-link invite (no password). Invite by email + first name + role picker.
   - Role picker uses plain-English role names, not permissions checkboxes. "Custom" exposes the matrix only when explicitly chosen.
   - Remove admin uses the same 30-second undo toast pattern as Mark paid.
   - Bus-factor-1 warning when there's only one Board chair.
   - Audit row per admin: "Added by [chair] · [date] · last signed in [time]".

### Super-admin additions for multi-admin clubs

The "last admin login" health signal currently used (§6.3) breaks with multi-admin clubs — could be 2 days for the treasurer but 90 days for the comms volunteer. Replace with:

- **Active admins last 30d** column (e.g. "3 of 5") — shows whether admin team is actually engaged or one person is carrying the club.
- **Single-admin flag** on tenants table — bus-factor-1 clubs are a churn risk independent of money. They churn the day that one volunteer quits the board.
- **Average admin DAU/MAU** as a network metric on the provider dashboard.

### Mocks delivered

- `redesign-admins-roles.html` — the Admins & roles screen.
- `redesign-role-aware-home.html` — same Home, two roles side-by-side (Treasurer vs Comms), proving the filter pattern.

---

## Notes specifically for Claude Code

- **Audit-log model first.** Every "Mark paid", every impersonation, every settings auto-save needs to write to an audit table. Without this you can't ship undo (§4.1) or impersonation safely (§6.13).
- **Optimistic UI + undo toast** as a shared pattern across the admin surface. Implement once, apply to: Mark paid, Approve application, Send reminder, Archive household, Delete photo.
- **Replace top-tab nav with a route-driven sidebar collapsing to a hamburger on mobile.** Once you accept the IA collapse from 12→5, the tab pattern stops scaling anyway (5 tabs fit; 5 tabs with sub-tabs need a sidebar).
- **Treat the super-admin surface as a separate app.** It shares auth and a few primitives with admin, but the UX rules are inverted (density > whitespace, terseness > explainers). Don't share layout components 1:1 — share tokens.
- **Auto-save infra:** debounce 600ms on blur, optimistic state, "Saved · just now" pill that fades after 2s. Same component everywhere.
- **Keyboard shortcuts** on super-admin only, behind a `useShortcuts(scope: 'platform-admin')` hook. Don't scatter; centralize the registry so `?` can render the cheat sheet.
- **Role model is data, not code.** Don't hardcode `if (role === 'treasurer')` checks in components. Define a `permissions: { sees: ['home','money'], can: ['mark-paid','refund'] }` object per role and let components ask `useCan('mark-paid')`. Custom roles fall out for free. Adding a sixth role is a config change, not a code change.
- **Action-queue items declare their role tag at source.** Each generator (unpaid-dues, venmo-pending, photo-pending, etc.) tags its output with one of the 5 role tags. Home is a single component reading `useActionQueue().filter(item => currentAdmin.roles.some(r => permissions[r].sees.includes(item.role)))`. One filter, one place.
- **Invite flow uses the same magic-link primitive as members.** No second auth path. Admin = a member with `roles[]` populated. Removing all roles demotes them back to a regular member without losing their household record.
