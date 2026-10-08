# Integrazione UISP, posizione GPS e copertura

## Configurazione

Nel `.env` del server (`sudo cdanet-cpe edit`):

```
UISP_API_URL=https://uisp.esempio.it
UISP_API_TOKEN=<token creato in UISP>
```

Il token si crea in UISP da **Settings → Users → API tokens** e serve con permesso di scrittura (accettazione e backup). Resta solo sul server: non viene mai inviato a browser o app. Il risultato si verifica in **Panoramica → UISP**: numero di dispositivi, AP (e quanti hanno una posizione), dispositivi in attesa e site.

Le chiamate usano le API **UISP v2.1** (`/nms/api/v2.1`, header `x-auth-token`). Se la vostra versione espone percorsi diversi, la Panoramica mostra l'errore con il codice HTTP: indicamelo e lo adeguo. La documentazione Swagger della vostra installazione è su `https://<uisp>/nms/api-docs`.

## Posizione della CPE

Nel modulo di provisioning dell'app, sezione **Posizione CPE e AP vicini**, la posizione si ottiene in due modi:
- **Usa GPS del telefono**: funziona anche offline;
- **indirizzo** (via, civico, CAP, comune), cercato tramite OpenStreetMap.

La posizione:
- viene salvata nello storico, con precisione e origine (GPS o indirizzo); nel dettaglio del job c'è il link alla mappa;
- viene scritta nella CPE (`system.latitude`/`system.longitude` di airOS), così UISP la mostra al posto giusto.

## AP più vicini e Copertura

A partire dalla posizione, il server chiede a UISP gli AP e restituisce **solo i più vicini** (massimo 5) entro `COVERAGE_MAX_KM` (default 15 km). La mappa completa della rete non viene mai esposta. Per ogni AP:
- distanza;
- **direzione di puntamento** (azimut in gradi e punto cardinale);
- SSID, site, stato e client collegati.

Le coordinate dell'AP sono quelle del dispositivo in UISP o, se mancano, quelle del suo site.

- **App, provisioning**: *Usa* su un AP compila nodo e distretto dal suo SSID (`CDA-NET-N{nodo}-D{distretto}`).
- **App e console, sezione Copertura**: la stessa verifica, senza provisioning, per sopralluoghi e preventivi.

Il servizio indirizzi è OpenStreetMap Nominatim: riceve solo l'indirizzo cercato, mai i dati del cliente. Le richieste sono limitate a 1 al secondo e messe in cache.

## Storico provisioning → UISP

Nel dettaglio di un provisioning completato, la sezione **UISP**:
- trova la CPE in UISP per MAC e ne mostra lo stato: in attesa o accettata, online, segnale, AP agganciato, site e firmware;
- **Accetta in UISP** (solo admin) autorizza la CPE nel **site dell'AP a cui è agganciata**. Se l'AP non è ancora noto, usa l'AP che trasmette l'SSID del job più vicino alla posizione della CPE; se non si può determinare, l'admin sceglie il site. Nessuna CPE viene accettata automaticamente senza questo pulsante;
- dopo l'accettazione parte un **backup** automatico (`UISP_AUTO_BACKUP=1`);
- **Backup ora** e l'elenco dei backup, scaricabili dalla console.

Accettazioni e backup vengono registrati nel **Registro attività**.
