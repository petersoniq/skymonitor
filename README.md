# SkyMonitor

PWA aplikácia na zobrazovanie aktuálnych pozícií lietadiel na mape.

## Zdroje (všetky voľne dostupné)

- **Data:** [OpenSky Network REST API](https://opensky-network.org/api/states/all) – bez registrácie a kľúča
- **Mapa:** [Leaflet](https://leafletjs.com) + [OpenStreetMap](https://www.openstreetmap.org) dlaždice
- **Hosting:** GitHub Pages (auto deploy pri push na `main`)
- **Release:** automatický GitHub Release podľa verzie v `manifest.webmanifest`

## Funkcie

- Live pozície lietadiel v aktuálnom výreze mapy (auto-refresh ~30 s)
- Farebné odlíšenie podľa výšky, otočenie ikony podľa kurzu
- Detail lietadla: callsign, ICAO24, krajina, rýchlosť, výška (baro/geo), vertikálna rýchlosť, kurz, squawk, čas kontaktu
- Vyhľadávanie podľa callsign alebo ICAO24 hex kódu
- PWA: inštalovateľná na plochu, offline app shell, cache OSM dlaždíc

## Nastavenie GitHub Pages (raz)

1. Settings → Pages
2. Source: **GitHub Actions**

Deploy potom prebehne automaticky pri každom push na `main`.

## Roadmap

- [ ] Detailný panel lietadla s históriou dráhy
- [ ] Filtrovanie podľa výšky / krajiny / typu
- [ ] Metadáta lietadiel (typ, registrácia)
- [ ] Sledovanie konkrétneho letu
- [ ] Upozornenia na lietadlá nad vlastnou polohou

## Poznámka k limitom

OpenSky API pre anonymných používateľov má denný limit požiadaviek. Po jeho dosiahnutí aplikácia zobrazí chybu a skúsi znova.
