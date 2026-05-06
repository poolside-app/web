#!/usr/bin/env python3
"""Rewrite <nav class="tabs">…</nav> across all club/admin/*.html files
with the canonical 7-item top nav, marking the right tab `class="on"`
based on which page is being rendered.

Also injects a Content / Insights sub-tab container immediately AFTER
</nav> for pages that fall under those wrapper sections (so users land
on a Content sub-tab page and see the strip; the wrapper "Content" top
tab is just a link to the first Content sub-tab page).

Idempotent — running twice produces no diff.
"""

import re
from pathlib import Path

ADMIN = Path(__file__).resolve().parents[1] / "club" / "admin"

# Canonical 7-tab top nav. Order is meaningful — daily-ops first, setup,
# then content, insights, settings.
CANONICAL_TABS = [
    ("dashboard",   "/club/admin/",                   "Dashboard"),
    ("members",     "/club/admin/members.html",       "Members"),
    ("application", "/club/admin/application.html",   "Application"),
    ("calendar",    "/club/admin/events.html",        "Calendar"),
    ("content",     "/club/admin/announcements.html", "Content"),
    ("insights",    "/club/admin/impact.html",        "Insights"),
    ("settings",    "/club/admin/settings.html",      "Settings"),
]

# Each filename maps to which top-tab gets `class="on"`. Pages not listed
# here keep no tab marked active.
PAGE_TO_TAB = {
    "index.html":         "dashboard",
    "members.html":       "members",
    "applications.html":  "members",   # legacy redirect
    "households.html":    "members",   # legacy redirect
    "payments.html":      "members",
    "programs.html":      "members",
    "parties.html":       "members",
    "volunteer.html":     "members",
    "guest-passes.html":  "members",
    "documents.html":     "members",
    "emails.html":        "members",   # member-lifecycle emails live under Members
    "application.html":   "application",
    "policies.html":      "application",  # deep page, embedded in Application editor
    "events.html":        "calendar",
    "announcements.html": "content",
    "campaigns.html":     "content",
    "sponsors.html":      "content",
    "feedback.html":      "content",
    "photos.html":        "content",
    "impact.html":        "insights",
    "health.html":        "insights",
    "audit.html":         "insights",
    "settings.html":      "settings",
    "billing.html":       "settings",
    "admins.html":        "settings",
    "help.html":          None,  # accessed via floating fab; no top tab
}

# Pages that should render the Content sub-tab strip beneath the top nav.
CONTENT_PAGES = {"announcements.html", "campaigns.html", "sponsors.html",
                 "feedback.html", "photos.html"}
# Pages that render the Insights sub-tab strip.
INSIGHTS_PAGES = {"impact.html", "health.html", "audit.html"}

# Regex to match the existing nav block (greedy-safe: matches the first
# </nav> after <nav class="tabs">).
NAV_RE = re.compile(r'<nav class="tabs">.*?</nav>', re.DOTALL)


def render_nav(active_key: str | None) -> str:
    parts = ['<nav class="tabs">']
    for key, href, label in CANONICAL_TABS:
        cls = ' class="on"' if key == active_key else ""
        parts.append(f'  <a href="{href}"{cls}>{label}</a>')
    parts.append("</nav>")
    return "\n".join(parts)


def render_subtab_block(filename: str) -> str:
    """Return the sub-tab container + script tag if this page belongs to a
    wrapper section, else empty string."""
    if filename in CONTENT_PAGES:
        return '\n<div id="content-subtabs"></div>\n<script src="/js/content-subtabs.js"></script>'
    if filename in INSIGHTS_PAGES:
        return '\n<div id="insights-subtabs"></div>\n<script src="/js/insights-subtabs.js"></script>'
    return ""


def rewrite_file(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    name = path.name
    if name == "login.html":
        return False
    if not NAV_RE.search(text):
        return False
    active = PAGE_TO_TAB.get(name)
    new_nav = render_nav(active) + render_subtab_block(name)
    new_text = NAV_RE.sub(lambda _m: new_nav, text, count=1)
    # Strip any pre-existing duplicate sub-tab container immediately
    # following — keeps the file idempotent on subsequent runs.
    if name in CONTENT_PAGES:
        new_text = re.sub(
            r'(<script src="/js/content-subtabs\.js"></script>)\s*<div id="content-subtabs"></div>\s*<script src="/js/content-subtabs\.js"></script>',
            r'\1', new_text, flags=re.DOTALL)
    if name in INSIGHTS_PAGES:
        new_text = re.sub(
            r'(<script src="/js/insights-subtabs\.js"></script>)\s*<div id="insights-subtabs"></div>\s*<script src="/js/insights-subtabs\.js"></script>',
            r'\1', new_text, flags=re.DOTALL)
    if new_text == text:
        return False
    path.write_text(new_text, encoding="utf-8")
    return True


def main() -> None:
    count = 0
    for p in sorted(ADMIN.glob("*.html")):
        if rewrite_file(p):
            print(f"  rewrote {p.name}")
            count += 1
    print(f"{count} files rewritten")


if __name__ == "__main__":
    main()
