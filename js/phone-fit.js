/*
 * phone-fit.js — stop iPhone Safari zooming into form fields (PLAN.md N8)
 *
 * Safari on iPhone zooms in when someone taps a field whose text is under
 * 16px, and leaves the page zoomed: on Add sponsor it read as "the page is
 * offset" (Doug, 2026-10-07). Most fields here are 14px on purpose, tuned for
 * phones, so instead of enlarging them this tells iPhones not to auto-zoom.
 * iPhones still let people pinch to zoom; Android is left alone, since there
 * the same setting would block pinch zoom.
 */
(function () {
  if (!/iPad|iPhone|iPod/.test(navigator.userAgent)) return;
  var m = document.querySelector('meta[name="viewport"]');
  if (m && !/maximum-scale/.test(m.content)) m.content += ', maximum-scale=1';
})();
