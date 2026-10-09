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
