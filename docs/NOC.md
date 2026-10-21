# Pagine NOC della console

Le pagine del lavoro quotidiano del NOC: amministratori e, dove indicato, il direttore tecnico, cioè uno Specialist con visibilità piena. Molte hanno anche una versione nell'app. Le regole su chi vede cosa sono in [SPECIALIST-GRUPPI.md](SPECIALIST-GRUPPI.md); i moduli che accendono le pagine in [MODULI.md](MODULI.md).

## Panoramica

La prima pagina (amministratori e direttore tecnico): provisioning delle ultime 24 ore, interventi di oggi fatti e in ritardo, collaudi da approvare, KO o rimandi aperti, problemi critici IA-AP, AP non raggiungibili o con un guasto Enel vicino; sotto, i lavori da completare, l'attività degli ultimi 30 giorni e lo stato di UISP, della ricerca indirizzi e dell'app Android pubblicata.

## Interventi e calendario

Modulo **Agenda interventi**, acceso di serie. L'ufficio pianifica gli interventi; l'installatore li trova in **Oggi** nell'app e li avvia con un tocco.
- **Tipi**: nuova installazione, ripuntamento o cambio AP, guasto, sopralluogo.
- **Dati**: giorno e fascia oraria, installatore (o «da assegnare»), cliente, indirizzo e posizione, contatto, utente PPPoE e note. «Cerca nel CRM» compila cliente, indirizzo, posizione, contatto e utente PPPoE da ISP Billing. La password PPPoE si scrive a mano e non compare mai nello storico.
- **Elenco** (console):
  - periodi Oggi, Domani, 7 giorni, Mese, Anno o date;
  - filtri per installatore, tipo e stato;
  - ricerca per cliente, indirizzo, contatto, PPPoE o numero;
  - una riga per intervento, raggruppata per giorno; quelli rimasti aperti dei giorni passati stanno a parte;
  - Esporta CSV.
- **Calendario** (console e app), come Google Calendar:
  - viste giorno, settimana e mese, con blocchi colorati per tipo;
  - interventi fatti sbiaditi, in ritardo con il bordo rosso;
  - nell'app un amministratore crea un intervento (anche toccando un'ora libera), lo modifica, lo sposta o lo annulla, con gli stessi avvisi all'installatore della console.
- **Cronologia** di ogni intervento: creato, ogni modifica (prima → dopo, mai la password), passi dall'app, avvisi, installazione e collaudo.
- **Diagnosi a distanza** nel dettaglio (vedi sotto): parte da sola per guasti e ripuntamenti.

Avvisi automatici:
- all'installatore: nuovo intervento o intervento modificato, promemoria prima dell'orario;
- all'installatore e al NOC:
  - **in ritardo** se non è iniziato 30 minuti dopo l'orario previsto;
  - **mancato** se il giorno passa senza esito;
- al NOC: **posizione non corrispondente** se all'inizio il telefono è a più di 500 m dalla posizione dell'intervento. Il collaudo resta bloccato finché i dati non coincidono.

Uno Specialist senza visibilità piena vede nel calendario solo i propri interventi e quelli del suo gruppo. Crearli e spostarli resta agli amministratori.

## Storico provisioning e collaudi

Ogni installazione ha i suoi tentativi, il collaudo, le foto, gli speedtest, la sezione UISP (vedi [UISP.md](UISP.md)) e la cronologia.

- **Collaudo**: misure radio, altezza della CPE, speedtest sul profilo del cliente, Wi-Fi del router (vedi [FIELD-TOOLS.md](FIELD-TOOLS.md)). Per le nuove installazioni le foto sono obbligatorie: antenna, staffa o palo, cablaggio, router del cliente. Esito: superato, con riserva o non superato.
- **Approvazione del NOC**: i collaudi con segnale sotto il minimo aspettano l'approvazione. Su un collaudo non superato o con riserva, «Segna come superato» chiede il motivo e la conferma. L'app e il rapporto mostrano chi l'ha deciso e quando.
- **Rapporto di collaudo in PDF**:
  - contenuto: logo, esito colorato, cliente e installazione, CPE, collegamento radio, rete e Internet, verifiche dell'app, note, approvazione del NOC, firma dell'installatore, visto del NOC e foto (due per riga);
  - mai la password PPPoE;
  - ogni download resta nel Registro attività;
  - gli installatori scaricano i propri, anche dall'app.
