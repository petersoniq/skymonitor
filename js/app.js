/* SkyMonitor – live aircraft positions
 * Sources (all free, no API key):
 *   1. adsb.lol      https://api.adsb.lol
 *   2. adsb.fi       https://opendata.adsb.fi
 *   3. airplanes.live https://api.airplanes.live
 *   4. OpenSky        https://opensky-network.org
 * Map: Leaflet + OpenStreetMap
 */
(function () {
  'use strict';

  var VERSION = '1.3.2';
  var REFRESH_MS = 15000;
  var FETCH_TIMEOUT = 12000;
  var ICON_COLORS = ['#1e73c8', '#e08a1e', '#d43f3f'];
  var FT = 3.28084;
  var DIST_NM = 250;

  var map = L.map('map', { zoomControl: true }).setView([48.7, 19.5], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Data: adsb.lol / adsb.fi / airplanes.live / OpenSky'
  }).addTo(map);

  var markers = {};
  var planes = {};          // icao24 -> data (aj s trailom)
  var selected = null;      // icao24 vybraného lietadla
  var follow = null;        // icao24 sledovaného lietadla
  var trailLayer = null;
  var hideGround = false;
  var inFlight = false;
  var pending = false;
  var timer = null;
  var lastFetch = 0;
  var lastSource = '';

  var dbgEl = null;
  function dbg(msg) {
    try {
      if (!dbgEl) dbgEl = document.getElementById('debug');
      if (!dbgEl) return;
      var ts = new Date().toLocaleTimeString('sk') + '.' + String(new Date().getMilliseconds()).padStart(3, '0');
      dbgEl.textContent = ts + '  ' + msg + '\n' + dbgEl.textContent;
    } catch (e) {}
  }

  function status(msg) {
    document.getElementById('status').innerHTML = msg + ' <small>v' + VERSION + '</small>';
  }

  function fetchTimeout(url, ms) {
    ms = ms || 8000;
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms) : null;
    dbg('fetch: ' + url + (ctl ? '' : ' (bez AbortController)'));
    var opts = ctl ? { signal: ctl.signal, cache: 'no-store' } : { cache: 'no-store' };
    var req = fetch(url, opts).finally(function () { if (timer) clearTimeout(timer); });
    // hard race: aj keď fetch visí (napr. kvôli SW/zdroju), po ms sa pokračuje ďalej
    return Promise.race([
      req,
      new Promise(function (_, reject) {
        setTimeout(function () { dbg('timeout ' + ms + ' ms – prerušujem'); reject(new Error('timeout')); }, ms);
      })
    ]);
  }

  function colorFor(altFt) {
    if (altFt == null) return ICON_COLORS[0];
    if (altFt < 6000) return ICON_COLORS[2];
    if (altFt < 26000) return ICON_COLORS[1];
    return ICON_COLORS[0];
  }

  function planeIcon(heading, altFt, isSel) {
    var c = colorFor(altFt);
    var ring = isSel ? '<circle cx="12" cy="12" r="10.5" fill="none" stroke="#d43f3f" stroke-width="1.2"/>' : '';
    var svg =
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
      ring +
      '<g transform="rotate(' + (heading || 0) + ' 12 12)">' +
      '<path fill="' + c + '" stroke="#fff" stroke-width="0.7" d="M12 2 L13.2 9.5 L21 12 L13.2 14.2 L13.6 17.5 L15.5 19.5 L12 18.8 L8.5 19.5 L10.4 17.5 L10.8 14.2 L3 12 L10.8 9.5 Z"/>' +
      '</g></svg>';
    return L.divIcon({ className: 'plane-icon', html: svg, iconSize: [26, 26], iconAnchor: [13, 13] });
  }

  function fmt(v, u) { return (v == null ? '–' : (typeof v === 'number' ? Math.round(v) : v) + (u ? ' ' + u : '')); }

  function popupHtml(a) {
    var cs = (a.callsign || '').trim() || a.icao24;
    var lines = ['<b>' + cs.toUpperCase() + '</b> <small>(' + a.icao24 + ')</small>'];
    if (a.reg) lines.push('Registrácia: ' + a.reg);
    if (a.type) lines.push('Typ: ' + a.type);
    if (a.country) lines.push('Krajina: ' + a.country);
    lines.push('Rýchlosť: ' + fmt(a.speedKmh, 'km/h') + ' (' + fmt(a.speedKt, 'kt') + ')');
    lines.push('Výška: ' + fmt(a.altFt, 'ft') + ' (' + fmt(a.altFt != null ? a.altFt / FT : null, 'm') + ')');
    lines.push('Vertikálna rýchlosť: ' + fmt(a.vrateFpm, 'ft/min'));
    lines.push('Kurz: ' + fmt(a.track, '°'));
    lines.push('Squawk: ' + (a.squawk || '–'));
    lines.push('Na zemi: ' + (a.onGround ? 'áno' : 'nie'));
    if (a.emergency && a.emergency !== 'none') lines.push('<b style="color:#d43f3f">STAV: ' + a.emergency + '</b>');
    lines.push('<small>Zdroj: ' + a.src + ' • dráha: ' + ((a.trail || []).length) + ' bodov</small>');
    lines.push('<button onclick="window.__skyFollow(&#39;' + a.icao24 + '&#39;)" style="margin-top:6px;padding:5px 10px;border:none;border-radius:6px;background:#0b3d5c;color:#fff;cursor:pointer">' +
      (follow === a.icao24 ? 'Prestaň sledovať' : 'Sleduj tento let') + '</button>');
    return '<div class="plane-popup">' + lines.join('<br>') + '</div>';
  }

  function normAdsb(a, src) {
    return {
      icao24: a.hex, callsign: a.flight, reg: a.r || null, type: a.t || null, country: null,
      lat: a.lat, lon: a.lon,
      altFt: (a.alt_baro === 'ground') ? 0 : a.alt_baro,
      onGround: (a.alt_baro === 'ground'),
      speedKt: a.gs, speedKmh: (a.gs != null ? a.gs * 1.852 : null),
      track: a.track, vrateFpm: a.baro_rate, squawk: a.squawk,
      emergency: a.emergency, src: src
    };
  }

  function normOpenSky(s) {
    return {
      icao24: s[0], callsign: s[1], reg: null, type: null, country: s[2],
      lat: s[6], lon: s[5],
      altFt: (s[7] != null ? s[7] * FT : null),
      onGround: !!s[8],
      speedKt: (s[9] != null ? s[9] * 1.94384 : null),
      speedKmh: (s[9] != null ? s[9] * 3.6 : null),
      track: s[10], vrateFpm: (s[11] != null ? s[11] * FT * 60 : null),
      squawk: s[14], emergency: null, src: 'OpenSky'
    };
  }

  // ---------- zdroje ----------
  function srcRadius(base, name) {
    var c = map.getCenter();
    var url = base + '/lat/' + c.lat.toFixed(4) + '/lon/' + c.lon.toFixed(4) + '/dist/' + DIST_NM;
    return fetchTimeout(url).then(function (r) {
      dbg('odpoveď ' + name + ' HTTP ' + r.status + ', ' + (r.headers.get('content-length') || '?') + ' B');
      if (!r.ok) throw new Error(name + ' HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      if (d && d.error) throw new Error(name + ' error: ' + String(d.error).slice(0, 80));
      var list = d.ac || d.aircraft || [];
      return list.map(function (a) { return normAdsb(a, name); });
    });
  }

  function fetchAdsbLol() { return srcRadius('https://api.adsb.lol/v2', 'adsb.lol'); }
  function fetchAdsbFi() { return srcRadius('https://opendata.adsb.fi/api/v2', 'adsb.fi'); }
  function fetchAirplanesLive() { return srcRadius('https://api.airplanes.live/v2', 'airplanes.live'); }

  function fetchOpenSky() {
    var b = map.getBounds().pad(0.5);
    var url = 'https://opensky-network.org/api/states/all?lamin=' + b.getSouth().toFixed(4) +
              '&lomin=' + b.getWest().toFixed(4) + '&lamax=' + b.getNorth().toFixed(4) +
              '&lomax=' + b.getEast().toFixed(4);
    return fetchTimeout(url).then(function (r) {
      if (!r.ok) throw new Error('OpenSky HTTP ' + r.status);
      return r.json();
    }).then(function (d) { return (d.states || []).map(normOpenSky); });
  }

  var SOURCES = [fetchAdsbLol, fetchAdsbFi, fetchAirplanesLive, fetchOpenSky];
  var SRC_NAMES = ['adsb.lol', 'adsb.fi', 'airplanes.live', 'OpenSky'];
  var attemptLog = [];

  function tryFetch(i) {
    if (i >= SOURCES.length) return Promise.reject(new Error('všetky zdroje zlyhali'));
    status('Načítavám… (' + (i + 1) + '/' + SOURCES.length + ': ' + SRC_NAMES[i] + ')');
    dbg('skúšam zdroj: ' + SRC_NAMES[i]);
    var fn = SOURCES[i];
    var p;
    try {
      p = fn();
    } catch (e) {
      p = Promise.reject(e);
    }
    return p
      .then(function (arr) {
        attemptLog.push(SRC_NAMES[i] + ': OK (' + arr.length + ')');
        dbg('OK ' + SRC_NAMES[i] + ': ' + arr.length + ' lietadiel');
        if (arr.length === 0 && i + 1 < SOURCES.length) {
          dbg(SRC_NAMES[i] + ' vrátil 0 lietadiel, skúšam ďalší zdroj');
          return tryFetch(i + 1);
        }
        return arr;
      })
      .catch(function (err) {
        attemptLog.push(SRC_NAMES[i] + ': ' + err.message);
        dbg('CHYBA ' + SRC_NAMES[i] + ': ' + err.message);
        return tryFetch(i + 1);
      });
  }

  // ---------- vykreslenie ----------
  function updateTrail(a) {
    var p = planes[a.icao24];
    var trail = (p && p.trail) || [];
    if (trail.length) {
      var last = trail[trail.length - 1];
      if (Math.abs(last[0] - a.lat) > 0.0005 || Math.abs(last[1] - a.lon) > 0.0005) trail.push([a.lat, a.lon]);
    } else trail.push([a.lat, a.lon]);
    if (trail.length > 80) trail.shift();
    a.trail = trail;
  }

  function drawTrail() {
    if (trailLayer) { map.removeLayer(trailLayer); trailLayer = null; }
    if (!selected || !planes[selected]) return;
    var t = planes[selected].trail || [];
    if (t.length > 1) {
      trailLayer = L.polyline(t, { color: '#d43f3f', weight: 2, dashArray: '4 4' }).addTo(map);
    }
  }

  function renderStates(arr) {
    var seen = {};
    arr.forEach(function (a) {
      if (a.lat == null || a.lon == null) return;
      if (hideGround && a.onGround) return;
      seen[a.icao24] = true;
      updateTrail(a);
      planes[a.icao24] = a;
      var isSel = (selected === a.icao24);
      if (markers[a.icao24]) {
        markers[a.icao24].setLatLng([a.lat, a.lon]);
        markers[a.icao24].setIcon(planeIcon(a.track, a.altFt, isSel));
        markers[a.icao24].setPopupContent(popupHtml(a));
      } else {
        var m = L.marker([a.lat, a.lon], { icon: planeIcon(a.track, a.altFt, isSel) })
          .addTo(map)
          .bindPopup(popupHtml(a));
        m.on('click', function () { selected = a.icao24; drawTrail(); renderSelection(); });
        m.on('popupclose', function () { selected = null; drawTrail(); renderSelection(); });
        markers[a.icao24] = m;
      }
    });
    Object.keys(markers).forEach(function (k) {
      if (!seen[k]) {
        map.removeLayer(markers[k]);
        delete markers[k];
        delete planes[k];
        if (selected === k) { selected = null; drawTrail(); }
        if (follow === k) follow = null;
      }
    });
    drawTrail();
  }

  function renderSelection() {
    Object.keys(markers).forEach(function (k) {
      var p = planes[k];
      if (markers[k]) markers[k].setIcon(planeIcon(p.track, p.altFt, k === selected));
    });
  }

  function fetchStates() {
    if (inFlight) { pending = true; return; }
    inFlight = true;
    attemptLog = [];
    status('Načítavam…');
    tryFetch(0)
      .then(function (arr) {
        lastFetch = Date.now();
        if (arr.length) lastSource = arr[0].src;
        renderStates(arr);
        if (follow && planes[follow]) {
          map.setView([planes[follow].lat, planes[follow].lon], map.getZoom(), { animate: false });
        }
        status(arr.length + ' lietadiel • ' + new Date().toLocaleTimeString('sk') + (lastSource ? ' • ' + lastSource : '') + (attemptLog.filter(function (s) { return s.indexOf(': OK') === -1; }).length ? ' • zlyhalo: ' + attemptLog.filter(function (s) { return s.indexOf(': OK') === -1; }).join(', ') : ''));
      })
      .catch(function (err) { status('Chyba: ' + err.message); })
      .then(function () { inFlight = false; if (pending) { pending = false; fetchStates(); } });
  }

  function refresh() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      fetchStates();
      timer = setTimeout(refresh, REFRESH_MS);
    }, Math.max(0, REFRESH_MS - (Date.now() - lastFetch)));
  }

  map.on('moveend zoomend', refresh);
  map.on('dragstart', function () { follow = null; });

  // sledovanie z popupu
  window.__skyFollow = function (icao24) {
    follow = (follow === icao24) ? null : icao24;
    if (follow && planes[follow]) map.setView([planes[follow].lat, planes[follow].lon], Math.max(map.getZoom(), 8), { animate: true });
    if (markers[icao24]) markers[icao24].setPopupContent(popupHtml(planes[icao24]));
  };

  // filter: skryť na zemi
  document.getElementById('hideground').addEventListener('change', function (e) {
    hideGround = e.target.checked;
    if (hideGround) {
      Object.keys(markers).forEach(function (k) {
        if (planes[k] && planes[k].onGround) { map.removeLayer(markers[k]); delete markers[k]; }
      });
    }
    fetchStates();
  });

  // hľadanie: callsign alebo hex (adsb.lol má priame endpointy)
  document.getElementById('search').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var q = e.target.value.trim();
    if (!q) return;
    var isHex = /^[0-9a-f]{6}$/i.test(q);
    var url = isHex
      ? 'https://api.adsb.lol/v2/hex/' + q
      : 'https://api.adsb.lol/v2/callsign/' + encodeURIComponent(q);
    status('Hľadám "' + q + '"…');
    fetchTimeout(url)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var hits = (d.ac || []).filter(function (a) { return a.lat != null; }).map(function (a) { return normAdsb(a, 'adsb.lol'); });
        if (!hits.length) throw new Error('nenájdené');
        var a = hits[0];
        renderStates(hits);
        selected = a.icao24;
        map.setView([a.lat, a.lon], 9, { animate: true });
        if (markers[a.icao24]) { markers[a.icao24].setPopupContent(popupHtml(a)); markers[a.icao24].openPopup(); }
        status('Nájdené: ' + hits.length + ' lietadiel');
      })
      .catch(function () {
        // fallback: globálne OpenSky
        status('Skúšam OpenSky globálne…');
        fetchTimeout('https://opensky-network.org/api/states/all')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            var ql = q.toLowerCase();
            var hits = (d.states || []).filter(function (s) {
              var cs = (s[1] || '').trim().toLowerCase();
              return cs.indexOf(ql) !== -1 || s[0].toLowerCase().indexOf(ql) !== -1;
            }).map(normOpenSky).filter(function (a) { return a.lat != null; });
            if (!hits.length) { status('Nič nenájdené pre "' + q + '"'); return; }
            var a = hits[0];
            renderStates(hits);
            map.setView([a.lat, a.lon], 9, { animate: true });
            status('Nájdené: ' + hits.length + ' lietadiel');
          })
          .catch(function (err) { status('Chyba hľadania: ' + err.message); });
      });
  });

  dbg('SkyMonitor v' + VERSION + ' štart');
  if (navigator.serviceWorker.controller) dbg('SW aktívny: ' + (navigator.serviceWorker.controller.scriptURL || ''));
  else dbg('žiadny SW controller');
  dbg('online: ' + navigator.onLine);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function (r) { dbg('SW zaregistrovaný'); }).catch(function (e) { dbg('SW chyba: ' + e.message); });
  }

  fetchStates();
  timer = setTimeout(refresh, REFRESH_MS);
})();
