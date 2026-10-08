# Roadmap

Stato: ✅ fatto · 🔄 in corso · ⏳ da fare. Ogni voce esce come release con test, CI e test e2e dell'installer.

## v1.1 — gestione e sicurezza

| # | Voce | Perché | Stato |
|---|---|---|---|
| 1 | **Il mio account**: cambio password personale (web e app), "esci da tutti i dispositivi" | oggi solo un admin può cambiare le password, anche la propria | ✅ v1.1.0 |
| 2 | **Export CSV dello storico provisioning**, con i filtri della pagina | report per NOC e amministrazione | ⏳ |
| 3 | **Connettore notifiche Telegram** (eventi da concordare); configurazione e test da Connettori | il NOC sa subito cosa è successo sul campo | ⏳ |
| 4 | **Verifica in due passaggi (TOTP)** per gli account, obbligatoria per gli admin se attivata | la console è esposta su Internet | ⏳ |

## Già rilasciato

- v1.0.10: stato OpenStreetMap in Panoramica, test e2e di aggiornamento.
- v1.0.9: OpenStreetMap locale (Nominatim) installato dall'installer, regione Sicilia.
- v1.0.8: Connettori (UISP configurabile e testabile dalla console, TLS ignorabile), verifica API su UISP 3.1.65.
- v1.0.0–v1.0.7: riscrittura server/web/Android, template airOS da backup, reti Wi-Fi da CSV, permessi template, UISP, GPS e Copertura.
