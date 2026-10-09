# Funzionalità (moduli)

Console → **Amministrazione → Funzionalità** (solo admin). Ogni funzione facoltativa si accende o si spegne con una spunta.

Un modulo spento:
- sparisce dal menu e dai pannelli della console web, subito;
- sparisce dall'app Android (schermate della Home, pulsanti nello storico, nella copertura e nel provisioning) al login successivo;
- **viene rifiutato dal server**: le sue API rispondono `404 module_disabled`. Non è solo nascosto.

Ogni modifica finisce nel Registro attività ("Funzionalità modificate").

| Modulo | Dove | Default |
|---|---|---|
| Copertura AP | web + app (anche "AP vicini" nel provisioning) | attivo |
| Puntamento antenna | app | attivo |
| Diagnosi CPE | app | attivo |
| Bussola verso l'AP | app | attivo |
| Collaudo e verbale | web + app | attivo |
| Sostituzione CPE | app | attivo |
| Storico segnale | web + app | attivo |
| Confronto con il template | web | attivo |
| **Salute CPE installate** | web + app | **spento** |
| Statistiche | web | attivo |
| Export CSV | web | attivo |
| Strumenti di rete | web + app | attivo |
| MikroTik · RouterOS | web + app | attivo |
| Notifiche Telegram | server | attivo (se configurate in Connettori) |

Restano sempre attivi: provisioning, storico, profili airOS, reti Wi-Fi, account, connettori, registro attività.

Le credenziali CPE per gli strumenti di campo vengono consegnate all'app solo se è attivo almeno uno tra Puntamento, Diagnosi e Collaudo. Lo speed test resta disponibile per il collaudo anche con gli Strumenti di rete spenti.
