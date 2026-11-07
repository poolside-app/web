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

  // Date and time boxes (PLAN.md CG, Doug 11/7): Safari on iPhone draws them
  // at their own width ("Nov 7, 2026" and its picker) and ignores the width
  // they're given, so in two columns the meeting pop-up's Date ran past its
  // edge and Starts at slid under Location. Turning off Safari's own drawing
  // lets the width win (the signup page's recipe, now everywhere); 44px keeps
  // an empty one from collapsing and the date sits on the left like text.
  var st = document.createElement('style');
  st.textContent =
    'input[type="date"],input[type="time"],input[type="datetime-local"],input[type="month"]' +
      '{-webkit-appearance:none;appearance:none;min-width:0;max-width:100%;min-height:44px}' +
    'input::-webkit-date-and-time-value{text-align:left}';
  (document.head || document.documentElement).appendChild(st);
})();
