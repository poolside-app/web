// =============================================================================
// app_name.ts — the name under the app icon on a home screen (PLAN.md AC1)
// =============================================================================
// About 12 characters fit under an iPhone icon. The manifest used to cut the
// club's name at 12, mid-word ("Bishop Estat"). A club can set its own
// (Settings → app icon, `branding.app_name`); otherwise Poolside uses as many
// whole words of the club's name as fit. js/pwa.js `homeName` is the same
// rule for the page's iPhone title; scripts/test_signup_notes.mjs checks the
// two agree.
// =============================================================================

export const HOME_NAME_MAX = 12;

export function homeScreenName(displayName: string | null | undefined, appName?: string | null): string {
  const own = String(appName ?? '').trim();
  if (own) return own;
  const words = String(displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'Poolside';
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > HOME_NAME_MAX) break;
    out = next;
  }
  return out || words[0].slice(0, HOME_NAME_MAX);
}
