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

## Zone di interesse

Console → **Guasti Enel** (admin):
- **zone automatiche attorno agli AP di UISP** (raggio configurabile, default 3 km), aggiornate da sole;
- **zone manuali**: nome, indirizzo (o coordinate "lat, lon") e raggio;
- **lavori programmati** inclusi o esclusi;
- **Controlla ora** per un controllo immediato.

L'elenco mostra per ogni evento: tipo, località, zona o AP più vicino con la distanza, clienti Enel disalimentati, inizio e ripristino previsto, link alla mappa. Mostra anche i ripristini delle ultime 48 ore. Lo storico viene tenuto 30 giorni.

## Notifiche

- **Telegram**: evento "Guasti Enel" in Connettori → Telegram. Un messaggio per ogni nuovo evento nelle zone e uno al ripristino.
- **App Android**: Guasti Enel → "Avvisami dei guasti nelle zone CDA Net". Il telefono controlla ogni 15 minuti, anche ad app chiusa (WorkManager), e mostra una notifica Android per ogni nuovo evento. I lavori programmati sono facoltativi.
  - Per farlo l'app riceve un **token in sola lettura** valido solo per l'elenco dei guasti: non apre sessioni, scade in 90 giorni e viene revocato se l'utente cambia password o esce da tutti i dispositivi.
  - Su Android 13+ viene chiesto il permesso di notifica.

Il modulo si attiva da **Funzionalità** (anche solo per alcuni utenti).
