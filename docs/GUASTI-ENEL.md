# Guasti Enel (modulo, spento di default)

Guasti e lavori programmati della rete elettrica di **e-distribuzione** nelle zone che interessano CDA Net: un guasto in media tensione vicino a un AP significa settore a batteria o fuori servizio, e clienti senza corrente (quindi CPE spente).

## Fonte dei dati

Il server legge la **mappa pubblica delle interruzioni di e-distribuzione**, lo stesso servizio cartografico (ArcGIS FeatureServer `ITA_power_cut_map_layer_View`) usato dal loro sito:
- un controllo ogni 10 minuti;
- una sola richiesta limitata al riquadro che contiene le zone, poi il filtro per distanza avviene sul server;
- attribuzione "fonte e-distribuzione".

Non è un'API con licenza dichiarata: va usata con moderazione, come facciamo. Non copre Valle d'Aosta e Trentino-Alto Adige, che hanno altri distributori.

Il progetto [eGuasti](https://github.com/Alberto97/eGuasti) usa la stessa fonte. **Non contiene una licenza**, quindi non è stato forkato né copiato: l'integrazione è scritta da zero.

| Codice | Significato |
|---|---|
| `GM` | guasto in **media tensione** (zone ampie, spesso gli AP) |
| `GB` | guasto in bassa tensione |
| `LV` | lavoro programmato |

## POP e AP da UISP

L'elenco dei POP (site di UISP) e degli AP, con **nome, indirizzo e coordinate**, è letto da UISP a ogni controllo: niente viene inserito a mano. Per correggere un indirizzo o una posizione si modifica il site o il dispositivo in UISP (Sites/Devices → Location).
- Un AP senza posizione propria usa quella del suo POP.
- Quello che non ha posizione in UISP è elencato a parte (non monitorabile finché non viene impostata).

Console → **Guasti Enel** → "POP e AP da UISP" (admin):
- **Monitora tutti i POP e gli AP di UISP** (default), oppure
- **Monitora solo quelli selezionati**: albero con ricerca (POP, AP, SSID, indirizzo), spunta su POP (seleziona anche i suoi AP) o sui singoli AP, "Seleziona tutti" / "Nessuno", **Salva selezione**. Gli elementi selezionati e poi spariti da UISP vengono segnalati.

## POP/AP potenzialmente impattati

Un guasto più vicino di un raggio configurabile (default **1 km**, 0,1–5 km) a un POP o a un AP monitorato viene segnalato come **impatto probabile** anche fuori dalle zone: in console è in cima all'elenco con i POP/AP coinvolti, la distanza e le CPE collegate; su Telegram il messaggio inizia con 🚨 e riporta "Potenzialmente impattati".

## Mappa

Anche nell'**app** (Guasti Enel → Mappa) c'è la stessa mappa, con gli stessi limiti per gli installatori. In cima alla pagina della console una mappa (Protomaps, ospitata sul nostro server: vedi [MAPPE.md](MAPPE.md)) mostra guasti, zone, POP e AP, con quelli potenzialmente impattati in rosso. Gli installatori vedono POP e AP solo come **area approssimativa**.

## Cosa vede l'installatore

- **Le sue zone di interesse**: ogni installatore crea le proprie (massimo 20) da web o app, con GPS, indirizzo o coordinate, e vede guasti e lavori in quelle zone.
- **POP/AP potenzialmente impattati**: solo per i POP e gli AP che l'amministratore gli ha assegnato (un POP include tutti i suoi AP). Senza assegnazioni vede i guasti nelle sue zone, senza POP/AP.
- Vede anche i guasti sui POP/AP e sulle zone condivise che gli sono stati assegnati.
- Gli **amministratori vedono tutto**.
- Il **numero di clienti (CPE)** dei POP/AP è nascosto agli installatori, salvo che l'amministratore lo abiliti (Account → "POP/AP assegnati agli installatori"). Le distanze da POP/AP sono arrotondate.
- Nella console e nell'app l'installatore non vede riferimenti a UISP, alla fonte dei dati o ai moduli.

Le assegnazioni si fanno in Console → **Account** → "POP/AP assegnati agli installatori" e valgono anche per la **verifica copertura** (vedi [UISP.md](UISP.md)).

## Zone di interesse

Console → **Guasti Enel** (admin):
- **zone automatiche attorno a ogni AP e POP monitorato** (raggio configurabile, default 3 km), aggiornate da sole;
- **zone condivise** per aree extra (es. una frazione): nome, raggio e posizione, in tre modi:
  - **GPS** del dispositivo ("Usa GPS di questo dispositivo"; nel browser serve la console in HTTPS), con via, civico, città, provincia e CAP compilati automaticamente;
  - **indirizzo** (via, civico, città, provincia, CAP → "Cerca indirizzo");
  - **coordinate a mano**, con "Indirizzo dalle coordinate" per ricavare la via;
- dall'**app** (admin) la stessa cosa: GPS con indirizzo automatico, ricerca indirizzo o coordinate;
- **lavori programmati** inclusi o esclusi;
- **Controlla ora** per un controllo immediato.

La ricerca indirizzi e il passaggio GPS → via usano il geocoder del server (Nominatim locale se installato, altrimenti quello pubblico).

L'elenco mostra per ogni evento: tipo, località, zona o AP più vicino con la distanza, POP/AP impattati, clienti Enel disalimentati, inizio e ripristino previsto, link alla mappa. Mostra anche i ripristini delle ultime 48 ore. Lo storico viene tenuto 30 giorni.

## Notifiche

- **Telegram al gruppo** (admin): evento "Guasti Enel" in Connettori → Telegram. Un messaggio per ogni nuovo evento nelle zone condivise, attorno ai POP/AP o con POP/AP impattati, e uno al ripristino. Le zone personali degli installatori **non** vanno al gruppo.
- **Telegram personale** (ogni utente): Guasti Enel → Notifiche → **Collega Telegram**. Si apre il bot configurato dall'amministratore, si preme *Avvia* e poi *Verifica*; in alternativa si inserisce il proprio ID Telegram (dopo aver scritto almeno un messaggio al bot). Arrivano solo i guasti che l'utente può vedere (le sue zone e i POP/AP assegnati), con i lavori programmati facoltativi. Si scollega in ogni momento. Richiede il bot configurato in Connettori → Telegram e il modulo "Notifiche Telegram" attivo.
- **App Android**: Guasti Enel → "Avvisami dei guasti nelle mie zone". Il telefono controlla ogni 15 minuti, anche ad app chiusa (WorkManager), e mostra una notifica Android per ogni nuovo evento che l'utente può vedere. I lavori programmati sono facoltativi.
  - Per farlo l'app riceve un **token in sola lettura** valido solo per l'elenco dei guasti: non apre sessioni, scade in 90 giorni e viene revocato se l'utente cambia password o esce da tutti i dispositivi.
  - Su Android 13+ viene chiesto il permesso di notifica.

Il modulo si attiva da **Funzionalità** (anche solo per alcuni utenti).
