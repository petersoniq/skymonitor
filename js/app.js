/* SkyMonitor – live aircraft positions
 * Data: OpenSky Network (free, https://opensky-network.org)
 * Map:  Leaflet + OpenStreetMap (free)
 */
(function () {
  'use strict';

  var API = 'https://opensky-network.org/api/states/all';
  var REFRESH_MS = 30000;          // rešpektuj anonymous rate-limit
  var ICON_COLORS = ['#1e73c8', '#e08a1e', '#d43f3f']; // vysoko / stredne / nízko

  var map = L.map('map', { zoomControl: true }).setView([48.7, 19.5], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Data: <a href="https://opensky-network.org">OpenSky Network</a>'
  }).addTo(map);

  var markers = {};   // icao24 -> marker
  var lastData = {};  // icao24 -> state
  var lastFetch = 0;
  var timer = null;

  function status(msg) { document.getElementById('status').textContent = msg; }

  function colorFor(alt) {
    if (alt == null) return ICON_COLORS[0];
    if (alt < 2000) return ICON_COLORS[2];
    if (alt < 8000) return ICON_COLORS[1];
    return ICON_COLORS[0];
  }

  function planeIcon(heading, alt) {
    var c = colorFor(alt);
    var svg =
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
      '<g transform="rotate(' + (heading || 0) + ' 12 12)">' +
      '<path fill="' + c + '" stroke="#fff" stroke-width="0.7" d="M12 2 L13.2 9.5 L21 12 L13.2 14.2 L13.6 17.5 L15.5 19.5 L12 18.8 L8.5 19.5 L10.4 17.5 L10.8 14.2 L3 12 L10.8 9.5 Z"/>' +
      '</g></svg>';
    return L.divIcon({ className: 'plane-icon', html: svg, iconSize: [26, 26], iconAnchor: [13, 13] });
  }

  // [icao24, callsign, origin_country, time_position, last_contact,
  //  lon, lat, baro_alt, on_ground, velocity, true_track, vertical_rate,
  //  sensors, geo_alt, squawk, spi, position_source, category?]
  function popupHtml(s) {
    var cs = (s[1] || '').trim() || s[0];
    var fmt = function (v, u) { return (v == null ? '–' : Math.round(v) + ' ' + u); };
    return '<div class="plane-popup">' +
      '<b>' + cs.toUpperCase() + '</b> <small>(' + s[0] + ')</small><br>' +
      'Krajina: ' + s[2] + '<br>' +
      'Rýchlosť: ' + fmt(s[9], 'm/s') + ' (' + (s[9] != null ? Math.round(s[9] * 3.6) : '–') + ' km/h)<br>' +
      'Výška (baro): ' + fmt(s[7], 'm') + ' / ' + (s[7] != null ? Math.round(s[7] * 3.28084) : '–') + ' ft<br>' +
      'Výška (geo): ' + fmt(s[13], 'm') + '<br>' +
      'Vertikálna rýchlosť: ' + fmt(s[11], 'm/s') + '<br>' +
      'Kurz: ' + fmt(s[10], '°') + '<br>' +
      'Squawk: ' + (s[14] || '–') + '<br>' +
      'Na zemi: ' + (s[8] ? 'áno' : 'nie') + '<br>' +
      'Posledný kontakt: ' + (s[4] ? new Date(s[4] * 1000).toLocaleTimeString('sk') : '–') +
      '</div>';
  }

  function renderStates(states) {
    var seen = {};
    states.forEach(function (s) {
      if (s[5] == null || s[6] == null) return; // bez pozície
      var icao24 = s[0];
      seen[icao24] = true;
      lastData[icao24] = s;
      if (markers[icao24]) {
        markers[icao24].setLatLng([s[6], s[5]]);
        markers[icao24].setIcon(planeIcon(s[10], s[13]));
        markers[icao24].setPopupContent(popupHtml(s));
      } else {
        var m = L.marker([s[6], s[5]], { icon: planeIcon(s[10], s[13]) })
          .addTo(map)
          .bindPopup(popupHtml(s));
        markers[icao24] = m;
      }
    });
    // odstráň staré
    Object.keys(markers).forEach(function (k) {
      if (!seen[k]) { map.removeLayer(markers[k]); delete markers[k]; delete lastData[k]; }
    });
  }

  function fetchStates() {
    var b = map.getBounds().pad(0.5);
    var url = API + '?lamin=' + b.getSouth().toFixed(4) + '&lomin=' + b.getWest().toFixed(4) +
              '&lamax=' + b.getNorth().toFixed(4) + '&lomax=' + b.getEast().toFixed(4);
    if (map.getZoom() <= 3) url = API; // široký výrez = celý svet

    status('Načítavam…');
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      lastFetch = Date.now();
      var n = (d.states || []).length;
      renderStates(d.states || []);
      status(n + ' lietadiel • ' + new Date().toLocaleTimeString('sk'));
    }).catch(function (e) {
      status('Chyba: ' + e.message + ' (skúsim znova)');
    });
  }

  function refresh() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      fetchStates();
      timer = setTimeout(refresh, REFRESH_MS);
    }, Math.max(0, REFRESH_MS - (Date.now() - lastFetch)));
  }

  map.on('moveend zoomend', refresh);

  // Hľadanie: globálny fetch + filter
  document.getElementById('search').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var q = e.target.value.trim().toLowerCase();
    if (!q) return;
    status('Hľadám "' + q + '"…');
    fetch(API).then(function (r) { return r.json(); }).then(function (d) {
      var hits = (d.states || []).filter(function (s) {
        var cs = (s[1] || '').trim().toLowerCase();
        return cs.indexOf(q) !== -1 || s[0].toLowerCase().indexOf(q) !== -1;
      });
      if (!hits.length) { status('Nič nenájdené pre "' + q + '"'); return; }
      var s = hits[0];
      renderStates(hits);
      map.setView([s[6], s[5]], 9, { animate: true });
      if (markers[s[0]]) markers[s[0]].openPopup();
      status('Nájdené: ' + hits.length + ' lietadiel');
    }).catch(function (err) { status('Chyba hľadania: ' + err.message); });
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  fetchStates();
  timer = setTimeout(refresh, REFRESH_MS);
})();
