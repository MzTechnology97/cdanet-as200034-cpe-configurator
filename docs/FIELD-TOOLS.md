# Strumenti di campo (app Android)

L'app accompagna l'installatore dall'intervento in Oggi al collaudo, e gli dà gli strumenti per le CPE già installate e per la rete del cliente. Le aree della barra in basso sono **Oggi**, **Installa**, **Copertura**, **Rete** e **Strumenti**. Gli Specialist hanno la loro area al posto di Installa (vedi [SPECIALIST-GRUPPI.md](SPECIALIST-GRUPPI.md)).

## Oggi e calendario

- **Interventi di oggi**: quelli assegnati dall'ufficio, con cliente, indirizzo, PPPoE e il profilo del cliente già scaricato. «Inizia» apre l'installazione o il ripuntamento con i dati compilati; «Naviga» apre il navigatore; «Rimanda» chiede il motivo. All'inizio il telefono deve essere entro 500 m dalla posizione dell'intervento, altrimenti il NOC viene avvisato e il collaudo resta bloccato.
- **Pronto offline**: per ogni nuova installazione della giornata l'app prepara da sola, con rete, la configurazione per l'AP migliore e per i successivi tra quelli assegnati (fino a 5, solo AP con chiave Wi-Fi). Sull'intervento compare «pronto offline» e «Inizia» va dritto alla scrittura anche senza rete. Sul posto si sceglie l'AP verso cui si punta; MAC, seriale e AP arrivano al server con l'esito. La configurazione resta cifrata sul telefono e non è mai visibile al tecnico.
- **Diagnosi a distanza** nella scheda dell'intervento: cosa dice la rete del cliente prima di partire, dal problema più grave, con lo stato di CPE e AP. Parte da sola per guasti e ripuntamenti (vedi [NOC.md](NOC.md#diagnosi-a-distanza)).
- **Calendario**: viste giorno, settimana e mese, come Google Calendar. L'installatore vede i suoi interventi; un amministratore quelli di tutti, e crea, modifica, sposta o annulla un intervento (vedi [NOC.md](NOC.md#interventi-e-calendario)).
- **Da completare**: installazioni fallite o preparate e mai scritte. «Modifica e riprova» le riapre con tutti i dati da correggere.
- **Scorciatoie** personalizzabili per account (salvate sul server, uguali su ogni telefono).

Gli orari sono nel fuso del telefono.

## Installazione CPE (procedura guidata)

**Installa** chiede che intervento fare e poi guida passo per passo. Gli strumenti sono quelli descritti più sotto, messi in ordine.

