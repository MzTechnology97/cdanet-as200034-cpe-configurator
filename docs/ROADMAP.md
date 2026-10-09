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
|   | ↳ Scansione degli AP visibili dalla CPE (da verificare su una CPE reale) | | ⏳ |
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
| 4 | Scansione degli AP visibili dalla CPE | scegliere l'AP migliore | ⏳ (serve una CPE reale per verificare il comando airOS) |

## Già rilasciato

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