- **Segnala KO**: l'installatore rimanda (motivo e giorno) o segnala un KO definitivo con la motivazione, senza bloccare i ritentativi.
- **Elimina tentativo**: un tentativo mai installato (preparato, fallito o scaduto) si cancella con collaudo, foto e KO. Un'installazione scritta con successo non si cancella mai.
- **Ripuntamenti**: ogni ripuntamento o cambio AP ha un collaudo nuovo; quelli precedenti restano («Collaudi precedenti»). Senza un intervento pianificato se ne crea uno «Ripuntamento» già fatto e il NOC riceve «Ripuntamento senza intervento».
- **CPE di altri tecnici**: un installatore può ripuntare e collaudare una CPE installata da un collega se è dal cliente (GPS entro 500 m dall'installazione). Il NOC lo sa subito. L'accesso dura 24 ore e si revoca dal dettaglio dell'installazione.
- **CPE installate prima dell'app**: nel ripuntamento «Registra la CPE» la crea sul server. MAC, modello, nome e SSID vengono dalla CPE, la posizione dal GPS, che deve essere entro 500 m dalla posizione di UISP se nota. Il NOC riceve l'avviso; il collaudo vale come una nuova installazione.
- **CPE fuori dal magazzino**: un'installazione fatta senza rete, con una CPE che nel frattempo l'ufficio ha spostato o scaricato, viene registrata comunque, con l'avviso al NOC.

## Salute CPE (modulo, spento di default)

- **Amministratori e direttore tecnico**: menu *Salute CPE*.
  - Mostra **tutte le CPE dei clienti presenti in UISP** (esclusi AP e link PtP), installate con l'app oppure prima o senza app.
  - Filtri per problema e per origine (app, solo UISP, assegnate, non assegnate); ricerca per cliente, MAC, AP o installatore. `?installer=` e `?scope=app` anche via API.
- **Assegnazione agli installatori**: si selezionano le CPE (anche «tutte le filtrate», per esempio tutte quelle di un AP) e si assegnano a un installatore, o si toglie l'assegnazione. Le CPE assegnate compaiono in *Le mie CPE* dell'installatore (console e app).
- **Installatori**: menu *Le mie CPE*, le CPE installate da loro con l'app più quelle assegnate.
- **CPE offline da tempo**: quelle offline da più dei mesi impostati sono nascoste (Impostazioni server; 0 = mai). Gli amministratori possono mostrarle.

Per le CPE installate con l'app conta l'ultimo provisioning riuscito per MAC non seguito da una sostituzione, e lo stato attuale si confronta con il **collaudo**. Le altre (solo UISP) seguono le stesse regole tranne «segnale calato», perché non hanno un collaudo.

| Problema | Regola (soglie in Impostazioni server → Soglie di collaudo e salute CPE) |
|---|---|
| Offline | stato UISP `disconnected`, `inactive` o `unknown` |
| Non trovata in UISP | nessun dispositivo UISP con quel MAC |
| Da accettare | ancora in attesa in UISP |
| Segnale debole | sotto il segnale minimo accettato (solo CPE online) |
| Segnale calato | sceso almeno del «Calo di segnale rispetto al collaudo» (vegetazione, antenna spostata) |
| Porta LAN | sotto la velocità minima della porta oppure half duplex: quasi sempre cavo o connettore |
| Capacità bassa | capacità airMAX in download sotto la minima |
| Firmware | più vecchio dello standard CDA Net |
| PPPoE offline | con il CRM di ISP Billing: CPE online ma sessione PPPoE assente |
| Account sospeso o cessato | con il CRM: account RADIUS sospeso o cessato. Gli account cessati restano con l'ultima sessione, per trovare le «CPE di clienti cessati» ancora in rete |

Con il CRM ogni riga mostra anche lo **stato sintetico del cliente** (cessato, in cessazione, sospeso, servizi sospesi, offline, online), l'utente e il profilo PPPoE.

Dati esposti: nome del cliente, modello, MAC, SSID, AP, segnale, porta LAN, firmware, data di installazione. **Mai** password PPPoE, chiavi Wi-Fi o configurazione.

Dall'elenco:
- lo storico della CPE e quello del segnale (modulo Storico segnale);
- per gli amministratori, **Gestisci**: la CPE come nell'app di UISP, con riavvio, firmware, backup, parametri wireless e la scheda Diagnosi (vedi [UISP.md](UISP.md#gestione-cpe));
- Export CSV, con il modulo Export CSV.

## Diagnosi a distanza

Serve prima di mandare un tecnico. Per un intervento, una CPE o un utente PPPoE il server raccoglie:
- lo stato della CPE: in linea, segnale ora, al collaudo e nel mese, interruzioni della settimana, porta LAN;
- account e sessione PPPoE;
- l'AP e le sue CPE offline;
- i guasti Enel vicino al POP, all'AP o al cliente, e la batteria del POP;
- l'ultimo speedtest.

Ne ricava le **cause probabili**, dalla più grave, ognuna con cosa fare. La diagnosi è nel dettaglio dell'intervento (console e app) e nella scheda Diagnosi di Gestione CPE. L'installatore la vede sui propri interventi, solo esito ed essenziale, senza i nomi delle fonti dati.

## Clienti

Anagrafiche e sedi di installazione da ISP Billing (amministratori e direttore tecnico). Per ogni cliente: utente PPPoE, CPE in rete e distanza tra la posizione del CRM e quella di UISP. Le sedi senza coordinate sono posizionate dall'indirizzo. Vedi [CRM.md](CRM.md).

## Magazzino

Le giacenze di ISP Billing, in sola lettura, rilette ogni ora: magazzini dell'azienda, dei nodi, degli installatori e dei partner. I modelli di CPE e il MAC nel seriale si riconoscono da soli.
- **Per il NOC**:
  - giacenze per magazzino e modello;
  - chi ha meno delle CPE minime (Impostazioni server → Magazzino), con avviso al NOC;
  - le CPE installate che risultano ancora a magazzino («da scaricare», con il collaudo accettato in cima);
  - il **registro dei movimenti** di ogni CPE: entrate, uscite, trasferimenti, installazione, collaudo;
  - le **CPE smontate** nelle sostituzioni (funziona, guasta, non so), da riportare in magazzino o in RMA.
- **Account**: ogni installatore o partner si collega al suo magazzino e ha l'opzione «può installare CPE non presenti nel suo magazzino». Senza l'opzione, un MAC fuori dal magazzino blocca la preparazione o la scrittura, anche senza rete. Gli amministratori non sono mai fermati.
- **Il mio magazzino**: l'installatore vede il proprio, anche nell'app; al passo 1 dell'installazione sceglie la CPE dal magazzino.

Lo scarico automatico della CPE al cliente in ISP Billing aspetta un'API di scarico che oggi non c'è.

## Avvisi proattivi

Il server avvisa il NOC prima che il cliente chiami, con le notifiche «Avvisi proattivi» (anche su Telegram, se scelto):
- **segnale delle CPE in calo** (ogni ora): sceso della soglia «Calo di segnale rispetto al collaudo» o sotto il minimo. Scatta solo se il calo è visto in due controlli di fila, al massimo una volta alla settimana per CPE;
- **AP vicini alla saturazione** (ogni ora): airtime o occupazione del canale della sera oltre la soglia (Impostazioni server → Avvisi proattivi), una volta alla settimana per AP;
- **batteria critica di un POP** (ogni 5 minuti, vedi sotto).

## Batterie dei POP (Victron)

Molti POP sono alimentati a fotovoltaico con batterie Victron. Il connettore **Victron VRM** sta in Connettori, con il token cifrato. «Testa connessione» dice, in sola lettura, quanti impianti ci sono, quanti con allarmi e quanti senza dati da oltre un'ora. Il server rilegge gli impianti ogni 5 minuti.
- **Assegnazione**: in Connettori → Victron VRM l'amministratore collega ogni impianto al suo POP; il GPS del GX entro 1 km o il nome suggeriscono il POP. Gli impianti **off-grid** si segnano a mano (VRM lo propone quando il GX non ha rete sull'ingresso AC). Dopo un'assegnazione il fotovoltaico compare subito.
- **Dove si vede**: in Stato rete (vedi [STATO-RETE.md](STATO-RETE.md)) e in Guasti Enel, nella console e nell'app. Per i POP off-grid un guasto Enel colpisce «solo i clienti».
- **Solo avvisi critici**: un POP che va a batteria (con il fotovoltaico succede ogni notte) non manda nulla finché l'autonomia stimata resta sopra le ore impostate (2) e la carica sopra la soglia critica (20%). Entrambi i valori stanno in Impostazioni server → Avvisi proattivi.
  - Sotto una delle due soglie arriva un solo avviso «batteria critica», al NOC e al gruppo Telegram.
  - «Di nuovo in carica» arriva solo dopo quell'avviso e dopo 15 minuti di carica continua. Poi per 2 ore non parte un altro avviso.
  - Lo stato degli avvisi resta nel database: un aggiornamento del server non li ripete.

