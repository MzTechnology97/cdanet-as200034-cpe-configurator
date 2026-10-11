# Mappe (Protomaps)

Le mappe della console (Guasti Enel e Copertura) usano **Leaflet** con la mappa di base **Protomaps**: dati OpenStreetMap in un unico file PMTiles **ospitato sul nostro server**. Nessun servizio esterno di mappe, nessun limite d'uso, nessun dato inviato a terzi.

| Componente | Licenza |
|---|---|
| Leaflet 1.9.4 (`web/vendor/leaflet`) | BSD-2-Clause |
| protomaps-leaflet 5.1.0 (`web/vendor/protomaps-leaflet`) | BSD-3-Clause |
| MapLibre GL JS 4.7.1 (`web/vendor/maplibre-gl`, solo vista 3D admin) | BSD-3-Clause |
| Dati della mappa | © OpenStreetMap contributors (ODbL), build Protomaps |

La ricerca indirizzi e il passaggio GPS → via restano su Nominatim (vedi [DEPLOY.md](DEPLOY.md)).

## Installazione e aggiornamento

L'installer scarica la mappa della regione (default quella del geocoder, altrimenti `sicilia`) nel volume dati dell'app (`/data/maps/basemap.pmtiles`) e la aggiorna **una volta al mese** (timer systemd `cdanet-cpe-map.timer`).

```bash
sudo CDANET_MAP=local CDANET_MAP_REGION=sicilia ./deploy/install-debian.sh
```

- Regioni: `sicilia`, `isole`, `sud`, `centro`, `nord-est`, `nord-ovest`, `italia`, `custom` (con `CDANET_MAP_BBOX=minLon,minLat,maxLon,maxLat`).
- Dimensioni indicative (zoom fino a 15): Sicilia qualche centinaio di MB, Italia qualche GB.
- `CDANET_MAP=off`: niente download; la console usa le mappe pubbliche di OpenStreetMap.

Comandi:

```bash
sudo cdanet-cpe map            # stato
sudo cdanet-cpe map update     # scarica/aggiorna ora
sudo cdanet-cpe map remove     # rimuove (si torna alle mappe pubbliche)
```

Il download avviene in un container temporaneo (`maptiles`, Debian) con lo strumento ufficiale `pmtiles` (versione fissata, controllo SHA-256), che estrae solo l'area richiesta dall'ultima build giornaliera di Protomaps.

Finché la mappa non è installata, la console usa le tile pubbliche di OpenStreetMap (permesse dalla Content-Security-Policy solo per questo).

## Cosa mostrano

**Guasti Enel**: guasti (rosso MT, arancio BT, grigio lavori), zone (tratteggiate), POP e AP; quelli potenzialmente impattati in rosso.

**Copertura**: il punto verificato, gli AP vicini con la linea di puntamento.

## Immagini satellitari per gli admin (v1.32.59)

Connettori → **Immagini satellitari**: una o più fonti di foto aeree per le mappe della console degli amministratori.

| Fonte | Cosa serve | Viste |
|---|---|---|
| Mapbox | token (account.mapbox.com) | Satellite, Ibrida |
| Esri (ArcGIS) | chiave API ArcGIS Location Platform con il privilegio Basemaps | Satellite, Ibrida (foto + strade + nomi) |
| Google | chiave API con la Map Tiles API e un account di fatturazione | Satellite, Ibrida |
| Ortofoto pubbliche (WMS) | niente: predefinite le ortofoto AGEA 2012 del Geoportale Nazionale, indirizzo e layer modificabili | Ortofoto (da zoom 9) |

- **Visualizzazioni (admin):** nel selettore in alto a destra, come sfondo, la mappa base (tema del sistema, chiara, scura, grigia) e le foto aeree. Sopra si possono aggiungere i livelli **Strade e vie** (con i nomi), **Edifici**, **Località e nomi**, **Acque** e **Confini**, presi dalla mappa base: sulle foto aeree danno una vista ibrida anche con le ortofoto. Sfondo e livelli scelti restano su quel browser.
- **Confronto:** ogni fonte attiva compare nel selettore in alto a destra delle mappe (per esempio «Satellite · Esri», «Ibrida · Mapbox»). Si attivano più fonti per confrontarle sullo stesso punto, poi si lascia accesa quella scelta; la vista scelta resta su quel browser.
- **Chiavi e immagini:** le chiavi sono cifrate sul server e le immagini passano da lì (`/api/admin/map/imagery/...`, solo admin collegati). Nessuna chiave arriva ai browser.
- **Cache:** il browser dell'admin tiene le immagini per 12 ore; sul server non viene salvato nulla.
- **Installatori e app:** gli installatori, la mappa nell'app e quella incorporata vedono sempre la mappa base.
- **Vista 3D (admin):** in Copertura, dal pannello del collegamento o dalla scheda «Collegamento con…», **Vista 3D** apre a tutto schermo il terreno in rilievo con sopra le foto aeree di Connettori (scelta in alto, ricordata dal browser), la **linea di vista** e il **60% della prima zona di Fresnel** come tubo (azzurro libero, rosso dove terreno, edifici o alberi ci entrano), gli edifici e gli alberi sul percorso, i pali di CPE e AP alle altezze del calcolo e gli altri AP intorno. Viste rapide *Di lato*, *Dalla CPE*, *Dall'AP*, *Dall'alto*; si ruota e inclina con il mouse (tasto destro o Ctrl) o con due dita. Le altezze sono reali; linea, tubo e pali sono allargati in proporzione alla lunghezza del collegamento per restare visibili. Gli edifici della mappa base sono in rilievo (altezza OSM, altrimenti 7 m). Anche la simulazione di un AP ha la sua *Vista 3D*: le celle colorate stese sul terreno.
- **Terreno 3D:** è lo stesso del calcolo di copertura (TINITALY 10 m dove importato, altrimenti SRTM 30 m), servito dal server come piastrelle PNG in codifica Terrarium (`/api/admin/map/terrain/{z}/{x}/{y}`, zoom 10–14, solo admin), tenute in memoria (ultime 400) e rifatte dopo un nuovo import. Senza foto aeree il terreno è mostrato con l'ombreggiatura.

## Riservatezza per gli installatori

- POP e AP sono mostrati **solo come area approssimativa** (cerchio di 1,5 km): la posizione è quella della cella di circa 1 km che contiene il punto reale, spostata di un valore fisso calcolato con un segreto del server. Non cambia tra una richiesta e l'altra, quindi non si può ricavare il punto reale facendo la media di più richieste. Le coordinate reali non arrivano mai al browser o all'app dell'installatore.
- Le distanze da POP e AP sono arrotondate (50 m sotto il km, 100 m sopra).
- La **direzione di puntamento** nella copertura resta esatta, perché serve per allineare la CPE.
- Il **numero di clienti (CPE)** di POP e AP è nascosto agli installatori, salvo che l'amministratore lo abiliti (Account → "POP/AP assegnati agli installatori").
- Gli installatori vedono solo i POP/AP assegnati.

## Tile singole (v1.32.1)

Il server legge il file PMTiles e serve ogni tile a sé: `/map/tiles/{z}/{x}/{y}.mvt`, con cache del browser di un giorno e URL che cambia con la mappa. Console e app fanno richieste normali invece di letture a intervalli di byte del file: alcune WebView Android (es. Android 16, Chrome 153) le rifiutavano e la mappa restava bianca. `/map/basemap.pmtiles` resta disponibile.
