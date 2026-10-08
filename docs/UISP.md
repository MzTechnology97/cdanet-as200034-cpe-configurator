# Integrazione UISP, posizione GPS e copertura

## Configurazione

Dalla console web, menu **Connettori** (solo amministratori), card **UISP**:
- **Indirizzo UISP**, es. `https://uisp.esempio.it`. Va bene anche l'URL delle API incollato per intero (`…/nms/api/v2.1`): viene ridotto da solo;
- **Token API**: si crea in UISP da **Settings → Users → API tokens**, con permesso di scrittura (serve per accettazione e backup). Viene salvato cifrato con la master key e non viene più mostrato (solo le ultime 4 cifre). Lasciando il campo vuoto si mantiene quello salvato;
- **Ignora verifica TLS**: da attivare solo se UISP usa un certificato autofirmato e il server lo raggiunge su una rete di gestione fidata;
- **Backup automatico** dopo "Accetta in UISP", **raggio della Copertura** (km) e **cache** dei dati UISP (secondi).

**Testa connessione** prova i valori del modulo senza salvarli e mostra versione di UISP, latenza, dispositivi, AP (e quanti con posizione), dispositivi in attesa e site. **Salva** applica subito la configurazione, senza riavviare il container. Ogni modifica finisce nel Registro attività.

In alternativa, o per le installazioni esistenti, restano validi i parametri del `.env` (`sudo cdanet-cpe edit`):

```
UISP_API_URL=https://uisp.esempio.it
UISP_API_TOKEN=<token creato in UISP>
UISP_IGNORE_TLS=0
```

Se nella console c'è una configurazione salvata, questa ha la precedenza; **Rimuovi configurazione** torna ai valori del `.env`.

### API usate e compatibilità

Le chiamate usano le API **UISP v2.1** (`/nms/api/v2.1`, header `x-auth-token`), verificate sulla specifica ufficiale *UISP API 1.5.0*, che vale anche per **UISP 3.1.x** (in uso la 3.1.65):

| Funzione | Chiamata |
|---|---|
| Test e versione | `GET /nms/version`, `GET /devices`, `GET /sites` |
| AP vicini e stato CPE | `GET /devices` (ruolo, `authorized`, `attributes.ssid`, `attributes.apDevice`, `location`) |
| Posizione dei site | `GET /sites` (`description.location`) |
| Accettazione CPE pending | `POST /devices/{id}/authorize` con `{ "siteId": … }` |
| Backup | `GET`/`POST /devices/{id}/backups`, `GET /devices/{id}/backups/{backupId}` (per airMAX è il `.cfg`) |

Il site proposto per l'accettazione è quello dell'AP a cui la CPE è agganciata (`attributes.apDevice.siteId`). Gli endpoint dei profili AP non vengono usati perché espongono le chiavi Wi-Fi. La documentazione Swagger della vostra installazione è su `https://<uisp>/nms/api-docs`.

## Posizione della CPE

Nel modulo di provisioning dell'app, sezione **Posizione CPE e AP vicini**, la posizione si ottiene in due modi:
- **Usa GPS del telefono**: funziona anche offline;
- **indirizzo** (via, civico, CAP, comune), cercato tramite OpenStreetMap: con Nominatim locale (vedi [DEPLOY.md](DEPLOY.md#openstreetmap-locale-ricerca-indirizzi)) la ricerca resta sul server.

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
