# Roadmap

Stato: ✅ fatto · 🔄 in corso · ⏳ da fare. Ogni voce esce come release con test, CI e test e2e dell'installer.

## v1.1 — gestione e sicurezza

| # | Voce | Perché | Stato |
|---|---|---|---|
| 1 | **Il mio account**: cambio password personale (web e app), "esci da tutti i dispositivi" | oggi solo un admin può cambiare le password, anche la propria | ✅ v1.1.0 |
| 2 | **Strumenti di campo** (Android), vedi [FIELD-TOOLS.md](FIELD-TOOLS.md) | puntare, collaudare e diagnosticare senza aprire l'interfaccia della CPE | ✅ (scansione AP dalla CPE da verificare) |
|   | ↳ Puntamento antenna (segnale live, bip, picco, segnale atteso) | | ✅ v1.2.0 |
|   | ↳ Diagnosi CPE (segnale, catene, CINR, cavo LAN, PPPoE, firmware) con rapporto per il NOC | | ✅ v1.2.0 |
|   | ↳ Collaudo finale automatico con verbale e foto salvati nel job | | ✅ v1.3.0 |
|   | ↳ Sostituzione CPE guasta riusando i dati del job (password PPPoE dal backup UISP) | | ✅ v1.3.0 |
|   | ↳ Bussola verso l'AP (con verifica calibrazione e disturbi magnetici) | | ✅ v1.4.0 |
|   | ↳ Storico segnale da UISP (web e app) con riconoscimento del degrado lento | | ✅ v1.4.0 |
|   | ↳ Configurazione cambiata rispetto al template (da backup UISP) | | ✅ v1.5.0 |
|   | ↳ Scansione degli AP visibili dalla CPE | | ✅ v1.25.0 (da verificare su CPE reale) |
|   | ↳ Discovery Ubiquiti, produttori in scansione LAN, canale consigliato nel Wi-Fi Analyzer | | ✅ v1.6.0 |
| 3 | **Export CSV dello storico provisioning**, con i filtri della pagina e l'intervallo di date | report per NOC e amministrazione | ✅ v1.8.0 |
| 4 | **Connettore notifiche Telegram**: provisioning fallito, CPE da accettare in UISP, UISP giù/su, eventi di sicurezza, riepilogo serale; configurazione e test da Connettori, vedi [NOTIFICHE.md](NOTIFICHE.md) | il NOC sa subito cosa è successo sul campo | ✅ v1.7.0 |
| 5 | **Verifica in due passaggi (TOTP)** per gli account, obbligatoria per gli admin se attivata (web e app), vedi [SECURITY.md](../SECURITY.md) | la console è esposta su Internet | ✅ v1.9.0 |

## v1.10+ — NOC e robustezza sul campo

