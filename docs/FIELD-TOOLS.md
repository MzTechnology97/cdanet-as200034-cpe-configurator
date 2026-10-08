# Strumenti di campo (app Android)

Strumenti per l'installatore su una CPE **già provisionata**: puntamento, diagnosi guasti e, a seguire, collaudo e sostituzione.

## Come il telefono raggiunge la CPE

L'app prova da sola, in quest'ordine:
1. il **gateway della Wi-Fi** a cui è collegato il telefono;
2. l'**IP LAN della CPE** (`CPE_LAN_IP`, default `192.168.1.254`): telefono sulla Wi-Fi del router del cliente, dietro la CPE;
3. l'**IP di management** (`CPE_FACTORY_IP`, default `192.168.172.1`): telefono sulla **Wi-Fi di management** della CPE (radio 2,4 GHz dei modelli airMAX AC Gen2), se il template la lascia attiva.

Su ogni indirizzo prova l'interfaccia web di airOS: `https` sulle porte 443 e 20443, poi `http` sulle porte 80 e 20080. Con "IP manuale" si indica direttamente l'indirizzo.

Il traffico verso la CPE passa sempre dalla Wi-Fi (anche se la Wi-Fi non ha Internet), mentre il server resta raggiungibile con i dati mobili.

## Credenziali

Le credenziali CDA Net della CPE (`CPE_ADMIN_USERNAME`/`CPE_ADMIN_PASSWORD`) arrivano dal server con `POST /api/field/access`:
- solo verso l'app Android riconosciuta (header `X-CDA-Client`, versione minima);
- in risposta `no-store`, tenute solo in memoria;
- con validità di 8 ore;
- ogni consegna è registrata nel Registro attività ("Accesso alla CPE dagli strumenti di campo").

L'app le richiede subito dopo il login, così gli strumenti funzionano anche più tardi sul tetto senza Internet.

Lo stato si legge da `/status.cgi` dopo il login su `/api/auth`, cioè la stessa API usata dall'interfaccia web della CPE. Il certificato della CPE è autofirmato, quindi non viene verificato: per questo il client accetta solo indirizzi privati.

## Puntamento antenna

- **Segnale ricevuto** in grande, colorato: verde ≥ −65 dBm, giallo fino a −75, rosso sotto.
- **Segnale atteso** stimato da airMAX per quella distanza, con lo scarto in dB.
- **Picco** raggiunto e grafico degli ultimi 90 secondi con le soglie.
- **Catene**: segnale delle due polarizzazioni. Uno sbilanciamento oltre 6 dB indica ostacolo, riflessione o antenna non allineata in elevazione.
- **Bip** a ogni lettura (una al secondo): il tono sale con il segnale, così si punta guardando l'AP e non il telefono.
- AP agganciato, distanza, frequenza, segnale lato AP, CINR, capacità e rumore.
- Lo schermo resta acceso finché lo strumento è aperto.

## Diagnosi CPE

Elenco di controlli, ognuno con la spiegazione di cosa fare:

| Controllo | Cosa segnala |
|---|---|
| Collegamento all'AP | CPE non agganciata: puntamento, SSID, chiave |
| Segnale ricevuto / lato AP | sotto soglia, scarto dal segnale atteso |
| Catene | sbilanciamento tra polarizzazioni |
| CINR | interferenze sul canale |
| Capacità airMAX | sotto il minimo per una nuova installazione |
| Porta LAN | cavo scollegato; **10 Mbit/s o half duplex = cavo/connettore rovinato** |
| PPPoE | sessione non attiva (utente/password, abbonamento) oppure IP pubblico |
| Firmware | diverso dallo standard CDA Net |
| Accesa da | riavvio recente (alimentazione/PoE) |
| Temperatura | surriscaldamento |

Il rapporto si copia o si condivide con il NOC (WhatsApp, Telegram, email). Non contiene credenziali né dati del cliente.

## Soglie

Le decide il server (`server/src/routes/field.ts`, `FIELD_THRESHOLDS`), così il NOC può cambiarle senza pubblicare una nuova app: segnale buono −65 dBm, minimo −75 dBm, CINR 20 dB, sbilanciamento catene 6 dB, capacità minima 100 Mbit/s, porta LAN minima 100 Mbit/s.

## Collaudo dell'installazione

Dall'app: **Storico → job completato → Collaudo**, oppure subito dopo un provisioning riuscito.

1. **Misure radio**: 10 letture in 10 secondi. Il segnale viene mediato (con minimo e massimo) e i controlli della diagnosi vengono applicati alla media.
2. **Internet dal lato cliente**: con il telefono sulla Wi-Fi del router del cliente, ping e velocità verso il server CDA Net passano dalla nuova linea (mai dai dati mobili). Se il telefono è sulla Wi-Fi di management della CPE, la misura viene segnalata come non eseguita.
3. **Foto**: fino a 8, con didascalia (Antenna, Staffa/palo, Cablaggio, Router cliente, Altro). Vengono ridotte a 1600 px e raddrizzate prima dell'invio.
4. **Note** per il NOC.

