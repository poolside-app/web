#!/usr/bin/env python3
"""Rewrite the top nav + sub-tab strip across every club/admin/*.html file.

Idempotent — running twice produces no diff. Pass --dry-run to see what
would change without writing.

2026-09-07 reorganisation
-------------------------
Previously this script had drifted badly out of sync with the live pages:
its canonical list still had an "Application" top tab and no "Lifeguards",
so RUNNING IT WOULD HAVE SILENTLY REVERTED the nav. It also mapped
documents.html, which does not exist. Anyone who ran it to fix one page
would have broken every other page's nav. Keeping this file honest matters
more than the nav change itself.

What changed in the nav:
  * New "Money" tab. Financial surfaces were spread over four top tabs —
    dues under Members, campaigns/donations/sponsors under Content, program
    fees under Calendar, and billing under nothing at all. A treasurer had
    to learn three tabs plus a URL nobody had written down.
  * Lifeguards demoted from a top-level tab into Calendar, next to
    Volunteer. They are the same job (staffing the pool); Lifeguards had
    the same visual weight as Settings while Volunteer was two levels down.
  * Content stops being a junk drawer: it keeps publishing + listening
    surfaces only.
  * Sub-tab strips are now ONE file (/js/admin-subtabs.js) that picks the
    right strip from the path, so this script injects an identical block on
    every page instead of tracking per-section page sets.
"""

import argparse
import re
from pathlib import Path

ADMIN = Path(__file__).resolve().parents[1] / "club" / "admin"

# Canonical top nav. Order is meaningful: daily ops first, then money,
# then scheduling, then publishing, then reporting, then configuration.
CANONICAL_TABS = [
    ("dashboard", "/club/admin/",                   "Dashboard"),
    ("members",   "/club/admin/members.html",       "Members"),
    ("money",     "/club/admin/payments.html",      "Money"),
    ("calendar",  "/club/admin/events.html",        "Calendar"),
    ("content",   "/club/admin/announcements.html", "Content"),
    ("insights",  "/club/admin/impact.html",        "Insights"),
    ("settings",  "/club/admin/settings.html",      "Settings"),
]

# filename -> which top tab is marked active. Must stay in step with
# PAGE_SECTION in /js/admin-subtabs.js; test_nav_consistency() checks it.
PAGE_TO_TAB = {
    "index.html":          "dashboard",
    # Members — people and the paperwork that makes them members
    "members.html":        "members",
    "policies.html":       "members",
    "application.html":    "members",
    "import.html":         "members",
    "migrate.html":        "members",
    "emails.html":         "members",
    # Money
    "payments.html":       "money",
    "tiers.html":          "money",
    "campaigns.html":      "money",
    "donations.html":      "money",
    "sponsors.html":       "money",
    # Calendar — things that happen at the pool on a date
    "events.html":         "calendar",
    "programs.html":       "calendar",
    "parties.html":        "calendar",
    "volunteer.html":      "calendar",
    "lifeguards.html":     "calendar",
    "my-shifts.html":      "calendar",
    # Content — publishing and listening
    "announcements.html":  "content",
    "photos.html":         "content",
    "board-meetings.html": "content",
    "feedback.html":       "content",
    # Insights
    "impact.html":         "insights",
    "audit.html":          "insights",
    "health.html":         "insights",
    # Settings — configuration and the club's account with Poolside
    "settings.html":       "settings",
    "admins.html":         "settings",
    "billing.html":        "settings",
    # Deliberately no active tab: reached from the dashboard, a FAB, or an
    # emailed link rather than from the nav.
    "checkin.html":        None,
    "help.html":           None,
    "setup.html":          None,
    "change-password.html": None,
    "activate.html":       None,
}

SKIP = {"login.html"}

NAV_RE = re.compile(r'<nav class="tabs">.*?</nav>', re.DOTALL)

# Any previously-injected strip: the old per-section containers and their
# script tags, in either order, plus the new unified one. Matched so the
# rewrite stays idempotent and never stacks two strips on a page.
OLD_STRIP_RE = re.compile(
    r'\s*(?:<div id="(?:members|calendar|content|insights|money|settings|admin)-subtabs"></div>'
    r'|<script src="/js/(?:members|calendar|content|insights|money|settings|admin)-subtabs\.js"></script>)',
)

SUBTAB_BLOCK = ('\n<div id="admin-subtabs"></div>'
                '\n<script src="/js/admin-subtabs.js"></script>')


def render_nav(active_key):
    parts = ['<nav class="tabs">']
    for key, href, label in CANONICAL_TABS:
        cls = ' class="on"' if key == active_key else ""
        parts.append(f'  <a href="{href}"{cls}>{label}</a>')
    parts.append("</nav>")
    return "\n".join(parts)


def rewrite_file(path: Path, dry_run: bool = False):
    name = path.name
    if name in SKIP:
        return None
    text = path.read_text(encoding="utf-8")
    if not NAV_RE.search(text):
        return None
    if name not in PAGE_TO_TAB:
        return ("unmapped", name)

    # Strip every previously-injected strip first, wherever it sits, so the
    # only one left is the one we add back.
    body = OLD_STRIP_RE.sub("", text)
    block = SUBTAB_BLOCK if name in PAGE_TO_TAB and PAGE_TO_TAB[name] else ""
    # Pages with no active tab still get no strip.
    new_nav = render_nav(PAGE_TO_TAB[name]) + (block if PAGE_TO_TAB[name] else "")
    new_text = NAV_RE.sub(lambda _m: new_nav, body, count=1)

    if new_text == text:
        return None
    if not dry_run:
        path.write_text(new_text, encoding="utf-8")
    return ("rewrote", name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change without writing")
    args = ap.parse_args()

    rewrote, unmapped = [], []
    for p in sorted(ADMIN.glob("*.html")):
        r = rewrite_file(p, dry_run=args.dry_run)
        if not r:
            continue
        (unmapped if r[0] == "unmapped" else rewrote).append(r[1])

    verb = "would rewrite" if args.dry_run else "rewrote"
    for n in rewrote:
        print(f"  {verb} {n}")
    if unmapped:
        print("\n  NOT IN PAGE_TO_TAB (nav left untouched — add them or delete the page):")
        for n in unmapped:
            print(f"    {n}")
    print(f"\n{len(rewrote)} files {verb}")


if __name__ == "__main__":
    main()
