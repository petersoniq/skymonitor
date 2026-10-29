/* SkyMonitor – live aircraft positions
 * Primary data: adsb.lol (free, no API key, https://api.adsb.lol)
 * Fallback:     OpenSky Network (free, https://opensky-network.org)
 * Map:          Leaflet + OpenStreetMap (free)
 */
(function () {
  'use strict';

  var REFRESH_MS = 15000;
  var ICON_COLORS = ['#1e73c8', '#e08a1e', '#d43f3f']; // vysoko / stredne / nízko
  var FT = 3.28084;

  var map = L.map('map', { zoomControl: true }).setView([48.7, 19.5], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Data: <a href="https://api.adsb.lol">adsb.lol</a> / <a href="https://opensky-network.org">OpenSky</a>'
  }).addTo(map);

  var markers = {};
  var inFlight = false;
  var pending = false;
  var timer = null;
  var lastFetch = 0;
  var source = 'adsb.lol';

  function status(msg) { document.getElementById('status').textContent = msg; }

  function colorFor(altFt) {
    if (altFt == null) return ICON_COLORS[0];
    if (altFt < 6000) return ICON_COLORS[2];
    if (altFt < 26000) return ICON_COLORS[1];
    return ICON_COLORS[0];
  }

  function planeIcon(heading, altFt) {
    var c = colorFor(altFt);
    var svg =
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
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
    lines.push('<small>Zdroj: ' + a.src + '</small>');
    return '<div class="plane-popup">' + lines.join('<br>') + '</div>';
  }

  function normAdsb(a) {
    return {
      icao24: a.hex, callsign: a.flight, reg: a.r || null, type: a.t || null, country: null,
      lat: a.lat, lon: a.lon,
      altFt: (a.alt_baro === 'ground') ? 0 : a.alt_baro,
      onGround: (a.alt_baro === 'ground'),
      speedKt: a.gs, speedKmh: (a.gs != null ? a.gs * 1.852 : null),
      track: a.track, vrateFpm: a.baro_rate, squawk: a.squawk,
      emergency: a.emergency, src: 'adsb.lol'
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

  function renderStates(arr) {
    var seen = {};
    arr.forEach(function (a) {
      if (a.lat == null || a.lon == null) return;
      seen[a.icao24] = true;
      if (markers[a.icao24]) {
        markers[a.icao24].setLatLng([a.lat, a.lon]);
        markers[a.icao24].setIcon(planeIcon(a.track, a.altFt));
        markers[a.icao24].setPopupContent(popupHtml(a));
      } else {
        markers[a.icao24] = L.marker([a.lat, a.lon], { icon: planeIcon(a.track, a.altFt) })
          .addTo(map)
          .bindPopup(popupHtml(a));
      }
    });
    Object.keys(markers).forEach(function (k) {
      if (!seen[k]) { map.removeLayer(markers[k]); delete markers[k]; }
    });
  }

  function fetchAdsbLol() {
    var c = map.getCenter();
    var url = 'https://api.adsb.lol/v2/lat/' + c.lat.toFixed(4) + '/lon/' + c.lon.toFixed(4) + '/dist/250';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) { return (d.ac || []).map(normAdsb); });
  }

  function fetchOpenSky() {
    var b = map.getBounds().pad(0.5);
    var url = 'https://opensky-network.org/api/states/all?lamin=' + b.getSouth().toFixed(4) +
              '&lomin=' + b.getWest().toFixed(4) + '&lamax=' + b.getNorth().toFixed(4) +
              '&lomax=' + b.getEast().toFixed(4);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) { return (d.states || []).map(normOpenSky); });
  }

  function fetchStates() {
    if (inFlight) { pending = true; return; }
    inFlight = true;
    status('Načítavam…');
    fetchAdsbLol()
      .catch(function (err) {
        status('adsb.lol zlyhal (' + err.message + '), skúšam OpenSky…');
        return fetchOpenSky();
      })
      .then(function (arr) {
        lastFetch = Date.now();
        if (arr.length) source = arr[0].src;
        renderStates(arr);
        status(arr.length + ' lietadiel • ' + new Date().toLocaleTimeString('sk') + ' • ' + source);
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

  document.getElementById('search').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var q = e.target.value.trim().toLowerCase();
    if (!q) return;
    status('Hľadám "' + q + '"…');
    fetch('https://opensky-network.org/api/states/all')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var hits = (d.states || []).filter(function (s) {
          var cs = (s[1] || '').trim().toLowerCase();
          return cs.indexOf(q) !== -1 || s[0].toLowerCase().indexOf(q) !== -1;
        }).map(normOpenSky).filter(function (a) { return a.lat != null; });
        if (!hits.length) { status('Nič nenájdené pre "' + q + '"'); return; }
        var a = hits[0];
        renderStates(hits);
        map.setView([a.lat, a.lon], 9, { animate: true });
        if (markers[a.icao24]) markers[a.icao24].openPopup();
        status('Nájdené: ' + hits.length + ' lietadiel');
      })
      .catch(function (err) { status('Chyba hľadania: ' + err.message); });
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  fetchStates();
  timer = setTimeout(refresh, REFRESH_MS);
})();
