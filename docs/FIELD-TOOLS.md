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
