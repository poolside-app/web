/* =============================================================================
 * pool-weather.js — the weather at the pool, for the member and board banners
 * =============================================================================
 * Open-Meteo: free, no key (PLAN.md V, W). Kept for 30 minutes so opening the
 * app often doesn't ask again. The banner just leaves it out if it can't be
 * had.
 *   PoolWeather.load({ lat, lng }, element)
 * ============================================================================= */
(function () {
  'use strict';
  var WX = { 0: ['☀️', 'Clear'], 1: ['🌤️', 'Mostly sunny'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Cloudy'], 45: ['🌫️', 'Fog'], 48: ['🌫️', 'Fog'],
    51: ['🌦️', 'Drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌦️', 'Drizzle'], 61: ['🌧️', 'Rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
    71: ['🌨️', 'Snow'], 73: ['🌨️', 'Snow'], 75: ['🌨️', 'Snow'], 80: ['🌦️', 'Showers'], 81: ['🌦️', 'Showers'], 82: ['🌧️', 'Heavy showers'],
    95: ['⛈️', 'Thunderstorms'], 96: ['⛈️', 'Thunderstorms'], 99: ['⛈️', 'Thunderstorms'] };
  async function load(loc, el) {
    if (!el || !loc) return;
    var KEY = 'poolside_wx';
    var wx = null;
    try { var c = JSON.parse(localStorage.getItem(KEY) || 'null'); if (c && Date.now() - c.at < 30 * 60000 && c.lat === loc.lat) wx = c; } catch (_) {}
    if (!wx) {
      try {
        var r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat + '&longitude=' + loc.lng + '&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto').then(function (x) { return x.json(); });
        if (!r || !r.current) return;
        wx = { at: Date.now(), lat: loc.lat, t: Math.round(r.current.temperature_2m), code: r.current.weather_code };
        try { localStorage.setItem(KEY, JSON.stringify(wx)); } catch (_) {}
      } catch (_) { return; }
    }
    var w = WX[wx.code] || ['🌡️', ''];
    el.textContent = w[0] + ' ' + wx.t + '°' + (w[1] ? ' ' + w[1] : '') + ' at the pool';
  }
  window.PoolWeather = { load: load };
})();