## IA-AP: assistente della rete (admin, v1.32.55)

Console → **IA-AP**, e nell'app Rete → **IA-AP** (anche come scorciatoia della Home); solo admin, gli installatori non vedono né la scheda né i dati. Ogni ora, insieme al carico serale degli AP, il server analizza tutti gli AP airMAX di UISP e le loro CPE e scrive cosa sistemare. L'analisi è in sola lettura; i dispositivi cambiano solo con l'ottimizzazione automatica, avviata da un admin (sotto).

Dati usati, tutti da UISP: stazioni collegate (segnale, rumore, modulazione attuale e ideale nei due sensi, airtime, capacità, polarizzazioni), statistiche della settimana (andamento del segnale, carico serale 20–23), **spettro misurato dall'AP e da ogni CPE** (come airView), frequenza, ampiezza, azimut e modello dell'antenna; in più il modello di copertura per il segnale atteso di ogni cliente.

**Regole tarate sulla rete reale (v1.32.77, 631 CPE su 107 AP, 11 ottobre 2026).** Ogni regola sulle CPE è stata verificata sulla **capacità che la CPE ottiene davvero, confrontata con le CPE di tutta la rete con lo stesso SNR** (±2 dB, per MHz di canale): quello che non la abbassa non viene segnalato. Una CPE ha **un solo avviso** per il suo collegamento: la causa più grave, con le altre nel dettaglio («Inoltre: …»). Risultato sugli stessi dati: da 276 avvisi (più 63 sul segnale atteso) a 57, su 55 CPE e 2 AP.

