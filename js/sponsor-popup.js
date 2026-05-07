// =============================================================================
// sponsor-popup.js — rotating sponsor pop-up + click-through behavior
// =============================================================================
// Public + member home pages call window.SponsorPopup.maybeShow({sponsors,
// config}) once their data lands. The popup self-injects DOM, rotates round-
// robin through the sponsor list, and respects the tenant's frequency
// preference (every load / once per session / once per day / disabled).
//
// Click-through: tapping the popup (anywhere except the X) opens the
// sponsor's link_url in a new tab — gives the sponsor real value.
// =============================================================================

(function () {
  'use strict';

  const STORAGE_INDEX = 'poolside_sponsor_popup_idx';
  const STORAGE_LAST  = 'poolside_sponsor_popup_last';     // localStorage — once_per_day
  const SESSION_SEEN  = 'poolside_sponsor_popup_seen';     // sessionStorage — once_per_session

  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function escapeAttr(s) { return String(s ?? '').replace(/["']/g, c => ({'"':'&quot;',"'":'&#39;'}[c])); }
  // Defensive: a bare hostname like "google.com" without a protocol
  // resolves as a relative URL → 404. Auto-prefix https://. Backend
  // normalizes new saves; this catches rows saved before that landed.
  function safeUrl(u) {
    const s = String(u || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^\/\//.test(s))         return 'https:' + s;
    return 'https://' + s;
  }

  function shouldShow(freq) {
    if (freq === 'every_load') return true;
    if (freq === 'once_per_session') {
      if (sessionStorage.getItem(SESSION_SEEN)) return false;
      return true;
    }
    if (freq === 'once_per_day') {
      const last = parseInt(localStorage.getItem(STORAGE_LAST) || '0', 10);
      return (Date.now() - last) > 24 * 60 * 60 * 1000;
    }
    return false;  // unknown freq => don't show
  }

  function pickNext(sponsors) {
    const idx = parseInt(localStorage.getItem(STORAGE_INDEX) || '0', 10) % sponsors.length;
    const sponsor = sponsors[idx];
    localStorage.setItem(STORAGE_INDEX, String((idx + 1) % sponsors.length));
    return sponsor;
  }

  // Auto-popups must NOT land on top of a modal the user opened
  // intentionally. Returns true if any user-action scrim is currently
  // visible — checks both `.scrim.open` (the m/ modal pattern) and any
  // inline-style scrim with display:flex (the club/ landing pattern).
  function isUserModalOpen() {
    if (document.querySelector('.scrim.open')) return true;
    const inline = Array.from(document.querySelectorAll('[id$="-scrim"]'));
    for (const el of inline) {
      if (el.id === 'sponsor-scrim') continue;             // ourselves
      if (el.classList.contains('campaign-popup-host')) continue;  // sibling auto-popup
      if (getComputedStyle(el).display !== 'none') return true;
    }
    return false;
  }

  function injectStyles() {
    if (document.getElementById('sponsor-popup-styles')) return;
    const css = `
      #sponsor-scrim {
        position: fixed; inset: 0; background: rgba(15, 23, 42, .55);
        display: none; align-items: center; justify-content: center;
        z-index: 180; padding: 20px; backdrop-filter: blur(2px);
      }
      #sponsor-scrim.open { display: flex; }
      #sponsor-popup {
        background: #fff; border-radius: 18px; max-width: 420px; width: 100%;
        padding: 28px 24px 22px; text-align: center; position: relative;
        box-shadow: 0 30px 60px -10px rgba(15, 23, 42, .35);
        cursor: pointer;
      }
      #sponsor-popup .eyebrow {
        font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
        font-weight: 700; color: #64748b; margin-bottom: 14px;
      }
      #sponsor-popup img.logo {
        max-width: 220px; max-height: 120px; width: auto; height: auto;
        margin: 0 auto 14px; display: block; object-fit: contain;
      }
      #sponsor-popup h3 {
        font-family: 'Fraunces', Georgia, serif; font-weight: 600;
        font-size: 22px; color: #0a3b5c; margin: 0 0 8px; letter-spacing: -.01em;
      }
      #sponsor-popup p {
        margin: 0; color: #475569; font-size: 14px; line-height: 1.55;
      }
      #sponsor-popup .visit-cta {
        margin-top: 18px; padding: 10px 18px; background: var(--blue, #0a3b5c);
        color: #fff; border-radius: 10px; display: inline-block;
        font: 600 13px 'Inter', sans-serif;
      }
      #sponsor-popup .close-x {
        position: absolute; top: 10px; right: 12px; background: transparent;
        border: 0; cursor: pointer; font-size: 22px; color: #94a3b8; line-height: 1;
        padding: 4px 8px; border-radius: 6px;
      }
      #sponsor-popup .close-x:hover { background: #f1f5f9; color: #475569; }
    `;
    const style = document.createElement('style');
    style.id = 'sponsor-popup-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function close() {
    const s = document.getElementById('sponsor-scrim');
    if (s) s.classList.remove('open');
  }

  function show(sponsor) {
    injectStyles();
    let scrim = document.getElementById('sponsor-scrim');
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.id = 'sponsor-scrim';
      scrim.addEventListener('click', (e) => {
        if (e.target === scrim) close();
      });
      document.body.appendChild(scrim);
    }
    const linkUrl = sponsor.link_url ? escapeAttr(safeUrl(sponsor.link_url)) : '';
    scrim.innerHTML = `
      <div id="sponsor-popup" ${linkUrl ? `onclick="window.open('${linkUrl}','_blank','noopener')"` : ''}>
        <button type="button" class="close-x" aria-label="Close" onclick="event.stopPropagation();window.SponsorPopup.close()">×</button>
        <div class="eyebrow">Brought to you by</div>
        ${sponsor.logo_url
          ? `<img src="${escapeAttr(sponsor.logo_url)}" alt="${escapeAttr(sponsor.name)}" class="logo">`
          : ''}
        <h3>${escapeHtml(sponsor.name)}</h3>
        ${sponsor.description ? `<p>${escapeHtml(sponsor.description)}</p>` : ''}
        ${linkUrl ? `<div class="visit-cta">Visit →</div>` : ''}
      </div>`;
    scrim.classList.add('open');
    sessionStorage.setItem(SESSION_SEEN, '1');
    localStorage.setItem(STORAGE_LAST, String(Date.now()));
  }

  // Public API
  window.SponsorPopup = {
    close,
    maybeShow(opts) {
      const sponsors = (opts && opts.sponsors) || [];
      const config   = (opts && opts.config)   || {};
      if (!sponsors.length) return;
      if (!config.popup_enabled) return;
      const freq = config.popup_frequency || 'once_per_session';
      if (!shouldShow(freq)) return;
      // Don't fire if a user-opened modal is already up.
      if (isUserModalOpen()) return;
      const sponsor = pickNext(sponsors);
      // Defer one tick so the host page paint isn't blocked. Re-check at
      // fire time too — the user might have opened a modal in the
      // intervening 600ms (this was the root cause of the "add-member
      // modal disappears" bug — sponsor popup was landing on top).
      setTimeout(() => {
        if (isUserModalOpen()) return;
        show(sponsor);
      }, 600);
    },
  };
})();