| # | Voce | Perché | Stato |
|---|---|---|---|
| 1 | **Salute CPE installate** (modulo, spento di default): solo CPE installate con l'app, ogni installatore le proprie, stato attuale vs collaudo — vedi [NOC.md](NOC.md) | manutenzione proattiva senza esporre il resto della rete | ✅ v1.11.0 (rifatta) |
| 2 | **Statistiche** per mese, installatore e modello | qualità del lavoro e carico | ✅ v1.10.0 |
| 3 | **Collaudo offline**: misure e foto in coda nell'app, inviate quando torna la rete | sul tetto spesso non c'è campo | ✅ v1.10.1 |
| 5 | **Funzionalità a moduli**: ogni funzione facoltativa si accende/spegne, nascosta in web e app e bloccata sul server — vedi [MODULI.md](MODULI.md) | adattare lo strumento all'organizzazione | ✅ v1.11.0 |
| 6 | **Moduli per singolo utente**: attivo/disattivo/predefinito per ogni installatore o admin | provare o limitare funzioni a gruppi di persone | ✅ v1.12.0 |
| 7 | **Strumenti di rete professionali**: scanner IP con produttore IEEE e tipo di apparato, port scanner con banner e TLS, ping continuo, MTU, DNS avanzato, HTTP, Wake-on-LAN; controllo Wi-Fi con popup Android | strumenti da tecnico di rete, non da hobbista | ✅ v1.13.0 |
| 8 | **Guasti Enel**: interruzioni e-distribuzione nelle zone e attorno agli AP, notifiche Telegram e Android — vedi [GUASTI-ENEL.md](GUASTI-ENEL.md) | sapere subito se un problema di rete è un guasto elettrico | ✅ v1.14.0 |
| 9 | **Guasti Enel su POP/AP**: POP e AP con indirizzi e coordinate da UISP, selezione di quelli da monitorare, POP/AP potenzialmente impattati, assegnazione agli installatori (vedono solo i propri), zone da GPS/indirizzo/coordinate | sapere quale POP o AP rischia di restare senza corrente e avvisare solo il tecnico di zona | ✅ v1.15.0 |
| 10 | **Installatori di zona**: zone personali dei guasti, Telegram personale con il bot dell'admin, POP/AP assegnati validi anche per la verifica copertura, nessun riferimento a UISP/fonti/moduli per gli installatori | ogni tecnico vede e riceve solo la sua zona | ✅ v1.16.0 |
| 11 | **Mappe Protomaps** sul nostro server in Guasti Enel e Copertura; POP/AP come area approssimativa e numero clienti nascosto per gli installatori — vedi [MAPPE.md](MAPPE.md) | colpo d'occhio sul territorio senza esporre la rete | ✅ v1.17.0 (web) |
| 12 | **Stato rete** (modulo, per account): stato di POP/AP, CPE offline, guasti Enel vicini; installatori solo gli assegnati, senza notifiche — vedi [STATO-RETE.md](STATO-RETE.md) | sapere se un AP/POP della propria zona è giù | ✅ v1.18.0 |
| 13 | **Trova l'AP** nell'app: mappa con direzione del telefono, lista con azimut/tilt/altitudine, mirino in fotocamera; **segnale stimato** dalle CPE già installate su ogni AP (anche in Copertura) | puntare e scegliere l'AP come con gli strumenti degli operatori 5G | ✅ v1.19.0 |
| 14 | **Mappa Guasti Enel nell'app** (stessa mappa della console, POP/AP approssimati per gli installatori) | il colpo d'occhio anche sul campo | ✅ v1.20.0 |
| 15 | **Salute CPE per tutti i clienti** (admin: tutte le CPE in UISP) e **assegnazione delle CPE storiche agli installatori** | manutenzione anche dei clienti installati prima dell'app | ✅ v1.21.0 |
| 16 | **Hikvision SADP completo** (attivazione, rete, porte, azioni) e **mappa di rete** della LAN scansionata nell'app | strumenti TVCC e di rete da tecnico | ✅ v1.22.0 |
| 17 | **Wi-Fi Analyzer stile WiFiman**: spettro, occupazione canali e consigliati, segnale nel tempo, dettagli reti e connessione | analisi Wi-Fi dal campo | ✅ v1.23.0 |
| 18 | **Topologia di rete**: discovery multi-vendor (MikroTik MNDP, Ubiquiti, Hikvision SADP, Dahua, ONVIF, UPnP/SSDP, mDNS, NetBIOS, Netgear NSDP, TP-Link) + SNMP (community `public` predefinita o manuali) con LLDP/CDP, tabelle MAC e ARP; senza SNMP mappa base dal gateway | mappa reale della LAN del cliente | ✅ v1.24.0 |
| 19 | **Impostazioni server dal portale** (credenziali e chiave UISP delle CPE, rete CPE, provisioning, rilasci) al posto del `.env` | niente SSH sul server | ✅ v1.26.0 |
| 20 | **Infrastruttura dal portale** (indirizzo/HTTPS, aggiornamenti automatici e canale, mappe) applicata dall'agente di aggiornamento, che aggiorna da solo anche i file di deploy | niente SSH neanche per l'infrastruttura | ✅ v1.27.0 |
| 21 | **Installazione CPE guidata**: AP consigliati dal GPS, scrittura, convalida, aggancio con scansione AP della CPE e cambio AP, puntamento con mirino AR e segnale, verifica finale (SNR, modulazione) e collaudo; percorso **ripuntamento** per CPE già installate | un unico percorso dal .cfg al collaudo | ✅ v1.28.0 |
| 22 | **Telegram personale per tutti gli account** (Il mio account / Impostazioni dell'app): basta il token del bot, gruppo NOC facoltativo, interruttore per l'admin e messaggi che dicono cosa manca | ogni utente riceve le proprie notifiche | ✅ v1.29.0 |
| 23 | **Accesso rapido con impronta o volto** nell'app (chiave del telefono revocabile, nessuna password salvata) e **salvataggio delle credenziali** nel browser della console | entrare in un attimo sul campo | ✅ v1.30.0 |
| 24 | **Aggiornamento obbligatorio dell'app**: controllo all'avvio, ogni 15 minuti e al rifiuto del server; download automatico; senza l'ultima versione niente login né uso (disattivabile in Impostazioni server) | tutti i tecnici sempre sulla stessa versione | ✅ v1.31.0 |
| 25 | **Regione OpenStreetMap dal portale** (reimport da zero con conferma) e **SSID dei rilanci** `CDA-NET-N<pop>-D<distretto>-R<n>` in reti Wi-Fi, provisioning, cambio AP e copertura | niente SSH anche per il geocoder; AP di rilancio gestiti come gli altri | ✅ v1.32.0 |

## CRM ISP Billing (da fare, dopo il connettore)

Vedi [CRM.md](CRM.md).
- **Lettura**:
  - cerca il cliente e compila PPPoE, nome, indirizzo e coordinate;
  - verifica l'account RADIUS e il profilo prima di preparare il `.cfg`;
  - controllo "PPPoE autenticato" nel collaudo (online, MAC e IP), con velocità confrontata con il profilo;
  - stato RADIUS e clienti sospesi/morosi in Salute CPE e Stato rete;
  - attività e team nell'agenda interventi (tabella `work_orders`, da coordinare);
  - articolo e modello dal seriale.
- **Scrittura**:
  - account RADIUS creato dal server con password generata, che va direttamente nella CPE;
  - stato del cliente `active` dopo il collaudo o l'approvazione NOC;
  - campi personalizzati (MAC, modello, AP/SSID, collaudo) e coordinate GPS;
  - azioni RADIUS dal NOC (disconnetti, sospendi, riattiva).
- **Da chiedere a ISP Billing**: scrittura delle attività (esito, stato), elenco tecnici, scarico a magazzino del seriale sul cliente, webhook.

## Da verificare sul campo

Mappe nell'app: verificate sul telefono con la v1.32 (tile singole dal server). Funzioni scritte e testate senza l'apparato reale: vanno provate su una CPE di laboratorio (o sul telefono) prima dell'uso in produzione.

| Voce | Cosa provare |
|---|---|
| Scansione AP dalla CPE (v1.25) | che `survey.json.cgi` risponda su airOS 8.7.4 e che l'elenco corrisponda a quello della pagina web della CPE |
| Cambio AP dall'installazione guidata (v1.28) | su una CPE di laboratorio: SSID e chiave WPA2 riscritti, "Lock to AP" sbloccato, riavvio e aggancio al nuovo AP |
| Modulazione nella verifica finale (v1.28) | che `status.cgi` riporti `rx_idx`/`tx_idx`: se mancano la riga non compare |
| Accesso rapido con impronta o volto (v1.30) | attivazione dopo il login, accesso con impronta e con volto, revoca da Il mio account |
| Aggiornamento obbligatorio (v1.31) | un'app più vecchia mostra solo la schermata di aggiornamento e si aggiorna da sola |
| Tema scuro (v1.32.1) | con il telefono in modalità scura: nessun lampo bianco all'avvio, mappe in versione scura |

## Già rilasciato

- v1.32.51: terreno TINITALY 10 m ed edifici/alberi da ESA WorldCover (scaricati dal server per l'area della rete, dalla console); antenne sopra gli ostacoli vicini e AP in cima alla collina; Visibilità con edifici e alberi; riquadro "Affidabilità della stima" (ogni cliente stimato senza di lui, storico prima/dopo, AP e clienti stimati peggio); altezze medie di edifici e vegetazione in Impostazioni server.
- v1.32.50: copertura riscritta: teoria radio + terreno (diffrazione sulle colline, stesso profilo di Visibilità) + calibrazione di rete e del singolo AP dai clienti reali; un solo cliente non può più dare −52 dBm dietro una collina; clienti con posizione UISP sull'AP o oltre 20 km esclusi (niente più "fasci" da 50 km); nessun AP oltre 20 km; quota GPS degli AP mai sotto il terreno + 5 m; simulazione con il terreno.
- v1.32.45: scorciatoie della home, catalogo completo (29 voci): anche Discovery LAN, Scanner porte, Diagnostica avanzata, SNMP, TVCC, Cerca e Impostazioni; ogni scorciatoia apre la sua scheda (Scansione LAN apre sempre Host attivi, non l'ultima scheda usata).
- v1.32.41: app, scorciatoie della home personalizzabili per account: "Modifica" accanto a Scorciatoie per aggiungere (da un catalogo di 22 funzioni), ordinare e togliere; "Ripristina predefinite". Salvate con l'account sul server (migrazione 24, `GET/PUT /api/auth/shortcuts`), quindi uguali su ogni telefono; copia sul telefono per l'uso senza rete, con invio al server alla riconnessione. Compaiono solo le funzioni attive per l'account.
- v1.32.37: app, "Copertura" come quinta area della barra in basso (dopo Installa) e scorciatoia in Oggi: indirizzo, coordinate, GPS o tocco sulla mappa; visibilità con l'altezza della CPE; per l'admin tutti gli AP sulla mappa, ricerca per nome e simulazione di copertura come nella console. Per gli installatori solo gli AP assegnati. "AP vicini" resta in Rete per il lavoro sul posto.
- v1.32.36: stato sintetico del cliente dal CRM (cessato, in cessazione, sospeso, servizi sospesi, offline, online) in Salute CPE; account terminati tenuti con l'ultima sessione: "CPE di clienti cessati" ancora in rete.
- v1.32.34: pagina Clienti nella console: anagrafiche e sedi di installazione da ISP Billing con PPPoE, CPE in rete e distanza tra la posizione del CRM e quella UISP; sedi senza coordinate dall'indirizzo.
- v1.32.32: stato RADIUS da ISP Billing per il NOC: sincronizzazione ogni 10 minuti, colonna PPPoE e problemi "PPPoE offline" e "account sospeso" in Salute CPE, account PPPoE offline/sospesi/senza CPE, sessioni per AP in Stato rete.
- v1.32.31: guida installatore aggiornata con la nuova Scansione LAN (host attivi, griglia IP, topologia, discovery, porte) e dati di esempio per tutte le schede nelle build di sviluppo.
- v1.32.24: Scansione LAN con radar e contatore dal vivo, topologia automatica a fine scansione con le due fasi indicate, produttori e tipi dell'elenco dal grafo (SNMP, impronte, nomi di fabbrica).
- v1.32.21: Scansione LAN riprogettata (radar, riepilogo per tipo, griglia degli indirizzi, schede host tecniche, discovery multi-vendor con quadro dei protocolli, porte con mappa e banner), orizzontale e tablet su due colonne, nuvoletta dei dispositivi a schermo intero, PNG/PDF salvati in Download.
- v1.32.19: scansione senza host fantasma (DNS intercettato dal router, "No route to host"), mappa automatica a fine scansione, zoom e schermo intero.
- v1.32.18: topologia di rete a grafo (stile UniFi) con icone per tipo e produttore, più protocolli di discovery, scansione ampia, export PNG/PDF.
- v1.32.17: connettore CRM ISP Billing in Connettori (chiave cifrata, test per modulo); nessun dato ancora letto o scritto.
- v1.32.7: Segnala KO (rimandata con motivo e giorno, o KO definitivo con motivazione) senza bloccare i ritentativi; scrittura nella CPE ritentabile; approvazione del NOC per i collaudi con segnale pessimo; pagina Notifiche (console e app) con scelta di cosa ricevere anche su Telegram.
- v1.32.6: Reti Wi-Fi da UISP con la chiave WPA2 comune: solo gli SSID ancora da importare, per nodo e selezionabili; export CSV con le chiavi in chiaro (con password).
- v1.32.3: Discovery LAN nell'app con lista compatta, tipo di dispositivo e azioni (web, copia IP, porte).
- v1.32.2: Guasti Enel nell'app con righe compatte e "Sulla mappa" sulla mappa della pagina.
- v1.32.1: mappa locale servita a tile singole dal server (niente letture a intervalli: le WebView Android le rifiutavano).
- v1.32.0: regione OpenStreetMap dal portale, SSID dei rilanci (…-R<n>).
- v1.31.1: collegamenti PtP esclusi da copertura, Trova l'AP, Stato rete e Salute CPE (SSID CDA-NET-N…-D…).
- v1.31.0: aggiornamento obbligatorio e automatico dell'app.
- v1.30.0: accesso rapido con impronta o volto nell'app, credenziali salvabili nel browser.
- v1.29.0: notifiche Telegram personali per tutti gli account, con il solo token del bot.
- v1.28.0: installazione CPE guidata (AP consigliati, cambio AP, mirino AR con segnale, collaudo) e ripuntamento; Salute CPE nell'app con ricerca, filtri e lista compatta; mappe dell'app tramite il client dell'app.
- v1.27.0: infrastruttura dal portale (indirizzo/HTTPS, aggiornamenti, mappe) tramite l'agente di aggiornamento, che aggiorna anche i file di deploy.
- v1.26.0: impostazioni server dal portale (password CPE e parametri del `.env`).
- v1.25.0: AP visibili dalla CPE, credenziali CPE alternative negli strumenti di campo.
- v1.22.0–v1.24.0: Hikvision SADP, mappa e topologia di rete, Wi-Fi Analyzer.
- v1.13.0–v1.21.0: strumenti di rete professionali, Guasti Enel (POP/AP, zone, mappe), Stato rete, Trova l'AP, Salute CPE per tutti i clienti.

- v1.12.0: moduli per singolo utente.
- v1.11.0: funzionalità a moduli, salute CPE installate.
- v1.10.x: statistiche, collaudo offline.
- v1.9.0: verifica in due passaggi (TOTP) su web e app.
- v1.8.0: export CSV dello storico.
- v1.7.0: notifiche Telegram per il NOC.
- v1.6.0: discovery Ubiquiti, produttori in scansione LAN, canale consigliato.
- v1.5.0: configurazione della CPE rispetto al template (backup UISP).
- v1.4.0: bussola verso l'AP, storico segnale UISP.
- v1.3.0: collaudo con verbale e foto, sostituzione CPE.
- v1.2.0: puntamento antenna e diagnosi CPE dall'app.
- v1.1.0: Il mio account (cambio password, esci da tutti i dispositivi).
- v1.0.10: stato OpenStreetMap in Panoramica, test e2e di aggiornamento.
- v1.0.9: OpenStreetMap locale (Nominatim) installato dall'installer, regione Sicilia.
- v1.0.8: Connettori (UISP configurabile e testabile dalla console, TLS ignorabile), verifica API su UISP 3.1.65.
- v1.0.0–v1.0.7: riscrittura server/web/Android, template airOS da backup, reti Wi-Fi da CSV, permessi template, UISP, GPS e Copertura.