**Nuova installazione**:
1. **Configurazione**:
   - **CPE**: si sceglie dal **magazzino** dell'installatore («Dal tuo magazzino») e modello, MAC e seriale si compilano da soli. Un MAC fuori dal magazzino blocca la preparazione, anche senza rete, salvo l'opzione dell'account. Senza l'opzione, MAC e seriale non si scrivono a mano: la CPE viene solo dal magazzino. Con l'opzione, MAC e seriale hanno ciascuno il tasto di scansione, con i controlli (un codice che non può essere un MAC è scartato, un MAC nel campo Seriale è segnalato).
   - **Controlla la CPE collegata** (discovery Ubiquiti, parte da sola e riprova ogni 8 secondi): modello, MAC rispetto all'etichetta (±3), firmware 8.7.4, se è di fabbrica, che non sia la CPE da sostituire; riconosce la CPE del magazzino. Con un firmware diverso propone l'aggiornamento lì (vedi [Discovery Ubiquiti](#discovery-ubiquiti)).
   - **AP consigliati** dal GPS del telefono (o dalla posizione dell'intervento): solo AP CDA Net con chiave WPA2, ordinati per segnale stimato e poi per distanza. «Usa» imposta nodo e distretto.
   - Cliente, PPPoE e posizione; il server prepara il `.cfg` (vedi [PROVISIONING.md](PROVISIONING.md)).
2. **Scrittura nella CPE**: un solo pulsante, «Installa sulla CPE». L'app entra nella CPE anche se è nuova o resettata, con le credenziali di fabbrica; se il firmware è diverso la porta alla 8.7.4 e aspetta il riavvio; poi verifica board e MAC, scrive e riavvia. Dopo 2 aggiornamenti del firmware non riusciti l'installatore può scrivere comunque con il firmware che ha la CPE, se Impostazioni server lo consente: resta annotato nell'esito.
3. **Verifica della CPE**: dopo il riavvio l'app rilegge la CPE e convalida la configurazione: SSID previsto, nome di sistema, credenziali CDA Net attive, firmware, PPPoE e cavo LAN.
4. **Aggancio all'AP**: stato del collegamento (segnale, SNR, modulazione). Se la CPE non si aggancia parte da sola la **scansione degli AP che la CPE sente**: solo gli AP CDA Net, e su richiesta anche le altre reti. Il **consigliato** è quello con segnale migliore; a parità entro 3 dB vince il più vicino. **Aggancia** sposta la CPE su quell'AP:
   - il server consegna la chiave WPA2 del nuovo SSID solo all'app, e l'operazione finisce nel Registro attività senza la chiave;
   - l'app riscrive SSID e chiave nella CPE via SSH, sblocca un eventuale «Lock to AP» (o lo imposta sul nuovo AP), salva e riavvia;
   - l'app aspetta che la CPE si agganci al nuovo AP.

   Se la CPE è già agganciata ma un altro AP si sente meglio di almeno 6 dB, l'app lo segnala.
5. **Puntamento**: segnale in tempo reale con bip, picco e grafico; direzione, tilt e distanza dell'AP agganciato. Da qui si aprono il **mirino in realtà aumentata** (con il segnale della CPE e il bip), la bussola, la mappa «Trova l'AP» e il puntamento a schermo intero.
6. **Fine lavori sul tetto**: con il telefono ancora sulla Wi-Fi della CPE, le 10 letture radio del collaudo, l'altezza della CPE dal suolo e le **foto del tetto** (antenna, staffa o palo, cablaggio). In una nuova installazione «Scendi: router del cliente» resta bloccato finché le tre foto non ci sono, così il tecnico non deve risalire.
7. **Router e velocità**, in casa: il telefono va sulla Wi-Fi del router del cliente (vedi [Speedtest](#speedtest-e-wi-fi-del-cliente)).
8. **Verifica finale e collaudo**: il collaudo ritrova già pronto quello che è stato fatto (misure, altezza, foto, speedtest) e chiede la foto del router. Si apre da solo a fine installazione.

**CPE già installata: ripuntamento o cambio AP**: salta configurazione e scrittura e parte dal passo 3.
- L'app riconosce la CPE dai suoi MAC (anche il MAC della LAN, quarto byte +1 rispetto all'etichetta) e la cerca tra le installazioni visibili al tecnico: le sue e quelle assegnate da Salute CPE.
- Se la trova, collaudo e foto vanno in quella installazione, come collaudo nuovo; quelli precedenti restano.
- Una CPE installata da un collega si può ripuntare se il telefono è dal cliente (GPS entro 500 m dall'installazione): l'accesso dura 24 ore e il NOC lo sa.
- Una CPE installata prima dell'app si registra con **Registra la CPE**: MAC, modello, nome e SSID dalla CPE, posizione dal GPS (obbligatoria). Il suo collaudo vale come quello di una nuova installazione, con le foto obbligatorie.
- Se il server non si raggiunge l'app lo dice e riprova da sola al ritorno di Internet.

**Sostituzione**: dalla scheda di un'installazione (vedi [Sostituzione CPE](#sostituzione-cpe)). Alla fine l'app chiede «La CPE smontata funziona?» (Funziona, Guasta, Non so, con una nota facoltativa); la risposta parte con l'esito, anche più tardi. Nello Storico, «CPE smontate da riportare» le elenca.

### KO, rimandi e ritentativi (v1.32.7)

In ogni passo c'è **Segnala KO**, che c'è anche nell'esito del collaudo quando è "non superato" o serve l'approvazione del NOC. Il tecnico sceglie:
- **Rimandata**: con la motivazione obbligatoria e, se concordato, il giorno in cui riprovare (domani, fra 2 giorni, fra una settimana);
- **KO definitivo**: con la motivazione sempre obbligatoria.

Motivi in lista: segnale insufficiente o nessun AP, la CPE non si aggancia, ostacoli, CPE guasta, cliente assente o accesso impossibile, maltempo, materiale mancante, altro. Fase, installazione, MAC, SSID, segnale, segnale atteso, distanza e AP li allega l'app.

La segnalazione **non blocca l'installazione**: dopo l'invio il tecnico sceglie *Riprova ora* o *Chiudi intervento*, e si può riprendere quando si vuole. Ogni tentativo resta registrato (in console e Telegram compare "tentativo N"). Le segnalazioni aperte di una CPE si chiudono da sole quando un tentativo successivo supera il collaudo (anche con riserva), oppure le chiude un amministratore con una nota (**Segna come risolto**).

Anche una **scrittura nella CPE fallita** si può ritentare con lo stesso pacchetto: prima il secondo esito veniva rifiutato dal server, e l'installazione restava "Fallita" anche se il secondo tentativo era riuscito. Lo storico mostra il numero di tentativi.

Console: Storico → **Da seguire** (rimandi e KO aperti, collaudi da approvare), filtri *Rimandate o KO aperte* e *Da approvare (NOC)*, colonna nel CSV, statistiche per motivo. API: `POST /api/installs/ko`, `GET /api/installs/ko`, `POST /api/admin/installs/ko/{id}/resolve`.

### Approvazione del NOC per segnale pessimo (v1.32.7)

Un collaudo con segnale sotto il minimo (−75 dBm) o con un controllo radio rosso resta **in attesa dell'approvazione del NOC**. Sono controlli radio: segnale ricevuto, segnale lato AP, CINR, capacità airMAX, catene, collegamento all'AP. Un problema solo di cavo o PPPoE non la richiede.
- L'app lo annuncia già nella verifica finale e nel collaudo.
- Il NOC riceve la notifica in console e sul gruppo Telegram.
- Nello Storico → job, sezione *Approvazione NOC*, il NOC approva, oppure rifiuta con la nota obbligatoria.
- L'installatore riceve l'esito nelle Notifiche (e su Telegram, se collegato).
- Un nuovo collaudo rimette l'installazione in attesa.

API: `POST /api/admin/provisioning/jobs/{id}/review` con `{ decision: approved|rejected, note }`.

## Come il telefono raggiunge la CPE

Il telefono si collega alla CPE in due modi:
- **Wi-Fi di management della CPE** (radio 2,4 GHz dei modelli airMAX AC Gen2): «Collegati alla Wi-Fi della CPE» (Android 10+) mostra le reti di management delle CPE vicine (es. «LBE-5AC-Gen2:…»). Il tecnico ne tocca una e l'app la usa per la CPE, mentre il telefono resta su Internet con la rete mobile: niente impostazioni Wi-Fi né avvisi «rete senza Internet». «Altre reti Wi-Fi» resta per il router del cliente e per i telefoni più vecchi.
- **Wi-Fi del router del cliente**, dietro la CPE.

Poi l'app cerca la CPE da sola, in quest'ordine:
1. la **discovery Ubiquiti**, qualunque IP abbia la CPE. Se ne rispondono più di una, il tecnico sceglie quella da sistemare; la scelta vale per tutti gli strumenti (barra della CPE in «CPE collegata»);
2. la CPE già scelta;
3. il **gateway IPv4 della Wi-Fi**, anche quando la rete annuncia pure un router IPv6;
4. gli indirizzi abituali: `192.168.1.254` (LAN dei template) e `192.168.172.1` (management, `CPE_FACTORY_IP`);
5. l'**IP manuale**, sempre disponibile.

Su ogni indirizzo l'app prova l'interfaccia web di airOS: `https` sulle porte 443 e 20443, poi `http` sulle porte 80 e 20080 (o le porte annunciate dalla discovery).

Il traffico verso la CPE passa sempre dalla Wi-Fi, anche se la Wi-Fi non ha Internet, mentre il server resta raggiungibile con i dati mobili. Se il Wi-Fi cade durante il lavoro l'app se ne accorge subito; con il Wi-Fi spento chiede di accenderlo.

## Credenziali

Le credenziali CDA Net della CPE (`CPE_ADMIN_USERNAME`/`CPE_ADMIN_PASSWORD`) arrivano dal server con `POST /api/field/access`:
- solo verso l'app Android riconosciuta (header `X-CDA-Client`, versione minima);
- in risposta `no-store`, conservate sul telefono cifrate con il Keystore di Android;
- valide quanto la sessione senza Internet (vedi sotto, minimo 8 ore);
- ogni consegna è registrata nel Registro attività ("Accesso alla CPE dagli strumenti di campo").

L'app le richiede subito dopo il login, così gli strumenti funzionano anche più tardi sul tetto senza Internet.

## Sessione senza Internet

Dopo ogni contatto con il server l'app tiene sul telefono, cifrata con il Keystore, la sessione dell'account (utente, ruolo, funzionalità attive) per le ore impostate in **Impostazioni server → Sessione dell'app senza Internet** (predefinito 24, 0 = mai, massimo 72). Il conteggio riparte a ogni contatto.

Se l'app viene chiusa o il telefono si spegne e alla riapertura non c'è Internet, l'app riparte con quella sessione. Funzionano:
- gli strumenti sulla CPE (diagnosi, puntamento, AP visibili, collaudo), con le credenziali salvate;
- gli strumenti locali e il provisioning già preparato.

Un avviso in alto dice fino a quando vale la sessione salvata. I dati del server tornano appena c'è Internet:
- con l'accesso automatico l'app si ricollega da sola e rilegge i dati;
- con lo sblocco con impronta o volto si usa **Ricollegati con impronta o volto** nell'avviso. All'apertura offline l'impronta o il volto vengono chiesti comunque.

Il token del server non viene salvato. Allo scadere delle ore torna la schermata di accesso.

**Attenzione:** un account disattivato, una password cambiata o un telefono perso restano utilizzabili senza Internet fino alla scadenza. Al primo contatto con il server l'app cancella la sessione salvata e le credenziali CPE, nei casi seguenti:
- risposta 401;
- chiave del telefono revocata o scaduta;
- telefono bloccato per accessi falliti.

«Esci» le cancella subito.

**Registro:** quello che si fa con la sessione salvata entra nel Registro attività al primo contatto, con l'ora in cui è successo e la nota «senza Internet»:
- `session.offline_resume`: sessione ripresa;
- `field.offline_use`: diagnosi o puntamento avviati.

Il server accetta solo ore comprese nella durata della sessione offline, mai nel futuro.

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

Le decide il server, così il NOC può cambiarle senza pubblicare una nuova app: Impostazioni server → Soglie di collaudo e salute CPE. Valori di serie: segnale buono −65 dBm, minimo −75 dBm, CINR 20 dB, sbilanciamento delle catene 6 dB, capacità minima 100 Mbit/s, porta LAN minima 100 Mbit/s, calo rispetto al collaudo 6 dB.

## Collaudo dell'installazione

Si apre da solo a fine installazione; altrimenti da **Storico → installazione → Collaudo**. Funziona anche senza Internet (le credenziali della CPE restano sul telefono) e parte appena c'è rete.

1. **Misure radio**: 10 letture in 10 secondi, già fatte a «Fine lavori sul tetto». Il segnale viene mediato (con minimo e massimo) e i controlli della diagnosi vengono applicati alla media.
2. **Velocità del profilo**: lo speedtest del passo «Router e velocità» (vedi sotto), senza ripeterlo, e la Wi-Fi del router del cliente con SSID, canale, banda e reti vicine.
3. **Foto**: per una nuova installazione sono obbligatorie antenna, staffa o palo, cablaggio e router del cliente; senza queste il collaudo non si salva (ripuntamenti e sostituzioni ne sono esenti). Fino a 8 foto con il loro tipo, ridotte a 1600 px e raddrizzate. Ogni foto nuova viene controllata: la stessa foto due volte non entra; se sembra mossa, sfocata, troppo scura o quasi uguale a un'altra l'app propone «Rifai la foto» o «Tieni comunque».
4. **Altezza della CPE** e **note** per il NOC.

L'esito (superato, con riserva, non superato) è calcolato dalle soglie del server; lo speedtest sotto il minimo porta il collaudo con riserva. Dopo «Salva e invia collaudo» il pulsante diventa «Collaudo inviato». Prima del collaudo l'app manda l'esito del provisioning, se è ancora in coda.

Il **rapporto di collaudo in PDF** si apre («Visualizza rapporto», con il lettore del telefono) o si salva («Scarica PDF», in Download/CDA Net) dallo Storico e dalla schermata Collaudo. Se il NOC ha deciso di segnarlo superato, l'app lo mostra con chi, quando e il motivo.

Sul server: `PUT /api/provisioning/jobs/{id}/acceptance` e `POST /api/provisioning/jobs/{id}/photos` (JPEG, max 3 MB, max 8 per installazione, con il tipo). Le foto sono salvate su disco in `PHOTOS_DIR` (di serie `photos/` accanto al database, quindi nel volume `/data` del container) e vengono cancellate insieme all'installazione dalla retention. Nella console, Storico → installazione, la sezione *Collaudo* mostra misure, controlli, speedtest, note e foto, e il rapporto in PDF (vedi [NOC.md](NOC.md#storico-provisioning-e-collaudi)).

## Speedtest e Wi-Fi del cliente

Il passo **Router e velocità** dell'installazione (e degli interventi):
- il telefono va sulla Wi-Fi del router del cliente, mai sui dati mobili. Sotto la soglia di segnale del telefono il test è bloccato con «Avvicinati al router»; tra avviso e blocco compare un avviso (Impostazioni server → Collaudo: speedtest e Wi-Fi);
- l'app legge canale e larghezza della rete del router, conta le reti sullo stesso canale e quelle sovrapposte e consiglia cosa cambiare;
- poi lo **speedtest Ookla** verso il server di speedtest di CDA Net (download, upload, ping e jitter, 4 connessioni) confrontato con il profilo del cliente al minimo impostato (80%). L'upload conta solo i dati che il server conferma, con richieste da 64 KB a 4 MB secondo la velocità della linea;
- sotto il minimo: la lista delle cose da controllare e «Ripeti il test» senza limiti. Se il tecnico prosegue lo stesso, il collaudo va con riserva.

Il profilo del cliente (da ISP Billing, anche con il solo MAC della CPE) si scarica già in Oggi e alla preparazione: se dalla Wi-Fi del cliente il server non si raggiunge, l'app lo usa e lo dice («server non raggiungibile, la prova resta sul telefono»), riprovando ogni 20 secondi. Ogni prova si salva sul server, anche più tardi. Lo **Speedtest (server CDA Net)** c'è anche in Strumenti.

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

## Verifica copertura (area "Copertura")

Quinta area della barra in basso e scorciatoia in Oggi, con il modulo Copertura. Serve prima del sopralluogo: indirizzo, coordinate, GPS del telefono o tocco sulla mappa; per ogni AP segnale stimato, modulazione, capacità e velocità la sera, direzione, **Collegamento** (puntamento vero e magnetico, inclinazione, Fresnel, segnale atteso sulla scala delle modulazioni, profilo; CPE da installare consigliata o scelta e altezza ± che ricalcolano la verifica) e **Bussola**. Sotto: gli altri operatori nel punto per bollino AGCOM e le **verifiche salvate**.
- **Installatori**: solo gli AP assegnati, in posizione approssimativa, entro 20 km e al massimo il numero impostato in Impostazioni server; lo filtra il server (`/api/coverage`), non l'app.
- **Amministratori**: tutti gli AP sulla mappa, ricerca per nome dell'AP, **raggio di ricerca** da 10 a 100 km (oltre 20 km «troppo lontano»), **Simula copertura**, vista **3D** e **Realtà aumentata**.
- **Simulazione A → B** (amministratori e Specialist): due punti scelti sulla mappa, con il GPS o con le coordinate, e il collegamento tra loro con profilo, segnale e modulazione; con la linea ostruita contano la diffrazione pura e il segnale fisico.

Tutto il calcolo è descritto in [COPERTURA.md](COPERTURA.md). La mappa è la pagina `/map-embed.html` del server; i tocchi tornano all'app tramite l'interfaccia JavaScript `CdaApp`, aggiunta solo su quella pagina.

## Trova l'AP (mappa, lista e mirino in fotocamera)

Dal GPS del telefono l'app mostra gli AP vicini (per gli installatori solo quelli assegnati):
- **Lista**: distanza, altitudine dell'antenna (m s.l.m.), **azimut** (Nord vero), **tilt** e **segnale stimato**; per ogni AP i pulsanti **Mirino** e **Bussola**.
- **Mappa**: la mappa della console (Protomaps sul nostro server) con la tua posizione e una freccia che segue la direzione del telefono; gli AP come punto (admin) o area approssimativa (installatori) con la linea di puntamento.
- **Realtà aumentata** (scorciatoia *Realtà aumentata* in Oggi, anche senza un intervento: GPS del telefono e AP intorno, il migliore già scelto; Mirino da Trova l'AP e dall'installazione; *Realtà aumentata* da Copertura): sulla fotocamera posteriore, in verticale:
  - **gli AP intorno** come segnali sulla loro direzione, con nome, distanza, segnale atteso e colore della valutazione; un tocco sull'etichetta sceglie l'AP. L'AP scelto è disegnato dove si trova davvero (tilt dal profilo): sotto la linea dell'orizzonte vuol dire coperto dalla collina;
  - **l'orizzonte del terreno** (`/api/pointing/horizon`: angolo del terreno ogni 0,5° fino a 25 km, con la curvatura terrestre, TINITALY/SRTM) come linea azzurra: ciò che nella foto sta sopra la linea sono edifici e alberi, che il modello conosce solo in parte. In alto la distanza della cresta più alta inquadrata;
  - **il tunnel di Fresnel** verso l'AP scelto: anelli del 60% della prima zona a 10 m, 25 m, 50 m… fino all'AP (dal profilo del server), rossi dove terreno, edifici o alberi ci entrano con la distanza e la causa; gli anelli vicini sono quelli da guardare per alberi e tetti;
  - **nastro della bussola** in alto (±60°) con gli AP, mirino verde e vibrazione quando sei allineato entro 2°, frecce quando l'AP è fuori schermo, verdetto (linea libera, Fresnel invasa, ostruita) e indicazioni (*gira a destra*, *alza*);
  - **Allinea sulle montagne**: l'app riconosce il profilo del cielo nella fotocamera e lo sovrappone a quello del terreno, correggendo la bussola (come un "peak finder"; serve un orizzonte con rilievo e cielo libero). In alternativa si trascina col dito per far combaciare la linea azzurra con le montagne; *Azzera* toglie la correzione;
  - **Foto**: salva in Galleria › Pictures/CDA Net l'immagine con tutto il disegno, l'AP, le coordinate e l'ora.

  Dal guided install mostra anche il segnale della CPE con il bip. Avvisa se la bussola non è calibrata (movimento a 8).

**Tilt**: se UISP riporta l'altitudine dal GPS interno dell'AP, si usa quella (in lista "(GPS)"); altrimenti altitudine del terreno dal modello SRTM (il server scarica e tiene in cache solo le zone usate, ~12 MB per grado; `DEM_URL` vuoto lo disattiva) più le altezze dal suolo impostate dall'admin in Copertura → "Puntamento (app)" (antenne AP, default 15 m; CPE, default 6 m, modificabile dal tecnico). Tiene conto della curvatura terrestre.

**Segnale stimato** (Copertura, AP vicini e simulazione usano lo stesso calcolo, `domain/coverage-model.ts` e `services/terrain.ts`): EIRP dell'AP + guadagno della CPE (Impostazioni server → Simulazione radio) − perdita in spazio libero alla frequenza dell'AP − diagramma dell'antenna (3GPP, solo con l'azimut in UISP) − terreno: profilo DEM tra il punto e l'AP con le stesse quote di Visibilità e diffrazione di Deygout (ITU-R P.526, fino a 3 creste). Due calibrazioni dai clienti reali: la **rete** (mediana, sugli AP con almeno 3 clienti con segnale, di quanto ricevono rispetto alla teoria; tra −10 e +15 dB) e il **singolo AP** (scostamento dalla rete tra −15 e +8 dB, pesato n/(n+1) sul numero di clienti; la pendenza con la distanza si impara solo da almeno 6 clienti ben distribuiti, altrimenti spazio libero). Clienti con la posizione a meno di 50 m dall'AP (posizione dell'AP o del sito) o oltre 20 km sono esclusi: anche il settore servito e la portata non si allungano più per una CPE mal posizionata. Oltre 20 km (`MAX_LINK_M`) un AP è sempre *improbabile*. Una cresta in mezzo abbassa la stima e l'affidabilità; il limite ottimistico ne tiene solo una parte (i clienti reali mostrano che il profilo a volte sbaglia per la posizione della CPE in UISP), così un'ostruzione lieve resta *possibile* e una cresta vera *improbabile*. La quota GPS di un AP sotto il terreno + 5 m viene alzata a terreno + 5 m (errore verticale del GPS). Le coordinate dei clienti in UISP sono la fonte giusta (gli indirizzi di ISP Billing non valgono per le posizioni).

**Realismo (v1.32.72)**, dati incrociati per avvicinare la stima alla realtà:
- **Edifici veri**: le sagome di OpenStreetMap della mappa base già sul server (Copertura → Terreno e ostacoli → *Edifici dalla mappa base*, nessun download), sulla griglia di 10 m, con l'altezza di OSM dove c'è, altrimenti quella media (3 m per i manufatti sotto 40 m²). Sostituiscono la classe «edificato» di ESA, che copre anche strade e piazze.
- **Alberi veri**: l'altezza di ogni albero dalla mappa Meta/WRI CHM v2 (~1 m, CC BY 4.0, AWS Open Data), letta per intervalli solo nei blocchi della panoramica a ~4 m sopra l'area della rete (~1,3 MB per riquadro di 0,1°, ~115 MB per tutta la rete); per ogni punto l'albero più alto entro ~6 m, sotto i 3 m niente. Sostituisce la classe «alberi» di ESA con l'altezza media.
- **CPE sul tetto**: con le sagome vere l'antenna sta 2 m sopra il tetto dell'edificio del punto e sopra gli ostacoli vicini, nella verifica e in ogni cella della simulazione; il pannello del collegamento dice l'altezza effettiva.
- **Correzione locale al netto del terreno**: ogni cliente è confrontato con il modello *con* il terreno del suo percorso (`services/model-inputs.ts`, profili tenuti in memoria): calibrazione di rete, dell'AP e correzione dei clienti vicini imparano solo ciò che il terreno non spiega.
- **Antenne vere** (Copertura → Antenne degli AP): diagrammi Ubiquiti airMAX (dl.ui.com) e RF elements (horn HG3/StarterHorn/UltraHorn/asimmetriche, settori, parabole: file per Google Network Planner) scaricati dal server su richiesta, mai nel codice. Per ogni AP antenna, azimut (suggerito dall'arco dei clienti, da confermare) e tilt meccanico; il calcolo usa il diagramma orizzontale e, con il tilt, anche quello verticale (con il tilt elettrico già nel file). Il diagramma vale solo con l'azimut noto (admin o UISP): uno stimato e sbagliato peggiorerebbe la stima. Le radio con antenna integrata (LiteAP GPS, LiteBeam, NanoBeam, NanoStation, PowerBeam) prendono il loro diagramma dal modello.
- **Sulla mappa admin**: i clienti reali colorati per quanto la stima ci prende (entro 6 dB verde, oltre 12 dB rosso) e le installazioni fallite, dall'ultima misura di Affidabilità della stima.

- **Altezze sane**: la CPE sta sul tetto vero della sua casa; edifici vicini e alberi la alzano al massimo come l'altezza media impostata (niente antenne sopra un pino di 25 m o il condominio accanto). L'AP resta all'altezza del sito UISP (o di un GPS sensato); solo con l'altezza predefinita sale sopra gli ostacoli intorno.

Misura sui 568 clienti reali (ottobre 2026): errore mediano 6 → 5 dB, entro ±6 dB 55% → 57%, scarto medio −2,5 → −1,6 dB, collegati ma dati per ostruiti 64 → 57 con edifici e alberi veri.

**Velocità la sera (v1.32.73)**: per ogni AP e cella della simulazione, oltre al segnale e alla capacità del collegamento (curva segnale → capacità delle CPE reali), la velocità che un cliente nuovo avrebbe al picco serale: capacità × tempo radio che l'AP ha libero la sera (airtime e utilizzo del canale, 20–23), mai meno della parte equa tra i suoi clienti. In Copertura (console, installatori, app) accanto alla capacità; in Simula copertura la scala «Velocità la sera» e la quota di area con almeno 30 Mbit/s.

**Simulazione in 3D (v1.32.73)**: *Vista 3D* nella simulazione apre le celle colorate (segnale, capacità o velocità la sera) stese sul terreno in rilievo con le foto aeree e gli **edifici in rilievo** della mappa base (altezza OSM, altrimenti 7 m); anche la vista 3D del collegamento mostra ora gli edifici. Viste dall'AP, verso l'AP e dall'alto, intensità regolabile.

**Civici ANNCSU (v1.32.73)**: Copertura → Terreno e ostacoli → *Scarica i civici ANNCSU* (Agenzia delle Entrate – ISTAT, dati aperti mensili, una regione: Sicilia ~37 MB). Il server tiene solo i civici con coordinate nell'area della rete (in Sicilia la maggior parte). Quando un indirizzo cercato ha via e numero, il risultato del geocoder (spesso solo la via) viene spostato sul civico: stessa via, stesso numero, entro 4 km.

**Terreno e ostacoli** (`services/terrain-store.ts`, import dal riquadro *Terreno e ostacoli* di Copertura o `npm run terrain:import -- minLat,minLon,maxLat,maxLon`): TINITALY 1.1 (INGV, 10 m, UTM 32N, CC BY 4.0) ed ESA WorldCover 2021 v200 (10 m, CC BY 4.0) convertiti in riquadri di 0,1° su griglia di 1/10800° in `data/terrain/{dtm,cover}` (quota in decimetri, classe del suolo); dove mancano, SRTM. Profilo ogni 25 m (`services/terrain.ts`): edifici (classe 50) solidi all'altezza media impostata, alberi (10) e arbusti (20, 2 m) con attenuazione del fogliame sul tratto di linea di vista dentro le chiome (0,4 dB/m, al massimo 20 dB, ITU-R P.833); nessun ostacolo entro 50 m dalle antenne; antenne almeno 2 m sopra gli ostacoli entro 60 m; terreno dell'AP = punto più alto entro 100 m dalla sua posizione UISP. Verifica sui 581 clienti reali (ottobre 2026, ciascuno stimato senza di lui; `services/coverage-accuracy.ts`, riquadro *Affidabilità della stima*): SRTM 55% entro ±6 dB, errore mediano 6 dB, 37 collegati dati per ostruiti; TINITALY 55%, 35 con l'AP sul punto più alto; con edifici e alberi a 8 m 53%, 44 (126 prima delle regole sulle antenne sopra gli ostacoli e l'AP in cima). Sui clienti collegati il terreno pesa poco perché vedono già l'AP: il beneficio è sugli indirizzi nuovi, da misurare con le installazioni fallite. **Carico e capacità** (`domain/ap-load.ts`, `services/ap-load.ts`, aggiornamento orario, 4 AP alla volta, risultato in `settings` `ap.load`): da UISP `GET /devices/{id}/statistics?interval=week` (airtime, downlinkUtilization, traffico per interfaccia: l'interfaccia radio trasmette verso tutte le CPE) e `GET /devices/airmaxes/{id}/stations` (airtime, rumore, segnale, capacità per CPE). Picco serale = media dei giorni del massimo orario tra le 20 e le 23 (Europe/Rome). Livello: medio oltre il 40% di airtime o utilizzo serale, carico oltre il 70%; un AP carico non è mai *buono* e nell'ordinamento conta 8 dB in meno (medio 3). Curva segnale (della CPE) → capacità downlink per MHz di canale, mediana ogni 2 dB e mai decrescente, dalle CPE collegate; ogni AP ha un fattore (0,5–2) rispetto alla curva. Sui dati reali (ottobre 2026): 103 AP in 138 s; mediane serali airtime 10%, picco 7,8 Mbit/s; curva da 606 CPE, a 40 MHz −60 dBm ≈ 149 Mbit/s, −80 dBm ≈ 55 Mbit/s.

Le posizioni dei clienti non lasciano mai il server; agli installatori il numero di clienti su cui si basa la stima è nascosto salvo diversa scelta dell'admin.

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

## Discovery Ubiquiti

**Strumenti → Con la CPE → Discovery Ubiquiti** cerca gli apparati airOS e UniFi nella rete locale della Wi-Fi a cui è collegato il telefono (quella della CPE o del cliente). La discovery non attraversa i router.

Funziona come la Ubiquiti Discovery Utility:
- richieste v1 (`01 00 00 00`) e v2 per UniFi (`02 08 00 00`) sulla porta UDP 10001, in broadcast e al gruppo multicast 233.89.188.1;
- una richiesta ogni mezzo secondo per 10 secondi, più l'ascolto degli annunci sulla porta UDP 10002;
- gli apparati compaiono man mano che rispondono.

Per ogni apparato mostra:
- prodotto, nome, IP, MAC e firmware (versione e build);
- tempo da cui è acceso, SSID e modalità wireless (Station o Access Point);
- se è ancora **di fabbrica** (dove l'apparato lo dice);
- se è un apparato UniFi.

La ricerca accetta `*` e `?`, e si può ordinare per IP, nome o prodotto.

Nel dettaglio di un apparato:
- tutte le sue interfacce;
- le porte web e SSH;
- il seriale;
- l'**IPv6 di emergenza** `fe80::`, calcolato dal MAC.

Azioni disponibili:
- **Interfaccia web**: apre l'interfaccia dell'apparato nell'app, solo per indirizzi privati e con il certificato autofirmato accettato solo per quell'indirizzo;
- **Copia**;
- **Riavvia**: usa la sfida del protocollo, con la risposta SHA-256(crypt(password, salt) || sfida), quindi la password non viaggia in rete. Le credenziali predefinite sono quelle CDA Net delle CPE salvate sul telefono, oppure altre inserite a mano. Prima di riavviare chiede conferma.

La stessa discovery serve anche negli altri flussi:
- **Installazione**: il controllo della CPE collegata parte da solo all'apertura e si ripete ogni 8 secondi finché una CPE risponde. Il tasto **Controlla di nuovo** lo rilancia. Prima di scrivere la configurazione verifica:
  - il modello, che imposta nel modulo;
  - che il MAC coincida con l'etichetta. La discovery può dare il MAC wireless, a poche unità da quello LAN;
  - il firmware rispetto all'8.7.4;
  - se la CPE è di fabbrica o già configurata;
  - nelle sostituzioni, che non sia ancora collegata la CPE da sostituire.

  Se la CPE è nel **magazzino** dell'installatore, propone MAC e seriale registrati lì (che vengono dall'etichetta). Se la discovery non trova nulla, la CPE si sceglie comunque dal menu **Dal tuo magazzino** del modulo, oppure si scansiona dall'etichetta.
- **CPE collegata** (diagnosi, puntamento, ripuntamento e cambio AP, collaudo): l'app cerca **prima** la CPE con la discovery, qualunque IP abbia.
  - Se trova una sola CPE (gli apparati UniFi del cliente sono esclusi), si collega da sola e lo segnala.
  - Se ne trova più di una, le elenca (modello, IP, nome, MAC, firmware, SSID) e si sceglie quella da sistemare.
  - Se non ne trova, prova come prima il gateway della Wi-Fi, l'IP LAN e l'IP di management.
  - **IP manuale** resta sempre disponibile; **Cerca CPE** rifà la ricerca.
  - Il cambio AP via SSH usa anche la porta SSH dichiarata dalla CPE.
- **Barra della CPE in «CPE collegata»**: in cima a tutte le schede (diagnosi, puntamento, AP visibili, collaudo, firmware) c'è la CPE su cui lavorano gli strumenti. È trovata dalla discovery all'apertura, oppure scelta dall'elenco se ne rispondono più di una. Mostra prodotto, IP, nome, MAC, SSID, firmware (verde se è quello richiesto) e se è «di fabbrica». Da lì si usano **Cerca di nuovo**, **Interfaccia web** e **Riavvia**.
- **Firmware senza uscire dall'installazione**: se il controllo della CPE trova un firmware diverso da quello richiesto, propone subito **Aggiorna a 8.7.4**. Se il firmware non è ancora sul telefono, prima **Scarica il firmware**, con Internet. Poi conferma, invio, controllo MD5, scrittura, attesa del riavvio e rilettura della versione; alla fine il controllo si ripete da solo e si prosegue. Anche la scheda Firmware usa la versione letta dalla discovery; la lettura via SSH resta come verifica.
- **CPE bloccata**: se risponde alla discovery ma non alla sua interfaccia web, l'app lo dice e propone **Riavvia la CPE**, con conferma.
- **Scansione LAN e topologia**: modello, modalità e apparati UniFi più completi. Dettagli del protocollo ripresi da [ubnt-discovery-next](https://github.com/Gaaraalex/ubnt-discovery-next) (licenza MIT).

## Strumenti di rete

- **Discovery LAN → Trova apparati Ubiquiti**: invia la richiesta di discovery Ubiquiti (UDP 10001, la stessa usata da UISP) e ascolta gli annunci degli apparati (UDP 10002). Mostra IP, MAC, modello, firmware, nome e SSID di CPE e AP sulla LAN, anche quando l'IP non è noto. Non attraversa i router: il telefono deve essere sulla stessa LAN.
- **Scansione subnet**: accanto a ogni host con MAC noto compare il **produttore** (Ubiquiti, MikroTik, TP-Link, Hikvision…), letto dal server dopo la scansione. Senza Internet viene semplicemente omesso.
- **Wi-Fi Analyzer**: oltre all'elenco delle reti indica il **canale consigliato per il router del cliente**:
  - 2.4 GHz: tra 1, 6 e 11, tenendo conto delle sovrapposizioni;
  - 5 GHz: tra 36 e 48, senza DFS né attese radar.

  Le reti vicine pesano in base al segnale.

### Lavoro senza rete

Collaudi, esiti, speedtest, foto, segnalazioni e CPE smontate vengono **sempre** salvati prima nella memoria privata dell'app e poi inviati da una coda:
- se c'è rete partono subito;
- altrimenti restano sul telefono e partono appena torna Internet, oppure a mano da Impostazioni → *Invia collaudi ora*. Prima viene sempre inviato l'esito del provisioning. Lo stesso collaudo inviato due volte dalla coda resta uno solo.

Oggi e Impostazioni mostrano quanti collaudi e foto sono in attesa. Le foto inviate vengono cancellate dal telefono. La configurazione preparata resta cifrata sul telefono fino alla scadenza: se Android chiude l'app sul tetto, alla riapertura senza rete «Riprendi l'intervento» riparte dalla scrittura. Cambiando account sul telefono, l'intervento lasciato aperto e le configurazioni preparate del precedente vengono cancellati.

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
- **Scansione LAN** (v1.32.21): pannello con radar della scansione, dati della Wi-Fi e opzioni; riepilogo (host, latenza media, produttori, subnet) e ripartizione per tipo di dispositivo che filtra l'elenco; viste **Elenco** (icona del tipo, sigla del produttore, latenza colorata, porte), **Griglia IP** (occupazione di ogni /24, tocca una cella per aprire l'host) e **Topologia**. In orizzontale e su tablet: comandi a sinistra e risultati a destra, ognuno con il suo scorrimento.
- **Discovery** (v1.32.21): tutti i protocolli dei produttori in un colpo (MNDP, Ubiquiti, SADP, Dahua, ONVIF, WS-Discovery, UPnP, mDNS, NSDP) con il quadro di chi ha risposto; dispositivi con modello, firmware, MAC e protocolli. Tabella ARP, NetBIOS e verifica porte restano in "Strumenti classici".
- **Topologia a schermo intero**: il dispositivo toccato si apre in una nuvoletta sulla mappa; PNG e PDF si salvano in **Download/CDA Net** (Android 10+) con "Apri" e "Condividi".
Strumento locale: tutto avviene dal telefono collegato alla Wi-Fi della LAN, nulla passa dal server.
- **Discovery multi-vendor** (in parallelo, ~4 s): MikroTik **MNDP**, Ubiquiti, Hikvision **SADP**, **Dahua** DHDiscover, **ONVIF**, **UPnP/SSDP** con lettura della descrizione del dispositivo (router e ONT TP-Link, Tenda, Huawei, Netgear, D-Link, AVM Fritz!Box, ZTE…), **mDNS/DNS-SD** (stampanti, NAS Synology/QNAP, Chromecast, Apple, Sonos, Shelly, Hue, Axis…), Netgear **NSDP**. Nomi, produttori, MAC e tipi arricchiscono l'elenco dello scanner e aggiungono i dispositivi che lo scanner non aveva visto.
- **SNMP v2c**: prova la community `public` (o quelle inserite, separate da virgola) su tutti gli host; dagli apparati che rispondono legge **LLDP** e **CDP** (chi è collegato a quale porta), la **tabella MAC** degli switch (BRIDGE-MIB e Q-BRIDGE-MIB) e la **tabella ARP** dei router.
- **Mappa**: Internet → gateway → switch/router collegati (con le porte), ogni dispositivo sulla porta di accesso dello switch dove è stato visto (la porta con meno MAC, escluse uplink e collegamenti tra apparati). Gli apparati senza LLDP vengono collocati dove gli switch vedono il loro MAC.
- **SNMP esteso** (v1.32.18): anche vicini MikroTik (MIKROTIK-MIB), stazioni wireless Ubiquiti airMAX con segnale, velocità e stato delle porte, `sysObjectID` (produttore dal numero enterprise) e subnet dichiarate sulle interfacce dei router, proposte per una seconda scansione.
- **Altri protocolli** (v1.32.18): **WS-Discovery** generico (stampanti, PC, scanner) e impronte dei servizi: HTTP/HTTPS (header `Server`, titolo, realm, certificato), banner SSH, RTSP, SIP. Insieme al produttore del MAC e ai nomi di fabbrica (es. `E410-…` → access point Cambium, `BRN…` → stampante Brother) stabiliscono il tipo di dispositivo.
- **Scansione ampia** (predefinita, `192.168.0.0/16`): prova i gateway tipici di ogni /24 e scansiona anche le subnet attive (al massimo 16).
- **Grafo** in stile UniFi (v1.32.18): albero da Internet con un'icona per tipo (router, firewall, ONT, switch, AP, radio, telecamera, NVR, PC, server, NAS, stampante, telefono, VoIP, TV, IoT) e la sigla del produttore; collegamenti certi (LLDP/CDP/MikroTik), wireless con segnale, dalla tabella MAC o presunti; collegamenti ridondanti e anelli a parte; apparati visti solo dai vicini "fuori scansione". Zoom e trascinamento, filtro "Solo apparati di rete", porte, scheda del dispositivo; export **PNG**, **PDF** e CSV (collegamenti e dispositivi).
- **Senza SNMP** (nessun apparato risponde): mappa base dal gateway, con i dispositivi raggruppati per tipo.
- Limiti: gli switch non gestiti non si vedono (i dispositivi dietro di loro risultano sulla stessa porta dello switch a monte); MikroTik espone poco via SNMP. LLDP/CDP "ascoltati" direttamente non sono possibili da un'app Android senza root.

### Hikvision SADP (TVCC)
- Ricerca di telecamere, NVR e DVR Hikvision con il protocollo SADP (UDP 37020): sonda inviata due volte in multicast e broadcast, risposte ascoltate anche sul gruppo multicast (molti apparati rispondono lì).
- Per ogni dispositivo: modello, seriale, firmware, MAC, IP/maschera/gateway, DHCP o statico, porte HTTP e SDK, canali, Hik-Connect e **stato di attivazione**: quelli **non attivati** (password di amministrazione ancora da impostare) sono evidenziati in cima.
- Azioni: interfaccia web, verifica porte (HTTP, HTTPS, RTSP, SDK), "Usa per RTSP" che compila l'anteprima dello stream.
- Attivazione e cambio di IP, subnet e gateway: con il SADP Tool di Hikvision da PC (in LAN o in Wi-Fi sulla stessa rete, anche tra subnet diverse) o dalla pagina web del dispositivo nella sua stessa subnet. I passi sono nella guida installatore («Attivare una telecamera Hikvision e cambiarne l'indirizzo»); l'app non tratta le password delle telecamere.

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

## Strumenti degli amministratori nell'app

Agli amministratori (e al direttore tecnico, dove indicato in [NOC.md](NOC.md)) l'app dà anche:
- **Rete → Stato rete**, **IA-AP** (con «Ottimizza…»), **Salute CPE** con **Gestisci** (la CPE come nell'app di UISP), **Guasti Enel** con le zone condivise;
- **Calendario** con nuovo intervento, modifica, spostamento e annullamento;
- **Copertura** completa (vedi sopra);
- nel collaudo, «Segna come superato» con il motivo.

Gli screenshot sono sempre permessi agli amministratori; per installatori e partner l'app li blocca, salvo il modulo «Screenshot nell'app» attivo per quell'account (vedi [SECURITY.md](../SECURITY.md#app-android)).
