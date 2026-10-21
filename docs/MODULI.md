# Funzionalità (moduli)

Console → **Amministrazione → Funzionalità** (solo admin). Ogni funzione facoltativa si accende o si spegne con una spunta.

Un modulo spento:
- sparisce dal menu e dai pannelli della console web, subito;
- sparisce dall'app Android (scorciatoie e schermate di Oggi, pulsanti nello storico, nella copertura e nell'installazione) al login successivo o quando l'app riprende la sessione (`/api/meta`);
- **viene rifiutato dal server**: le sue API rispondono `404 module_disabled`. Non è solo nascosto.

Ogni modifica finisce nel Registro attività ("Funzionalità modificate").

| Modulo | Dove | Default |
|---|---|---|
| Copertura AP | web + app (area «Copertura» nella barra in basso, AP consigliati nell'installazione), vedi [COPERTURA.md](COPERTURA.md) | attivo |
| Puntamento antenna | app | attivo |
| Diagnosi CPE | app | attivo |
| Trova l'AP (bussola e fotocamera) | app | attivo |
| Collaudo e verbale | web + app | attivo |
| Sostituzione CPE | app | attivo |
| Storico segnale | web + app | attivo |
| Confronto con il template | web | attivo |
| **Salute CPE** | web + app | **spento**: admin, tutte le CPE dei clienti in UISP e assegnazione agli installatori, vedi [NOC.md](NOC.md) |
| Statistiche | web | attivo |
| Export CSV | web | attivo |
| Strumenti di rete | app | attivo |
| MikroTik · RouterOS | web + app | attivo |
| **Guasti Enel** | web + app | **spento**, vedi [GUASTI-ENEL.md](GUASTI-ENEL.md) |
| **Stato rete** | web + app | **spento**, vedi [STATO-RETE.md](STATO-RETE.md) |
| Agenda interventi | web + app | attivo: interventi assegnati dall'ufficio, calendario, vedi [NOC.md](NOC.md#interventi-e-calendario) |
| **Aggiornamento firmware** | web + app | **spento**: firmware airOS di riferimento caricati dall'admin e portati sulla CPE dall'app |
| **Screenshot nell'app** | app | **spento**: l'app blocca screenshot e registrazione dello schermo; gli admin possono sempre, per installatori e partner si attiva account per account |
| Notifiche Telegram | server | attivo (se configurate in Connettori), vale per tutti |

## Moduli per singolo utente

In **Account → utente → Funzionalità per questo utente** ogni modulo ha tre valori:
- **Predefinito**: segue l'impostazione generale (indicata tra parentesi);
- **Attivo per questo utente**: anche se in generale è spento. Utile per provare un modulo con pochi installatori, per esempio *Salute CPE*;
- **Disattivo per questo utente**: anche se in generale è acceso.

Il server applica il risultato per utente: API, `/api/meta`, menu web e app. Nella pagina Funzionalità ogni modulo indica quante eccezioni ci sono ("attivo per 2, spento per 1"). Le **notifiche Telegram** sono un modulo del server e valgono per tutti. Le modifiche finiscono nel Registro attività ("Funzionalità di un utente modificate").

Restano sempre attivi: provisioning, storico, profili airOS, reti Wi-Fi, account, connettori, registro attività, magazzino, notifiche.

I moduli si sommano ai ruoli: uno Specialist senza visibilità piena non vede le funzioni che usano i dati o la rete di CDA Net anche con il modulo acceso (vedi [SPECIALIST-GRUPPI.md](SPECIALIST-GRUPPI.md)).

Le credenziali CPE per gli strumenti di campo vengono consegnate all'app solo se è attivo almeno uno tra Puntamento, Diagnosi e Collaudo. Lo speedtest usa il server Ookla di CDA Net (Impostazioni server → «Collaudo: speedtest e Wi-Fi») e resta disponibile nel collaudo e negli interventi anche con gli Strumenti di rete spenti; il server dell'app non fa più da server di speedtest.
