/* =============================================================================
 * photo-shrink.js — phone photos shrunk before they're uploaded (PLAN.md AQ4)
 * =============================================================================
 * A phone photo is 3–5 MB and takes about 40 MB of memory to show, so a
 * gallery of them fills the free plan's storage and can crash a phone.
 * Shrunk to 1600 px JPEG it's a few hundred KB and still sharp on any screen.
 * If the browser can't read the file (some HEIC), it goes as-is when it's a
 * type the server takes and isn't over 8 MB.
 *
 *   const p = await PoolsideShrink.photo(file);  // { content_type, base64, name }
 * ============================================================================= */
(function () {
  'use strict';
  var MAX_SIDE = 1600, MAX_RAW = 8 * 1024 * 1024;

  function readBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(new Error('Could not read the photo')); };
      r.readAsDataURL(file);
    });
  }

  async function photo(file, maxSide) {
    if (!file) throw new Error('Pick a photo first.');
    var max = maxSide || MAX_SIDE;
    var base = String(file.name || 'photo').replace(/\.[^.]+$/, '');
    try {
      var url = URL.createObjectURL(file);
      var img = await new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = url; });
      var scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';                         // see-through PNGs get a white background, not black
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      return { content_type: 'image/jpeg', base64: c.toDataURL('image/jpeg', 0.85).split(',')[1], name: base + '.jpg' };
    } catch (_) {
      if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) throw new Error('That photo couldn\'t be read. Try a screenshot of it instead.');
      if (file.size > MAX_RAW) throw new Error('That photo is too big (8 MB at most).');
      return { content_type: file.type, base64: await readBase64(file), name: file.name || base };
    }
  }

  window.PoolsideShrink = { photo: photo };
})();