| Avviso | Su | Quando | Perché (dati reali) |
|---|---|---|---|
| SNR basso | CPE | sotto 15 dB (critico sotto 12) | 15–20 dB dà la stessa capacità per MHz di 20–25; sotto 15 scende a un terzo |
| Modulazione | CPE | 6 o più livelli sotto l'ideale **e** capacità sotto il 70% delle pari | 4–5 livelli sotto è normale (capacità 0,98 delle pari); da 6 scende a 0,64 |
| Modulazione | AP | almeno 3 CPE e il 30% delle CPE 6 o più livelli sotto l'ideale (critico 50%) | sintomo di canale disturbato |
| CPE lenta che occupa airtime | CPE | almeno il 10% dell'airtime e 3 volte la mediana dell'AP, CPE lenta (SNR sotto 15, modulazione 6 livelli sotto o capacità sotto il 70% delle pari) **e** AP carico la sera: attenzione oltre il 50%, critico oltre il 70% | l'airtime per CPE di UISP è letto in un istante: un cliente veloce che scarica non è un problema; nessun AP oggi supera il 50% la sera |
| Segnale in calo | CPE | ultimo giorno peggiore dei primi due della settimana di 6 dB (critico 10) | |
| Sotto il segnale atteso | CPE | 20 dB sotto la stima del modello, oppure 10 dB con capacità sotto il 70% delle pari | tra 10 e 20 dB le CPE hanno la loro capacità normale: è l'errore del modello (6 dB tipico) |
| Polarizzazioni | CPE | catene distanti 8 dB o più **e** capacità sotto il 70% delle pari (12 dB se la capacità non è nota) | da 8 dB la capacità scende solo in parte dei casi (0,71) |
| Interferenza dal cliente | CPE | la CPE vede il canale molto più occupato dell'AP | |
| Spostamento su altro AP | CPE | AP carico e un altro AP libero è "buono" per quel cliente | |
| Carico serale | AP | airtime o utilizzo del canale tra le 20 e le 23 oltre il 50% (critico 70%) | |
| Rumore all'AP | AP | rumore di fondo sopra −78 dBm | |
| Canale sovrapposto | AP | un nostro AP entro 6 km sullo stesso canale e dentro il fascio dell'altro | |
| Canale più libero | AP | solo per un AP con un sintomo (canale sovrapposto, rumore alto o modulazione bassa su molte CPE) e un canale con almeno 4 punti di occupazione in meno | sugli AP sani l'occupazione misurata non ha relazione con le prestazioni delle CPE |
| Ampiezza del canale | AP | più stretta se l'SNR mediano delle CPE è sotto 15 dB, più larga per un AP carico con SNR mediano da 30 dB | sopra 15 dB i 40 MHz danno più capacità dei 20 anche con 3 dB di rumore in più |