L'esito (superato, con riserva, non superato) è calcolato dalle soglie del server. Prima dell'invio l'app manda l'esito del provisioning, se è ancora in coda. Le foto non inviate restano nell'app per riprovare.

Sul server: `PUT /api/provisioning/jobs/{id}/acceptance` e `POST /api/provisioning/jobs/{id}/photos` (JPEG, max 3 MB, max 8 per job). Le foto sono salvate su disco in `PHOTOS_DIR` (default `photos/` accanto al database, quindi nel volume `/data` del container) e vengono cancellate insieme al job dalla retention GDPR.

Nella **console web**, Storico → job, la sezione *Collaudo* mostra misure, controlli, note e foto. Il pulsante **Verbale di installazione** apre un verbale stampabile (o salvabile in PDF) con dati dell'installazione, misure, controlli, foto e spazio per le firme di installatore e cliente.

## Sostituzione CPE

Dall'app: **Storico → job completato → Sostituisci CPE**. Si apre il provisioning con cliente, SSID, template e posizione della CPE guasta: basta inserire (o scansionare) **MAC e seriale della CPE nuova**.

La **password PPPoE** si può lasciare vuota: il server la legge dall'ultimo backup UISP della CPE sostituita (dalla chiave del template che contiene `${PPPOE_PASSWORD}`, di norma `ppp.1.password`) e la inserisce nella configurazione. Non viene mai mostrata né salvata. Se UISP non è configurato o il backup non la contiene, l'app chiede di inserirla.

Il nuovo job risulta collegato a quello sostituito ("Sostituisce la CPE del job …" nello storico web). Nel Registro attività resta l'evento *Sostituzione CPE*, con l'origine della password (installatore o backup UISP).

## Bussola verso l'AP

Dall'app: **Copertura → AP → Bussola**. L'azimut dell'AP arriva dal server (Nord vero, calcolato dalle coordinate UISP).

La bussola indica dove girare ("Gira di 23° a destra", "Allineato" entro ±3°), ma solo dopo aver verificato che il magnetometro sia affidabile:
- **Calibrazione**: viene letto lo stato che Android riporta per il sensore magnetico. Con calibrazione bassa o assente la bussola si dichiara non affidabile e chiede di muovere il telefono "a 8".
- **Precisione stimata**: se il telefono la fornisce (sensore di rotazione), oltre ±20° la bussola non è usabile.
- **Disturbi magnetici**: l'intensità del campo misurata viene confrontata con quella attesa in quel punto (modello geomagnetico mondiale, circa 44 µT in Sicilia). Uno scarto oltre 8 µT indica metallo vicino (palo, staffa, ringhiere, auto, quadri elettrici); oltre 15 µT la bussola è considerata non affidabile.
- **Declinazione magnetica**: applicata automaticamente, così il Nord della bussola coincide con il Nord vero dell'azimut.
- **Inclinazione**: il telefono va tenuto in piano; oltre 30° compare un avviso.

La bussola serve per il puntamento grossolano; quello fine si fa con il segnale (Puntamento antenna).

## Storico segnale (UISP)

Per una CPE già accettata in UISP, lo storico è disponibile in due punti: nella console web (Storico → job → *Storico segnale*, per giorno, settimana o mese) e nell'app (Storico → job → *Storico segnale*, ultimi 7 giorni).

Mostra:
- il grafico del segnale ricevuto e di quello lato AP, con le soglie;
- minimo, media e massimo;
- la capacità media;
- le interruzioni (UISP `/outages`).

Se il segnale nell'ultimo quarto del periodo è più basso di almeno 4 dB rispetto al primo quarto, viene segnalato un **degrado lento** (vegetazione, antenna spostata, staffa allentata). Questo aiuta a distinguerlo da un guasto improvviso.

API usate: `GET /devices/{id}/statistics` (`interval`, `start`, `period`) e `GET /outages` (`deviceId`, `start`, `period`) della specifica UISP API 1.5.0.

## Strumenti di rete

- **Discovery LAN → Trova apparati Ubiquiti**: invia la richiesta di discovery Ubiquiti (UDP 10001, la stessa usata da UISP) e ascolta gli annunci degli apparati (UDP 10002). Mostra IP, MAC, modello, firmware, nome e SSID di CPE e AP sulla LAN, anche quando l'IP non è noto. Non attraversa i router: il telefono deve essere sulla stessa LAN.
- **Scansione subnet**: accanto a ogni host con MAC noto compare il **produttore** (Ubiquiti, MikroTik, TP-Link, Hikvision…), letto dal server dopo la scansione. Senza Internet viene semplicemente omesso.
- **Wi-Fi Analyzer**: oltre all'elenco delle reti indica il **canale consigliato per il router del cliente**:
  - 2.4 GHz: tra 1, 6 e 11, tenendo conto delle sovrapposizioni;
  - 5 GHz: tra 36 e 48, senza DFS né attese radar.

  Le reti vicine pesano in base al segnale.
