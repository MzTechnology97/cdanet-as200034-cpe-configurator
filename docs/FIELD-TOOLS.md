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

Ordine dei tentativi sulla CPE: credenziali **inserite a mano** (se presenti), poi quelle **CDA Net**, poi quelle **di fabbrica** airOS (`ubnt`/`ubnt`). Se la CPE le rifiuta tutte (CPE configurata a mano o prima dell'app con altre credenziali) l'app si ferma — niente tentativi ripetuti — e mostra **Credenziali della CPE** per inserire utente e password: valgono solo per quella sessione, restano in memoria e non vengono mai salvate né inviate al server. Si possono inserire anche prima con "Credenziali diverse". Quando la CPE si apre con credenziali non standard l'app lo segnala.

Lo stato si legge da `/status.cgi` dopo il login su `/api/auth`, cioè la stessa API usata dall'interfaccia web della CPE. Il certificato della CPE è autofirmato, quindi non viene verificato: per questo il client accetta solo indirizzi privati.

## Puntamento antenna

- **Segnale ricevuto** in grande, colorato: verde ≥ −65 dBm, giallo fino a −75, rosso sotto.
- **Segnale atteso** stimato da airMAX per quella distanza, con lo scarto in dB.
- **Picco** raggiunto e grafico degli ultimi 90 secondi con le soglie.
- **Catene**: segnale delle due polarizzazioni. Uno sbilanciamento oltre 6 dB indica ostacolo, riflessione o antenna non allineata in elevazione.
- **Bip** a ogni lettura (una al secondo): il tono sale con il segnale, così si punta guardando l'AP e non il telefono.
- AP agganciato, distanza, frequenza, segnale lato AP, CINR, capacità e rumore.
- Lo schermo resta acceso finché lo strumento è aperto.

### AP visibili dalla CPE (site survey)
Nella schermata Puntamento, **Scansiona AP dalla CPE** chiede alla radio della CPE quali AP sente da lì (site survey airOS): SSID, segnale, rumore e SNR, frequenza/canale, modalità, sicurezza, airMAX; gli AP CDA Net (`CDA-NET-Nx-Dy`) sono evidenziati con il migliore in cima e l'AP agganciato è segnato. Durante la scansione il collegamento della CPE può interrompersi per qualche secondo. *Da verificare su CPE reale*: gli endpoint del site survey cambiano tra le versioni di airOS (vengono provati quelli noti; se nessuno risponde compare "Site survey non disponibile su questo firmware").

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

## Trova l'AP (mappa, lista e mirino in fotocamera)

Dal GPS del telefono l'app mostra gli AP vicini (per gli installatori solo quelli assegnati):
- **Lista**: distanza, altitudine dell'antenna (m s.l.m.), **azimut** (Nord vero), **tilt** e **segnale stimato**; per ogni AP i pulsanti **Mirino** e **Bussola**.
- **Mappa**: la mappa della console (Protomaps sul nostro server) con la tua posizione e una freccia che segue la direzione del telefono; gli AP come punto (admin) o area approssimativa (installatori) con la linea di puntamento.
- **Mirino in fotocamera**: inquadri con la fotocamera posteriore; il punto dell'AP viene disegnato dove si trova (azimut + tilt), con frecce quando è fuori schermo e il mirino che diventa verde (e vibra) quando sei allineato entro 2°. In basso: azimut e tilt richiesti e quelli attuali del telefono. Funziona in verticale; avvisa se la bussola non è calibrata (movimento a 8).

**Tilt**: se UISP riporta l'altitudine dal GPS interno dell'AP, si usa quella (in lista "(GPS)"); altrimenti altitudine del terreno dal modello SRTM (il server scarica e tiene in cache solo le zone usate, ~12 MB per grado; `DEM_URL` vuoto lo disattiva) più le altezze dal suolo impostate dall'admin in Copertura → "Puntamento (app)" (antenne AP, default 15 m; CPE, default 6 m, modificabile dal tecnico). Tiene conto della curvatura terrestre.

**Segnale stimato**: per ogni AP il server usa le CPE già collegate (posizione del cliente e segnale reale da UISP): ricava il settore già servito, fin dove arrivano i clienti e l'andamento del segnale con la distanza, poi corregge con i clienti più vicini al punto. Mostra valore, intervallo e affidabilità (alta/media/bassa); avvisa se il punto è fuori dal settore servito o più lontano dei clienti attuali. Le posizioni dei clienti non lasciano mai il server; agli installatori il numero di clienti su cui si basa la stima è nascosto salvo diversa scelta dell'admin.

Il puntamento fine resta quello sul segnale reale (Puntamento antenna).

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

### Collaudo senza rete

Misure, note e foto vengono **sempre** salvate prima nella memoria privata dell'app e poi inviate da una coda:
- se c'è rete partono subito;
- altrimenti restano sul telefono e vengono ritentate dopo il login e ogni 2 minuti, oppure a mano da Impostazioni → *Invia collaudi ora*. Prima viene sempre inviato l'esito del provisioning.

La Home e le Impostazioni mostrano quanti collaudi e foto sono in attesa. Le foto inviate vengono cancellate dal telefono.

## Strumenti di rete professionali (v1.13)

Tutti questi strumenti richiedono la **Wi-Fi della rete da analizzare**. Se il telefono è sui dati mobili, la schermata lo dice, apre il popup Wi-Fi di Android e si sblocca da sola appena il telefono è collegato.

### Scanner IP
- Subnet fino a /22, proposta in automatico dalla Wi-Fi collegata.
- **Rilevamento degli host**: sondaggio TCP su 16 porte comuni (anche una connessione rifiutata prova che l'host è acceso) e ping ICMP per gli host che non rispondono su TCP.
- **Nomi**: DNS inverso chiesto al DNS della LAN (il router conosce i suoi client DHCP) e nomi NetBIOS dei PC Windows.
- **MAC**: dalla discovery Ubiquiti, da NetBIOS e dalla tabella ARP dove Android la rende disponibile.
- **Produttore** di ogni MAC dal registro ufficiale IEEE (MA-L/MA-M/MA-S), che il server scarica e aggiorna ogni 30 giorni. I MAC casuali dei telefoni vengono indicati come tali.
- **Tipo di apparato** stimato da produttore, porte e nome: Ubiquiti (anche "CPE CDA Net"), MikroTik, telecamera/NVR, stampante, PC Windows, Apple, Chromecast, IoT, NAS, router/gateway.
- Gateway e telefono evidenziati, filtro e ordinamento, porte aperte con il nome del servizio, export CSV.
- Da ogni host si passa al **port scanner** o si apre l'interfaccia web.
- **Mappa di rete** (strumento locale, nessun dato dal server): mappa logica della LAN scansionata, Internet → gateway → dispositivi raggruppati per tipo (rete, Ubiquiti, MikroTik, telecamere/NVR, PC, NAS, stampanti, telefoni, TV, IoT); si scorre in entrambe le direzioni e toccando un dispositivo si aprono i dettagli. È "logica": dal telefono non si vede a quale porta di quale switch è collegato un dispositivo.

### Wi-Fi Analyzer (stile WiFiman)
- **Connessione attuale**: segnale e qualità, BSSID, canale/banda/larghezza, standard (Wi-Fi 4…7), velocità TX/RX, sicurezza, IP e gateway; si aggiorna da sola.
- **Spettro** per banda (2.4 / 5 / 6 GHz): ogni rete è una curva larga quanto il suo canale (20/40/80/160 MHz) con il picco al suo segnale; in grassetto la rete a cui sei collegato; canali DFS in arancio.
- **Canali**: occupazione di ogni canale (reti sovrapposte e loro potenza) e **canali consigliati** per il router del cliente (2.4 GHz solo 1/6/11; 5 GHz prima i non-DFS).
- **Segnale nel tempo** delle reti principali (ultimi ~2 minuti), utile spostando telefono o antenna.
- **Reti**: SSID, BSSID e produttore (registro IEEE), canale, larghezza, standard, sicurezza (aperte e WEP in rosso), distanza indicativa.
- Android consente 4 scansioni ogni 2 minuti: i risultati si leggono ogni 3 s e una nuova scansione parte ogni 30 s (per aggiornamenti più rapidi: Opzioni sviluppatore → disattiva "Limitazione scansione Wi-Fi"). Serve il permesso di posizione.

### Topologia di rete (scanner IP → Mappa di rete)
Strumento locale: tutto avviene dal telefono collegato alla Wi-Fi della LAN, nulla passa dal server.
- **Discovery multi-vendor** (in parallelo, ~4 s): MikroTik **MNDP**, Ubiquiti, Hikvision **SADP**, **Dahua** DHDiscover, **ONVIF**, **UPnP/SSDP** con lettura della descrizione del dispositivo (router e ONT TP-Link, Tenda, Huawei, Netgear, D-Link, AVM Fritz!Box, ZTE…), **mDNS/DNS-SD** (stampanti, NAS Synology/QNAP, Chromecast, Apple, Sonos, Shelly, Hue, Axis…), Netgear **NSDP**. Nomi, produttori, MAC e tipi arricchiscono l'elenco dello scanner e aggiungono i dispositivi che lo scanner non aveva visto.
- **SNMP v2c**: prova la community `public` (o quelle inserite, separate da virgola) su tutti gli host; dagli apparati che rispondono legge **LLDP** e **CDP** (chi è collegato a quale porta), la **tabella MAC** degli switch (BRIDGE-MIB e Q-BRIDGE-MIB) e la **tabella ARP** dei router.
- **Mappa**: Internet → gateway → switch/router collegati (con le porte), ogni dispositivo sulla porta di accesso dello switch dove è stato visto (la porta con meno MAC, escluse uplink e collegamenti tra apparati). Gli apparati senza LLDP vengono collocati dove gli switch vedono il loro MAC.
- **Senza SNMP** (nessun apparato risponde): mappa base dal gateway, con i dispositivi raggruppati per tipo.
- Limiti: gli switch non gestiti non si vedono (i dispositivi dietro di loro risultano sulla stessa porta dello switch a monte); MikroTik espone poco via SNMP. LLDP/CDP "ascoltati" direttamente non sono possibili da un'app Android senza root.

### Hikvision SADP (TVCC)
- Ricerca di telecamere, NVR e DVR Hikvision con il protocollo SADP (UDP 37020): sonda inviata due volte in multicast e broadcast, risposte ascoltate anche sul gruppo multicast (molti apparati rispondono lì).
- Per ogni dispositivo: modello, seriale, firmware, MAC, IP/maschera/gateway, DHCP o statico, porte HTTP e SDK, canali, Hik-Connect e **stato di attivazione**: quelli **non attivati** (password di amministrazione ancora da impostare) sono evidenziati in cima.
- Azioni: interfaccia web, verifica porte (HTTP, HTTPS, RTSP, SDK), "Usa per RTSP" che compila l'anteprima dello stream.

### Port scanner
- Preset (top 30, apparati di rete, TVCC/NVR, Windows/server, database, stampanti, prime 1024) o elenco libero come `1-1024,8291,8728,20443` (fino a 10.000 porte).
- Stato **aperta / chiusa (RST) / filtrata** (nessuna risposta: firewall o host spento), latenza, nome del servizio.
- **Banner** dei servizi che si presentano (SSH, FTP, SMTP…), **status e header `Server`** HTTP, redirect, e **certificato TLS** (protocollo, CN, emittente, scadenza, autofirmato sì/no).
- Timeout regolabile (300-600 ms in LAN, 800-1500 ms sui link radio), avanzamento in tempo reale, interruzione, export CSV.
- Solo indirizzi privati o CGNAT.

### Diagnostica di rete
- **Ping continuo** con dimensione del pacchetto a scelta: inviati/ricevuti, perdita, minimo/medio/massimo, jitter e deviazione standard.
- **MTU di percorso** (ricerca binaria con il bit DF): 1500 su Ethernet, 1492 dietro PPPoE; valori inferiori indicano tunnel o overhead da compensare con MSS clamping.
- **DNS avanzato**: A, AAAA, MX, TXT, NS, CNAME, SOA, PTR, SRV, CAA verso qualsiasi server (quello della Wi-Fi, 1.1.1.1, il DNS CDA Net…), con TTL, codice di risposta e tempo.
- **Verifica HTTP/HTTPS**: catena di redirect, codice, tempo, header `Server`, certificato validato come in un browser.
- **Wake-on-LAN**: magic packet in broadcast (UDP 9 e 7).

Il produttore dei MAC compare anche nella scansione e nella tabella ARP degli Strumenti di rete della console web.