**Canali proposti**: sempre interi dentro la banda di Impostazioni server → Assistente rete (predefinita 5120–5800 MHz), mai sovrapposti a un nostro AP vicino. Lo spettro considerato è la media di quello dell'AP e di quello mediano delle sue CPE. Il cambio di frequenza stima anche la **risposta in frequenza delle antenne** (guadagno migliore a centro banda, circa 1,5 dB in meno per antenna ai bordi) e la perdita di percorso: un canale che porterebbe il cliente più debole sotto il minimo del collaudo viene scartato.

**Pagina (v1.32.60):**
- in alto i contatori (Critici, Da guardare, Suggerimenti, AP coinvolti), che fanno anche da filtro;
- sotto la barra con ricerca, gravità (predefinito *Problemi*: critici e da guardare), tipo e raggruppamento *Per AP* o *Per problema*;
- su schermo largo, a sinistra l'elenco ordinato per gravità e a destra il dettaglio: gli avvisi dell'AP in schede e le CPE in una tabella, con *Cosa fare* scritto una volta per tipo.

Ogni avviso dice cosa fare e, dove serve, i parametri (frequenza, ampiezza); per le CPE c'è il link alla scheda (nell'app: Gestisci CPE). *Ignora 7/90 giorni* nasconde un avviso (registrato nello storico eventi); *Aggiorna ora* rilegge UISP senza aspettare l'ora. I nuovi problemi critici arrivano come notifica a tutti gli admin (Notifiche → "Assistente rete").

### Ottimizzazione automatica (v1.32.57)

Spenta di default: si accende in Impostazioni server → Assistente rete (*Ottimizzazione automatica degli AP tramite UISP*). Da un avviso di un AP (canale più libero, ampiezza, rumore, modulazione, canale sovrapposto) un admin preme **Ottimizza…** nella console o nell'app, legge cosa succederà e conferma:

- **cosa**: il canale consigliato dall'avviso, oppure la ricerca del canale migliore (fino a 3 prove scelte sullo spettro di AP e CPE, stesse regole dei suggerimenti: banda consentita, mai sopra un nostro AP vicino, cliente più debole protetto);
- **quando**: stanotte alle 3:00 (consigliato) o subito.

Per ogni prova il server, tramite UISP:

1. misura i collegamenti sul canale attuale (3 letture in 2 minuti: capacità, SNR, modulazione, segnale del cliente più debole);
2. controlla che il canale esista nella tabella della radio e che ogni CPE lo possa seguire (elenco frequenze della CPE);
3. cambia solo frequenza, ampiezza e modo IEEE dell'AP (il resto della configurazione è riletto da UISP e riscritto com'è; chiavi e segreti non vengono mai salvati né mostrati);
4. aspetta che **tutte** le CPE si riaggancino (al massimo 5 minuti), poi 4 minuti di assestamento, poi misura di nuovo.

