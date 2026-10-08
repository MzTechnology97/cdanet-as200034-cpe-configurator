# Roadmap

Stato: ✅ fatto · 🔄 in corso · ⏳ da fare. Ogni voce esce come release con test, CI e test e2e dell'installer.

## v1.1 — gestione e sicurezza

| # | Voce | Perché | Stato |
|---|---|---|---|
| 1 | **Il mio account**: cambio password personale (web e app), "esci da tutti i dispositivi" | oggi solo un admin può cambiare le password, anche la propria | ✅ v1.1.0 |
| 2 | **Strumenti di campo** (Android), vedi [FIELD-TOOLS.md](FIELD-TOOLS.md) | puntare, collaudare e diagnosticare senza aprire l'interfaccia della CPE | 🔄 |
|   | ↳ Puntamento antenna (segnale live, bip, picco, segnale atteso) | | ✅ v1.2.0 |
|   | ↳ Diagnosi CPE (segnale, catene, CINR, cavo LAN, PPPoE, firmware) con rapporto per il NOC | | ✅ v1.2.0 |
|   | ↳ Collaudo finale automatico con verbale e foto salvati nel job | | ✅ v1.3.0 |
|   | ↳ Sostituzione CPE guasta riusando i dati del job (password PPPoE dal backup UISP) | | ✅ v1.3.0 |
|   | ↳ Bussola verso l'AP (con verifica calibrazione e disturbi magnetici) | | ✅ v1.4.0 |
|   | ↳ Storico segnale da UISP (web e app) con riconoscimento del degrado lento | | ✅ v1.4.0 |
|   | ↳ Configurazione cambiata rispetto al template (da backup UISP) | | ⏳ |
|   | ↳ Scansione degli AP visibili dalla CPE (da verificare su una CPE reale) | | ⏳ |
|   | ↳ Migliorie a Wi-Fi Analyzer e Discovery LAN | | ⏳ |
| 3 | **Export CSV dello storico provisioning**, con i filtri della pagina | report per NOC e amministrazione | ⏳ |
| 4 | **Connettore notifiche Telegram**: provisioning fallito, CPE da accettare in UISP, UISP giù/su, eventi di sicurezza, riepilogo serale; configurazione e test da Connettori | il NOC sa subito cosa è successo sul campo | ⏳ |
| 5 | **Verifica in due passaggi (TOTP)** per gli account, obbligatoria per gli admin se attivata | la console è esposta su Internet | ⏳ |

## Già rilasciato

- v1.3.0: collaudo con verbale e foto, sostituzione CPE.
- v1.2.0: puntamento antenna e diagnosi CPE dall'app.
- v1.1.0: Il mio account (cambio password, esci da tutti i dispositivi).
- v1.0.10: stato OpenStreetMap in Panoramica, test e2e di aggiornamento.
- v1.0.9: OpenStreetMap locale (Nominatim) installato dall'installer, regione Sicilia.
- v1.0.8: Connettori (UISP configurabile e testabile dalla console, TLS ignorabile), verifica API su UISP 3.1.65.
- v1.0.0–v1.0.7: riscrittura server/web/Android, template airOS da backup, reti Wi-Fi da CSV, permessi template, UISP, GPS e Copertura.
