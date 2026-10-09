# Pagine NOC della console

## Salute CPE (modulo, spento di default)

- **Admin**: menu *Salute CPE*, **tutte le CPE dei clienti presenti in UISP** (stazioni dei clienti; esclusi AP e link PtP), sia quelle installate con l'app sia quelle installate prima o senza app. Filtri per problema, origine (app / solo UISP / assegnate / non assegnate) e ricerca (cliente, MAC, AP, installatore); `?installer=` e `?scope=app` anche via API.
- **Assegnazione agli installatori**: l'admin seleziona le CPE (anche "tutte le filtrate", es. tutte quelle di un AP) e le assegna a un installatore, o rimuove l'assegnazione. Le CPE assegnate compaiono in *Le mie CPE* dell'installatore (web e app).
- **Installatori**: menu *Le mie CPE*, le CPE installate da loro con l'app più quelle assegnate.

Per le CPE installate con l'app si considera l'ultimo provisioning riuscito per MAC non seguito da una sostituzione, e lo stato attuale si confronta con il **collaudo**; per le altre (solo UISP) valgono le stesse regole tranne "segnale calato" (non c'è un collaudo).

Per ogni CPE si confronta lo stato attuale in UISP con il **collaudo**:

| Problema | Regola |
|---|---|
| Offline | stato UISP `disconnected`, `inactive` o `unknown` |
| Non trovata in UISP | nessun dispositivo UISP con quel MAC |
| Segnale debole | sotto −75 dBm (solo CPE online) |
| Segnale calato | almeno 6 dB in meno rispetto al collaudo (vegetazione, antenna spostata) |
| Porta LAN | sotto 100 Mbit/s oppure half duplex: quasi sempre cavo o connettore |
| Capacità bassa | capacità airMAX in download sotto 100 Mbit/s |
| Da accettare | ancora in attesa in UISP |
| Firmware | diverso dallo standard CDA Net |

Dati esposti: nome del cliente (come in UISP / nello storico), modello, MAC, SSID, AP, segnale, porta LAN, firmware, data di installazione. **Mai** utente o password PPPoE, chiavi Wi-Fi o configurazione.

Dall'elenco: link allo storico della CPE e, nell'app, lo storico del segnale degli ultimi 7 giorni (se il modulo Storico segnale è attivo). Export CSV con il modulo Export CSV attivo.

## Statistiche (admin)

Per gli ultimi 3, 6, 12 o 24 mesi:
- **per mese**: provisioning riusciti e falliti (grafico), collaudi superati, con riserva e non superati, segnale e download medi dei collaudi, sostituzioni, CPE accettate in UISP;
- **per installatore**: riuscite, percentuale di fallimenti, quota di installazioni collaudate, collaudi con riserva, segnale medio, ultimo intervento;
- **per modello**: provisioning e percentuale di fallimenti.

I falliti sono **tentativi**: un'installazione riuscita al secondo tentativo conta un fallito e un riuscito.