Un canale è **migliore** se la capacità totale delle CPE sale almeno del 5% senza perdere più di 1 dB di SNR mediano (la regola non vale se l'SNR resta almeno a 30 dB: lì la modulazione è già la massima) e senza che il cliente più debole perda più di 3 dB. Alla fine resta il migliore; se nessuno lo è, o se una CPE non si riaggancia, l'AP torna al **canale iniziale** e gli admin ricevono una notifica (anche su Telegram, se scelto) con l'esito di ogni prova. Un AP alla volta; *Annulla e ripristina* ferma la prova in corso e rimette il canale iniziale. Se il server si riavvia durante una prova, alla ripartenza rimette il canale iniziale e lo segnala. Ogni avvio e annullamento è nel registro attività.


**Antenne (v1.32.72)**: IA-AP segnala, come informazione, gli AP con almeno 3 clienti senza azimut dell'antenna (né in UISP né in Copertura → Antenne degli AP), con l'azimut suggerito dai clienti, e le radio senza antenna propria (Rocket) di cui nessuno ha indicato l'antenna (horn RF elements, settore…). Si sistemano in Copertura → Antenne degli AP.

## Statistiche (admin)

Per gli ultimi 3, 6, 12 o 24 mesi:
- **per mese**: provisioning riusciti e falliti (grafico), collaudi superati, con riserva e non superati, segnale e download medi dei collaudi, sostituzioni, CPE accettate in UISP;
- **per installatore**: riuscite, percentuale di fallimenti, quota di installazioni collaudate, collaudi con riserva, segnale medio, ultimo intervento;
- **per modello**: provisioning e percentuale di fallimenti.

I falliti sono **tentativi**: un'installazione riuscita al secondo tentativo conta un fallito e un riuscito.

## Report mensile

In Statistiche, «Report mensile» (modulo Statistiche) riassume il mese:
- installazioni: sostituzioni, fallite, confronto con il mese prima;
- collaudi per esito e quelli superati dal NOC; segnale medio; ripuntamenti;
- interventi: fatti, annullati, aperti, in ritardo, non fatti, per tipo;
- rimandi e KO per motivo, speedtest sotto profilo;
- una riga per installatore.

«Scarica PDF» lo salva. Il 1° del mese dalle 8 il report del mese finito va al gruppo Telegram, testo e PDF, una volta sola (evento «Riepilogo serale e report mensile»).

## Salute piattaforma e backup

Amministrazione → **Salute piattaforma** mostra:
- per ogni servizio esterno (UISP, ISP Billing, magazzino, guasti Enel, Victron, backup sul NAS): l'ultimo esito positivo, l'ultimo errore e il ritardo. Un servizio è «in ritardo» dopo tre letture mancate, mai prima di 30 minuti;
- il server: versione, database, spazio su disco, copie automatiche e ultimo backup scaricato.

Ogni 5 minuti, solo quando lo stato cambia, arriva un avviso al NOC e su Telegram (evento «Servizi giù / di nuovo su»), anche per il disco quasi pieno.

**Backup del database**:
- **Scarica backup cifrato**: una copia del database (`VACUUM INTO`) cifrata AES-256-GCM con una password scelta dall'amministratore, con dentro la chiave principale se richiesta. **Verifica un backup** apre una copia e ne controlla l'integrità, senza sostituire nulla.
- **Backup sul NAS** (Connettori → NAS):
  - il percorso di rete si scrive in ogni forma (`\\NAS\cartella`, `//NAS/cartella`, `smb://`, IP) e il server lo riconosce: nome, porta SMB, condivisione e cartelle con i nomi veri;
  - «Riconosci» trova il NAS e la condivisione, «Sfoglia il NAS» sceglie la cartella, anche nuova;
  - il test scrive e cancella un file di prova e mostra lo spazio libero;
  - il backup parte ogni notte all'ora scelta, o appena il server riparte se era spento. La copia è cifrata con la password del backup, scritta con un nome temporaneo e rinominata, poi riaperta come prova di ripristino;
  - restano solo le ultime N copie create da qui;
  - «Esegui backup ora», «Copie sul NAS» e la verifica di una copia sono nella stessa card;
  - la password del NAS non torna mai alla console.

Il backup completo del server (database, chiave principale, configurazione) è in [DEPLOY.md](DEPLOY.md).

## Registro attività

Ogni azione rilevante, con chi, quando e cosa: accessi, account, connettori, impostazioni, installazioni, accettazioni in UISP, modifiche agli interventi, download dei rapporti, azioni di Claude, gruppi di lavoro. Le azioni fatte dal connettore MCP sono segnate «via Claude» (vedi [MCP.md](MCP.md)). Il registro si conserva per i giorni impostati (Impostazioni server → Conservazione dello storico e del registro). Lo vedono gli amministratori e il direttore tecnico.
