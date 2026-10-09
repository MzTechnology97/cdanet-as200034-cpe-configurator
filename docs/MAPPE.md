# Mappe (Protomaps)

Le mappe della console (Guasti Enel e Copertura) usano **Leaflet** con la mappa di base **Protomaps**: dati OpenStreetMap in un unico file PMTiles **ospitato sul nostro server**. Nessun servizio esterno di mappe, nessun limite d'uso, nessun dato inviato a terzi.

| Componente | Licenza |
|---|---|
| Leaflet 1.9.4 (`web/vendor/leaflet`) | BSD-2-Clause |
| protomaps-leaflet 5.1.0 (`web/vendor/protomaps-leaflet`) | BSD-3-Clause |
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

## Riservatezza per gli installatori

- POP e AP sono mostrati **solo come area approssimativa** (cerchio di 1,5 km): la posizione è quella della cella di circa 1 km che contiene il punto reale, spostata di un valore fisso calcolato con un segreto del server. Non cambia tra una richiesta e l'altra, quindi non si può ricavare il punto reale facendo la media di più richieste. Le coordinate reali non arrivano mai al browser o all'app dell'installatore.
- Le distanze da POP e AP sono arrotondate (50 m sotto il km, 100 m sopra).
- La **direzione di puntamento** nella copertura resta esatta, perché serve per allineare la CPE.
- Il **numero di clienti (CPE)** di POP e AP è nascosto agli installatori, salvo che l'amministratore lo abiliti (Account → "POP/AP assegnati agli installatori").
- Gli installatori vedono solo i POP/AP assegnati.
