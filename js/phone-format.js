/* =============================================================================
 * phone-format.js — auto-format US 10-digit phones as the user types
 * =============================================================================
 * Usage: load this script anywhere — it auto-attaches to every <input type="tel">
 * on the page (and any added later via DOM mutation). Format it produces:
 *
 *   ""              → ""
 *   "5"             → "(5"
 *   "555"           → "(555) "
 *   "5551234"       → "(555) 123-4"
 *   "5551234567"    → "(555) 123-4567"
 *   "+15551234567"  → "+1 (555) 123-4567"
 *
 * Doesn't touch values starting with "+" (other than +1 US numbers) since
 * those are international and we'd rather not guess at the format.
 *
 * Also exposes window.formatUSPhone(raw) for any code that wants to format
 * a string outside of an input event.
 * ============================================================================= */
(function () {
  'use strict';

  // Pure formatter — no side effects, easy to unit-test.
  function formatUSPhone(raw) {
    const s = String(raw || '');
    // Honor +X international numbers (other than +1 US) without re-formatting
    if (s.trim().startsWith('+') && !s.trim().startsWith('+1')) return s;
    const digits = s.replace(/[^\d]/g, '');
    let n = digits;
    let prefix = '';
    if (n.length === 11 && n[0] === '1') { prefix = '+1 '; n = n.slice(1); }
    if (n.length > 10) n = n.slice(0, 10);
    if (n.length === 0) return prefix.trim();
    if (n.length < 4)   return prefix + '(' + n;
    if (n.length < 7)   return prefix + '(' + n.slice(0, 3) + ') ' + n.slice(3);
    return prefix + '(' + n.slice(0, 3) + ') ' + n.slice(3, 6) + '-' + n.slice(6);
  }
  window.formatUSPhone = formatUSPhone;

  function attach(input) {
    if (!input || input._phoneFormatAttached) return;
    input._phoneFormatAttached = true;
    // Format current value once so server-stored E.164 (+15551234567) shows
    // pretty on first paint.
    if (input.value) input.value = formatUSPhone(input.value);
    input.addEventListener('input', () => {
      const before = input.value;
      const cursorAt = input.selectionStart;
      const formatted = formatUSPhone(before);
      if (formatted === before) return;
      input.value = formatted;
      // Best-effort cursor restore — count digits-before-cursor in the
      // original, then put the cursor after the same digit count in the
      // formatted version. Falls back to end-of-string.
      const digitsBefore = before.slice(0, cursorAt).replace(/[^\d]/g, '').length;
      let n = 0, pos = formatted.length;
      for (let i = 0; i < formatted.length; i++) {
        if (/\d/.test(formatted[i])) {
          n++;
          if (n > digitsBefore) { pos = i; break; }
        }
      }
      try { input.setSelectionRange(pos, pos); } catch (_) { /* some inputs reject */ }
    });
  }

  function attachAll() {
    document.querySelectorAll('input[type="tel"]').forEach(attach);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachAll);
  } else {
    attachAll();
  }

  // Catch dynamically-added inputs (e.g. wizard step changes, modals,
  // admins.html inviting new rows). Lightweight observer scoped to body.
  try {
    const obs = new MutationObserver(() => attachAll());
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
  } catch (_) { /* MutationObserver not supported — fall back to one-shot */ }
})();
