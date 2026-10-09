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
| **Salute CPE** | web + app | **spento** — admin: tutte le CPE dei clienti in UISP e assegnazione agli installatori |
| Statistiche | web | attivo |
| Export CSV | web | attivo |
| Strumenti di rete | web + app | attivo |
| MikroTik · RouterOS | web + app | attivo |
| **Guasti Enel** | web + app | **spento** — vedi [GUASTI-ENEL.md](GUASTI-ENEL.md) |
| **Stato rete** | web + app | **spento** — vedi [STATO-RETE.md](STATO-RETE.md) |
| Notifiche Telegram | server | attivo (se configurate in Connettori) |

## Moduli per singolo utente

In **Account → utente → Funzionalità per questo utente** ogni modulo ha tre valori:
- **Predefinito**: segue l'impostazione generale (indicata tra parentesi);
- **Attivo per questo utente**: anche se in generale è spento. Utile per provare un modulo con pochi installatori, per esempio *Salute CPE*;
- **Disattivo per questo utente**: anche se in generale è acceso.

Il server applica il risultato per utente: API, `/api/meta`, menu web e app. Nella pagina Funzionalità ogni modulo indica quante eccezioni ci sono ("attivo per 2, spento per 1"). Le **notifiche Telegram** sono un modulo del server e valgono per tutti. Le modifiche finiscono nel Registro attività ("Funzionalità di un utente modificate").

Restano sempre attivi: provisioning, storico, profili airOS, reti Wi-Fi, account, connettori, registro attività.

Le credenziali CPE per gli strumenti di campo vengono consegnate all'app solo se è attivo almeno uno tra Puntamento, Diagnosi e Collaudo. Lo speed test resta disponibile per il collaudo anche con gli Strumenti di rete spenti.
