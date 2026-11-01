/* SkyMonitor – live aircraft positions
 * Sources (all free, no API key):
 *   1. adsb.lol      https://api.adsb.lol
 *   2. adsb.fi       https://opendata.adsb.fi
 *   3. airplanes.live https://api.airplanes.live
 *   4. OpenSky        https://opensky-network.org
 *   Trasy letov:      https://api.adsbdb.com (flightroute)
 * Map: Leaflet + OpenStreetMap
 */
(function () {
  'use strict';

  var VERSION = '4.1.0';
  var REFRESH_MS = 15000;
  var FETCH_TIMEOUT = 12000;
  var ICON_COLORS = ['#1e73c8', '#e08a1e', '#d43f3f'];
  var FT = 3.28084;
  var DIST_NM = 120; // Slovensko a okolie – menšie dáta, rýchlejšia odpoveď

  var SK_BOUNDS = L.latLngBounds([46.5, 16.0], [49.6, 22.6]);

  // Načítanie: pohľad na Slovensko; po prvom pokuse o posunutie sa mapa odomkne
  // a je možné ju posúvať ľubovoľne (lietadlá sa dočítavajú podľa stredu mapy).
  var mapUnlocked = false;
  function distNm() {
    if (!mapUnlocked) return DIST_NM;
    var b = map.getBounds(), c = map.getCenter(), ne = b.getNorthEast();
    var dLat = (ne.lat - c.lat) * 60;
    var dLon = (ne.lng - c.lng) * 60 * Math.cos(c.lat * Math.PI / 180);
    return Math.min(250, Math.max(120, Math.round(Math.sqrt(dLat * dLat + dLon * dLon))));
  }

  var map = L.map('map', {
    zoomControl: false,
    minZoom: 7,
    maxBounds: SK_BOUNDS.pad(0.2),
    maxBoundsViscosity: 0.9
  }).setView([48.7, 19.5], 8);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  function unlockMap() {
    if (mapUnlocked) return;
    mapUnlocked = true;
    map.setMaxBounds(null);
    map.setMinZoom(3);
    dbg('mapa odomknutá – voľné posúvanie');
  }
  map.on('dragstart', unlockMap);
  map.on('wheel', function (e) { if (e.originalEvent && e.originalEvent.deltaY > 0) unlockMap(); });

  // ---------- téma mapy ----------
  var tileLayer = null, darkTiles = false;
  var TILES = {
    light: {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Data: adsb.lol / adsb.fi / airplanes.live / OpenSky | Trasy: adsbdb'
    },
    dark: {
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a> | Data: adsb.lol / adsb.fi / airplanes.live / OpenSky | Trasy: adsbdb'
    }
  };
  function setTheme(dark) {
    darkTiles = dark;
    try { localStorage.setItem('skymon-theme', dark ? 'dark' : 'light'); } catch (e) {}
    var b = document.getElementById('themeBtn'); if (b) b.textContent = dark ? '☀️' : '🌙';
    var t = dark ? TILES.dark : TILES.light;
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(t.url, { maxZoom: 18, attribution: t.attr }).addTo(map);
  }
  window.__skyTheme = function () { setTheme(!darkTiles); };

  // ---------- moja poloha ----------
  var myPos = null, myMarker = null;
  window.__skyLocate = function () {
    if (!navigator.geolocation) { status('Geolokácia nie je podporovaná'); return; }
    status('Zisťujem polohu…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      myPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      if (myMarker) map.removeLayer(myMarker);
      myMarker = L.circleMarker([myPos.lat, myPos.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#4aa3e8', fillOpacity: 1 })
        .addTo(map).bindTooltip('📍 Moja poloha');
      unlockMap();
      map.setView([myPos.lat, myPos.lon], Math.max(map.getZoom(), 9), { animate: true });
      status('Poloha zistená');
      if (selected && planes[selected]) openSheet(planes[selected]);
    }, function (err) { status('Poloha: ' + err.message); }, { enableHighAccuracy: true, timeout: 10000 });
  };

  var markers = {};
  var planes = {};          // icao24 -> data (aj s trailom)
  var selected = null;      // icao24 vybraného lietadla
  var follow = null;        // icao24 sledovaného lietadla
  var trailLayer = null;
  var airportLayer = null;  // zvýraznenie letísk vybraného lietadla
  var hideGround = false;
  var inFlight = false;
  var pending = false;
  var timer = null;
  var lastFetch = 0;
  var lastSource = '';

  // ---------- obľúbené ----------
  function loadFavs() {
    try { return JSON.parse(localStorage.getItem('skymon-favs') || '{}'); } catch (e) { return {}; }
  }
  function saveFavs() {
    try { localStorage.setItem('skymon-favs', JSON.stringify(favs)); } catch (e) {}
  }
  var favs = loadFavs();
  window.__skyFav = function (icao24) {
    if (favs[icao24]) { delete favs[icao24]; } else { favs[icao24] = true; }
    saveFavs();
    if (markers[icao24]) {
      var p = planes[icao24];
      markers[icao24].setIcon(planeIcon(p.track, p.altFt, icao24 === selected, !!favs[icao24], !!pins[icao24]));
      if (icao24 === selected) openSheet(p);
    }
  };

  // ---------- pripnuté lietadlá (trasy natrvalo na mape) ----------
  function loadPins() { try { return JSON.parse(localStorage.getItem('skymon-pins') || '{}'); } catch (e) { return {}; } }
  function savePins() { try { localStorage.setItem('skymon-pins', JSON.stringify(pins)); } catch (e) {} }
  var pins = loadPins();
  var pinLayer = null;
  // body po veľkej kružnici medzi letiskami – "skutočná" trasa
  function gcPoints(la1, lo1, la2, lo2) {
    var R = Math.PI / 180, D = 180 / Math.PI, n = 64, pts = [];
    var p1 = la1 * R, l1 = lo1 * R, p2 = la2 * R, l2 = lo2 * R;
    var d = 2 * Math.asin(Math.sqrt(Math.pow(Math.sin((p2 - p1) / 2), 2) + Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin((l2 - l1) / 2), 2)));
    if (!d) return [[la1, lo1], [la2, lo2]];
    for (var i = 0; i <= n; i++) {
      var f = i / n;
      var A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      var x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
      var y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
      var z = A * Math.sin(p1) + B * Math.sin(p2);
      pts.push([Math.atan2(z, Math.sqrt(x * x + y * y)) * D, Math.atan2(y, x) * D]);
    }
    return pts;
  }
  function renderPins() {
    if (pinLayer) { map.removeLayer(pinLayer); pinLayer = null; }
    var keys = Object.keys(pins);
    if (!keys.length) return;
    pinLayer = L.layerGroup().addTo(map);
    keys.forEach(function (hex) {
      var rt = pins[hex];
      if (!rt || !rt.from || !rt.to) return;
      [[rt.from, '🛫', '#1e73c8'], [rt.to, '🛬', '#d43f3f']].forEach(function (x) {
        var info = x[0];
        if (info.lat == null) return;
        L.circleMarker([info.lat, info.lon], { radius: 5, color: '#fff', weight: 2, fillColor: x[2], fillOpacity: 1 })
          .addTo(pinLayer).bindTooltip(x[1] + ' ' + info.name + ' (' + info.icao + ')', { direction: 'top' });
      });
      if (rt.from.lat != null && rt.to.lat != null) {
        var pp = planes[hex];
        var rpx = (pp && pp.lat != null) ? routeProgress(rt, pp) : null;
        var gp = rpx ? rpx.gpts : gcPoints(rt.from.lat, rt.from.lon, rt.to.lat, rt.to.lon);
        var tip = '📌 ' + ((pp && (pp.callsign || '').trim()) || hex).toUpperCase();
        if (rpx && rpx.idx > 0) {
          L.polyline(gp.slice(0, rpx.idx + 1), { color: '#00897b', weight: 2.5, opacity: 0.9 }).addTo(pinLayer).bindTooltip(tip);
          L.polyline(gp.slice(rpx.idx), { color: '#00897b', weight: 2, dashArray: '6 6', opacity: 0.55 }).addTo(pinLayer);
        } else {
          L.polyline(gp, { color: '#00897b', weight: 2.5, opacity: 0.85 }).addTo(pinLayer).bindTooltip(tip);
        }
      }
    });
  }
  window.__skyPin = function (hex) {
    if (pins[hex]) {
      delete pins[hex];
    } else {
      var p = planes[hex];
      var cs = p ? (p.callsign || '').trim() : '';
      pins[hex] = (p && p.fromTo) ? p.fromTo : (routeCache[cs] || null);
      if (p && !p.fromTo) ensureRoute(p);
    }
    savePins();
    renderPins();
    if (markers[hex]) {
      var pp = planes[hex];
      markers[hex].setIcon(planeIcon(pp.track, pp.altFt, hex === selected, !!favs[hex], !!pins[hex]));
      if (hex === selected) openSheet(pp);
    }
  };

  // ---------- preklad IATA <-> ICAO volacích znakov ----------
  // Na letiskových tabuliach je IATA formát (FR8017), ADS-B vysielanie používa ICAO (RYR8017).
  var IATA_TO_ICAO = {
    FR: 'RYR', W6: 'WZZ', LH: 'DLH', U2: 'EZY', BA: 'BAW', AF: 'AFR', KL: 'KLM',
    TK: 'THY', OS: 'AUA', OK: 'CSA', LO: 'LOT', LX: 'SWR', EW: 'EWG', VY: 'VLG',
    DY: 'NOZ', AY: 'FIN', SK: 'SAS', SU: 'AFL', EK: 'UAE', QR: 'QTR', UA: 'UAL',
    AA: 'AAL', DL: 'DAL', WN: 'SWA', B6: 'JBU', AC: 'ACA', QF: 'QFA', SQ: 'SIA',
    CX: 'CPA', JL: 'JAL', NH: 'ANA', CA: 'CCA', MU: 'CES', CZ: 'CSN', AI: 'AIC',
    ET: 'ETH', MS: 'MSR', SA: 'SAA', LA: 'LAN', AM: 'AMX', AV: 'AVA', CM: 'CMP',
    IB: 'IBE', TP: 'TAP', A3: 'AEE', FB: 'LZB', RO: 'ROT', OU: 'CTN',
    JP: 'ADR', BT: 'BTI', AZ: 'ITY', VS: 'VIR', TG: 'THA', MH: 'MAS', GA: 'GIA',
    PR: 'PAL', VN: 'HVN', BR: 'EVA', KE: 'KAL', OZ: 'AAR', ME: 'MEA', RJ: 'RJA',
    GF: 'GFA', SV: 'SVA', PC: 'PGT', HV: 'TRA', DE: 'CFG', X3: 'TUI',
    PS: 'AUI', UX: 'AEA', FI: 'ICE', GJ: 'GDA', V7: 'VOE', YW: 'AEW',
    '9C': 'CQH', '5F': 'FIA', '6E': 'IGO', W9: 'AVJ', W4: 'WIF', '4U': 'GWI',
    FZ: 'FDB', TO: 'TVF', D8: 'IBS', HY: 'UZB'
  };
  function callCandidates(raw) {
    var cleaned = (raw || '').toUpperCase().replace(/\s+/g, '');
    var out = [cleaned];
    if (cleaned.length > 2) {
      var icao = IATA_TO_ICAO[cleaned.slice(0, 2)];
      if (icao) {
        var c2 = icao + cleaned.slice(2);
        if (out.indexOf(c2) === -1) out.push(c2);
      }
      // aj opačný smer: zadané ICAO -> skús IATA (pre adsbdb, ktorý kľúčuje aj IATA)
      for (var iata in IATA_TO_ICAO) {
        if (IATA_TO_ICAO[iata] === cleaned.slice(0, 3)) {
          var c3 = iata + cleaned.slice(3);
          if (out.indexOf(c3) === -1) out.push(c3);
        }
      }
    }
    return out;
  }

  // ---------- offline cache posledných dát ----------
  var LAST_CACHE_KEY = 'skymon-last-v1';
  function saveLastStates(arr) {
    try {
      var slim = arr.slice(0, 400).map(function (a) {
        var c = {};
        for (var k in a) { if (k !== 'trail') c[k] = a[k]; }
        c.trail = (a.trail || []).slice(-30);
        return c;
      });
      localStorage.setItem(LAST_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: slim }));
    } catch (e) {}
  }
  function loadLastStates() {
    try { var r = localStorage.getItem(LAST_CACHE_KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; }
  }

  // ---------- PWA inštalácia ----------
  var deferredInstall = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstall = e;
    var b = document.getElementById('installBtn');
    if (b) b.style.display = 'inline-block';
  });
  window.__skyInstall = function () {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    deferredInstall.userChoice.then(function () {
      deferredInstall = null;
      var b = document.getElementById('installBtn');
      if (b) b.style.display = 'none';
    });
  };

  // ---------- kategórie lietadiel + fotografie ----------
  var CATEGORIES = {
    A1: 'ľahké', A2: 'malé', A3: 'stredné (A320/B737)', A4: 'veľké (B757/B767)',
    A5: 'ťažké (A350/B787)', A6: 'veľmi ťažké (A380/B747)', A7: 'vysokorýchlostné',
    B1: 'klzák', B2: 'balón', B3: 'padák', B4: 'drôt/VTOL',
    C1: 'vrtuľník', C2: 'dron (UAV)', C3: 'núdzové vozidlo'
  };
  var photoCache = {};
  function ensurePhoto(a) {
    var hex = a.icao24;
    if (hex in photoCache) return;
    photoCache[hex] = null;
    fetchTimeout('https://api.planespotters.net/pub/photos/hex/' + hex, 9000)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var p = d && d.photos && d.photos[0];
        photoCache[hex] = p ? {
          src: (p.thumbnail_large && p.thumbnail_large.src) || (p.thumbnail && p.thumbnail.src) || null,
          link: p.link || 'https://www.planespotters.net',
          by: p.photographer || 'planespotters.net'
        } : null;
        if (p && photoCache[hex].src && selected === hex) openSheet(planes[hex] || a);
      })
      .catch(function () { photoCache[hex] = null; });
  }

  // ---------- manuálny refresh ----------
  window.__skyRefresh = function () {
    lastFetch = 0;
    fetchStates();
  };

  // ---------- panel obľúbených ----------
  window.__skyFavPanel = function () {
    var panel = document.getElementById('favPanel');
    var out = document.getElementById('favOut');
    if (!panel || !out) return;
    panel.style.display = 'flex';
    var list = Object.keys(favs);
    if (!list.length) { out.innerHTML = '<div class="favempty">Zatiaľ nemáš žiadne obľúbené lietadlá.<br>Klepni na lietadlo na mape a pridaj ho tlačidlom ☆ Obľúbené.</div>'; return; }
    out.innerHTML = '';
    list.forEach(function (hex) {
      var p = planes[hex] || {};
      var cs = (p.callsign || '').trim() || hex;
      var line = document.createElement('div');
      line.className = 'favrow';
      var info = document.createElement('div');
      info.innerHTML = '<b>' + cs.toUpperCase() + '</b><span>' + (p.reg || '') + (p.altFt != null ? ' · ' + Math.round(p.altFt) + ' ft' : '') + '</span>';
      var btn = document.createElement('button');
      btn.textContent = p.lat != null ? '📍 Zobraziť' : '🔎 Nájsť';
      btn.onclick = function () { window.__skyShowFav(hex); };
      line.appendChild(info); line.appendChild(btn);
      out.appendChild(line);
    });
  };
  window.__skyFavPanelClose = function () { var p = document.getElementById('favPanel'); if (p) p.style.display = 'none'; };
  window.__skyShowFav = function (hex) {
    window.__skyFavPanelClose();
    if (planes[hex] && planes[hex].lat != null) {
      selected = hex;
      unlockMap();
      map.setView([planes[hex].lat, planes[hex].lon], Math.max(map.getZoom(), 9), { animate: true });
      drawTrail(); renderSelection(); openSheet(planes[hex]);
      return;
    }
    status('Hľadám ' + hex + '…');
    fetchTimeout('https://api.adsb.lol/v2/hex/' + hex)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var hits = (d.ac || []).filter(function (a) { return a.lat != null; }).map(function (a) { return normAdsb(a, 'adsb.lol'); });
        if (!hits.length) throw new Error('nenájdené');
        unlockMap();
        renderStates(hits);
        selected = hex;
        map.setView([hits[0].lat, hits[0].lon], 9, { animate: true });
        drawTrail(); renderSelection(); openSheet(planes[hex]);
        status('Nájdené: ' + hits.length);
      })
      .catch(function (err) { status('Nepodarilo sa nájsť: ' + err.message); });
  };

  function dbg(msg) {
    // tichý režim – len do konzoly (F12), žiadny vizuálny panel
    try { if (console && console.log) console.log('[SkyMonitor] ' + msg); } catch (e) {}
  }

  function status(msg) {
    document.getElementById('status').innerHTML = msg;
  }

  function fetchTimeout(url, ms) {
    ms = ms || 8000;
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms) : null;
    dbg('fetch: ' + url + (ctl ? '' : ' (bez AbortController)'));
    var opts = ctl ? { signal: ctl.signal, cache: 'no-store' } : { cache: 'no-store' };
    var req = fetch(url, opts).finally(function () { if (timer) clearTimeout(timer); });
    var raceTimer = new Promise(function (_, reject) {
      setTimeout(function () { dbg('timeout ' + ms + ' ms – prerušujem'); reject(new Error('timeout')); }, ms);
    });
    raceTimer.catch(function () {});
    return Promise.race([req, raceTimer]);
  }

  function colorFor(altFt) {
    if (altFt == null) return ICON_COLORS[0];
    if (altFt < 6000) return ICON_COLORS[2];
    if (altFt < 26000) return ICON_COLORS[1];
    return ICON_COLORS[0];
  }

  function planeIcon(heading, altFt, isSel, isFav, isPin) {
    var c = colorFor(altFt);
    var ring = isPin
      ? '<circle cx="12" cy="12" r="10.5" fill="none" stroke="#8e24aa" stroke-width="1.6"/>'
      : (isFav
        ? '<circle cx="12" cy="12" r="10.5" fill="none" stroke="#f5b301" stroke-width="1.4"/>'
        : (isSel ? '<circle cx="12" cy="12" r="10.5" fill="none" stroke="#d43f3f" stroke-width="1.2"/>' : ''));
    var star = isFav ? '<path d="M19.5 4.6 L18.1 7.4 L15 7.9 L17.3 10.1 L16.7 13.2 L19.5 11.7 L22.3 13.2 L21.7 10.1 L24 7.9 L20.9 7.4 Z" fill="#f5b301" stroke="#fff" stroke-width="0.5" transform="scale(0.72) translate(1 1)"/>' : '';
    var svg =
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
      ring +
      '<g transform="rotate(' + (heading || 0) + ' 12 12)">' +
      '<path fill="' + c + '" stroke="#fff" stroke-width="0.7" d="M12 2 L13.2 9.5 L21 12 L13.2 14.2 L13.6 17.5 L15.5 19.5 L12 18.8 L8.5 19.5 L10.4 17.5 L10.8 14.2 L3 12 L10.8 9.5 Z"/>' +
      '</g>' + star + '</svg>';
    return L.divIcon({ className: 'plane-icon', html: svg, iconSize: [32, 32], iconAnchor: [16, 16] });
  }

  function fmt(v, u) { return (v == null ? '–' : (typeof v === 'number' ? Math.round(v) : v) + (u ? ' ' + u : '')); }

  // ---------- trasa letu ----------
  // ICAO -> [názov, lat, lon] (približné polohy letísk pre vzdialenosti a zvýraznenie)
  var AIRPORTS = {
    LZIB: ['Bratislava', 48.170, 17.213], LZKZ: ['Košice', 48.663, 21.244],
    LZTT: ['Poprad', 49.071, 20.247], LZPW: ['Piešťany', 48.620, 17.817],
    LZSL: ['Sliač', 48.635, 19.136], LZTN: ['Trenčín', 48.889, 18.042],
    LZZI: ['Žilina', 49.232, 18.974], LZLU: ['Lučenec', 48.334, 19.672],
    LZMC: ['Malacky', 48.354, 17.019], LZNI: ['Nitra', 48.290, 18.151],
    LOWW: ['Viedeň', 48.110, 16.570], LHBP: ['Budapešť', 47.437, 19.256],
    LKPR: ['Praha', 50.101, 14.260], LKBR: ['Brno', 49.152, 16.694],
    LKMT: ['Ostrava', 49.696, 18.111], EPKK: ['Krakov', 50.078, 19.785],
    EPKT: ['Katovice', 50.474, 19.080], EPWA: ['Varšava', 52.166, 20.967],
    EPRA: ['Radom', 51.169, 21.194], LRAR: ['Arad', 46.177, 21.262],
    LRSM: ['Satu Mare', 47.784, 22.888], LROP: ['Bukurešť', 44.571, 26.085],
    LRCL: ['Kluž', 46.785, 23.686], LRSB: ['Sibiu', 45.786, 24.091],
    LYBE: ['Belehrad', 44.819, 20.309], LYTV: ['Niš', 43.337, 21.854],
    LYPG: ['Podgorica', 42.359, 19.252],
    LSZH: ['Zürich', 47.465, 8.549], LSGG: ['Ženeva', 46.238, 6.109],
    EDDF: ['Frankfurt', 50.038, 8.562], EDDM: ['Mníchov', 48.354, 11.786],
    EDDL: ['Düsseldorf', 51.289, 6.767], EDDT: ['Berlín Tegel', 52.560, 13.287],
    EDDP: ['Lipsko', 51.424, 12.236], EDDK: ['Kolín/Bonn', 50.866, 7.143],
    EDDB: ['Berlín', 52.362, 13.501], EDDN: ['Norimberg', 49.499, 11.078],
    EDDV: ['Hannover', 52.461, 9.685], EDDH: ['Hamburg', 53.630, 9.988],
    EDDW: ['Brémy', 53.047, 8.787],
    EHAM: ['Amsterdam', 52.309, 4.764], EBBR: ['Brusel', 50.901, 4.484],
    LFPG: ['Paríž CDG', 49.010, 2.548], LFPO: ['Paríž Orly', 48.726, 2.365],
    LFPB: ['Le Bourget', 48.970, 2.441], LFMN: ['Nice', 43.658, 7.216],
    LFML: ['Marseille', 43.436, 5.215],
    EGLL: ['Londýn Heathrow', 51.471, -0.454], EGKK: ['Londýn Gatwick', 51.148, -0.191],
    EGSS: ['Londýn Stansted', 51.885, 0.235],
    LEMD: ['Madrid', 40.494, -3.567], LEBL: ['Barcelona', 41.297, 2.078],
    LIRF: ['Rím Fiumicino', 41.804, 12.252], LIML: ['Miláno Linate', 45.445, 9.277],
    LIMC: ['Miláno Malpensa', 45.630, 8.723], LIPZ: ['Benátky', 45.505, 12.352],
    LIPX: ['Verona', 45.396, 10.888], LIRP: ['Pisa', 43.684, 10.393],
    LGAV: ['Atény', 37.937, 23.946], LTFM: ['Istanbul', 41.275, 28.752],
    LTAI: ['Antalya', 36.899, 30.801], LTAC: ['Ankara', 40.128, 32.995],
    EKCH: ['Kodaň', 55.619, 12.656], ESSA: ['Štokholm', 59.652, 17.923],
    ENGM: ['Oslo', 60.194, 11.100], EFHK: ['Helsinki', 60.317, 24.963],
    EYVI: ['Vilnius', 54.634, 25.286], EVRA: ['Riga', 56.924, 23.972],
    EETN: ['Tallinn', 59.413, 24.764],
    UUEE: ['Moskva Šeremetevo', 55.973, 37.415], UUDD: ['Moskva Domodedovo', 55.409, 37.906],
    OMDB: ['Dubaj', 25.253, 55.365], OTHH: ['Dauha', 25.273, 51.608]
  };
  function airInfo(icao, nameHint) {
    var l = AIRPORTS[icao];
    return { icao: icao, name: (nameHint || (l ? l[0] : '') || icao), lat: l ? l[1] : null, lon: l ? l[2] : null };
  }
  // route formát v dátach: "EDDF-EPKT"
  function routeParts(route) {
    if (!route) return null;
    var m = String(route).toUpperCase().match(/([A-Z]{4})/g);
    if (!m || m.length < 2) return null;
    return { from: m[0], to: m[1] };
  }
  // haversine vzdialenosť v km
  function distKm(la1, lo1, la2, lo2) {
    var R = 6371;
    var dLat = (la2 - la1) * Math.PI / 180, dLon = (lo2 - lo1) * Math.PI / 180;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  // poloha lietadla na trase: najbližší bod veľkej kružnice -> presný progres
  function routeProgress(rt, a) {
    var gpts = gcPoints(rt.from.lat, rt.from.lon, rt.to.lat, rt.to.lon);
    var best = 0, bestD = Infinity;
    for (var i = 0; i < gpts.length; i++) {
      var d = distKm(a.lat, a.lon, gpts[i][0], gpts[i][1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return { gpts: gpts, idx: best, offKm: bestD, flownFrac: best / (gpts.length - 1) };
  }

  // trasa z adsbdb (databáza letových trás, free bez kľúča), cacheovaná podľa callsignu
  var routeCache = {};
  function ensureRoute(a) {
    var cs = (a.callsign || '').trim();
    if (!cs) return;
    var cached = routeCache[cs];
    if (cached === undefined) {
      routeCache[cs] = null; // záp. marker, neopakovať
      dbg('trasa: pýtam adsbdb pre ' + cs);
      fetchTimeout('https://api.adsbdb.com/v0/callsign/' + encodeURIComponent(cs), 9000)
        .then(function (r) { if (!r.ok) throw new Error('adsbdb HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          var fr = d && d.response && d.response.flightroute;
          if (!fr || !fr.origin || !fr.destination) return null;
          var mk = function (x) {
            var l = AIRPORTS[x.icao_code];
            return {
              icao: x.icao_code,
              name: x.municipality || (l ? l[0] : '') || x.icao_code,
              lat: (x.latitude != null ? x.latitude : (l ? l[1] : null)),
              lon: (x.longitude != null ? x.longitude : (l ? l[2] : null))
            };
          };
          return {
            from: mk(fr.origin),
            to: mk(fr.destination),
            airline: fr.airline && fr.airline.name ? fr.airline.name : null
          };
        })
        .then(function (v) {
          routeCache[cs] = v;
          if (v) {
            var p = planes[a.icao24];
            if (p) p.fromTo = v;
            if (pins[a.icao24]) { pins[a.icao24] = v; savePins(); renderPins(); }
            if (selected === a.icao24) openSheet(planes[a.icao24] || a);
          }
        })
        .catch(function () { routeCache[cs] = null; });
    } else if (cached) {
      a.fromTo = cached;
    }
  }

  function normAdsb(a, src) {
    return {
      icao24: a.hex, callsign: a.flight, reg: a.r || null, type: a.t || null, country: null,
      route: a.route || null,
      lat: a.lat, lon: a.lon,
      altFt: (a.alt_baro === 'ground') ? 0 : a.alt_baro,
      onGround: (a.alt_baro === 'ground'),
      speedKt: a.gs, speedKmh: (a.gs != null ? a.gs * 1.852 : null),
      track: a.track, vrateFpm: a.baro_rate, squawk: a.squawk,
      mach: (a.mach != null ? a.mach : null), oat: (a.oat != null ? a.oat : null), category: a.category || null,
      emergency: a.emergency, src: src
    };
  }

  function normOpenSky(s) {
    return {
      icao24: s[0], callsign: s[1], reg: null, type: null, country: s[2], route: null,
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
  // mriežka bodov pokrývajúca celý výrez mapy (až 5×4 bodov, každý do 250 NM)
  function gridPoints() {
    var b = map.getBounds(), c = map.getCenter();
    var ne = b.getNorthEast(), sw = b.getSouthWest();
    var wNm = Math.abs(ne.lng - sw.lng) * 60 * Math.cos(c.lat * Math.PI / 180);
    var hNm = Math.abs(ne.lat - sw.lat) * 60;
    var r = 250;
    var cols = Math.max(1, Math.min(5, Math.ceil(wNm / (2 * r * 0.8))));
    var rows = Math.max(1, Math.min(4, Math.ceil(hNm / (2 * r * 0.8))));
    var pts = [];
    for (var i = 0; i < cols; i++) {
      for (var j = 0; j < rows; j++) {
        pts.push({
          lat: sw.lat + (ne.lat - sw.lat) * ((i + 0.5) / cols),
          lon: sw.lng + (ne.lng - sw.lng) * ((j + 0.5) / rows),
          dist: r
        });
      }
    }
    return pts;
  }

  function srcRadius(base, name) {
    var pts = gridPoints();
    var jobs = pts.map(function (pt) {
      var url = base + '/lat/' + pt.lat.toFixed(4) + '/lon/' + pt.lon.toFixed(4) + '/dist/' + pt.dist;
      return fetchTimeout(url).then(function (r) {
        if (!r.ok) throw new Error(name + ' HTTP ' + r.status);
        return r.json();
      }).then(function (d) {
        if (d && d.error) throw new Error(name + ' error: ' + String(d.error).slice(0, 80));
        return d.ac || d.aircraft || [];
      });
    });
    // spájame všetky body mriežky; zlyhanie časti ne prestaví celý zdroj
    return Promise.allSettled(jobs).then(function (res) {
      var out = [], seen = {};
      res.forEach(function (x, i) {
        if (x.state !== 'fulfilled') { dbg(name + '[' + i + '] zlyhal: ' + (x.reason && x.reason.message)); return; }
        x.value.forEach(function (a) {
          if (a && a.hex && !seen[a.hex]) { seen[a.hex] = 1; out.push(normAdsb(a, name)); }
        });
      });
      dbg(name + ': ' + out.length + ' lietadiel z ' + res.length + ' bodov mriežky');
      if (!out.length) throw new Error(name + ': 0 lietadiel');
      return out;
    });
  }

  // repo-cache: dáta ukladané GitHub Actions workflowom do vetvy data
  function fetchRepoData() {
    var url = 'https://raw.githubusercontent.com/petersoniq/skymonitor/data/data/sk.json?_=' + Date.now();
    return fetchTimeout(url, 15000).then(function (r) {
      if (!r.ok) throw new Error('repo HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      var age = d.updated ? Math.round((Date.now() / 1000 - d.updated) / 60) : 0;
      var list = d.ac || [];
      return list.map(function (a) { return normAdsb(a, 'repo-cache (' + age + ' min)'); });
    });
  }

  function fetchAdsbLol() { return srcRadius('https://api.adsb.lol/v2', 'adsb.lol'); }

  function fetchViaProxy2() {
    var g0 = gridPoints()[0];
    var target = 'https://api.adsb.lol/v2/lat/' + g0.lat.toFixed(4) + '/lon/' + g0.lon.toFixed(4) + '/dist/' + Math.min(250, g0.dist);
    var url = 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(target);
    return fetchTimeout(url, 30000).then(function (r) {
      if (!r.ok) throw new Error('proxy2 HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      if (d && d.error) throw new Error('proxy2 error');
      var list = d.ac || d.aircraft || [];
      return list.map(function (a) { return normAdsb(a, 'adsb.lol (codetabs)'); });
    });
  }

  function parseProxyJson(d) {
    if (d && typeof d.contents === 'string') d = JSON.parse(d.contents); // allorigins /get wrapper
    if (d && d.error) throw new Error('proxy error');
    var list = (d && (d.ac || d.aircraft)) || [];
    return list.map(function (a) { return normAdsb(a, 'adsb.lol (proxy)'); });
  }

  function fetchViaProxy() {
    var g0 = gridPoints()[0];
    var target = 'https://api.adsb.lol/v2/lat/' + g0.lat.toFixed(4) + '/lon/' + g0.lon.toFixed(4) + '/dist/' + Math.min(250, g0.dist);
    var urls = [
      { name: 'allorigins', u: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(target) },
      { name: 'codetabs', u: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(target) },
      { name: 'allorigins-get', u: 'https://api.allorigins.win/get?url=' + encodeURIComponent(target) },
      { name: 'thingproxy', u: 'https://thingproxy.freeboard.io/fetch/' + target }
    ];
    var jobs = urls.map(function (x) {
      return fetchTimeout(x.u, 30000).then(function (r) {
        if (!r.ok) throw new Error(x.name + ' HTTP ' + r.status);
        return r.json();
      }).then(parseProxyJson);
    });
    // hedged: použije prvý proxy, ktorý odpovie; čaká max. 30 s
    return new Promise(function (resolve, reject) {
      var pending = jobs.length, done = false, errs = [];
      jobs.forEach(function (j) {
        j.then(function (arr) { if (!done) { done = true; resolve(arr); } },
              function (e) { errs.push(e.message); if (--pending === 0 && !done) { done = true; reject(new Error('proxy: ' + errs.slice(0, 3).join(' | '))); } });
      });
    });
  }
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

  var SOURCES = [fetchAdsbLol, fetchAdsbFi, fetchAirplanesLive, fetchOpenSky, fetchViaProxy, fetchViaProxy2, fetchRepoData];
  var SRC_NAMES = ['adsb.lol', 'adsb.fi', 'airplanes.live', 'OpenSky', 'allorigins', 'codetabs', 'repo-cache'];
  var attemptLog = [];

  function tryFetch(i) {
    if (i >= SOURCES.length) return Promise.reject(new Error('všetky zdroje zlyhali'));
    status('Načítavam…');
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
        lastSource = SRC_NAMES[i];
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

  // ---------- detailný panel (spodný sheet) ----------
  var sheetEl = null;
  function clearAirports() {
    if (airportLayer) { map.removeLayer(airportLayer); airportLayer = null; }
  }
  function closeSheet() {
    if (sheetEl) sheetEl.classList.remove('open');
    clearAirports();
  }
  // zvýraznenie letísk + spojnica trasy na mape
  function drawAirports(a) {
    clearAirports();
    var rt = a.fromTo;
    if (!rt) {
      var rp = routeParts(a.route);
      if (rp) rt = { from: airInfo(rp.from), to: airInfo(rp.to) };
    }
    if (!rt) return;
    var pts = [];
    airportLayer = L.layerGroup().addTo(map);
    [[rt.from, '🛫', '#1e73c8'], [rt.to, '🛬', '#d43f3f']].forEach(function (x) {
      var info = x[0];
      if (info.lat == null) return;
      pts.push([info.lat, info.lon]);
      L.circleMarker([info.lat, info.lon], {
        radius: 7, color: '#fff', weight: 2.5, fillColor: x[2], fillOpacity: 1
      }).addTo(airportLayer).bindTooltip(x[1] + ' ' + info.name + ' (' + info.icao + ')', { direction: 'top' });
    });
    if (rt.from.lat != null && rt.to.lat != null) {
      var rp1 = (a.lat != null) ? routeProgress(rt, a) : null;
      var gpts1 = rp1 ? rp1.gpts : gcPoints(rt.from.lat, rt.from.lon, rt.to.lat, rt.to.lon);
      if (rp1 && rp1.idx > 0) {
        L.polyline(gpts1.slice(0, rp1.idx + 1), { color: '#1e73c8', weight: 2.5, opacity: 0.9 }).addTo(airportLayer); // preletaná časť
        L.polyline(gpts1.slice(rp1.idx), { color: '#1e73c8', weight: 2, dashArray: '6 6', opacity: 0.55 }).addTo(airportLayer); // zostáva
      } else {
        L.polyline(gpts1, { color: '#1e73c8', weight: 2, dashArray: '6 6', opacity: 0.75 }).addTo(airportLayer);
      }
    }
  }
  function openSheet(a) {
    if (!a) return;
    if (!sheetEl) sheetEl = document.getElementById('sheet');
    if (!sheetEl) return;
    var cs = (a.callsign || '').trim() || a.icao24;
    document.getElementById('sheetTitle').textContent = cs.toUpperCase();
    var sub = [];
    if (a.reg) sub.push(a.reg);
    if (a.type) sub.push(a.type);
    if (a.fromTo && a.fromTo.airline) sub.push(a.fromTo.airline);
    if (a.country) sub.push(a.country);
    document.getElementById('sheetSub').textContent = sub.join(' · ') || ('hex ' + a.icao24);
    document.getElementById('sheetBody').innerHTML = sheetBodyHtml(a);
    sheetEl.classList.add('open');
    ensureRoute(a);
    ensurePhoto(a);
    drawAirports(a);
  }
  window.__skySheetClose = function () { selected = null; closeSheet(); drawTrail(); renderSelection(); };

  function sheetBodyHtml(a) {
    var cell = function (l, v) {
      return '<div class="cell"><span>' + l + '</span><b>' + v + '</b></div>';
    };
    var altFt = a.altFt != null ? Math.round(a.altFt) : '–';
    var altM = a.altFt != null ? Math.round(a.altFt / FT) : '–';
    var spd = a.speedKmh != null ? Math.round(a.speedKmh) : '–';
    var gsKt = a.speedKt != null ? Math.round(a.speedKt) : '–';
    var vr = a.vrateFpm != null ? Math.round(a.vrateFpm) : '–';
    var vrA = a.vrateFpm > 100 ? '▲' : (a.vrateFpm < -100 ? '▼' : '●');
    var trk = a.track != null ? Math.round(a.track) + '°' : '–';
    var html = '';
    if (a.emergency && a.emergency !== 'none') html += '<div class="alert">⚠ NÚDZOVÝ STAV: ' + a.emergency + '</div>';

    // trasa: odkiaľ → kam (+ vzdialenosť a progres, ak poznáme polohy letísk)
    var rt = a.fromTo;
    if (!rt) {
      var rp = routeParts(a.route);
      if (rp) rt = { from: airInfo(rp.from), to: airInfo(rp.to) };
    }
    var progCells = '';
    if (rt) {
      html += '<div class="routeline"><span class="leg">🛫 ' + rt.from.name + ' <small>(' + rt.from.icao + ')</small></span>' +
              '<span class="arrow">→</span>' +
              '<span class="leg">🛬 ' + rt.to.name + ' <small>(' + rt.to.icao + ')</small></span></div>';
      if (rt.from.lat != null && rt.to.lat != null && a.lat != null) {
        var dTot = distKm(rt.from.lat, rt.from.lon, rt.to.lat, rt.to.lon);
        var rp0 = routeProgress(rt, a);
        var dFlown = dTot * rp0.flownFrac;
        var pct = Math.max(0, Math.min(100, Math.round(dFlown / dTot * 100)));
        var dLeft = Math.max(0, Math.round(dTot - dFlown));
        html += '<div class="routeprog" title="' + pct + ' % preletané"><span style="width:' + pct + '%"></span></div>';
        progCells =
          cell('Vzdialenosť', Math.round(dTot) + ' km') +
          cell('Preletané', pct + ' %') +
          cell('Zostáva', dLeft + ' km');
      }
    } else {
      html += '<div class="routeline muted">Trasa neznáma <small>(adsbdb nemá pre tento callsign letovú trasu)</small></div>';
    }

    // overenie: poloha by mala ležať zhruba na trase (callsigny sa denne opakujú, adsbdb môže mať iný sektor)
    if (rt && rt.from.lat != null && rt.to.lat != null && a.lat != null) {
      var minD = routeProgress(rt, a).offKm;
      var nearEnd = (distKm(a.lat, a.lon, rt.from.lat, rt.from.lon) < 150) || (distKm(a.lat, a.lon, rt.to.lat, rt.to.lon) < 150);
      if (!nearEnd && minD > 250) {
        html += '<div class="routewarn">⚠ Pozícia je ~' + Math.round(minD) + ' km mimo trasy ' + rt.from.icao + ' → ' + rt.to.icao + '. Callsigny aeroliniek sa denne opakujú – zobrazená trasa z databázy adsbdb zodpovedá možno inému sektoru/dňu. Poloha lietadla je priamo z ADS-B a je pravá.</div>';
      }
    }

    var ph = photoCache[a.icao24];
    if (ph && ph.src) {
      html += '<a class="plane-photo" href="' + ph.link + '" target="_blank" rel="noopener"><img src="' + ph.src + '" alt="Fotografia lietadla" loading="lazy"></a><div class="photo-credit">📷 ' + ph.by + ' · planespotters.net</div>';
    }
    html += '<div class="sheet-grid">' + progCells +
      cell('Výška', altFt + ' ft') +
      cell('Výška (m)', altM + ' m') +
      cell('Rýchlosť', spd + ' km/h') +
      cell('Rýchlosť (kt)', gsKt + ' kt') +
      cell('Stúp./kles.', vrA + ' ' + vr + ' ft/min') +
      cell('Kurz', trk) +
      cell('Squawk', a.squawk || '–') +
      cell('Stav', a.onGround ? 'na zemi' : 'v lete') +
      (a.mach != null ? cell('Mach', a.mach) : '') +
      (a.oat != null ? cell('Teplota', Math.round(a.oat) + ' °C') : '') +
      (a.category && CATEGORIES[a.category] ? cell('Kategória', CATEGORIES[a.category]) : '') +
      (myPos && a.lat != null ? cell('Odo mňa', Math.round(distKm(myPos.lat, myPos.lon, a.lat, a.lon)) + ' km') : '') +
    '</div>';
    var links = '';
    if (a.reg) {
      links += '<a class="btn ghost" href="https://www.planespotters.net/search?q=' + encodeURIComponent(a.reg) + '" target="_blank" rel="noopener">📷 Fotografie</a>';
      links += '<a class="btn ghost" href="https://www.flightradar24.com/' + encodeURIComponent(a.reg) + '" target="_blank" rel="noopener">🔎 FR24</a>';
    }
    html += '<div class="sheet-actions">' +
      '<button class="btn' + (follow === a.icao24 ? ' on' : '') + '" onclick="window.__skyFollow(&#39;' + a.icao24 + '&#39;)">' + (follow === a.icao24 ? '⏹ Ukončiť sledovanie' : '🎯 Sledovať') + '</button>' +
      '<button class="btn pin' + (pins[a.icao24] ? ' on' : '') + '" onclick="window.__skyPin(&#39;' + a.icao24 + '&#39;)">' + (pins[a.icao24] ? '📌 Odopnúť' : '📌 Pripnúť trasu') + '</button>' +
      '<button class="btn fav' + (favs[a.icao24] ? ' on' : '') + '" onclick="window.__skyFav(&#39;' + a.icao24 + '&#39;)">' + (favs[a.icao24] ? '★ V obľúbených' : '☆ Obľúbené') + '</button>' +
      links +
    '</div>';
    html += '<div class="sheet-foot">' + a.src + ' • dráha: ' + ((a.trail || []).length) + ' bodov</div>';
    return html;
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

  // limit počtu zobrazených lietadiel podľa priblíženia (pri veľkom záberu menej)
  function planeCap() {
    var z = map.getZoom();
    if (z <= 4) return 500;
    if (z <= 5) return 700;
    if (z <= 6) return 800;
    return 1000;
  }

  function renderStates(arr) {
    arr = (arr || []);
    var prio = [], rest = [];
    arr.forEach(function (a) {
      if (pins[a.icao24] || favs[a.icao24] || selected === a.icao24) prio.push(a);
      else rest.push(a);
    });
    arr = prio.concat(rest).slice(0, planeCap());
    var seen = {};
    arr.forEach(function (a) {
      if (a.lat == null || a.lon == null) return;
      if (hideGround && a.onGround) return;
      seen[a.icao24] = true;
      updateTrail(a);
      var prev = planes[a.icao24];
      if (prev) { a.trail = prev.trail; a.fromTo = prev.fromTo || a.fromTo; }
      planes[a.icao24] = a;
      var isSel = (selected === a.icao24);
      if (markers[a.icao24]) {
        markers[a.icao24].setLatLng([a.lat, a.lon]);
        markers[a.icao24].setIcon(planeIcon(a.track, a.altFt, isSel, !!favs[a.icao24], !!pins[a.icao24]));
        if (selected === a.icao24) openSheet(a);
      } else {
        var m = L.marker([a.lat, a.lon], { icon: planeIcon(a.track, a.altFt, isSel, !!favs[a.icao24], !!pins[a.icao24]) })
          .addTo(map);
        m.on('click', function () { selected = a.icao24; drawTrail(); renderSelection(); openSheet(planes[a.icao24]); });
        markers[a.icao24] = m;
      }
    });
    Object.keys(markers).forEach(function (k) {
      if (!seen[k]) {
        map.removeLayer(markers[k]);
        delete markers[k];
        delete planes[k];
        if (selected === k) { selected = null; drawTrail(); closeSheet(); }
        if (follow === k) follow = null;
      }
    });
    drawTrail();
    renderPins();
  }

  function renderSelection() {
    Object.keys(markers).forEach(function (k) {
      var p = planes[k];
      if (markers[k]) markers[k].setIcon(planeIcon(p.track, p.altFt, k === selected, !!favs[k], !!pins[k]));
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
        if (arr.length && lastSource && lastSource !== 'repo-cache') {
          var w = SRC_NAMES.indexOf(lastSource);
          if (w > 0) {
            SOURCES.unshift(SOURCES.splice(w, 1)[0]);
            SRC_NAMES.unshift(SRC_NAMES.splice(w, 1)[0]);
          }
        }
        saveLastStates(arr);
        renderStates(arr);
        // pri širokom zábere doplň lietadlá z repo-cache (celá Európa, aktualizácia každých 5 min)
        if (map.getZoom() <= 5 && lastSource !== 'repo-cache') {
          fetchRepoData().then(function (repo) {
            var bnd = map.getBounds().pad(0.2);
            var seen = {};
            arr.forEach(function (a) { seen[a.icao24] = 1; });
            var extra = repo.filter(function (a) {
              return a.lat != null && !seen[a.icao24] && bnd.contains([a.lat, a.lon]);
            });
            if (extra.length) {
              renderStates(arr.concat(extra));
              dbg('repo-cache doplnok: +' + extra.length + ' lietadiel');
            }
          }).catch(function (e) { dbg('repo-cache doplnok zlyhal: ' + e.message); });
        }
        if (follow && planes[follow]) {
          map.setView([planes[follow].lat, planes[follow].lon], map.getZoom(), { animate: false });
        }
        status(arr.length + ' lietadiel • ' + new Date().toLocaleTimeString('sk') + (lastSource ? ' • ' + lastSource : ''));
      })
      .catch(function (err) {
        // offline fallback: ak nemáme nič na mape, zobraz posledné uložené dáta
        var n = 0; for (var k in markers) { n++; }
        var cached = loadLastStates();
        if (cached && cached.data && cached.data.length && n === 0) {
          renderStates(cached.data);
          var age = Math.round((Date.now() - cached.ts) / 60000);
          status('⚠ Zdroje zlyhali – zobrazujem posledné dáta (' + age + ' min staré)');
        } else {
          status('Chyba: ' + err.message);
        }
      })
      .then(function () { inFlight = false; if (pending) { pending = false; fetchStates(); } });
  }

  function refresh() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      fetchStates();
      timer = setTimeout(refresh, REFRESH_MS);
    }, Math.max(0, REFRESH_MS - (Date.now() - lastFetch)));
  }

  // po posune/zoome mapy doplní lietadlá pre nový výrez takmer hneď (debounce 700 ms)
  var moveTimer = null;
  map.on('moveend zoomend', function () {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(fetchStates, 700);
  });
  var mapEl = map.getContainer();
  map.on('zoomstart', function () { mapEl.classList.add('zooming'); });
  map.on('zoomend', function () { mapEl.classList.remove('zooming'); });
  map.on('click', function () { if (selected) { selected = null; closeSheet(); drawTrail(); renderSelection(); } });
  map.on('dragstart', function () { follow = null; });

  // sledovanie z popupu
  window.__skyFollow = function (icao24) {
    follow = (follow === icao24) ? null : icao24;
    if (follow && planes[follow]) map.setView([planes[follow].lat, planes[follow].lon], Math.max(map.getZoom(), 8), { animate: true });
    if (icao24 === selected && planes[icao24]) openSheet(planes[icao24]);
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

  // hľadanie: callsign (IATA aj ICAO tvar) alebo hex
  document.getElementById('search').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var q = e.target.value.trim();
    if (!q) return;
    var isHex = /^[0-9a-f]{6}$/i.test(q);
    var cands = isHex ? [q] : callCandidates(q);
    status('Hľadám "' + q + '"' + (cands.length > 1 ? ' (skúšam ' + cands.join(' aj ') + ')' : '') + '…');
    var idx = 0;
    function tryOne() {
      if (idx >= cands.length) return Promise.reject(new Error('všetky tvary skúšané'));
      var c = cands[idx++];
      var url = isHex
        ? 'https://api.adsb.lol/v2/hex/' + c
        : 'https://api.adsb.lol/v2/callsign/' + encodeURIComponent(c);
      return fetchTimeout(url)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var hits = (d.ac || []).filter(function (a) { return a.lat != null; }).map(function (a) { return normAdsb(a, 'adsb.lol'); });
          if (!hits.length) return tryOne();
          return hits;
        });
    }
    // najprv medzi lietadlami, ktoré už máme na mape
    var local = null;
    cands.forEach(function (c) {
      if (local) return;
      Object.keys(planes).forEach(function (k) {
        if (!local && (planes[k].callsign || '').trim().toUpperCase() === c) local = planes[k];
      });
    });
    if (local) {
      selected = local.icao24;
      map.setView([local.lat, local.lon], Math.max(map.getZoom(), 9), { animate: true });
      drawTrail(); renderSelection(); openSheet(local);
      status('Nájdené na mape: ' + (local.callsign || '').trim());
      return;
    }
    tryOne()
      .then(function (hits) {
        var a = hits[0];
        unlockMap();
        renderStates(hits);
        selected = a.icao24;
        map.setView([a.lat, a.lon], 9, { animate: true });
        if (markers[a.icao24]) { openSheet(a); }
        status('Nájdené: ' + hits.length + ' lietadiel');
      })
      .catch(function () {
        // fallback: globálne OpenSky (skúša všetky tvary callsignu)
        status('Skúšam OpenSky globálne…');
        fetchTimeout('https://opensky-network.org/api/states/all')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            var candsLow = cands.map(function (c) { return c.toLowerCase(); });
            var hits = (d.states || []).filter(function (st) {
              var cs = (st[1] || '').trim().toLowerCase();
              return candsLow.indexOf(cs) !== -1;
            }).map(normOpenSky).filter(function (a) { return a.lat != null; });
            if (!hits.length) { status('Nič nenájdené pre "' + q + '"'); return; }
            var a = hits[0];
            unlockMap();
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

  // ---------- diagnostika (tlačidlo 🔧) ----------
  window.__skyDiag = function () {
    var panel = document.getElementById('diagPanel');
    var out = document.getElementById('diagOut');
    if (!panel || !out) return;
    panel.style.display = 'flex';
    out.innerHTML =
      '<b>SkyMonitor v' + VERSION + '</b><br>' +
      'online: ' + navigator.onLine + '<br>' +
      'service worker: ' + (navigator.serviceWorker.controller ? 'aktívny' : 'neaktívny') + '<br>' +
      'prehliadač: ' + navigator.userAgent.slice(0, 60) + '<br><br>';
    var idx = 0;
    function next() {
      if (idx >= SOURCES.length) {
        out.innerHTML += '<br><b>Hotovo.</b> Ak všetky zdroje zlyhajú, skús vypnúť rozšírenia prehliadača alebo iný prehliadač.';
        return;
      }
      var i = idx++;
      var name = SRC_NAMES[i];
      out.innerHTML += '<div id="diag' + i + '">' + name + ': <i>testujem…</i></div>';
      var t0 = Date.now();
      var p;
      try { p = SOURCES[i](); } catch (e) { p = Promise.reject(e); }
      p.then(function (arr) {
        document.getElementById('diag' + i).innerHTML = name + ': <b style="color:#2e7d32">OK — ' + arr.length + ' lietadiel (' + (Date.now() - t0) + ' ms)</b>';
      }).catch(function (err) {
        document.getElementById('diag' + i).innerHTML = name + ': <b style="color:#c62828">' + err.message + ' (' + (Date.now() - t0) + ' ms)</b>';
      }).then(next);
    }
    next();
  };
  window.__skyDiagClose = function () {
    var panel = document.getElementById('diagPanel');
    if (panel) panel.style.display = 'none';
  };
  window.__skyDiagCopy = function () {
    var out = document.getElementById('diagOut');
    var btn = document.getElementById('diagCopyBtn');
    if (!out) return;
    var text = out.innerText;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        if (btn) btn.textContent = '✓ Skopírované';
      }).catch(function () {
        if (btn) btn.textContent = 'Skopíruj ručne (označ text)';
      });
    } else if (btn) {
      btn.textContent = 'Skopíruj ručne (označ text)';
    }
  };

  // ---------- aktualizácie aplikácie: banner ↻ načíta celú appku znova ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function (r) { dbg('SW zaregistrovaný'); }).catch(function (e) { dbg('SW chyba: ' + e.message); });
  }
  var newWorker = null;
  window.__skyUpdate = function () {
    if (newWorker) { swReloadArmed = true; newWorker.postMessage('SKIP_WAITING'); }
    else location.reload();
  };
  if ('serviceWorker' in navigator) {
    var swReloadArmed = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (swReloadArmed) { swReloadArmed = false; location.reload(); }
    });
    setInterval(function () {
      navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); }).catch(function () {});
    }, 15 * 60 * 1000);
    navigator.serviceWorker.getRegistration().then(function (r) {
      if (!r) return;
      r.addEventListener('updatefound', function () {
        var nw = r.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            newWorker = nw;
            var b = document.getElementById('updBar');
            if (b) b.style.display = 'flex';
            dbg('nová verzia nainštalovaná – čakám na potvrdenie používateľa');
          }
        });
      });
    });
  }

  setTheme((function () { try { return localStorage.getItem('skymon-theme') === 'dark'; } catch (e) { return false; } })());
  renderPins();

  fetchStates();
  timer = setTimeout(refresh, REFRESH_MS);
})();
