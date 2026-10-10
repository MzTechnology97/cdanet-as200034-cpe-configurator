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

## IA-AP: assistente della rete (admin, v1.32.55)

Console → **IA-AP**, e nell'app Rete → **IA-AP** (anche come scorciatoia della Home); solo admin, gli installatori non vedono né la scheda né i dati. Ogni ora, insieme al carico serale degli AP, il server analizza tutti gli AP airMAX di UISP e le loro CPE e scrive cosa sistemare. Solo lettura: nessuna modifica ai dispositivi.

Dati usati, tutti da UISP: stazioni collegate (segnale, rumore, modulazione attuale e ideale nei due sensi, airtime, capacità, polarizzazioni), statistiche della settimana (andamento del segnale, carico serale 20–23), **spettro misurato dall'AP e da ogni CPE** (come airView), frequenza, ampiezza, azimut e modello dell'antenna; in più il modello di copertura per il segnale atteso di ogni cliente.

| Avviso | Su | Quando |
|---|---|---|
| SNR basso | CPE | sotto 20 dB (critico sotto 12) |
| Modulazione | CPE / AP | 4 o più livelli sotto l'ideale (attenzione da 6); sull'AP quando almeno metà delle CPE (minimo 4) è sotto (critico tre quarti) |
| Airtime eccessivo | CPE | oltre il 5% dell'airtime (critico 10%) e 3 volte la mediana dell'AP |
| Segnale in calo | CPE | ultimo giorno peggiore dei primi due della settimana di 6 dB (critico 10) |
| Sotto il segnale atteso | CPE | 10 dB sotto la stima del modello: puntamento o ostacolo nuovo |
| Polarizzazioni | CPE | le due catene differiscono di 8 dB o più |
| Interferenza dal cliente | CPE | la CPE vede il canale molto più occupato dell'AP |
| Spostamento su altro AP | CPE | AP carico e un altro AP libero è "buono" per quel cliente |
| Carico serale | AP | airtime o utilizzo del canale tra le 20 e le 23 oltre il 50% (critico 70%) |
| Rumore all'AP | AP | rumore di fondo sopra −78 dBm |
| Canale sovrapposto | AP | un nostro AP entro 6 km sullo stesso canale e dentro il fascio dell'altro |
| Canale più libero | AP | un canale con almeno 4 punti di occupazione in meno, da AP e CPE insieme |
| Ampiezza del canale | AP | più stretta per molti collegamenti deboli, più larga per un AP carico con margine di SNR |

**Canali proposti**: sempre interi dentro la banda di Impostazioni server → Assistente rete (predefinita 5120–5800 MHz), mai sovrapposti a un nostro AP vicino. Lo spettro considerato è la media di quello dell'AP e di quello mediano delle sue CPE. Il cambio di frequenza stima anche la **risposta in frequenza delle antenne** (guadagno migliore a centro banda, circa 1,5 dB in meno per antenna ai bordi) e la perdita di percorso: un canale che porterebbe il cliente più debole sotto il minimo del collaudo viene scartato.

Ogni avviso dice cosa fare e, dove serve, i parametri (frequenza, ampiezza); per le CPE c'è il link alla scheda (nell'app: Gestisci CPE). *Ignora 7/90 giorni* nasconde un avviso (registrato nello storico eventi); *Aggiorna ora* rilegge UISP senza aspettare l'ora. I nuovi problemi critici arrivano come notifica a tutti gli admin (Notifiche → "Assistente rete").

## Statistiche (admin)

Per gli ultimi 3, 6, 12 o 24 mesi:
- **per mese**: provisioning riusciti e falliti (grafico), collaudi superati, con riserva e non superati, segnale e download medi dei collaudi, sostituzioni, CPE accettate in UISP;
- **per installatore**: riuscite, percentuale di fallimenti, quota di installazioni collaudate, collaudi con riserva, segnale medio, ultimo intervento;
- **per modello**: provisioning e percentuale di fallimenti.

I falliti sono **tentativi**: un'installazione riuscita al secondo tentativo conta un fallito e un riuscito.
